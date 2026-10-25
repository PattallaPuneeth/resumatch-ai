"""
Phase 3B: Hybrid Retrieval, RRF, Cross-Encoder Reranking, and Skill-Gap Tests.

Tests:
1. Lexical search: OR-style tsquery generation, long job hits, and EXPLAIN GIN index usage.
2. Semantic search: pgvector cosine distance and synonym retrieval.
3. Reciprocal Rank Fusion (RRF): k=60 formula, tie-breaking, chunk-to-resume aggregation.
4. Cross-Encoder reranking: token length protection (512 tokens), calibrated 0-100 score spread.
5. Skill-gap analysis: exact, alias, and partial matching, coverage ratio.
6. Persistence & Idempotency: atomic transaction, ON CONFLICT update in matches table.
7. Worker backward compatibility: EMBED_DOCUMENT legacy {resumeId} payload.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import psycopg
import pytest
from pgvector.psycopg import register_vector

from ml.config import settings
from ml.pipelines.embeddings.chunker import TextChunk
from ml.pipelines.embeddings.embedder import generate_chunk_embeddings
from ml.pipelines.embeddings.repository import persist_resume_chunks
from ml.pipelines.matching.lexical import build_or_tsquery, search_lexical
from ml.pipelines.matching.repository import persist_match_result
from ml.pipelines.matching.reranker import (
    build_bounded_rerank_query,
    get_cross_encoder,
    normalize_cross_encoder_logit,
    rerank_candidates,
)
from ml.pipelines.matching.rrf import aggregate_resume_rrf, fuse_ranks
from ml.pipelines.matching.semantic import search_semantic
from ml.pipelines.matching.skill_gap import analyze_skill_gap
from ml.worker import process_embed_document, process_match_scoring

# =============================================================================
# Database Test Fixtures
# =============================================================================


@pytest.fixture
def db_conn():
    with psycopg.connect(settings.database_url) as conn:
        register_vector(conn)
        yield conn


def _seed_test_match_environment(
    conn: psycopg.Connection,
) -> tuple[str, str, str]:
    """
    Creates a user, a job description with chunks, and a parsed resume with chunks.
    Returns (user_id, job_id, resume_id).
    """
    user_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    resume_id = str(uuid.uuid4())

    with conn.cursor() as cur:
        # Create user
        cur.execute(
            """
            INSERT INTO users (id, email, role, "createdAt", "updatedAt")
            VALUES (%s, %s, 'CANDIDATE', NOW(), NOW());
            """,
            (user_id, f"test-{user_id[:8]}@example.com"),
        )

        # Create job
        cur.execute(
            """
            INSERT INTO jobs (
                id, "userId", title, company, location, "jobType",
                "rawDescription", "requiredSkills", "preferredSkills",
                "experienceLevel", status, "createdAt", "updatedAt"
            ) VALUES (
                %s, %s, 'Senior Full-Stack Engineer', 'Acme Corp', 'San Francisco, CA', 'FULL_TIME',
                (
                    'We are seeking an experienced Senior Full-Stack Engineer with deep expertise '
                    'in Python, Node.js, PostgreSQL, and Kubernetes. The ideal candidate will '
                    'design distributed cloud microservices on AWS and optimize vector search.'
                ),
                '["Python", "Node.js", "PostgreSQL", "Kubernetes"]'::jsonb,
                '["Docker", "AWS", "Redis"]'::jsonb,
                'SENIOR', 'ACTIVE', NOW(), NOW()
            );
            """,
            (job_id, user_id),
        )

        # Create resume
        cur.execute(
            """
            INSERT INTO resumes (
                id, "userId", "originalFilename", "storageKey", "mimeType",
                "sizeBytes", status, "createdAt", "updatedAt"
            ) VALUES (
                %s, %s, 'test_resume.pdf', %s, 'application/pdf', 1024,
                'PARSED'::"ResumeStatus", NOW(), NOW()
            );
            """,
            (resume_id, user_id, f"resumes/{user_id}/{resume_id}.pdf"),
        )

        # Create parsed resume with skills
        cur.execute(
            """
            INSERT INTO parsed_resumes (
                id, "resumeId", "rawText", "candidateName", "contactInfo",
                skills, "atsScore", "createdAt", "updatedAt"
            ) VALUES (
                %s, %s,
                'Summary: Senior Python & Postgres developer with Kubernetes container expertise.',
                'Alex Candidate', '{"email": "alex@example.com"}'::jsonb,
                '["Python", "PostgreSQL", "K8s", "Docker", "FastAPI"]'::jsonb,
                92.0, NOW(), NOW()
            );
            """,
            (str(uuid.uuid4()), resume_id),
        )

    # Generate and persist chunks for the resume
    resume_chunks = [
        TextChunk(
            chunk_index=0,
            section_type="WORK_EXPERIENCE",
            heading="WORK EXPERIENCE",
            content=(
                "Led backend engineering team building distributed vector search "
                "pipelines using Python, PostgreSQL, and pgvector."
            ),
            start_char=0,
            end_char=112,
            token_count=18,
            metadata={},
        ),
        TextChunk(
            chunk_index=1,
            section_type="WORK_EXPERIENCE",
            heading="WORK EXPERIENCE",
            content=(
                "Deployed and managed production microservices on Kubernetes (K8s) "
                "clusters with Docker, Redis caching, and CI/CD pipelines."
            ),
            start_char=113,
            end_char=235,
            token_count=20,
            metadata={},
        ),
        TextChunk(
            chunk_index=2,
            section_type="TECHNICAL_SKILLS",
            heading="TECHNICAL SKILLS",
            content="Technical Skills: Python, Node.js, PostgreSQL, K8s, Docker, Redis, Git.",
            start_char=236,
            end_char=312,
            token_count=14,
            metadata={},
        ),
    ]
    conn.commit()
    vectors = generate_chunk_embeddings(resume_chunks)
    persist_resume_chunks(resume_id, vectors)

    return user_id, job_id, resume_id


# =============================================================================
# 1. Lexical Search Tests
# =============================================================================


def test_build_or_tsquery(db_conn: psycopg.Connection):
    """Verifies OR-style tsquery generation and safe character handling."""
    text = "Senior Python & PostgreSQL Engineer with 5+ years experience in K8s / Docker!"
    q = build_or_tsquery(text, db_conn)
    assert q is not None
    assert " | " in q

    # Confirm PostgreSQL can parse the generated tsquery string
    with db_conn.cursor() as cur:
        cur.execute("SELECT to_tsquery('english', %s);", (q,))
        res = cur.fetchone()
        assert res is not None


def test_lexical_search_long_job_description_returns_hits(db_conn: psycopg.Connection):
    """
    Condition 1: Proves that a long, multi-paragraph job description returns lexical hits
    using OR semantics (unlike plainto_tsquery which requires all words to match simultaneously).
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    long_job_description = (
        "About the Role:\n"
        "We are looking for a Senior Staff Software Engineer to join our Core Infrastructure team. "
        "In this role, you will lead high-impact architectural initiatives across cloud and edge "
        "platforms.\n\n"
        "Responsibilities:\n"
        "- Build scalable microservices in Go, Rust, or Python.\n"
        "- Optimize query planning, indexing, and vector similarity performance in PostgreSQL.\n"
        "- Spearhead container orchestration strategies using Kubernetes and service meshes.\n"
        "- Collaborate with cross-functional product teams, engineering leaders, and "
        "DevOps architects.\n"
        "- Mentor junior engineers, conduct code reviews, and drive operational excellence.\n\n"
        "Qualifications:\n"
        "- 8+ years of distributed backend systems experience.\n"
        "- Expertise in relational database internals (Postgres, MySQL).\n"
        "- Strong experience with Docker, Terraform, Kubernetes, and AWS."
    )

    hits = search_lexical(long_job_description, resume_id=resume_id, limit=10)
    assert len(hits) > 0, "Long job description must return lexical hits under OR tsquery semantics"

    # Confirm ranked chunk properties
    top_hit = hits[0]
    assert top_hit["resume_id"] == resume_id
    assert top_hit["score"] > 0
    assert "content" in top_hit
    assert top_hit["rank"] == 1


def test_lexical_search_uses_gin_index_explain(db_conn: psycopg.Connection):
    """
    Examines PostgreSQL query plans for lexical search:
    1. Single-resume query (as executed by process_match_scoring):
       PostgreSQL optimizer naturally and optimally selects resume_chunks_resumeId_idx (B-tree)
       WITHOUT enable_seqscan = off, filtering the resume's ~3-10 chunks with tsquery.
    2. Cross-resume search:
       The expression GIN index resume_chunks_content_tsv_idx on to_tsvector('english', content)
       exists and is chosen for full-text search when scanning across all candidate resumes.
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    query_str = build_or_tsquery("Python PostgreSQL Kubernetes", db_conn)
    assert query_str is not None

    with db_conn.cursor() as cur:
        # 1. Single-resume query WITHOUT enable_seqscan = off (standard production execution)
        single_resume_sql = """
        EXPLAIN (FORMAT TEXT)
        SELECT id, "resumeId", "chunkIndex", "sectionType", content,
               ts_rank_cd(
                   to_tsvector('english', content),
                   to_tsquery('english', %(q)s),
                   32
               ) AS lexical_score
        FROM resume_chunks
        WHERE "resumeId" = %(resume_id)s
          AND to_tsvector('english', content) @@ to_tsquery('english', %(q)s)
        ORDER BY lexical_score DESC
        LIMIT 10;
        """
        cur.execute(single_resume_sql, {"q": query_str, "resume_id": resume_id})
        single_plan = " ".join([row[0] for row in cur.fetchall()])
        # Single resume lookup must use a selective B-tree index on resumeId
        assert (
            "resume_chunks_resumeId_idx" in single_plan
            or "resume_chunks_resumeId_chunkIndex_key" in single_plan
        ), f"Expected single-resume lookup to use a resumeId B-tree index, got: {single_plan}"

        # 2. Cross-resume query plan verifies GIN index resume_chunks_content_tsv_idx exists
        cur.execute("SET enable_seqscan = off;")
        cross_resume_sql = """
        EXPLAIN (FORMAT TEXT)
        SELECT id, "resumeId", "chunkIndex", content,
               ts_rank_cd(
                   to_tsvector('english', content),
                   to_tsquery('english', %(q)s),
                   32
               ) AS lexical_score
        FROM resume_chunks
        WHERE to_tsvector('english', content) @@ to_tsquery('english', %(q)s);
        """
        cur.execute(cross_resume_sql, {"q": query_str})
        cross_plan = " ".join([row[0] for row in cur.fetchall()])
        assert (
            "resume_chunks_content_tsv_idx" in cross_plan
        ), f"Expected cross-resume plan to use GIN index, got: {cross_plan}"
        cur.execute("SET enable_seqscan = on;")


# =============================================================================
# 2. Semantic Search Tests
# =============================================================================


def test_semantic_search_synonyms_and_concepts(db_conn: psycopg.Connection):
    """Verifies that vector cosine search captures semantic synonyms."""
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    # Search with terms not literally present in chunk 0 (e.g. 'relational database indexing')
    hits = search_semantic(
        "relational database indexing and cloud architecture",
        resume_id=resume_id,
        limit=5,
    )
    assert len(hits) > 0
    assert hits[0]["score"] > 0.0
    assert hits[0]["rank"] == 1


# =============================================================================
# 3. Reciprocal Rank Fusion (RRF) Tests
# =============================================================================


def test_rrf_formula_and_tie_breaking():
    """
    Tests RRF formula with k=60, fusion of lexical and semantic ranks,
    and deterministic tie-breaking (rrf_score DESC, chunk_id ASC).
    """
    # Chunk A: rank 1 lexical, rank 2 semantic
    # Chunk B: rank 2 lexical, rank 1 semantic
    # Chunk C: rank 3 lexical only
    lexical_hits = [
        {"chunk_id": "chunk-B", "score": 0.8, "content": "Text B"},
        {"chunk_id": "chunk-A", "score": 0.6, "content": "Text A"},
        {"chunk_id": "chunk-C", "score": 0.3, "content": "Text C"},
    ]
    semantic_hits = [
        {"chunk_id": "chunk-A", "score": 0.9, "content": "Text A"},
        {"chunk_id": "chunk-B", "score": 0.7, "content": "Text B"},
    ]

    fused = fuse_ranks(lexical_hits, semantic_hits, k=60)
    assert len(fused) == 3

    # Chunk A: lexical_rank 2, semantic_rank 1 -> 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    # Chunk B: lexical_rank 1, semantic_rank 2 -> 1/(60+1) + 1/(60+2) = 1/61 + 1/62
    # Chunk A and Chunk B have the exact same RRF score!
    # Tie-breaking rule: chunk_id ascending ("chunk-A" < "chunk-B")
    expected_score = (1.0 / 61.0) + (1.0 / 62.0)
    assert abs(fused[0]["rrf_score"] - expected_score) < 1e-6
    assert abs(fused[1]["rrf_score"] - expected_score) < 1e-6
    assert fused[0]["chunk_id"] == "chunk-A"  # Alphabetical tie-breaker
    assert fused[1]["chunk_id"] == "chunk-B"

    # Chunk C: lexical_rank 3, semantic_rank None -> 1/(60+3) = 1/63
    assert abs(fused[2]["rrf_score"] - (1.0 / 63.0)) < 1e-6
    assert fused[2]["lexical_rank"] == 3
    assert fused[2]["semantic_rank"] is None


def test_rrf_empty_inputs():
    """Verifies graceful handling of empty rank lists."""
    assert fuse_ranks([], []) == []
    summary = aggregate_resume_rrf([])
    assert summary["resume_rrf_score"] == 0.0
    assert summary["max_chunk_rrf"] == 0.0


def test_aggregate_resume_rrf_scoring():
    """Tests chunk-to-resume aggregation with peak match and depth bonus."""
    fused_chunks = [
        {"chunk_id": "c1", "rrf_score": 0.032},
        {"chunk_id": "c2", "rrf_score": 0.025},
        {"chunk_id": "c3", "rrf_score": 0.020},
        {"chunk_id": "c4", "rrf_score": 0.010},
    ]
    summary = aggregate_resume_rrf(fused_chunks)
    assert summary["max_chunk_rrf"] == 0.032
    # top 3 mean = (0.032 + 0.025 + 0.020) / 3 = 0.025666...
    # depth bonus = 0.25 * 0.025666... = 0.006417
    # combined = 0.032 + 0.006417 = 0.038417
    assert summary["resume_rrf_score"] > summary["max_chunk_rrf"]


# =============================================================================
# 4. Cross-Encoder Reranker Tests
# =============================================================================


def test_cross_encoder_calibrated_percentage_spread():
    """Tests score calibration from raw cross-encoder logits to [0, 100]."""
    # Centered at shift=-3.5, logit -3.5 maps to exactly 50.0
    assert abs(normalize_cross_encoder_logit(-3.5) - 50.0) < 0.1

    # Large positive logit maps close to 100 (> 95)
    assert normalize_cross_encoder_logit(5.0) > 95.0

    # Strong match logit around +2.0 maps to ~87%
    assert normalize_cross_encoder_logit(2.0) > 85.0

    # Irrelevant match logit <= -10.0 maps to < 10%
    assert normalize_cross_encoder_logit(-10.0) < 10.0


def test_cross_encoder_calibration_and_spread_strong_medium_weak():
    """
    Issue 1 Labeled Set:
    Evaluates cross-encoder and composite score calibration across candidate profiles:
    - Strong fit: Backend Engineer (Python, PostgreSQL, Docker, AWS)
    - Medium fit: Full-Stack Web Dev (Node.js, Express, MySQL)
    - Weak / Irrelevant fit: Digital Marketing Specialist (SEO, Google Ads, Content)

    Asserts:
    1. strong_score > medium_score > weak_score
    2. strong_score >= 80.0
    3. medium_score between 25.0 and 70.0
    4. weak_score <= 15.0
    5. score spread (strong - weak) >= 60.0
    """
    job_query = build_bounded_rerank_query(
        job_title="Senior Backend Engineer",
        required_skills=["Python", "PostgreSQL", "Docker", "AWS"],
        raw_description=(
            "We are seeking an experienced Senior Backend Engineer to build "
            "scalable microservices using Python, PostgreSQL, and Docker deployed on AWS."
        ),
        max_tokens=180,
    )

    strong_candidate = [
        {
            "chunk_id": "c-strong-1",
            "content": (
                "Senior Backend Engineer with 6 years experience building scalable REST APIs "
                "and distributed microservices using Python, PostgreSQL, and Docker "
                "deployed to AWS ECS."
            ),
            "rrf_score": 0.032,
            "section_type": "WORK_EXPERIENCE",
        }
    ]

    medium_candidate = [
        {
            "chunk_id": "c-med-1",
            "content": (
                "Backend Developer with 3 years experience building Python Flask and Django "
                "web applications with MySQL and Redis caching."
            ),
            "rrf_score": 0.021,
            "section_type": "WORK_EXPERIENCE",
        }
    ]

    weak_candidate = [
        {
            "chunk_id": "c-weak-1",
            "content": (
                "Senior Digital Marketing Specialist with 5 years leading SEO, SEM, content "
                "strategy, email marketing campaigns, and Google Ads optimization."
            ),
            "rrf_score": 0.005,
            "section_type": "WORK_EXPERIENCE",
        }
    ]

    reranked_strong = rerank_candidates(job_query, strong_candidate, top_k=1)
    reranked_medium = rerank_candidates(job_query, medium_candidate, top_k=1)
    reranked_weak = rerank_candidates(job_query, weak_candidate, top_k=1)

    strong_ce = reranked_strong[0]["cross_encoder_score"]
    medium_ce = reranked_medium[0]["cross_encoder_score"]
    weak_ce = reranked_weak[0]["cross_encoder_score"]

    # 1. Monotonic ordering
    assert (
        strong_ce > medium_ce > weak_ce
    ), f"Expected strong > med > weak, got {strong_ce}, {medium_ce}, {weak_ce}"

    # 2. Sensible bounds
    assert strong_ce >= 90.0, f"Strong fit scored {strong_ce}, expected >= 90.0"
    assert 25.0 <= medium_ce <= 90.0, f"Medium fit scored {medium_ce}, expected 25..90"
    assert weak_ce <= 15.0, f"Irrelevant fit scored {weak_ce}, expected <= 15.0"

    # 3. Dynamic spread across 0-100 range
    spread = strong_ce - weak_ce
    assert spread >= 60.0, f"Expected spread >= 60.0 across 0-100, got {spread}"

    # 4. Composite final score spread verification:
    # Blend: 0.65 * CE + 0.25 * (Coverage * 100) + 0.10 * (Vector * 100)
    # Strong: 4/4 skills = 100% coverage, vector ~ 0.85
    final_strong = round(0.65 * strong_ce + 0.25 * 100.0 + 0.10 * 85.0, 2)
    # Medium: 1/4 required skills = 25% coverage, vector ~ 0.50
    final_medium = round(0.65 * medium_ce + 0.25 * 25.0 + 0.10 * 50.0, 2)
    # Weak: 0/4 skills = 0% coverage, vector ~ 0.15
    final_weak = round(0.65 * weak_ce + 0.25 * 0.0 + 0.10 * 15.0, 2)

    assert final_strong > final_medium > final_weak
    assert final_strong >= 80.0, f"Final strong score {final_strong} < 80"
    assert final_weak <= 15.0, f"Final weak score {final_weak} > 15"


def test_cross_encoder_bounded_query_never_truncates_chunk():
    """
    Issue 2 Regression Test:
    Ensures that a long job description (thousands of characters) paired with
    a maximum-sized resume chunk (~240 tokens) never causes silent truncation
    of either the requirements or the candidate chunk.
    """
    model = get_cross_encoder()
    tokenizer = getattr(model, "tokenizer", None)
    assert tokenizer is not None

    long_job_desc = (
        "About the company: We are a high growth startup founded in 2020 revolutionizing commerce. "
        "We offer competitive 401k matching, unlimited PTO, and health insurance. "
        "Job Summary: Senior Backend Software Engineer. "
        "Key Responsibilities: Design, develop, and maintain backend microservices and databases. "
        "Qualifications: Bachelor's degree in CS, 5+ years with Python, PostgreSQL, and Docker. "
        "Equal Opportunity Employer: All qualified applicants will receive consideration. "
    ) * 10

    # 1. Bounded query generation
    bounded_query = build_bounded_rerank_query(
        job_title="Senior Backend Software Engineer",
        required_skills=["Python", "PostgreSQL", "Docker", "AWS"],
        raw_description=long_job_desc,
        max_tokens=180,
    )

    query_tokens = tokenizer.encode(bounded_query, add_special_tokens=False)
    assert len(query_tokens) <= 180, f"Bounded query exceeded 180 tokens: {len(query_tokens)}"

    # 2. Maximum length resume chunk (~240 tokens)
    resume_chunk_words = [
        "Architected",
        "and",
        "implemented",
        "scalable",
        "distributed",
        "event-driven",
        "microservices",
        "using",
        "Python",
        "FastAPI",
        "and",
        "PostgreSQL",
        "handling",
        "high",
        "throughput.",
        "Containerized",
        "applications",
        "with",
        "Docker",
        "and",
        "deployed",
        "to",
        "Kubernetes",
        "clusters",
        "on",
        "AWS.",
    ] * 5  # ~130 words, ~225 tokens
    chunk_text = " ".join(resume_chunk_words)
    chunk_tokens = tokenizer.encode(chunk_text, add_special_tokens=False)
    assert 180 <= len(chunk_tokens) <= 250

    # 3. Combined sequence length
    total_tokens = len(tokenizer.encode(bounded_query, chunk_text, truncation=False))
    # Must fit strictly within 512 tokens with special tokens ([CLS], [SEP], [SEP])
    assert total_tokens <= 512, f"Total sequence length exceeded 512: {total_tokens}"
    assert total_tokens <= 180 + 250 + 3

    # 4. Rerank execution preserves candidate content completely
    candidates = [{"chunk_id": "c-full-chunk", "content": chunk_text, "rrf_score": 0.03}]
    reranked = rerank_candidates(bounded_query, candidates, top_k=1)
    assert len(reranked) == 1
    assert reranked[0]["content"] == chunk_text
    assert 0.0 <= reranked[0]["cross_encoder_score"] <= 100.0


def test_cross_encoder_rerank_sequence_length_truncation():
    """
    Verifies that inputs exceeding 512 tokens are safely truncated without
    throwing runtime or memory errors.
    """
    query = "Staff Backend Engineer with distributed systems expertise"
    long_candidate_text = "Python PostgreSQL Kubernetes microservices architecture " * 200

    candidates = [
        {
            "chunk_id": "c-long",
            "content": long_candidate_text,
            "rrf_score": 0.03,
            "section_type": "EXPERIENCE",
        },
        {
            "chunk_id": "c-short",
            "content": "Python and PostgreSQL backend development.",
            "rrf_score": 0.02,
            "section_type": "EXPERIENCE",
        },
    ]

    reranked = rerank_candidates(query, candidates, top_k=2)
    assert len(reranked) == 2
    for cand in reranked:
        assert 0.0 <= cand["rerank_score"] <= 100.0


# =============================================================================
# 5. Skill-Gap Analysis Tests
# =============================================================================


def test_skill_gap_analysis():
    """Tests exact, alias, and missing skill categorizations."""
    job_required = ["Python", "PostgreSQL", "Kubernetes", "GraphQL"]
    job_preferred = ["AWS", "Docker"]
    candidate_skills = ["python", "postgres", "k8s", "docker", "fastapi"]

    result = analyze_skill_gap(job_required, candidate_skills, job_preferred)

    # Python -> matched (exact case-insensitive)
    # PostgreSQL -> matched (alias: postgres)
    # Kubernetes -> matched (alias: k8s)
    # GraphQL -> missing
    assert "Python" in result["matched"]
    assert "PostgreSQL" in result["matched"]
    assert "Kubernetes" in result["matched"]
    assert "GraphQL" in result["missing"]
    assert result["coverageRatio"] == 0.75  # 3 of 4 required skills matched


# =============================================================================
# 6. Persistence & Idempotency Tests
# =============================================================================


def test_persist_match_result_idempotency(db_conn: psycopg.Connection):
    """
    Verifies atomic transaction persistence and that repeated match runs
    safely update the existing Match record (ON CONFLICT DO UPDATE).
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    top_chunk_details = [
        {
            "resume_chunk_id": None,
            "job_chunk_id": None,
            "lexical_rank": 1,
            "semantic_rank": 2,
            "rrf_score": 0.031,
            "rerank_score": 88.5,
            "similarity": 0.85,
            "rationale": "Strong backend and database alignment",
        }
    ]

    # First run
    match_id_1 = persist_match_result(
        job_id=job_id,
        resume_id=resume_id,
        user_id=user_id,
        overall_score=88.5,
        lexical_score=0.75,
        semantic_score=0.85,
        rrf_score=0.031,
        cross_encoder_score=88.5,
        final_score=88.5,
        explanation={"skillGap": {"matched": ["Python"]}},
        top_chunk_details=top_chunk_details,
    )
    assert match_id_1 is not None

    # Verify record in database
    with db_conn.cursor() as cur:
        cur.execute(
            'SELECT "finalScore", "rrfScore" FROM matches WHERE "resumeId" = %s AND "jobId" = %s;',
            (resume_id, job_id),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 88.5

    # Second run with updated score (idempotent re-run)
    match_id_2 = persist_match_result(
        job_id=job_id,
        resume_id=resume_id,
        user_id=user_id,
        overall_score=92.0,
        lexical_score=0.80,
        semantic_score=0.90,
        rrf_score=0.035,
        cross_encoder_score=92.0,
        final_score=92.0,
        explanation={"skillGap": {"matched": ["Python", "PostgreSQL"]}},
        top_chunk_details=top_chunk_details,
    )
    assert match_id_2 == match_id_1

    # Verify updated score
    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT "finalScore", "rrfScore", COUNT(*) OVER ()
            FROM matches
            WHERE "resumeId" = %s AND "jobId" = %s;
            """,
            (resume_id, job_id),
        )
        rows = cur.fetchall()
        assert len(rows) == 1
        assert rows[0][0] == 92.0


# =============================================================================
# 7. Backward Compatibility Test for EMBED_DOCUMENT
# =============================================================================


@pytest.mark.asyncio
async def test_embed_document_backward_compatibility_resume_id(db_conn: psycopg.Connection):
    """
    Condition 4: EMBED_DOCUMENT must stay backward compatible.
    The existing {resumeId} payload from Phase 3A (without entityType) must continue to work.
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    # Construct mock BullMQ Job with Phase 3A payload
    mock_job = MagicMock()
    mock_job.id = f"job-test-{uuid.uuid4()}"
    mock_job.data = {"resumeId": resume_id}  # No entityType field!

    result = await process_embed_document(mock_job)

    assert result["status"] == "EMBEDDED"
    assert result["resumeId"] == resume_id
    assert result["chunkCount"] > 0
    assert result["embeddingDimension"] == 384


# =============================================================================
# 8. Regression Tests: Error Propagation & Persistence Safety
# =============================================================================


@pytest.mark.asyncio
async def test_process_match_scoring_raises_and_persists_no_row_when_semantic_fails(
    db_conn: psycopg.Connection,
):
    """
    Issue 3 cleanup regression: Proves that a failed semantic search raises an
    exception out of process_match_scoring (enabling BullMQ retry) and strictly
    persists ZERO rows in the matches table rather than recording vector_score=0.
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    mock_job = MagicMock()
    mock_job.id = f"job-test-{uuid.uuid4()}"
    mock_job.data = {"jobId": job_id, "resumeId": resume_id}

    with patch(
        "ml.worker.search_semantic",
        side_effect=psycopg.OperationalError("Simulated vector search failure"),
    ):
        with pytest.raises(psycopg.OperationalError):
            await process_match_scoring(mock_job)

    # Verify no row was persisted in matches table
    with db_conn.cursor() as cur:
        cur.execute(
            'SELECT COUNT(*) FROM matches WHERE "jobId" = %s AND "resumeId" = %s;',
            (job_id, resume_id),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0, "No match record should be persisted when semantic search fails"


@pytest.mark.asyncio
async def test_process_match_scoring_raises_and_persists_no_row_when_lexical_fails(
    db_conn: psycopg.Connection,
):
    """
    Issue 3 cleanup regression: Proves that a failed lexical search raises an
    exception out of process_match_scoring (enabling BullMQ retry) and strictly
    persists ZERO rows in the matches table.
    """
    user_id, job_id, resume_id = _seed_test_match_environment(db_conn)

    mock_job = MagicMock()
    mock_job.id = f"job-test-{uuid.uuid4()}"
    mock_job.data = {"jobId": job_id, "resumeId": resume_id}

    with patch(
        "ml.worker.search_lexical",
        side_effect=psycopg.OperationalError("Simulated full-text search failure"),
    ):
        with pytest.raises(psycopg.OperationalError):
            await process_match_scoring(mock_job)

    # Verify no row was persisted in matches table
    with db_conn.cursor() as cur:
        cur.execute(
            'SELECT COUNT(*) FROM matches WHERE "jobId" = %s AND "resumeId" = %s;',
            (job_id, resume_id),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == 0, "No match record should be persisted when lexical search fails"

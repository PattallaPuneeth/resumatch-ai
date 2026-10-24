"""
Tests for Phase 3A Section-Aware Chunker (ml/pipelines/embeddings/chunker.py).
"""

from ml.pipelines.embeddings.chunker import (
    TARGET_MAX_TOKENS,
    chunk_resume_text,
    get_tokenizer,
)

REALISTIC_RESUME_TEXT = """John Doe
Senior Software Engineer
San Francisco, CA | john.doe@email.com | (555) 123-4567 | github.com/johndoe

PROFESSIONAL SUMMARY
Results-driven Senior Software Engineer with over 8 years of experience designing and scaling
distributed systems, cloud-native microservices, and high-throughput data processing pipelines.
Proven track record of reducing latency by 45% and mentoring engineering teams across high-growth
technology companies. Passionate about system reliability and clean architectural design.

TECHNICAL SKILLS
- Programming Languages: Python, TypeScript, Go, Java, C++, SQL
- Frameworks & Libraries: Fastify, FastAPI, React, Next.js, Node.js, PyTorch, PyMuPDF
- Databases & Storage: PostgreSQL, Redis, pgvector, MinIO, AWS S3, Cloudflare R2
- DevOps & Tools: Docker, Kubernetes, Terraform, GitHub Actions, Linux, Git
- Distributed Systems: BullMQ, Celery, Kafka, REST APIs, gRPC, Message Queues

WORK EXPERIENCE
Senior Distributed Systems Engineer | Acme Cloud Corp | 2021 - Present
- Architected and implemented an event-driven ingestion pipeline handling over 50,000 requests
  per second using Go, Redis, and PostgreSQL.
- Reduced end-to-end P95 document processing latency from 4.2s to 1.8s through parallelization.
- Led migration of legacy storage service to S3-compatible object storage, saving $180k annually.
- Implemented robust BullMQ queue topology with exponential backoff retries and dead-letter logs.
- Mentored 6 junior engineers through code reviews and pair programming sessions.

Software Engineer | TechStart Solutions | 2018 - 2021
- Developed high-reliability RESTful microservices using Python, FastAPI, and Docker.
- Integrated automated text extraction and OCR fallbacks using PyMuPDF and Tesseract.
- Optimized complex PostgreSQL relational queries and full-text search indexes.
- Designed and maintained CI/CD pipelines using GitHub Actions, ensuring 99.9% build reliability.

EDUCATION
Bachelor of Science in Computer Science
University of California, Berkeley | Graduated May 2018
Relevant Coursework: Distributed Systems, Operating Systems, Algorithms, Databases, ML.

KEY PROJECTS
- Open-Source Distributed Task Scheduler: Lightweight Redis-backed worker library.
- High-Performance Vector Search Engine: Hybrid search engine combining BM25 and pgvector HNSW.
"""


def test_chunker_realistic_resume_offsets_and_sections():
    """Verifies chunking on realistic multi-section resume."""
    tokenizer = get_tokenizer()
    chunks = chunk_resume_text(REALISTIC_RESUME_TEXT, tokenizer=tokenizer)

    assert len(chunks) > 0

    # 1. Verify every chunk's offsets exactly slice the original raw_text
    for chunk in chunks:
        sliced_text = REALISTIC_RESUME_TEXT[chunk.start_char : chunk.end_char]
        assert (
            sliced_text == chunk.content
        ), f"Offset mismatch in chunk {chunk.chunk_index}: '{sliced_text}' != '{chunk.content}'"
        assert chunk.token_count > 0

    # 2. Verify section types identified
    section_types = {c.section_type for c in chunks}
    assert "SUMMARY" in section_types
    assert "SKILLS" in section_types
    assert "EXPERIENCE" in section_types
    assert "EDUCATION" in section_types

    # 3. Verify chunk indices are consecutive and start from 0
    indices = [c.chunk_index for c in chunks]
    assert indices == list(range(len(chunks)))


def test_chunker_empty_and_blank_text():
    """Verifies that empty and blank text return empty chunk lists."""
    assert chunk_resume_text("") == []
    assert chunk_resume_text("   \n\t\r  ") == []


def test_chunker_short_text():
    """Verifies that short text is emitted as a single chunk without data loss."""
    short_text = "Experienced Python developer with expertise in PostgreSQL and Redis."
    chunks = chunk_resume_text(short_text)

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.content == short_text
    assert chunk.start_char == 0
    assert chunk.end_char == len(short_text)
    assert chunk.section_type == "OTHER"


def test_chunker_long_section_token_limits_and_overlap():
    """
    Verifies that a section exceeding 384 tokens is split into multiple chunks
    with ~20% token overlap and exact string slicing.
    """
    # Create a long experience section with ~800 tokens
    long_para = (
        "Engineered scalable microservices using Python, Docker, Fastify, and PostgreSQL. "
        "Spearheaded distributed database performance tuning, query optimization, and pooling. "
        "Constructed automated CI/CD deployment pipelines using GitHub Actions and Kubernetes. "
        "Monitored production infrastructure with Prometheus, Grafana, Pino, and alerting. "
    )
    long_text = "WORK EXPERIENCE\n" + (long_para * 15)

    tokenizer = get_tokenizer()
    chunks = chunk_resume_text(long_text, tokenizer=tokenizer)

    assert len(chunks) > 1

    for chunk in chunks:
        # Check token limits
        assert chunk.token_count <= TARGET_MAX_TOKENS
        # Check exact slice offset guarantee
        assert long_text[chunk.start_char : chunk.end_char] == chunk.content
        assert chunk.section_type == "EXPERIENCE"

    # Verify overlap exists between consecutive chunks
    for i in range(len(chunks) - 1):
        c1 = chunks[i]
        c2 = chunks[i + 1]
        # Since there is token overlap, chunk2 start_char should be less than chunk1 end_char
        assert c2.start_char < c1.end_char, f"Expected overlap between chunk {i} and {i+1}"


def test_chunker_heading_variants():
    """Verifies detection of multiple heading variants."""
    text = (
        "ABOUT ME\nPassionate engineer building tools.\n\n"
        "CAREER HISTORY\nSoftware Engineer at Startup.\n\n"
        "CORE COMPETENCIES\nPython, TypeScript, SQL.\n\n"
        "ACADEMIC BACKGROUND\nB.S. in Computer Science."
    )
    chunks = chunk_resume_text(text)
    types_by_index = {c.chunk_index: c.section_type for c in chunks}

    assert types_by_index[0] == "SUMMARY"
    assert types_by_index[1] == "EXPERIENCE"
    assert types_by_index[2] == "SKILLS"
    assert types_by_index[3] == "EDUCATION"


def test_chunker_repeated_headings():
    """Verifies that repeated headings are handled in document order without crashing."""
    text = (
        "WORK EXPERIENCE\nFirst role as backend engineer.\n\n"
        "WORK EXPERIENCE\nSecond role as platform engineer."
    )
    chunks = chunk_resume_text(text)
    assert len(chunks) == 2
    assert chunks[0].section_type == "EXPERIENCE"
    assert chunks[1].section_type == "EXPERIENCE"
    assert chunks[0].start_char < chunks[1].start_char
    assert text[chunks[0].start_char : chunks[0].end_char] == chunks[0].content
    assert text[chunks[1].start_char : chunks[1].end_char] == chunks[1].content


def test_chunker_unicode_and_special_characters():
    """Verifies correct offset calculation and handling of Unicode characters."""
    text = (
        "PROFILE\nDéveloppeur logiciel senior avec expertise en IA et résumé 🚀.\n\n"
        "COMPÉTENCES\nPython 🐍, TypeScript, C++, €100k budget."
    )
    chunks = chunk_resume_text(text)
    assert len(chunks) >= 1
    for chunk in chunks:
        assert text[chunk.start_char : chunk.end_char] == chunk.content


def test_chunker_prevents_silent_embedding_model_truncation():
    """
    Regression test: Verifies that no chunk exceeds the model's hard input limit (256 tokens).
    SentenceTransformer adds [CLS] and [SEP] (2 special tokens), so content tokens must be <= 254.
    Every chunk must tokenize to <= 256 total tokens without any truncation by the model.
    """
    from sentence_transformers import SentenceTransformer

    embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    assert embedder.max_seq_length == 256

    # Test realistic resume
    realistic_chunks = chunk_resume_text(REALISTIC_RESUME_TEXT)
    for c in realistic_chunks:
        assert c.token_count <= TARGET_MAX_TOKENS
        tokenized = embedder.tokenize([c.content])
        seq_len = tokenized["input_ids"].shape[1]
        msg = f"Chunk {c.chunk_index} exceeded model max sequence length: {seq_len}"
        assert seq_len <= 256, msg

    # Test very long text with ~1500 tokens
    long_para = (
        "Designed and maintained distributed systems with PostgreSQL, Redis, Docker, and K8s. "
        "Built automated CI/CD pipelines, orchestrated microservices, and reduced latency. "
    )
    long_text = "EXPERIENCE\n" + (long_para * 25)
    long_chunks = chunk_resume_text(long_text)
    assert len(long_chunks) > 3

    for c in long_chunks:
        assert c.token_count <= TARGET_MAX_TOKENS
        tokenized = embedder.tokenize([c.content])
        seq_len = tokenized["input_ids"].shape[1]
        assert seq_len <= 256, f"Long chunk {c.chunk_index} exceeded limit: {seq_len}"


def test_chunker_numbered_headings_and_clean_cand():
    """Regression test: Verifies detection of numbered headings, markdown, and punctuation."""
    text = (
        "1. Professional Experience\nSenior engineer at Cloud Corp.\n\n"
        "2) Technical Skills & Technologies:\nPython, TypeScript, PostgreSQL.\n\n"
        "3. Education & Credentials\nB.S. in Computer Science.\n\n"
        "### 4. Certifications & Licenses ###\nAWS Certified Solutions Architect."
    )
    chunks = chunk_resume_text(text)
    assert len(chunks) == 4
    assert chunks[0].section_type == "EXPERIENCE"
    assert chunks[1].section_type == "SKILLS"
    assert chunks[2].section_type == "EDUCATION"
    assert chunks[3].section_type == "OTHER"

    # Verify exact slice offset guarantee on all
    for chunk in chunks:
        assert text[chunk.start_char : chunk.end_char] == chunk.content


def test_chunker_heading_context_retention_via_embedding_text():
    """
    Regression test: Verifies that embedding_text retains heading context for dense embeddings
    without mutating the canonical source slice or violating the exact character offset contract.
    """
    text = "TECHNICAL SKILLS\nPython, Docker, pgvector, Redis, Fastify"
    chunks = chunk_resume_text(text)
    assert len(chunks) == 1
    c = chunks[0]

    # Canonical source slice strictly points to the raw_text slice
    assert text[c.start_char : c.end_char] == c.content
    assert c.content == "Python, Docker, pgvector, Redis, Fastify"
    assert c.heading == "TECHNICAL SKILLS"

    # embedding_text prefixes heading for semantic vector representation
    assert c.embedding_text == "TECHNICAL SKILLS\nPython, Docker, pgvector, Redis, Fastify"


def test_chunker_windows_crlf_line_endings():
    """Regression test: Verifies correct offset calculation with Windows CRLF line endings."""
    crlf_text = (
        "PROFESSIONAL SUMMARY\r\nSenior engineer with distributed systems experience.\r\n\r\n"
        "TECHNICAL SKILLS\r\nPython, PostgreSQL, Redis.\r\n\r\n"
        "WORK EXPERIENCE\r\nLead Architect at Cloud Inc.\r\nBuilt scalable pipelines.\r\n"
    )
    chunks = chunk_resume_text(crlf_text)
    assert len(chunks) == 3
    for c in chunks:
        assert crlf_text[c.start_char : c.end_char] == c.content


def test_chunker_empty_and_whitespace_sections_skipped():
    """Regression test: Empty or whitespace-only sections between headings do not create chunks."""
    text = (
        "PROFESSIONAL SUMMARY\nValid summary here.\n\n"
        "TECHNICAL SKILLS\n   \n\t  \n"  # Empty whitespace section
        "WORK EXPERIENCE\nBuilt distributed systems."
    )
    chunks = chunk_resume_text(text)
    assert len(chunks) == 2
    assert chunks[0].section_type == "SUMMARY"
    assert chunks[1].section_type == "EXPERIENCE"
    # Chunk indices must remain contiguous (0, 1) without gaps
    assert [c.chunk_index for c in chunks] == [0, 1]
    for c in chunks:
        assert text[c.start_char : c.end_char] == c.content


def test_chunker_short_final_chunk_behavior():
    """Regression test: Sections just over TARGET_MAX_TOKENS produce sensible final overlapping chunk."""
    para = "Senior engineer specialized in distributed database architectures and cloud scaling. "
    # ~300 tokens (each sentence is ~12 tokens, 12 * 25 = 300 > TARGET_MAX_TOKENS of 240)
    text = "EXPERIENCE\n" + (para * 25)
    chunks = chunk_resume_text(text)
    assert len(chunks) >= 2
    for c in chunks:
        assert c.token_count <= TARGET_MAX_TOKENS
        assert text[c.start_char : c.end_char] == c.content
    # Overlap between consecutive chunks
    assert chunks[1].start_char < chunks[0].end_char


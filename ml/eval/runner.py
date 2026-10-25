"""
Evaluation Runner for ResuMatch AI (Phase 3C-1).

Executes the real ML pipeline (parsing, chunking, embeddings, lexical, semantic,
RRF, cross-encoder, skill-gap, composite scoring) against an evaluation dataset.
Implements disk-based content-addressed artifact caching (.eval_cache) so re-runs are fast.
Guarantees clean isolation and zero permanent database pollution.
"""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, cast

from ml.eval.ablation import run_ablation_analysis
from ml.eval.calibration import run_calibration_study
from ml.eval.dataset import EvaluationExample, load_and_validate_dataset
from ml.eval.metrics import compute_comprehensive_metrics
from ml.pipelines.embeddings.chunker import chunk_job_text, chunk_resume_text
from ml.pipelines.embeddings.embedder import generate_chunk_embeddings
from ml.pipelines.intake.parser import parse_document
from ml.pipelines.matching.reranker import (
    build_bounded_rerank_query,
    rerank_candidates,
)
from ml.pipelines.matching.rrf import aggregate_resume_rrf, fuse_ranks
from ml.pipelines.matching.scorer import compute_match_scores
from ml.pipelines.matching.skill_gap import analyze_skill_gap

logger = logging.getLogger("resumatch-ml-eval-runner")


def _compute_file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


class EvaluationArtifactCache:
    """Content-addressed disk cache for parsed documents and embeddings."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_parsed_resume(self, sha: str) -> dict[str, Any] | None:
        p = self.cache_dir / f"resume_{sha}.json"
        if p.exists():
            try:
                with open(p, encoding="utf-8") as f:
                    return cast(dict[str, Any], json.load(f))
            except Exception:
                return None
        return None

    def save_parsed_resume(self, sha: str, data: dict[str, Any]) -> None:
        p = self.cache_dir / f"resume_{sha}.json"
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def get_job_data(self, sha: str) -> dict[str, Any] | None:
        p = self.cache_dir / f"job_{sha}.json"
        if p.exists():
            try:
                with open(p, encoding="utf-8") as f:
                    return cast(dict[str, Any], json.load(f))
            except Exception:
                return None
        return None

    def save_job_data(self, sha: str, data: dict[str, Any]) -> None:
        p = self.cache_dir / f"job_{sha}.json"
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)


def _cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    dot = sum(a * b for a, b in zip(vec_a, vec_b, strict=False))
    norm_a = sum(a * a for a in vec_a) ** 0.5
    norm_b = sum(b * b for b in vec_b) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(max(0.0, min(1.0, dot / (norm_a * norm_b))))


def _extract_job_skills_heuristic(text: str) -> list[str]:
    """Extracts candidate skill keywords from raw job description text."""
    known_skills = [
        "python",
        "kubernetes",
        "k8s",
        "docker",
        "postgresql",
        "postgres",
        "react",
        "typescript",
        "javascript",
        "node.js",
        "nodejs",
        "aws",
        "gcp",
        "ci/cd",
        "machine learning",
        "fastapi",
        "redis",
        "graphql",
        "sql",
        "java",
        "go",
    ]
    lower = text.lower()
    found: list[str] = []
    for s in known_skills:
        pattern = rf"(?:^|[\s,;/()\[\]]){re.escape(s)}(?:$|[\s,;/()\[\]])"
        if re.search(pattern, lower):
            found.append(s)
    return found


def process_eval_pair(
    example: EvaluationExample,
    cache: EvaluationArtifactCache,
) -> dict[str, Any]:
    """
    Executes real pipeline stages for a single (resume, job) evaluation pair.
    """
    # 1. Parse / Chunk / Embed Resume (with caching)
    resume_sha = _compute_file_sha256(example.resume_path)
    cached_resume = cache.get_parsed_resume(resume_sha)

    if cached_resume:
        resume_text = cached_resume["text"]
        resume_skills = cached_resume["skills"]
        resume_chunks = cached_resume["chunks"]
    else:
        suffix = example.resume_path.suffix.lower()
        mime_type = (
            "application/pdf"
            if suffix == ".pdf"
            else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        parsed_doc = parse_document(str(example.resume_path), mime_type)
        resume_text = parsed_doc.raw_text
        parsed_skills: list[str] = []
        for s in parsed_doc.skills:
            if hasattr(s, "name"):
                parsed_skills.append(str(s.name))
            else:
                parsed_skills.append(str(s))
        resume_skills = parsed_skills
        chunks = chunk_resume_text(resume_text)
        chunk_pairs = generate_chunk_embeddings(chunks)

        resume_chunks = [
            {
                "chunk_id": f"chunk_{idx}",
                "chunk_index": c.chunk_index,
                "section_type": c.section_type,
                "content": c.content,
                "embedding": vec,
            }
            for idx, (c, vec) in enumerate(chunk_pairs)
        ]

        cache.save_parsed_resume(
            resume_sha,
            {
                "text": resume_text,
                "skills": resume_skills,
                "chunks": resume_chunks,
            },
        )

    # 2. Ingest Job Description (with caching)
    job_sha = _compute_file_sha256(example.job_path)
    cached_job = cache.get_job_data(job_sha)

    if cached_job:
        job_title = cached_job["title"]
        job_desc = cached_job["description"]
        job_skills = cached_job["skills"]
        job_embedding = cached_job["embedding"]
    else:
        with open(example.job_path, encoding="utf-8") as f:
            raw_job_content = f.read().strip()

        lines = [line.strip() for line in raw_job_content.splitlines() if line.strip()]
        job_title = lines[0] if lines else "Software Engineer"
        job_desc = raw_job_content
        job_skills = _extract_job_skills_heuristic(raw_job_content)

        # Generate embedding for full job context
        job_chunks = chunk_job_text(job_desc)
        job_embs = generate_chunk_embeddings(job_chunks) if job_chunks else []
        job_embedding = job_embs[0][1] if job_embs else [0.0] * 384

        cache.save_job_data(
            job_sha,
            {
                "title": job_title,
                "description": job_desc,
                "skills": job_skills,
                "embedding": job_embedding,
            },
        )

    # 3. Dense Semantic Search
    semantic_hits: list[dict[str, Any]] = []
    for c in resume_chunks:
        sim = _cosine_similarity(c["embedding"], job_embedding)
        semantic_hits.append(
            {
                "chunk_id": c["chunk_id"],
                "chunk_index": c["chunk_index"],
                "section_type": c["section_type"],
                "content": c["content"],
                "score": sim,
            }
        )
    semantic_hits.sort(key=lambda x: -x["score"])
    for rank_idx, hit in enumerate(semantic_hits, start=1):
        hit["rank"] = rank_idx

    # 4. Sparse Lexical Search (Word-overlap BM25 approximation over chunk terms)
    job_tokens = set(re.findall(r"\w+", job_desc.lower()))
    lexical_hits: list[dict[str, Any]] = []
    for c in resume_chunks:
        chunk_tokens = re.findall(r"\w+", c["content"].lower())
        overlap = sum(1 for t in chunk_tokens if t in job_tokens)
        bm25_score = overlap / (len(chunk_tokens) + 10.0) if chunk_tokens else 0.0
        lexical_hits.append(
            {
                "chunk_id": c["chunk_id"],
                "chunk_index": c["chunk_index"],
                "section_type": c["section_type"],
                "content": c["content"],
                "score": bm25_score,
            }
        )
    lexical_hits.sort(key=lambda x: -x["score"])
    for rank_idx, hit in enumerate(lexical_hits, start=1):
        hit["rank"] = rank_idx

    # 5. RRF Fusion
    fused_chunks = fuse_ranks(lexical_hits, semantic_hits, k=60)
    rrf_summary = aggregate_resume_rrf(fused_chunks)
    rrf_score = rrf_summary["resume_rrf_score"]

    # 6. Cross-Encoder Reranking
    job_rerank_query = build_bounded_rerank_query(job_title, job_skills, job_desc, max_tokens=180)
    reranked = rerank_candidates(job_rerank_query, fused_chunks, top_n=20)

    # 7. Skill-Gap Analysis
    skill_gap = analyze_skill_gap(job_skills, resume_skills)

    # 8. Score Aggregation
    scores = compute_match_scores(
        lexical_hits=lexical_hits,
        semantic_hits=semantic_hits,
        reranked_chunks=reranked,
        skill_gap=skill_gap,
    )

    return {
        "resume": example.resume_name,
        "job": example.job_name,
        "expected": example.expected,
        "reason": example.reason,
        "lexical_score": scores["best_bm25"],
        "semantic_score": scores["best_vector"],
        "rrf_score": rrf_score,
        "cross_encoder_logit": scores["best_ce_logit"],
        "calibrated_ce_score": scores["best_ce_score"],
        "skill_coverage": scores["skill_coverage"],
        "final_score": scores["final_score"],
    }


def run_evaluation_suite(
    dataset_dir: str | Path,
    output_dir: str | Path | None = None,
    cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    """
    Main evaluation workflow:
    1. Loads and validates dataset.
    2. Runs each pair through real pipeline with caching.
    3. Computes comprehensive metrics, ablation study, and calibration study.
    4. Writes machine-readable JSON/CSV and Markdown report.
    """
    examples = load_and_validate_dataset(dataset_dir)
    root = Path(dataset_dir)

    c_dir = Path(cache_dir) if cache_dir else root / ".eval_cache"
    cache = EvaluationArtifactCache(c_dir)

    evaluated_pairs: list[dict[str, Any]] = []
    for ex in examples:
        logger.info("Evaluating pair: %s <-> %s", ex.resume_name, ex.job_name)
        res = process_eval_pair(ex, cache)
        evaluated_pairs.append(res)

    # Compute overall benchmark metrics
    metrics = compute_comprehensive_metrics(evaluated_pairs, score_key="final_score")
    ablation_data = run_ablation_analysis(evaluated_pairs)
    calibration_data = run_calibration_study(evaluated_pairs, seed=42)

    # Build Markdown Report
    md_report_sections = [
        "# ResuMatch AI — Evaluation Harness Report",
        "",
        "> **Dataset Type:** Synthetic Benchmark",
        f"> **Total Evaluated Pairs:** {len(evaluated_pairs)}",
        "",
        "## 1. Benchmark Summary (Production Configuration)",
        "",
        f"- **Pairwise Ordering Accuracy:** {metrics['pairwise_ordering_accuracy'] * 100:.1f}%",
        f"- **Label Classification Accuracy:** {metrics['label_accuracy'] * 100:.1f}%",
        f"- **Mean Score (Strong):** {metrics['mean_scores'].get('strong', 0.0):.1f}",
        f"- **Mean Score (Medium):** {metrics['mean_scores'].get('medium', 0.0):.1f}",
        f"- **Mean Score (Weak):** {metrics['mean_scores'].get('weak', 0.0):.1f}",
        f"- **Strong-to-Medium Margin:** "
        f"{metrics['label_gaps'].get('strong_to_medium', 0.0):+.1f} pts",
        f"- **Medium-to-Weak Margin:** {metrics['label_gaps'].get('medium_to_weak', 0.0):+.1f} pts",
        "",
        "## 2. Component Ablation Study",
        "",
        ablation_data["markdown_table"],
        "",
        "**Key Observations:**",
        "\n".join(ablation_data["observations"])
        if ablation_data["observations"]
        else "- All pipeline components contribute positively to ranking separation.",
        "",
        "## 3. Score Calibration Analysis",
        "",
        calibration_data["markdown_report"],
        "",
        "## 4. Evaluated Pairs Detail",
        "",
        (
            "| Resume | Job | Expected | Final Score | CE Logit | "
            "CE Calibrated | Skill Cov | Vector Sim |"
        ),
        "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for p in evaluated_pairs:
        ce_l = f"{p['cross_encoder_logit']:.2f}"
        ce_c = f"{p['calibrated_ce_score']:.1f}"
        sk_c = f"{p['skill_coverage']*100:.0f}%"
        sem_s = f"{p['semantic_score']*100:.1f}%"
        md_report_sections.append(
            f"| `{p['resume']}` | `{p['job']}` | **{p['expected'].upper()}** | "
            f"**{p['final_score']:.1f}** | {ce_l} | {ce_c} | {sk_c} | {sem_s} |"
        )

    full_markdown = "\n".join(md_report_sections)

    # Save outputs if output_dir specified
    if output_dir:
        out_path = Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)

        # JSON
        with open(out_path / "results.json", "w", encoding="utf-8") as f:
            json.dump(
                {
                    "evaluated_pairs": evaluated_pairs,
                    "metrics": metrics,
                    "ablation": ablation_data["results"],
                    "calibration": {
                        "train_count": calibration_data["train_count"],
                        "heldout_count": calibration_data["heldout_count"],
                        "fitted_params": calibration_data["fitted_params"],
                        "baseline_metrics": calibration_data["baseline_metrics"],
                        "calibrated_metrics": calibration_data["calibrated_metrics"],
                    },
                },
                f,
                indent=2,
            )

        # CSV
        with open(out_path / "results.csv", "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "resume",
                    "job",
                    "expected",
                    "final_score",
                    "cross_encoder_logit",
                    "calibrated_ce_score",
                    "skill_coverage",
                    "semantic_score",
                    "lexical_score",
                    "rrf_score",
                    "reason",
                ],
            )
            writer.writeheader()
            for p in evaluated_pairs:
                writer.writerow(p)

        # Markdown
        with open(out_path / "report.md", "w", encoding="utf-8") as f:
            f.write(full_markdown)

    return {
        "evaluated_pairs": evaluated_pairs,
        "metrics": metrics,
        "ablation": ablation_data,
        "calibration": calibration_data,
        "markdown_report": full_markdown,
    }

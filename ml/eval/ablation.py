"""
Ablation Analysis for ResuMatch AI (Phase 3C-1).

Evaluates 6 retrieval and scoring configurations:
1. Lexical only (BM25 sparse search)
2. Semantic only (dense pgvector cosine similarity)
3. RRF only (Reciprocal Rank Fusion)
4. RRF + Cross-Encoder (neural reranking on fused candidates)
5. RRF + Cross-Encoder + Skill-Gap (reranking + structured skill coverage)
6. Full Blend (production 0.65 CE + 0.25 Skill + 0.10 Vector)

Outputs Markdown ablation table, observations, and structured results.
Always labels the dataset as 'synthetic'.
"""

from __future__ import annotations

from typing import Any

from ml.eval.metrics import compute_comprehensive_metrics

ABLATION_CONFIGS = [
    ("lexical_only", "Lexical Only (BM25)"),
    ("semantic_only", "Semantic Only (Dense Cosine)"),
    ("rrf_only", "RRF Only (Rank Fusion)"),
    ("rrf_cross_encoder", "RRF + Cross-Encoder"),
    ("plus_skill_gap", "RRF + Cross-Encoder + Skill-Gap"),
    ("full_blend", "Full Blend (Production)"),
]


def extract_ablation_score(example: dict[str, Any], config_name: str) -> float:
    """Computes normalized 0-100 score for a specific ablation stage."""
    best_bm25 = float(example.get("lexical_score", 0.0))
    best_vector = float(example.get("semantic_score", 0.0))
    rrf_score = float(example.get("rrf_score", 0.0))
    ce_score = float(example.get("calibrated_ce_score", 0.0))
    coverage = float(example.get("skill_coverage", 1.0))

    if config_name == "lexical_only":
        # ts_rank_cd typically in [0.0, 1.5+]; normalize to 0-100
        return round(min(100.0, max(0.0, best_bm25 * 60.0)), 2)

    elif config_name == "semantic_only":
        # Cosine similarity in [0.0, 1.0]; scale to 0-100
        return round(min(100.0, max(0.0, best_vector * 100.0)), 2)

    elif config_name == "rrf_only":
        # RRF scores typically in [0.01, 0.04]; scale to 0-100
        return round(min(100.0, max(0.0, rrf_score * 2500.0)), 2)

    elif config_name == "rrf_cross_encoder":
        return round(ce_score, 2)

    elif config_name == "plus_skill_gap":
        return round(0.70 * ce_score + 0.30 * (coverage * 100.0), 2)

    elif config_name == "full_blend":
        return round(
            0.65 * ce_score + 0.25 * (coverage * 100.0) + 0.10 * max(0.0, best_vector * 100.0),
            2,
        )

    raise ValueError(f"Unknown ablation configuration: {config_name}")


def run_ablation_analysis(
    evaluated_pairs: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Computes comparative ablation metrics across all 6 configurations.

    Args:
        evaluated_pairs: List of dicts with lexical_score, semantic_score, rrf_score,
                         calibrated_ce_score, skill_coverage, expected.

    Returns:
        Dict with 'configs': list of per-config metrics, 'markdown_table': str,
        and 'observations': list of strings.
    """
    results: list[dict[str, Any]] = []

    for key, display_name in ABLATION_CONFIGS:
        # Augment copies with the stage-specific score
        stage_examples: list[dict[str, Any]] = []
        for pair in evaluated_pairs:
            item = dict(pair)
            item["stage_score"] = extract_ablation_score(pair, key)
            stage_examples.append(item)

        metrics = compute_comprehensive_metrics(stage_examples, score_key="stage_score")
        results.append(
            {
                "config_key": key,
                "display_name": display_name,
                "metrics": metrics,
            }
        )

    # Generate Markdown Table
    md_lines: list[str] = [
        "### Ablation Study (Synthetic Evaluation Dataset)",
        "",
        (
            "> **Note:** All figures in this table are computed against a "
            "synthetic evaluation benchmark."
        ),
        "",
        (
            "| Pipeline Configuration | Ordering Acc | Label Acc | Mean (Strong) | "
            "Mean (Medium) | Mean (Weak) | Strong-Medium Gap | Medium-Weak Gap |"
        ),
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for item in results:
        name = item["display_name"]
        m = item["metrics"]
        ordering = f"{m['pairwise_ordering_accuracy'] * 100:.1f}%"
        label_acc = f"{m['label_accuracy'] * 100:.1f}%"
        m_strong = f"{m['mean_scores'].get('strong', 0.0):.1f}"
        m_med = f"{m['mean_scores'].get('medium', 0.0):.1f}"
        m_weak = f"{m['mean_scores'].get('weak', 0.0):.1f}"
        g_sm = f"{m['label_gaps'].get('strong_to_medium', 0.0):+.1f}"
        g_mw = f"{m['label_gaps'].get('medium_to_weak', 0.0):+.1f}"

        md_lines.append(
            f"| **{name}** | {ordering} | {label_acc} | {m_strong} | {m_med} | "
            f"{m_weak} | {g_sm} | {g_mw} |"
        )

    # Observations on marginal value of each stage
    observations: list[str] = []
    if len(results) >= 2:
        lex_ord = results[0]["metrics"]["pairwise_ordering_accuracy"]
        sem_ord = results[1]["metrics"]["pairwise_ordering_accuracy"]
        ce_ord = results[3]["metrics"]["pairwise_ordering_accuracy"]
        full_ord = results[5]["metrics"]["pairwise_ordering_accuracy"]

        if sem_ord > lex_ord:
            observations.append(
                "- Dense semantic search outperforms sparse lexical search alone "
                f"(Ordering: {sem_ord*100:.1f}% vs {lex_ord*100:.1f}%)."
            )
        elif sem_ord == lex_ord:
            observations.append(
                "- Dense semantic search and sparse lexical search provide equivalent "
                "pairwise ordering on this dataset."
            )

        if ce_ord >= sem_ord:
            observations.append(
                "- Cross-encoder reranking yields strong discrimination with "
                f"{ce_ord*100:.1f}% pairwise ordering accuracy."
            )

        gap_sm_full = results[5]["metrics"]["label_gaps"].get("strong_to_medium", 0.0)
        gap_sm_ce = results[3]["metrics"]["label_gaps"].get("strong_to_medium", 0.0)
        if gap_sm_full < gap_sm_ce:
            observations.append(
                "- Note: Skill-gap and vector blending slightly compresses the "
                f"Strong-to-Medium margin ({gap_sm_full:+.1f} vs {gap_sm_ce:+.1f} in pure CE), "
                "highlighting the need for recalibration in Phase 3C-2."
            )
        else:
            observations.append(
                "- Full blend provides robust separation across all tiers with "
                f"{full_ord*100:.1f}% pairwise accuracy."
            )

    return {
        "results": results,
        "markdown_table": "\n".join(md_lines),
        "observations": observations,
    }

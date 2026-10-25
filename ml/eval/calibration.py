"""
Score Calibration Optimizer for ResuMatch AI (Phase 3C-1).

Splits dataset deterministically into train and held-out evaluation splits.
Fits shift, temperature, and blend weights on the train split to optimize label separation,
and reports performance on the held-out split.

STRICT RULE: Does NOT change production defaults in Phase 3C-1.
"""

from __future__ import annotations

import random
from typing import Any

from ml.eval.metrics import compute_comprehensive_metrics
from ml.pipelines.matching.scorer import (
    DEFAULT_SHIFT,
    DEFAULT_TEMP,
    DEFAULT_W_CE,
    DEFAULT_W_SKILL,
    DEFAULT_W_VEC,
    calibrate_ce_logit,
)


def deterministic_train_heldout_split(
    examples: list[dict[str, Any]],
    train_ratio: float = 0.60,
    seed: int = 42,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    Splits examples deterministically into train and held-out subsets.
    Uses stratified grouping by expected label where possible.
    """
    if len(examples) < 2:
        return list(examples), list(examples)

    rng = random.Random(seed)

    # Group by label for stratified split
    by_label: dict[str, list[dict[str, Any]]] = {}
    for ex in examples:
        lbl = ex.get("expected", "weak").lower()
        by_label.setdefault(lbl, []).append(ex)

    train_set: list[dict[str, Any]] = []
    heldout_set: list[dict[str, Any]] = []

    for _, group in sorted(by_label.items()):
        shuffled = list(group)
        rng.shuffle(shuffled)
        k = max(1, int(round(len(shuffled) * train_ratio)))
        # Ensure at least 1 in heldout if group has >= 2 items
        if len(shuffled) >= 2 and k == len(shuffled):
            k = len(shuffled) - 1
        train_set.extend(shuffled[:k])
        heldout_set.extend(shuffled[k:])

    # Fallback if heldout is empty due to small dataset
    if not heldout_set:
        heldout_set = train_set[-1:]
        train_set = train_set[:-1] or train_set

    return train_set, heldout_set


def score_with_params(
    example: dict[str, Any],
    shift: float,
    temp: float,
    w_ce: float,
    w_skill: float,
    w_vec: float,
) -> float:
    """Computes final score using explicit calibration parameters."""
    logit = float(example.get("cross_encoder_logit", 0.0))
    coverage = float(example.get("skill_coverage", 1.0))
    best_vector = float(example.get("semantic_score", 0.0))

    ce_score = calibrate_ce_logit(logit, shift=shift, temp=temp)
    raw_final = (
        w_ce * ce_score + w_skill * (coverage * 100.0) + w_vec * max(0.0, best_vector * 100.0)
    )
    return round(max(0.0, min(100.0, raw_final)), 2)


def fit_calibration_on_train(
    train_examples: list[dict[str, Any]],
) -> dict[str, float]:
    """
    Performs grid search on train split to optimize separation margins
    and pairwise ordering accuracy.
    """
    if not train_examples:
        return {
            "shift": DEFAULT_SHIFT,
            "temp": DEFAULT_TEMP,
            "w_ce": DEFAULT_W_CE,
            "w_skill": DEFAULT_W_SKILL,
            "w_vec": DEFAULT_W_VEC,
        }

    candidate_shifts = [-5.0, -4.5, -4.0, -3.5, -3.0, -2.5, -2.0]
    candidate_temps = [1.8, 2.2, 2.8, 3.2, 3.8]
    candidate_weights = [
        (0.65, 0.25, 0.10),
        (0.70, 0.20, 0.10),
        (0.60, 0.30, 0.10),
    ]

    best_score = -9999.0
    best_params = {
        "shift": DEFAULT_SHIFT,
        "temp": DEFAULT_TEMP,
        "w_ce": DEFAULT_W_CE,
        "w_skill": DEFAULT_W_SKILL,
        "w_vec": DEFAULT_W_VEC,
    }

    for shift in candidate_shifts:
        for temp in candidate_temps:
            for w_ce, w_skill, w_vec in candidate_weights:
                scored = []
                for ex in train_examples:
                    item = dict(ex)
                    item["eval_score"] = score_with_params(ex, shift, temp, w_ce, w_skill, w_vec)
                    scored.append(item)

                m = compute_comprehensive_metrics(scored, score_key="eval_score")
                ord_acc = m["pairwise_ordering_accuracy"]
                gaps = m["label_gaps"]
                # Objective: heavily prioritize ordering, then reward balanced gap separation
                sep_reward = gaps["strong_to_medium"] + gaps["medium_to_weak"]
                composite_fitness = (ord_acc * 100.0) + (sep_reward * 0.5)

                if composite_fitness > best_score:
                    best_score = composite_fitness
                    best_params = {
                        "shift": shift,
                        "temp": temp,
                        "w_ce": w_ce,
                        "w_skill": w_skill,
                        "w_vec": w_vec,
                    }

    return best_params


def run_calibration_study(
    examples: list[dict[str, Any]],
    train_ratio: float = 0.60,
    seed: int = 42,
) -> dict[str, Any]:
    """
    Runs full calibration study:
    1. Splits examples deterministically.
    2. Fits parameters on train split.
    3. Compares baseline vs calibrated on held-out split.
    """
    train_set, heldout_set = deterministic_train_heldout_split(
        examples, train_ratio=train_ratio, seed=seed
    )

    fitted_params = fit_calibration_on_train(train_set)

    # 1. Baseline on held-out split
    baseline_heldout = []
    for ex in heldout_set:
        item = dict(ex)
        item["score"] = score_with_params(
            ex,
            shift=DEFAULT_SHIFT,
            temp=DEFAULT_TEMP,
            w_ce=DEFAULT_W_CE,
            w_skill=DEFAULT_W_SKILL,
            w_vec=DEFAULT_W_VEC,
        )
        baseline_heldout.append(item)
    baseline_metrics = compute_comprehensive_metrics(baseline_heldout, score_key="score")

    # 2. Calibrated on held-out split
    calibrated_heldout = []
    for ex in heldout_set:
        item = dict(ex)
        item["score"] = score_with_params(
            ex,
            shift=fitted_params["shift"],
            temp=fitted_params["temp"],
            w_ce=fitted_params["w_ce"],
            w_skill=fitted_params["w_skill"],
            w_vec=fitted_params["w_vec"],
        )
        calibrated_heldout.append(item)
    calibrated_metrics = compute_comprehensive_metrics(calibrated_heldout, score_key="score")

    base_ord = baseline_metrics["pairwise_ordering_accuracy"] * 100
    cal_ord = calibrated_metrics["pairwise_ordering_accuracy"] * 100
    ord_delta = cal_ord - base_ord

    base_sm = baseline_metrics["label_gaps"]["strong_to_medium"]
    cal_sm = calibrated_metrics["label_gaps"]["strong_to_medium"]
    sm_delta = cal_sm - base_sm

    base_mw = baseline_metrics["label_gaps"]["medium_to_weak"]
    cal_mw = calibrated_metrics["label_gaps"]["medium_to_weak"]
    mw_delta = cal_mw - base_mw

    base_s_mean = baseline_metrics["mean_scores"].get("strong", 0.0)
    cal_s_mean = calibrated_metrics["mean_scores"].get("strong", 0.0)

    base_m_mean = baseline_metrics["mean_scores"].get("medium", 0.0)
    cal_m_mean = calibrated_metrics["mean_scores"].get("medium", 0.0)

    base_w_mean = baseline_metrics["mean_scores"].get("weak", 0.0)
    cal_w_mean = calibrated_metrics["mean_scores"].get("weak", 0.0)

    b_weights = f"{DEFAULT_W_CE}/{DEFAULT_W_SKILL}/{DEFAULT_W_VEC}"
    f_weights = f"{fitted_params['w_ce']}/{fitted_params['w_skill']}/{fitted_params['w_vec']}"

    md_report = [
        "### Score Calibration Analysis (Held-Out Benchmark Split)",
        "",
        (
            "> **Note:** Conducted on synthetic benchmark pairs. "
            "Production defaults remain unchanged in Phase 3C-1."
        ),
        "",
        (
            f"- **Train Pairs:** {len(train_set)} | "
            f"**Held-Out Pairs:** {len(heldout_set)} (Seed: {seed})"
        ),
        (
            f"- **Baseline Parameters:** shift={DEFAULT_SHIFT}, "
            f"temp={DEFAULT_TEMP}, weights=({b_weights})"
        ),
        (
            f"- **Fitted Parameters:** shift={fitted_params['shift']}, "
            f"temp={fitted_params['temp']}, weights=({f_weights})"
        ),
        "",
        (
            "| Metric | Baseline (Production Defaults) | "
            "Fitted Candidate (Held-Out) | Margin Delta |"
        ),
        "| :--- | :---: | :---: | :---: |",
        f"| **Pairwise Ordering Acc** | {base_ord:.1f}% | {cal_ord:.1f}% | {ord_delta:+.1f}% |",
        (
            f"| **Strong-to-Medium Gap** | {base_sm:+.1f} pts | "
            f"{cal_sm:+.1f} pts | {sm_delta:+.1f} pts |"
        ),
        (
            f"| **Medium-to-Weak Gap** | {base_mw:+.1f} pts | "
            f"{cal_mw:+.1f} pts | {mw_delta:+.1f} pts |"
        ),
        f"| **Mean Score (Strong)** | {base_s_mean:.1f} | {cal_s_mean:.1f} | - |",
        f"| **Mean Score (Medium)** | {base_m_mean:.1f} | {cal_m_mean:.1f} | - |",
        f"| **Mean Score (Weak)** | {base_w_mean:.1f} | {cal_w_mean:.1f} | - |",
    ]

    return {
        "train_count": len(train_set),
        "heldout_count": len(heldout_set),
        "fitted_params": fitted_params,
        "baseline_metrics": baseline_metrics,
        "calibrated_metrics": calibrated_metrics,
        "markdown_report": "\n".join(md_report),
    }

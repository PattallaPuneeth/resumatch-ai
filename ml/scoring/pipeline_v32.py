"""Unified Item 1 + 2 pipeline, v3.2 (docs/SCORING_V32_DESIGN.md).

Deterministic mathematical layer combining:
1. Seniority ladder & interval union penalty with hard caps (roles.py)
2. Context multipliers, list-only caps, generic caps & thin-job shrinkage (units.py)
3. Hard credential & degree gates with OCR safety (gates.py)
4. Monotone isotonic calibration curve (curve.py)
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import date
from fractions import Fraction as F
from functools import lru_cache
from pathlib import Path
from typing import Any

from ml.scoring import curve as curve_mod
from ml.scoring import gates as gates_mod
from ml.scoring import roles as roles_mod
from ml.scoring import units as U
from ml.scoring.item1_assessment import _PUBLIC_SECTOR
from ml.scoring.item1_years import assess_years
from ml.scoring.pipeline import _alias_regex, _education_hits, _registry

VERSION = "unified-3.2"
DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def _hash_file(p: Path) -> str:
    if p.exists():
        return hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    return "missing"


def unsupported_fraction(text: str) -> float:
    """Share of letters outside the Latin script."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    other = sum(1 for c in letters if not unicodedata.name(c, "").startswith("LATIN"))
    return other / len(letters)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_#]+", " ", text)).strip(" -:")


def _is_gate_line(text: str) -> bool:
    """Degree and licence lines are scored as gates, so they are not duplicate skill units."""
    if _education_hits(text):
        return True
    return any(
        _alias_regex(a["text"], len(a["text"]) <= 3).search(text)
        for entry in _registry()
        for a in entry["aliases"]
    )


def band_for(score: int) -> str:
    if score >= 75:
        return "Good Fit"
    if score >= 45:
        return "Potential Fit"
    return "No Fit"


@lru_cache(maxsize=1)
def _curve() -> curve_mod.Curve:
    return curve_mod.load()


def assess_pair(
    resume_text: str,
    jd_text: str,
    *,
    as_of: date | None = None,
    parse_failed: bool = False,
    curve: curve_mod.Curve | None = None,
    matcher: Any = None,
) -> dict[str, Any]:
    """Score a resume-job pair using the v3.2 deterministic scoring engine."""
    as_of = as_of or date.today()
    resume_text, jd_text = resume_text or "", jd_text or ""
    idf = U.load_idf()
    curve = curve or _curve()

    # 1. Segment JD into units
    seg = U.segment(jd_text, idf)
    index = U.index_resume(resume_text)
    skill_lines = tuple(u for u in seg.units if not _is_gate_line(u.text))
    results = U.score_units(skill_lines, index, idf)

    # Optional meaning matching hook
    extraction, matcher_note = "deterministic", None
    if matcher is not None and results:
        try:
            from ml.scoring import llm_match
            unmet = tuple(r.unit for r in results if r.credit < llm_match.UNMET_BELOW)
            found = matcher(unmet, index)
            if found:
                results = llm_match.apply_matches(results, found)
                extraction = "deterministic+llm-match"
        except Exception as exc:
            matcher_note = type(exc).__name__

    # 2. Build RequirementUnit representations with generic terms check
    generic_terms, idf_thresh, max_generic_frac = U.load_generic_terms()
    req_units: list[U.RequirementUnit] = []
    unit_res_map: dict[str, U.UnitResult] = {}
    for r in results:
        unit_res_map[r.unit.id] = r
        u_text_low = r.unit.text.lower()
        is_gen = (
            r.unit.mass < idf_thresh
            or any(gt in u_text_low for gt in generic_terms)
        )
        base_w = float(U.CUE_WEIGHT[r.unit.cue]) * float(r.unit.mass)
        req_units.append(
            U.RequirementUnit(
                uid=r.unit.id,
                text=r.unit.text,
                span=(r.unit.start, r.unit.end),
                idf=float(r.unit.mass),
                is_generic=is_gen,
                weight=base_w,
            )
        )

    # 3. Apply Generic Mass Cap (max 15%)
    capped_units = U.apply_generic_cap(req_units, max_frac=max_generic_frac)

    # 4. Evidence matching with Context Multipliers
    ctx_cfg = U.load_context_cfg()
    ev_dict: dict[str, U.Evidence] = {}
    for u in capped_units:
        r = unit_res_map.get(u.uid)
        if not r or not r.hits:
            continue
        cands: list[U.RerankedPassage] = []
        for h in r.hits:
            cands.append(
                U.RerankedPassage(
                    passage_id=f"{h.term}:{h.start}",
                    text=h.quote,
                    section=h.context,
                    rho=float(r.credit),
                    span=(h.start, h.end),
                )
            )
        best_ev = U.unit_evidence(u, cands, ctx_cfg)
        if best_ev is not None:
            ev_dict[u.uid] = best_ev

    # 5. Coverage and mass
    raw_coverage, total_mass = U.coverage_v32(capped_units, ev_dict)

    # 6. Thin-job shrinkage toward domain prior
    prior_path = DATA_DIR / "domain_prior_v1.json"
    k_shrink = 6.0
    c_prior = 0.50
    if prior_path.exists():
        try:
            pd = json.loads(prior_path.read_text(encoding="utf-8"))
            k_shrink = float(pd.get("k", 6.0))
        except Exception:
            pass

    shrunk_coverage = U.shrink(raw_coverage, total_mass, c_prior, k=k_shrink)

    # 7. Seniority Assessment & Multiplier
    sen_res = roles_mod.assess_seniority(jd_text, index.text, today=as_of)
    final_coverage = round(shrunk_coverage * sen_res.multiplier, 4)

    # 8. Monotone Calibration Curve
    # Curve input is Fraction or float in [0, 1]
    raw_score = round(float(curve(F(str(min(1.0, max(0.0, final_coverage)))))) * 100)

    # 9. Hard Gates Assessment
    cred_registry = gates_mod.CredentialRegistry.load()
    gate_results = gates_mod.evaluate_gates(
        jd_text=jd_text,
        resume_sections=index.text,
        registry=cred_registry,
        parse_ok=not parse_failed,
    )
    extra_caps = [sen_res.cap] if sen_res.cap is not None else []
    cap_outcome = gates_mod.effective_cap(gate_results, extra_caps)

    final_score = raw_score
    capped_by: list[str] = []
    hard_gate_failed = any(g.status == "FAIL" and g.action == "cap" for g in gate_results)

    if cap_outcome is not None:
        active_cap, reasons = cap_outcome
        if active_cap < final_score:
            final_score = active_cap
            capped_by = reasons
        elif hard_gate_failed or sen_res.cap is not None:
            # Record that the candidate is subject to hard cap ceiling
            capped_by = reasons

    # 10. Thin-JD Safeguard
    thin_jd_triggered = False
    if len(capped_units) < 4:
        # Forbid No Fit unless a hard gate failed or seniority delta >= 3.0
        if final_score < 45 and not hard_gate_failed and not (sen_res.delta and sen_res.delta >= 3.0):
            final_score = 45
            thin_jd_triggered = True

    # 11. Final Band & Confidence
    final_band = band_for(final_score)
    confidence = "high"
    if len(capped_units) < 4 or thin_jd_triggered:
        confidence = "low"
    elif not curve.fitted or parse_failed or sen_res.delta is None:
        confidence = "medium"

    # Years & Tier assessment for Item 1/2 contract compatibility
    spans = U.skill_like_spans(results, index)
    years_res = assess_years(index.text, jd_text, spans, as_of=as_of)

    public = _PUBLIC_SECTOR.search(jd_text)
    resume_unsupported = unsupported_fraction(resume_text)
    jd_unsupported = unsupported_fraction(jd_text)
    worst_unsupported = max(resume_unsupported, jd_unsupported)

    tier = "Firm"
    if bool(public):
        tier = "Comparison only"
        final_band = None
        final_score = None
    elif parse_failed or worst_unsupported >= 0.5 or len(capped_units) == 0:
        tier = "Abstain"
        final_band = None
        final_score = None
    elif not curve.fitted or confidence == "low":
        tier = "Tentative"

    # Version Hashes for Bit-Identical Auditability
    versions = {
        "engine": VERSION,
        "scoring_version": "3.2.0",
        "curve_hash": _hash_file(DATA_DIR / "coverage_curve_v1.json"),
        "idf_hash": _hash_file(DATA_DIR / "jd_idf_v1.json"),
        "registry_hash": _hash_file(DATA_DIR / "credential_registry_v1.json"),
        "seniority_params_hash": _hash_file(DATA_DIR / "seniority_params_v1.json"),
        "context_weights_hash": _hash_file(DATA_DIR / "context_weights_v1.json"),
    }

    # Format unit rows and gaps
    unit_rows = []
    for u in capped_units:
        r = unit_res_map.get(u.uid)
        best = max(r.hits, key=lambda h: (h.mult, -h.start), default=None) if r else None
        ev = ev_dict.get(u.uid)
        credit_val = round(ev.value, 3) if ev else 0.0
        st = "Met" if credit_val >= 0.70 else "Partial" if credit_val > 0.0 else "Not evidenced"
        unit_rows.append({
            "id": u.uid,
            "skill": u.text[:140],
            "cue": r.unit.cue if r else "Required",
            "weight": round(u.weight, 4),
            "credit": credit_val,
            "status": st,
            "evidence": best.quote if best else None,
            "start": best.start if best else None,
            "end": best.end if best else None,
            "context": best.context if best else None,
            "is_generic": u.is_generic,
            "matched_terms": sorted({h.term.replace("_", " ") for h in r.hits})[:12] if r else [],
            "missing_terms": sorted((t.replace("_", " ") for t in r.missing if " " not in t), key=lambda t: -idf.idf(t.replace(" ", "_")))[:12] if r else [],
        })

    # Format Gaps & Actionable Tips
    gaps: list[dict[str, Any]] = []
    if sen_res.feedback and "SENIORITY_GAP" in sen_res.reason_codes:
        gaps.append({
            "requirement": "Seniority and Experience Level",
            "kind": "seniority",
            "points_if_closed": 0.0,
            "tip": sen_res.feedback,
        })

    for gr in gate_results:
        if gr.status == "FAIL":
            gaps.append({
                "requirement": gr.label,
                "kind": "credential",
                "points_if_closed": 10.0 if gr.action == "cap" else 0.0,
                "tip": gr.reason_text,
            })

    for u in unit_rows:
        if u["status"] != "Met" and u["missing_terms"]:
            gaps.append({
                "requirement": u["skill"],
                "kind": "skill",
                "points_if_closed": round(u["weight"] * (1.0 - u["credit"]), 1),
                "tip": f"The job asks for: \"{u['skill']}\". If you have this experience, demonstrate it in an action bullet.",
            })

    gaps.sort(key=lambda g: -g["points_if_closed"])
    gaps = gaps[:12]

    # Role fit integration
    fit = roles_mod.role_fit(jd_text, index.text, as_of)

    limitations = [
        "Scores are computed deterministically using the v3.2 scoring architecture.",
        "Verified character spans ground all matched evidence; unevidenced terms receive zero credit.",
    ]
    if not curve.fitted:
        limitations.append("The coverage curve is currently an unfitted placeholder.")
    if thin_jd_triggered:
        limitations.append("The job posting lists very few requirement units; thin-job fairness rules applied.")
    if capped_by:
        limitations.append(f"Score was hard-capped by: {', '.join(capped_by)}.")

    return {
        "engine": VERSION,
        "score": final_score,
        "raw_score": raw_score,
        "band": final_band,
        "verdict": final_band,
        "tier": tier,
        "confidence": confidence,
        "coverage": {
            "raw": raw_coverage,
            "shrunk": shrunk_coverage,
            "final": final_coverage,
            "mass": total_mass,
        },
        "seniority": {
            "jd_level": sen_res.jd.level,
            "resume_level": sen_res.resume.level,
            "delta": sen_res.delta,
            "multiplier": sen_res.multiplier,
            "cap": sen_res.cap,
            "reason_codes": sen_res.reason_codes,
            "feedback": sen_res.feedback,
        },
        "gates": [
            {
                "id": g.entry_id,
                "label": g.label,
                "kind": g.kind,
                "status": g.status,
                "action": g.action,
                "cap": g.cap,
                "reason": g.reason_text,
            }
            for g in gate_results
        ],
        "years": {
            "required": None if years_res.required_years is None else str(years_res.required_years),
            "candidate": None if years_res.candidate_years is None else str(years_res.candidate_years),
            "low": None if years_res.low_years is None else str(years_res.low_years),
            "high": None if years_res.high_years is None else str(years_res.high_years),
            "source": years_res.source,
            "flags": list(years_res.flags),
        },
        "capped_by": capped_by,
        "units": unit_rows,
        "skill_units": unit_rows,
        "gaps": gaps,
        "role_fit": fit,
        "limitations": limitations,
        "versions": versions,
    }

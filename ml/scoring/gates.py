"""Education and credential gate evaluation (rules: docs/ITEM12_UNIFIED_RULES.md section 6).

Pure functions. Silence is never failure: nothing stated -> `Unknown`. `Not met` needs
affirmative evidence on the resume (a lower highest degree, a past expiry date, a
lower stage that is not on the same pathway, a jurisdiction that is not recognised).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional

from ml.scoring.roles import Span

Status = Literal["Met", "Partial", "Not met", "Unknown", "Confirm"]
Recognition = Literal[
    "automatic", "administrative_transfer", "exam_required", "not_recognized", "unknown"
]


@dataclass(frozen=True)
class GateOutcome:
    status: Status
    reason: str  # plain-language, shown to the user


@dataclass(frozen=True)
class EducationFact:
    level: int  # 0-5 ladder
    status: Literal["completed", "in_progress", "discontinued"]


@dataclass(frozen=True)
class CredentialFact:
    credential_id: str
    stage_ordinal: int = 0
    in_progress: bool = False
    expiry: date | None = None  # only an explicit date on the resume
    jurisdiction: str | None = None  # e.g. "IN-KA"; None = not stated


@dataclass(frozen=True)
class CredentialRequirement:
    credential_id: str
    stage_ordinal: int = 0
    jurisdiction: str | None = None
    lower_stage_in_pathway: bool = False  # from the registry stage.in_pathway


def evaluate_education(
    required_level: int,
    facts: list[EducationFact],
    *,
    alt_years: Decimal | int | None = None,
    candidate_years: Decimal | int | None = None,
    vague_equivalent: bool = False,
) -> GateOutcome:
    """Education gate. `alt_years` is the numeric experience alternative ("or 4 years")."""
    if alt_years is not None and candidate_years is not None and candidate_years >= alt_years:
        return GateOutcome("Met", f"Meets the stated experience alternative ({alt_years}+ years).")
    completed = [f.level for f in facts if f.status == "completed"]
    if completed and max(completed) >= required_level:
        return GateOutcome("Met", "Education level is stated and meets the requirement.")
    if any(f.status == "in_progress" and f.level >= required_level for f in facts):
        return GateOutcome("Partial", "The required degree is shown as in progress.")
    if vague_equivalent:
        return GateOutcome("Confirm", "The job accepts 'equivalent' qualifications; please confirm.")
    if completed:
        return GateOutcome(
            "Not met", "The highest completed qualification on the resume is below the requirement."
        )
    return GateOutcome("Unknown", "No education is stated on the resume; please confirm.")


def evaluate_credential(
    req: CredentialRequirement,
    facts: list[CredentialFact],
    as_of: date,
    recognition: Recognition = "unknown",
) -> GateOutcome:
    """Licence / registration / membership gate. `recognition` applies only when the
    candidate holds the credential in a different jurisdiction than the job needs."""
    mine = [f for f in facts if f.credential_id == req.credential_id]
    if not mine:
        return GateOutcome("Unknown", "Not stated on the resume; please confirm you hold it.")
    best = max(mine, key=lambda f: (not f.in_progress, f.stage_ordinal))
    if best.expiry is not None and best.expiry < as_of:
        return GateOutcome("Not met", f"The resume shows it expired on {best.expiry.isoformat()}.")
    if best.in_progress:
        return GateOutcome("Partial", "Shown as in progress on the resume.")
    if best.stage_ordinal < req.stage_ordinal:
        if req.lower_stage_in_pathway:
            return GateOutcome("Partial", "A lower stage of the same pathway is held.")
        return GateOutcome("Not met", "The stage held is below the stage the job requires.")
    same_place = (
        req.jurisdiction is None or best.jurisdiction is None or best.jurisdiction == req.jurisdiction
    )
    if same_place:
        return GateOutcome("Met", "Stated on the resume for the required jurisdiction.")
    if recognition == "automatic":
        return GateOutcome("Met", "Held in another jurisdiction that is automatically recognised.")
    if recognition == "administrative_transfer":
        return GateOutcome("Partial", "Held in another jurisdiction; an administrative transfer applies.")
    if recognition in ("exam_required", "not_recognized"):
        return GateOutcome("Not met", "Held in another jurisdiction and not directly recognised.")
    return GateOutcome("Unknown", "Held in another jurisdiction; recognition is unconfirmed.")


# ==============================================================================
# Scoring v3.2: Hard Credential & Degree Gates (Auditable Legal Grounding)
# ==============================================================================

GateStatus = Literal["PASS", "FAIL", "UNVERIFIABLE", "NOT_MANDATORY"]
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
REGISTRY_V1_PATH = DATA_DIR / "credential_registry_v1.json"


@dataclass(frozen=True)
class CredentialEntry:
    id: str
    label: str
    kind: str  # degree | license | certification | clearance | work_auth | location
    jd_patterns: tuple[re.Pattern[str], ...]
    resume_patterns: tuple[re.Pattern[str], ...]
    equivalents: tuple[str, ...]
    scope: tuple[str, ...]
    action_on_missing: Literal["cap", "flag", "none"]
    cap_on_missing: Optional[int]
    action_on_unverifiable: str = "flag"


@dataclass(frozen=True)
class GateResult:
    entry_id: str
    label: str
    kind: str
    status: GateStatus
    action: Literal["cap", "flag", "none"]
    cap: Optional[int]
    jd_span: Span
    resume_span: Optional[Span]
    reason_code: str
    reason_text: str


class CredentialRegistry:
    def __init__(
        self,
        entries: list[CredentialEntry],
        mandatory_markers: tuple[re.Pattern[str], ...],
        preferred_markers: tuple[re.Pattern[str], ...],
        window_chars: int = 120,
    ) -> None:
        self._entries = entries
        self._mandatory_markers = mandatory_markers
        self._preferred_markers = preferred_markers
        self._window_chars = window_chars

    @property
    def entries(self) -> list[CredentialEntry]:
        return self._entries

    @classmethod
    def load(cls, path: Optional[Path | str] = None) -> CredentialRegistry:
        p = Path(path) if path else REGISTRY_V1_PATH
        if not p.exists():
            return cls([], (), ())
        raw = json.loads(p.read_text(encoding="utf-8"))

        # Strength markers
        s_markers = raw.get("strength_markers", {})
        mand_pats = tuple(
            re.compile(r"\b" + re.escape(m) + r"\b", re.I)
            for m in s_markers.get("mandatory", ["must", "required", "mandatory"])
        )
        pref_pats = tuple(
            re.compile(r"\b" + re.escape(p) + r"\b", re.I)
            for p in s_markers.get("preferred", ["preferred", "nice to have", "plus"])
        )
        window = int(raw.get("marker_window_chars", 120))

        compiled_entries: list[CredentialEntry] = []
        for e in raw.get("entries", []):
            kind = e.get("kind", "degree")
            on_missing = e.get("on_missing", {})
            action = on_missing.get("action", "flag")
            # Safety rule: non-credentials (work_auth, clearance, location) can NEVER cap
            if kind in ("work_auth", "clearance", "location") and action == "cap":
                action = "flag"

            cap_val = on_missing.get("cap") if action == "cap" else None
            jd_pats = tuple(re.compile(pat, re.I) for pat in e.get("jd_patterns", []))
            res_pats = tuple(re.compile(pat, re.I) for pat in e.get("resume_patterns", []))
            eqs = tuple(eq.lower() for eq in e.get("equivalents", []))
            sc = tuple(e.get("scope", ["education", "certifications", "header", "summary"]))

            compiled_entries.append(
                CredentialEntry(
                    id=e["id"],
                    label=e.get("label", e["id"]),
                    kind=kind,
                    jd_patterns=jd_pats,
                    resume_patterns=res_pats,
                    equivalents=eqs,
                    scope=sc,
                    action_on_missing=action,
                    cap_on_missing=cap_val,
                    action_on_unverifiable=e.get("on_unverifiable", "flag"),
                )
            )

        return cls(compiled_entries, mand_pats, pref_pats, window)


def classify_strength(
    jd_text: str,
    hit_span: Span,
    registry: CredentialRegistry,
) -> Literal["mandatory", "preferred"]:
    """Classify requirement as mandatory or preferred based on neighboring text markers."""
    start = max(0, hit_span.start - registry._window_chars)
    end = min(len(jd_text), hit_span.end + registry._window_chars)
    window = jd_text[start:end].lower()

    # Downgrade rule: "or equivalent experience" in window downgrades to preferred
    if "or equivalent experience" in window or "or equivalent" in window:
        return "preferred"

    # Check for preferred patterns
    for pat in registry._preferred_markers:
        if pat.search(window):
            return "preferred"

    # Check for mandatory patterns
    for pat in registry._mandatory_markers:
        if pat.search(window):
            return "mandatory"

    # Default to mandatory if it was explicitly listed in requirements section
    return "mandatory"


def evaluate_gates(
    jd_text: str,
    resume_sections: dict[str, str] | str,
    registry: Optional[CredentialRegistry] = None,
    parse_ok: bool = True,
) -> list[GateResult]:
    """Evaluate all credential and degree gates against the job description and resume."""
    reg = registry or CredentialRegistry.load()
    if isinstance(resume_sections, dict):
        full_resume = "\n\n".join(resume_sections.values())
    else:
        full_resume = resume_sections or ""

    results: list[GateResult] = []

    for entry in reg.entries:
        # 1. Search for requirement in JD
        jd_match = None
        for pat in entry.jd_patterns:
            m = pat.search(jd_text)
            if m:
                jd_match = Span("jd", m.start(), m.end(), m.group(0))
                break

        if not jd_match:
            continue

        # 2. Classify requirement strength
        strength = classify_strength(jd_text, jd_match, reg)
        if strength != "mandatory":
            results.append(
                GateResult(
                    entry_id=entry.id,
                    label=entry.label,
                    kind=entry.kind,
                    status="NOT_MANDATORY",
                    action="none",
                    cap=None,
                    jd_span=jd_match,
                    resume_span=None,
                    reason_code=f"GATE_PREFERRED_{entry.id.upper()}",
                    reason_text=f"{entry.label} is preferred or accepts equivalent experience.",
                )
            )
            continue

        # 3. Search for evidence in resume
        res_match = None
        for pat in entry.resume_patterns:
            m = pat.search(full_resume)
            if m:
                res_match = Span("resume", m.start(), m.end(), m.group(0))
                break

        if not res_match:
            for eq in entry.equivalents:
                eq_pat = re.compile(r"\b" + re.escape(eq) + r"\b", re.I)
                m = eq_pat.search(full_resume)
                if m:
                    res_match = Span("resume", m.start(), m.end(), m.group(0))
                    break

        # 4. Formulate gate outcome
        if res_match:
            results.append(
                GateResult(
                    entry_id=entry.id,
                    label=entry.label,
                    kind=entry.kind,
                    status="PASS",
                    action="none",
                    cap=None,
                    jd_span=jd_match,
                    resume_span=res_match,
                    reason_code=f"GATE_PASS_{entry.id.upper()}",
                    reason_text=f"Evidenced mandatory requirement: {entry.label}.",
                )
            )
        elif not parse_ok:
            results.append(
                GateResult(
                    entry_id=entry.id,
                    label=entry.label,
                    kind=entry.kind,
                    status="UNVERIFIABLE",
                    action="flag",
                    cap=None,
                    jd_span=jd_match,
                    resume_span=None,
                    reason_code=f"GATE_UNVERIFIABLE_{entry.id.upper()}",
                    reason_text=f"Low OCR confidence or extraction limits prevented verifying {entry.label}.",
                )
            )
        else:
            action = entry.action_on_missing
            cap = entry.cap_on_missing if action == "cap" else None
            results.append(
                GateResult(
                    entry_id=entry.id,
                    label=entry.label,
                    kind=entry.kind,
                    status="FAIL",
                    action=action,
                    cap=cap,
                    jd_span=jd_match,
                    resume_span=None,
                    reason_code=f"GATE_MISSING_{entry.id.upper()}",
                    reason_text=f"Missing mandatory requirement: {entry.label}.",
                )
            )

    return results


def effective_cap(
    gates: list[GateResult],
    extra_caps: Optional[list[int]] = None,
) -> Optional[tuple[int, list[str]]]:
    """Compute the lowest active cap and return (lowest_cap, triggering_reasons)."""
    caps: list[tuple[int, str]] = []

    for g in gates:
        if g.status == "FAIL" and g.action == "cap" and g.cap is not None:
            caps.append((g.cap, f"gate:{g.entry_id}"))

    if extra_caps:
        for ec in extra_caps:
            if ec is not None:
                caps.append((ec, "seniority"))

    if not caps:
        return None

    lowest_cap = min(c[0] for c in caps)
    triggers = [reason for cap_val, reason in caps if cap_val == lowest_cap]
    return lowest_cap, triggers


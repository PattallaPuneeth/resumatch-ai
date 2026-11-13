"""
ResuMatch AI: Closed-World Generative Rewrite Fact Guardrail.
Inspects LLM-suggested resume rewrites against the candidate's original text to ensure
zero hallucinated metrics, unearned tools, title inflation, or scope exaggeration.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum


class Severity(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class Verdict(str, Enum):
    ACCEPT = "ACCEPT"
    WARN = "WARN"
    REJECT = "REJECT"


@dataclass(frozen=True)
class NumericClaim:
    value: float
    unit: str  # "%", "$", "x", "count", "time"
    raw: str


@dataclass
class Violation:
    kind: str
    token: str
    detail: str
    severity: Severity


@dataclass
class ValidationResult:
    original_bullet: str
    suggested_bullet: str
    verdict: Verdict
    accepted: bool
    violations: list[Violation] = field(default_factory=list)
    neutralized_bullet: str | None = None  # Safe template with [X] placeholders


# Scale multipliers
_SCALE_MULTIPLIERS = {
    "k": 1_000.0,
    "thousand": 1_000.0,
    "m": 1_000_000.0,
    "million": 1_000_000.0,
    "b": 1_000_000_000.0,
    "billion": 1_000_000_000.0,
}

_NUMERIC_REGEX = re.compile(
    r"(?P<cur>[\$€£])?\s?(?P<num>\d[\d,]*(?:\.\d+)?)\s?"
    r"(?P<suf>%|x\b|[kmb]\b|million|billion|thousand|ms|sec(?:onds?)?|minutes?|hours?|days?|weeks?|months?|TB|GB|MB)?",
    re.IGNORECASE,
)
_YEAR_REGEX = re.compile(r"^(?:19|20)\d{2}$")

_IMPLIED_QUANTITIES = re.compile(
    r"\b(?:doubled|tripled|quadrupled|halved|order[- ]of[- ]magnitude|orders[- ]of[- ]magnitude|"
    r"tenfold|hundreds|thousands|millions|dozens)\b",
    re.IGNORECASE,
)

_SENIORITY_TITLES = re.compile(
    r"\b(?:senior|sr\.?|staff|principal|lead|head of|director|vp|vice president|chief|"
    r"architect|founder|co-founder|manager|cto|ceo)\b",
    re.IGNORECASE,
)

_TOOL_PATTERN = re.compile(
    r"\b(?:[A-Z][a-z]+[A-Z]\w*|[A-Za-z0-9]+\.(?:js|io|ai|py)|[A-Z]{2,}[a-z0-9]*)\b"
)

_STANDARD_ACRONYMS = {
    "ROI", "KPI", "SLA", "API", "CI", "CD", "UI", "UX", "QA", "B2B", "B2C",
    "SaaS", "P&L", "OKR", "REST", "HTTP", "HTTPS", "TCP", "IP", "DNS", "SQL",
    "AWS", "GCP", "EC2", "S3", "PR", "RFC", "CPU", "RAM", "GPU",
}

# Verb ownership ladder: Level 1 (Contributor), Level 2 (Practitioner), Level 3 (Owner/Lead)
_VERB_LADDER: dict[int, set[str]] = {
    1: {"assisted", "supported", "helped", "contributed", "participated", "aided"},
    2: {"built", "developed", "implemented", "designed", "created", "wrote", "deployed", "engineered", "improved", "optimized", "refactored"},
    3: {"led", "owned", "managed", "directed", "architected", "spearheaded", "headed", "founded", "oversaw"},
}
_VERB_TO_LEVEL: dict[str, int] = {
    verb: lvl for lvl, verbs in _VERB_LADDER.items() for verb in verbs
}


def parse_numeric_claims(text: str) -> list[NumericClaim]:
    """Extracts standardized numeric claims and units from text."""
    claims: list[NumericClaim] = []
    for m in _NUMERIC_REGEX.finditer(text):
        raw_num = m.group("num").replace(",", "")
        cur = m.group("cur")
        suf = (m.group("suf") or "").lower()

        # Ignore bare 4-digit years without currency or unit
        if _YEAR_REGEX.match(raw_num) and not cur and not suf:
            continue

        try:
            val = float(raw_num)
        except ValueError:
            continue

        if cur:
            unit = cur
            if suf in _SCALE_MULTIPLIERS:
                val *= _SCALE_MULTIPLIERS[suf]
        elif suf == "%":
            unit = "%"
        elif suf == "x":
            unit = "x"
        elif suf in _SCALE_MULTIPLIERS:
            unit = "count"
            val *= _SCALE_MULTIPLIERS[suf]
        elif suf in ("ms", "sec", "second", "seconds", "min", "minute", "minutes", "hour", "hours", "day", "days"):
            unit = "time"
        else:
            unit = "count"

        claims.append(NumericClaim(val, unit, m.group(0).strip()))
    return claims


class ResumeSuggestionValidator:
    """
    Closed-World Fact Grounding Validator.
    Verifies that AI-generated bullet rewrites do not inject ungrounded metrics,
    unearned tools, title inflation, or exaggerated ownership.
    """

    def __init__(
        self,
        known_candidate_skills: Sequence[str] | None = None,
        candidate_seniority_history: Sequence[str] | None = None,
        percentage_derived_tol: float = 1.5,
    ) -> None:
        self.known_skills = {
            s.strip().lower() for s in (known_candidate_skills or []) if s.strip()
        }
        self.known_seniority = {
            s.strip().lower() for s in (candidate_seniority_history or []) if s.strip()
        }
        self.percentage_derived_tol = percentage_derived_tol

    def _is_number_grounded(
        self,
        claim: NumericClaim,
        base_claims: list[NumericClaim],
    ) -> bool:
        """Applies the per-unit derivation tolerance table."""
        # 1. Exact match by value and unit
        for b in base_claims:
            if b.unit == claim.unit:
                if claim.unit in ("count", "time", "$", "€", "£"):
                    if abs(b.value - claim.value) < 1e-4:
                        return True
                elif claim.unit == "%":
                    # Direct match within 0.5pp
                    if abs(b.value - claim.value) <= 0.5:
                        return True
                elif claim.unit == "x":
                    # Multipliers: 1 decimal place tolerance
                    if round(b.value, 1) == round(claim.value, 1):
                        return True

        # 2. Percentage derivation check: |Delta| = 100 * |A - B| / A
        if claim.unit == "%":
            same_unit_base = [b for b in base_claims if b.unit not in ("%", "x") and b.value > 0]
            for a in same_unit_base:
                for b in same_unit_base:
                    if a is not b and a.unit == b.unit:
                        derived = 100.0 * abs(a.value - b.value) / a.value
                        if abs(derived - claim.value) <= self.percentage_derived_tol:
                            return True

        # 3. Multiplier derivation check: M = A / B
        if claim.unit == "x":
            same_unit_base = [b for b in base_claims if b.unit not in ("%", "x") and b.value > 0]
            for a in same_unit_base:
                for b in same_unit_base:
                    if a is not b and a.unit == b.unit and b.value > 0:
                        derived = a.value / b.value
                        if abs(derived - claim.value) <= 0.2:
                            return True

        return False

    def validate_rewrite(
        self,
        original_bullet: str,
        suggested_bullet: str,
        profile_context_text: str = "",
    ) -> ValidationResult:
        """Validates a single suggested rewrite against the original bullet and profile context."""
        violations: list[Violation] = []
        neutralized = suggested_bullet

        combined_source = f"{original_bullet} {profile_context_text}"
        base_numbers = parse_numeric_claims(combined_source)
        suggested_numbers = parse_numeric_claims(suggested_bullet)

        # 1. Metric Claim Verification
        for num_claim in suggested_numbers:
            if not self._is_number_grounded(num_claim, base_numbers):
                violations.append(
                    Violation(
                        kind="NEW_METRIC",
                        token=num_claim.raw,
                        detail=f"Metric '{num_claim.raw}' ({num_claim.value} {num_claim.unit}) not found in source text and cannot be derived.",
                        severity=Severity.CRITICAL,
                    )
                )
                neutralized = neutralized.replace(num_claim.raw, "[X]")

        # 2. Implied Quantities
        for m in _IMPLIED_QUANTITIES.finditer(suggested_bullet):
            tok = m.group(0)
            if not _IMPLIED_QUANTITIES.search(combined_source):
                violations.append(
                    Violation(
                        kind="IMPLIED_METRIC",
                        token=tok,
                        detail=f"Implied quantity '{tok}' claimed without source support.",
                        severity=Severity.CRITICAL,
                    )
                )

        # 3. Seniority & Title Inflation
        for m in _SENIORITY_TITLES.finditer(suggested_bullet):
            title_tok = m.group(0).lower()
            if title_tok not in self.known_seniority and not re.search(
                rf"\b{re.escape(title_tok)}\b", combined_source, re.IGNORECASE
            ):
                violations.append(
                    Violation(
                        kind="TITLE_INFLATION",
                        token=m.group(0),
                        detail=f"Seniority claim '{m.group(0)}' not present in candidate's original history.",
                        severity=Severity.CRITICAL,
                    )
                )

        # 4. Verb Scope Ownership Ladder
        orig_first = re.match(r"^\W*([A-Za-z]+)", original_bullet.strip())
        sugg_first = re.match(r"^\W*([A-Za-z]+)", suggested_bullet.strip())
        if orig_first and sugg_first:
            orig_v = orig_first.group(1).lower()
            sugg_v = sugg_first.group(1).lower()
            orig_lvl = _VERB_TO_LEVEL.get(orig_v, 2)
            sugg_lvl = _VERB_TO_LEVEL.get(sugg_v, 2)
            delta = sugg_lvl - orig_lvl
            if delta >= 2:
                violations.append(
                    Violation(
                        kind="SCOPE_INFLATION",
                        token=sugg_first.group(1),
                        detail=f"Ownership level jump from Level {orig_lvl} ('{orig_v}') to Level {sugg_lvl} ('{sugg_v}') overstates responsibility.",
                        severity=Severity.CRITICAL,
                    )
                )
            elif delta == 1:
                violations.append(
                    Violation(
                        kind="SCOPE_DRIFT",
                        token=sugg_first.group(1),
                        detail=f"Ownership level increased from Level {orig_lvl} ('{orig_v}') to Level {sugg_lvl} ('{sugg_v}').",
                        severity=Severity.WARNING,
                    )
                )

        # 5. Tool Containment
        for tok in _TOOL_PATTERN.findall(suggested_bullet):
            tok_norm = tok.lower()
            if tok in _STANDARD_ACRONYMS or tok_norm in self.known_skills:
                continue
            if not re.search(rf"\b{re.escape(tok)}\b", combined_source, re.IGNORECASE):
                violations.append(
                    Violation(
                        kind="UNKNOWN_ENTITY",
                        token=tok,
                        detail=f"Tool or proper noun '{tok}' not found in candidate profile.",
                        severity=Severity.WARNING,
                    )
                )

        # Determine final verdict
        has_critical = any(v.severity == Severity.CRITICAL for v in violations)
        has_warning = any(v.severity == Severity.WARNING for v in violations)

        if has_critical:
            verdict = Verdict.REJECT
            accepted = False
        elif has_warning:
            verdict = Verdict.WARN
            accepted = True
        else:
            verdict = Verdict.ACCEPT
            accepted = True

        return ValidationResult(
            original_bullet=original_bullet,
            suggested_bullet=suggested_bullet,
            verdict=verdict,
            accepted=accepted,
            violations=violations,
            neutralized_bullet=neutralized if neutralized != suggested_bullet else None,
        )

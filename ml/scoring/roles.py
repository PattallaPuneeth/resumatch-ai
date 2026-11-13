"""Role family, adjacency and level from O*NET occupation data (design D5).

For five domains (software/IT, healthcare, skilled trades, accounting/finance, legal) the file
`ml/data/domain_knowledge_v1.json` lists occupations with alternate titles, related occupations,
typical education and experience. This module maps a job title and a resume's role titles onto those
occupations and says how the two relate: same role, related role, same field or different field.
It explains and informs; it never changes the score (owner decision Q4: cap only if proven).
Source: O*NET 31.0 Database, U.S. Department of Labor, CC BY 4.0.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from enum import IntEnum
from functools import lru_cache
from typing import Any

from ml.scoring.item1_years import _experience_sections, _ranges_in_section, jd_title_text
from ml.scoring.spans import canonicalize
from ml.scoring.units import DATA, _stem

KNOWLEDGE_PATH = DATA / "domain_knowledge_v1.json"
MIN_MATCH = 0.6
_DROP = frozenset(
    "senior sr junior jr lead principal staff intern trainee apprentice entry level interim "
    "and the of for in to a an with at ii iii iv".split()
)
RELATION_RANK = {"same role": 4, "related role": 3, "same field": 2, "different field": 1, "unknown": 0}
FIELD_LABEL = {
    "software_it": "software and IT", "healthcare": "healthcare", "skilled_trades": "skilled trades",
    "accounting_finance": "accounting and finance", "legal": "legal",
}


@dataclass(frozen=True)
class Occupation:
    soc: str
    title: str
    domain: str
    job_zone: int | None
    typical_years: float | None
    typical_education_level: int | None
    related: tuple[str, ...]
    title_sets: tuple[frozenset[str], ...]
    primary: frozenset[str] = frozenset()


@dataclass(frozen=True)
class RoleMatch:
    soc: str
    occupation: str
    domain: str
    score: float
    text: str


@lru_cache(maxsize=1)
def _india_titles() -> tuple[dict[str, str], list[tuple[str, str]]]:
    path = DATA / "india_titles.json"
    if not path.exists():
        return {}, []
    data = json.loads(path.read_text(encoding="utf-8"))
    phrases = sorted(data["phrases"].items(), key=lambda kv: -len(kv[0]))
    return data["abbreviations"], phrases


def _india_normalise(title: str) -> str:
    """Expand Indian abbreviations ("S/W Engg", "Sr. Exec") and map common Indian title wording to
    a title the O*NET index recognises."""
    abbreviations, phrases = _india_titles()
    low = " " + re.sub(r"[.\-]+", " ", title.lower().replace("&", " and ")) + " "
    for short, full in abbreviations.items():
        low = re.sub(r"(?<![a-z0-9/])" + re.escape(short) + r"(?![a-z0-9])", full, low)
    low = " " + " ".join(low.split()) + " "
    for phrase, canonical in phrases:
        if f" {phrase} " in low:
            return canonical
    return low.strip()


def _tokens(title: str, normalise: bool = True) -> frozenset[str]:
    """Stemmed title words. Indian wording is normalised for the query only, never for the
    O*NET titles in the index."""
    if normalise:
        title = _india_normalise(title)
    words = [w for w in re.findall(r"[a-z]+", title.lower()) if w not in _DROP and len(w) > 1]
    return frozenset(_stem(w) for w in words)


@lru_cache(maxsize=1)
def knowledge() -> tuple[dict[str, Occupation], dict[str, list[str]]]:
    """soc -> Occupation, and an inverted index token -> [soc]. Empty when the file is absent."""
    if not KNOWLEDGE_PATH.exists():
        return {}, {}
    data = json.loads(KNOWLEDGE_PATH.read_text(encoding="utf-8"))
    occ: dict[str, Occupation] = {}
    inverted: dict[str, list[str]] = {}
    for o in data["occupations"]:
        sets = tuple(
            s
            for s in {_tokens(t, False) for t in [o["title"], *o.get("alt_titles", [])]}
            if s
        )
        occ[o["soc"]] = Occupation(
            o["soc"], o["title"], o["domain"], o.get("job_zone"), o.get("typical_years"),
            o.get("typical_education_level"), tuple(o.get("related", [])), sets,
            _tokens(o["title"], False),
        )
        for tok in {t for s in sets for t in s}:
            inverted.setdefault(tok, []).append(o["soc"])
    return occ, inverted


def match_title(title: str, top: int = 3) -> list[RoleMatch]:
    """Occupations whose title or alternate title best matches `title` (Dice score >= 0.6)."""
    occ, inverted = knowledge()
    toks = _tokens(title)
    if not toks or not occ:
        return []
    cands = {soc for t in toks for soc in inverted.get(t, ())}
    scored: list[tuple[float, float, RoleMatch]] = []
    for soc in cands:
        o = occ[soc]
        best = max(2 * len(toks & s) / (len(toks) + len(s)) for s in o.title_sets)
        if best >= MIN_MATCH:
            primary = 2 * len(toks & o.primary) / (len(toks) + len(o.primary)) if o.primary else 0.0
            scored.append((best, primary, RoleMatch(soc, o.title, o.domain, round(best, 3), title)))
    scored.sort(key=lambda t: (-t[0], -t[1], len(t[2].occupation), t[2].soc))
    return [m for _, _, m in scored[:top]]


def relation(a_soc: str, b_soc: str) -> str:
    occ, _ = knowledge()
    a, b = occ[a_soc], occ[b_soc]
    if a_soc[:7] == b_soc[:7]:
        return "same role"
    if b_soc[:7] in {r[:7] for r in a.related} or a_soc[:7] in {r[:7] for r in b.related} \
            or a_soc[:6] == b_soc[:6]:
        return "related role"
    return "same field" if a.domain == b.domain else "different field"


_SEGMENT = re.compile(r"\s*[|,@–—]\s*|\s+-\s+|\s+at\s+")


def _title_segments(chunk: str) -> list[str]:
    chunk = re.sub(r"[*_#]+", " ", chunk)
    return [s.strip() for s in _SEGMENT.split(chunk) if 1 <= len(s.split()) <= 7]


def resume_role_candidates(resume_text: str, as_of: date, limit: int = 4) -> list[RoleMatch]:
    """Occupations matched by the resume's headline and by the titles next to each dated role,
    most recent role first."""
    text, _ = canonicalize(resume_text or "")
    lines = text.split("\n")
    found: list[tuple[date, int, RoleMatch]] = []
    seen: set[str] = set()

    def add(chunk: str, when: date, rank: int) -> None:
        best: RoleMatch | None = None
        for seg in _title_segments(chunk):
            for m in match_title(seg, top=1):
                if best is None or m.score > best.score:
                    best = m
        if best is not None and best.soc not in seen:
            seen.add(best.soc)
            found.append((when, rank, best))

    offsets = []
    pos = 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln) + 1
    ranges = []
    for b, e in _experience_sections(text):
        ranges.extend(_ranges_in_section(text, b, e, as_of))
    for start, finish, _yo, p0, p1 in sorted(ranges, key=lambda r: r[1], reverse=True):
        li = max(i for i, o in enumerate(offsets) if o <= p0)
        line = lines[li]
        add(text[max(offsets[li], p0 - 80) : p0], finish, 0)  # same line, before the dates
        add(text[p1 : min(len(text), p1 + 80)].split("\n")[0], finish, 1)  # same line, after
        prev = next((lines[j] for j in range(li - 1, max(-1, li - 3), -1) if lines[j].strip()), "")
        add(prev, finish, 2)
        _ = line
    head = [ln for ln in lines[:4] if ln.strip()]
    for ln in head:
        add(ln, date.min, 3)
    found.sort(key=lambda t: (-t[0].toordinal(), t[1], -t[2].score))
    return [m for _, _, m in found][:limit]


def role_fit(jd_text: str, resume_text: str, as_of: date) -> dict[str, Any]:
    """How the job's role relates to the resume's recent roles, with plain-language notes."""
    occ, _ = knowledge()
    base: dict[str, Any] = {
        "source": "O*NET 31.0 Database (U.S. Department of Labor, CC BY 4.0)",
        "relation": "unknown", "jd_role": None, "resume_role": None, "level": None, "note": None,
    }
    if not occ:
        return base
    title = jd_title_text(jd_text)
    jd_matches = match_title(title, top=1) if title else []
    if not jd_matches:
        base["note"] = "The job title was not recognised, so role fit is not shown."
        return base
    # equally good title matches (for example Accountants and Auditors vs Budget Analysts for
    # "Cost Accountant") are all considered; the closest relation to the resume decides
    all_jd = match_title(title, top=4)
    jd_options = [m for m in all_jd if m.score >= all_jd[0].score - 0.05]
    cands = resume_role_candidates(resume_text, as_of)
    if not cands:
        jd = jd_options[0]
        base["jd_role"] = {"title": title, "occupation": jd.occupation, "soc": jd.soc,
                           "field": jd.domain, "confidence": jd.score}
        base["note"] = (f"The job is a {jd.occupation} role. No recognisable job titles were found "
                        "on the resume, so role fit is not shown.")
        return base
    best_rel, best, jd = "unknown", None, jd_options[0]
    for j in jd_options:
        for c in cands:
            rel = relation(j.soc, c.soc)
            if RELATION_RANK[rel] > RELATION_RANK[best_rel]:
                best_rel, best, jd = rel, c, j
    assert best is not None
    base["jd_role"] = {"title": title, "occupation": jd.occupation, "soc": jd.soc,
                       "field": jd.domain, "confidence": jd.score}
    base["relation"] = best_rel
    base["resume_role"] = {"title": best.text, "occupation": best.occupation, "soc": best.soc,
                           "field": best.domain, "confidence": best.score}
    jo, ro = occ[jd.soc], occ[best.soc]
    if jo.job_zone and ro.job_zone:
        base["level"] = {"job_zone": jo.job_zone, "resume_zone": ro.job_zone,
                         "gap": jo.job_zone - ro.job_zone,
                         "typical_years_for_job": jo.typical_years}
    mine, theirs = best.text.strip(), jd.occupation
    phrase = {
        "same role": f"Your recent role ({mine}) is the same kind of work as this job ({theirs}).",
        "related role": (f"Your recent role ({mine}) is related to this job's role ({theirs})."),
        "same field": (f"Your recent role ({mine}) and this job's role ({theirs}) are both in "
                       f"{FIELD_LABEL[jd.domain]}, but the work differs."),
        "different field": (f"This job's role ({theirs}) is in {FIELD_LABEL[jd.domain]}; your recent "
                            f"role ({mine}) is in {FIELD_LABEL[best.domain]}, a different field."),
    }[best_rel]
    base["note"] = phrase
    return base


# ==============================================================================
# Scoring v3.2: Seniority & Career Progression Engine
# ==============================================================================

class Level(IntEnum):
    INTERN = 0
    JUNIOR = 1
    MID = 2
    SENIOR = 3
    LEAD = 4
    PRINCIPAL = 5


@dataclass(frozen=True)
class Span:
    source: str  # "jd" | "resume"
    start: int
    end: int
    text: str


@dataclass(frozen=True)
class Role:
    title: str
    company: str
    start: date | None
    end: date | None
    is_internship: bool
    title_span: Span
    bullets: tuple[str, ...] = ()


@dataclass(frozen=True)
class JDLevel:
    level: float | None
    min_years: float | None
    confidence: float
    evidence: tuple[Span, ...] = ()


@dataclass(frozen=True)
class ResumeLevel:
    level: float | None
    effective_years: float | None
    n_roles: int
    evidence: tuple[Span, ...] = ()


@dataclass(frozen=True)
class SeniorityParams:
    kappa: float = 0.22
    delta0: float = 0.5
    m_floor: float = 0.40
    hard_gap_potential: float = 2.0
    cap_potential: int = 69
    hard_gap_no_fit: float = 3.0
    cap_no_fit: int = 44
    overqualified_threshold: float = -2.0


@dataclass(frozen=True)
class SeniorityResult:
    jd: JDLevel
    resume: ResumeLevel
    delta: float | None
    multiplier: float
    cap: int | None
    reason_codes: tuple[str, ...]
    feedback: str = ""


LEVEL_CURVE_PATH = DATA / "level_curve_v1.json"
SENIORITY_PARAMS_PATH = DATA / "seniority_params_v1.json"


@lru_cache(maxsize=1)
def load_seniority_params() -> SeniorityParams:
    if SENIORITY_PARAMS_PATH.exists():
        try:
            d = json.loads(SENIORITY_PARAMS_PATH.read_text(encoding="utf-8"))
            return SeniorityParams(
                kappa=float(d.get("kappa", 0.22)),
                delta0=float(d.get("delta0", 0.5)),
                m_floor=float(d.get("m_floor", 0.40)),
                hard_gap_potential=float(d.get("hard_gap_potential", 2.0)),
                cap_potential=int(d.get("cap_potential", 69)),
                hard_gap_no_fit=float(d.get("hard_gap_no_fit", 3.0)),
                cap_no_fit=int(d.get("cap_no_fit", 44)),
                overqualified_threshold=float(d.get("overqualified_threshold", -2.0)),
            )
        except Exception:
            pass
    return SeniorityParams()


@lru_cache(maxsize=1)
def _load_level_curve() -> list[tuple[float, float]]:
    if LEVEL_CURVE_PATH.exists():
        try:
            d = json.loads(LEVEL_CURVE_PATH.read_text(encoding="utf-8"))
            return [(float(k[0]), float(k[1])) for k in d["knots"]]
        except Exception:
            pass
    return [(0.0, 0.0), (1.0, 1.0), (3.0, 2.0), (5.0, 3.0), (8.0, 4.0), (12.0, 5.0)]


def years_to_level(years: float) -> float:
    """Piecewise linear mapping from years to career level [0, 5]."""
    if years <= 0.0:
        return 0.0
    knots = _load_level_curve()
    if years >= knots[-1][0]:
        return float(knots[-1][1])
    for i in range(len(knots) - 1):
        x0, y0 = knots[i]
        x1, y1 = knots[i + 1]
        if x0 <= years <= x1:
            if x1 == x0:
                return float(y0)
            return float(round(y0 + (years - x0) * (y1 - y0) / (x1 - x0), 3))
    return float(knots[-1][1])


TITLE_RULES: list[tuple[float, str]] = [
    (5.0, r"\b(principal|director|head of|vp|vice president|chief|architect|distinguished)\b"),
    (4.0, r"\b(staff|lead|team lead|tech lead|manager|engineering manager)\b"),
    (3.0, r"\b(senior|sr\.?|iii|iv)\b"),
    (1.0, r"\b(junior|jr\.?|associate|graduate|entry[- ]level|i)\b"),
    (0.0, r"\b(intern|trainee|apprentice|fresher|student)\b"),
]
DEFAULT_TITLE_LEVEL = 2.0


def title_to_level(title: str) -> float | None:
    """Map title string to continuous float level in [0, 5]."""
    t = (title or "").strip()
    if not t:
        return None
    low = t.lower()
    # Negative lookahead check for lead generation/scoring
    if re.search(r"\blead\s+(?:gen|scor)\w*", low):
        low = re.sub(r"\blead\s+(?:gen|scor)\w*", " ", low)
    # Architect ambiguity rules
    if re.search(r"\b(principal|chief)\s+architect\b", low):
        return 5.0
    if re.search(r"\barchitect\b", low) and not re.search(r"\b(junior|associate)\b", low):
        return 4.5
    for lvl, pat in TITLE_RULES:
        if re.search(pat, low):
            return lvl
    if re.search(r"\b(engineer|developer|analyst|specialist|accountant|auditor|consultant|programmer|designer|coordinator|officer)\b", low):
        return DEFAULT_TITLE_LEVEL
    return None


def _union(intervals: list[tuple[date, date]]) -> list[tuple[date, date]]:
    if not intervals:
        return []
    sorted_ivs = sorted(intervals, key=lambda iv: iv[0])
    merged: list[tuple[date, date]] = [sorted_ivs[0]]
    for cur_s, cur_e in sorted_ivs[1:]:
        last_s, last_e = merged[-1]
        if cur_s <= last_e:
            merged[-1] = (last_s, max(last_e, cur_e))
        else:
            merged.append((cur_s, cur_e))
    return merged


def _subtract(a_intervals: list[tuple[date, date]], b_intervals: list[tuple[date, date]]) -> list[tuple[date, date]]:
    if not a_intervals or not b_intervals:
        return a_intervals
    res: list[tuple[date, date]] = []
    for s, e in a_intervals:
        cur = [(s, e)]
        for bs, be in b_intervals:
            next_cur = []
            for cs, ce in cur:
                if be <= cs or bs >= ce:
                    next_cur.append((cs, ce))
                else:
                    if cs < bs:
                        next_cur.append((cs, bs))
                    if ce > be:
                        next_cur.append((be, ce))
            cur = next_cur
        res.extend(cur)
    return res


def effective_years(roles: list[Role]) -> float | None:
    """Union of intervals; internships weight 0.5; None if no role has dates."""
    ivs = [
        (r.start, r.end, 0.5 if r.is_internship else 1.0)
        for r in roles
        if r.start and r.end and r.end >= r.start
    ]
    if not ivs:
        return None
    full = _union([(s, e) for s, e, w in ivs if w == 1.0])
    part = _subtract(_union([(s, e) for s, e, w in ivs if w < 1.0]), full)
    days = sum((e - s).days for s, e in full) + 0.5 * sum((e - s).days for s, e in part)
    return round(days / 365.25, 2)


def parse_roles(resume_text: str, today: date) -> list[Role]:
    """Extract work roles and dates from resume text using experience section bounds."""
    text, _ = canonicalize(resume_text or "")
    lines = text.split("\n")
    offsets: list[int] = []
    pos = 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln) + 1

    roles: list[Role] = []
    ranges: list[tuple[date, date, Any, int, int]] = []
    for b, e in _experience_sections(text):
        ranges.extend(_ranges_in_section(text, b, e, today))

    for start_dt, end_dt, _, p0, p1 in sorted(ranges, key=lambda r: r[0] if r[0] else date.min):
        li = max((i for i, o in enumerate(offsets) if o <= p0), default=0)
        chunks = [
            text[max(offsets[li], p0 - 80) : p0].strip(),
            text[p1 : min(len(text), p1 + 80)].split("\n")[0].strip(),
        ]
        if li > 0:
            chunks.append(lines[li - 1].strip())

        title = "Role"
        span_s, span_e = p0, p1
        for ch in chunks:
            if not ch:
                continue
            for seg in _title_segments(ch):
                if title_to_level(seg) is not None or (1 <= len(seg.split()) <= 5 and not re.search(r"^\d", seg)):
                    title = seg
                    idx = text.find(seg, max(0, p0 - 150))
                    if idx != -1:
                        span_s, span_e = idx, idx + len(seg)
                    break
            if title != "Role":
                break

        is_intern = bool(re.search(r"\b(intern|internship|trainee|apprentice|fresher)\b", title.lower()))
        span = Span("resume", span_s, span_e, text[span_s:span_e] if span_e <= len(text) else title)
        roles.append(Role(title=title, company="", start=start_dt, end=end_dt, is_internship=is_intern, title_span=span))
    return roles


def detect_jd_level(jd_text: str) -> JDLevel:
    """Detect career level and required years from job description text."""
    t = (jd_title_text(jd_text) or "").strip()
    evidence: list[Span] = []
    t_j: float | None = None
    if t:
        t_j = title_to_level(t)
        idx = jd_text.find(t)
        if idx != -1:
            evidence.append(Span("jd", idx, idx + len(t), t))

    # Detect required years near experience
    y_val: float | None = None
    y_j: float | None = None
    m_yr = re.search(r"(\d+)(?:\s*\+)?(?:\s*-\s*(\d+))?\s*(?:years?|yrs)\b(?:[^\n.]{0,40}?\b(?:experience|exp)\b)?", jd_text, re.I)
    if m_yr:
        y1 = float(m_yr.group(1))
        if m_yr.group(2):
            y2 = float(m_yr.group(2))
            y_val = y1 + 0.25 * (y2 - y1)
        else:
            y_val = y1
        if y_val < 30.0:  # sanity bound against founding years
            y_j = years_to_level(y_val)
            evidence.append(Span("jd", m_yr.start(), m_yr.end(), m_yr.group(0)))
        else:
            y_val = None

    # Detect scope verbs
    own_hits = len(set(re.findall(r"\b(own|architect|define strategy|mentor|roadmap|stakeholder|lead|drive)\b", jd_text, re.I)))
    supp_hits = len(set(re.findall(r"\b(assist|support|learn|under guidance)\b", jd_text, re.I)))
    s_j: float | None = None
    if own_hits > 0 or supp_hits > 0:
        base_scope = min(5.0, 1.5 + 0.5 * own_hits)
        if supp_hits > 0 and own_hits == 0:
            base_scope = 1.0
        s_j = base_scope

    signals: list[tuple[float, float]] = []
    if t_j is not None:
        signals.append((0.50, t_j))
    if y_j is not None:
        signals.append((0.30, y_j))
    if s_j is not None:
        signals.append((0.20, s_j))

    if not signals:
        return JDLevel(level=None, min_years=y_val, confidence=0.0, evidence=tuple(evidence))

    w_sum = sum(w for w, _ in signals)
    computed_lvl = sum(w * s for w, s in signals) / w_sum
    return JDLevel(level=round(computed_lvl, 2), min_years=y_val, confidence=round(w_sum, 2), evidence=tuple(evidence))


def detect_resume_level(resume_text: str, today: date) -> ResumeLevel:
    """Detect candidate career level from roles, tenure, and scope."""
    roles = parse_roles(resume_text, today)
    ev_spans: list[Span] = [r.title_span for r in roles]
    y_eff = effective_years(roles)
    y_lvl = years_to_level(y_eff) if y_eff is not None else None

    # Title level from recent roles within last 5 years
    title_lvls: list[float] = []
    for r in roles:
        tl = title_to_level(r.title)
        if tl is not None:
            tenure = (r.end - r.start).days / 365.25 if r.start and r.end else 1.0
            discount = min(1.0, tenure / 1.0)
            title_lvls.append(tl * discount)

    t_r = max(title_lvls) if title_lvls else None

    # Scope verb score in resume text
    own_hits = len(set(re.findall(r"\b(designed|architected|built|led|spearheaded|mentored|managed|owned)\b", resume_text, re.I)))
    s_r = min(5.0, 1.0 + 0.5 * own_hits) if own_hits > 0 else None

    signals: list[tuple[float, float]] = []
    if y_lvl is not None:
        signals.append((0.55, y_lvl))
    if t_r is not None:
        signals.append((0.30, t_r))
    if s_r is not None:
        signals.append((0.15, s_r))

    if not signals:
        return ResumeLevel(level=None, effective_years=y_eff, n_roles=len(roles), evidence=tuple(ev_spans))

    w_sum = sum(w for w, _ in signals)
    computed_lvl = sum(w * s for w, s in signals) / w_sum
    return ResumeLevel(level=round(computed_lvl, 2), effective_years=y_eff, n_roles=len(roles), evidence=tuple(ev_spans))


def seniority_multiplier(delta: float | None, params: SeniorityParams) -> tuple[float, int | None]:
    """Compute score coverage multiplier and band cap from seniority delta."""
    if delta is None:
        return 1.0, None
    d_plus = max(0.0, delta - params.delta0)
    m = max(params.m_floor, round(1.0 - params.kappa * d_plus, 4))
    cap: int | None = None
    if delta >= params.hard_gap_no_fit:
        cap = params.cap_no_fit
    elif delta >= params.hard_gap_potential:
        cap = params.cap_potential
    return m, cap


REASONS = {
    "SENIORITY_GAP": (
        "Your technical skills align well, but this role is {jd_level_label} "
        "(requires about {jd_years}+ years of ownership-level work); your experience "
        "reads as {res_level_label} (about {res_years:.1f} years across {n_roles} roles)."
    ),
    "YEARS_SHORTFALL": "The posting asks for {jd_years}+ years; your dated roles total about {res_years:.1f}.",
    "JD_LEVEL_UNKNOWN": "The posting does not state a clear seniority level, so no seniority adjustment was applied.",
    "RESUME_LEVEL_UNKNOWN": "We couldn't read dates or titles reliably, so no seniority adjustment was applied.",
    "OVERQUALIFIED": "Your experience level ({res_level_label}) significantly exceeds the requirements for this {jd_level_label} role.",
}

_LABEL_MAP = {
    0: "Intern / Fresher",
    1: "Junior",
    2: "Mid-level",
    3: "Senior",
    4: "Lead / Staff",
    5: "Principal / Architect",
}


def _level_label(lvl: float | None) -> str:
    if lvl is None:
        return "Unknown"
    rounded = max(0, min(5, round(lvl)))
    return _LABEL_MAP.get(rounded, "Mid-level")


def assess_seniority(
    jd_text: str,
    resume_text: str,
    today: date,
    params: SeniorityParams | None = None,
) -> SeniorityResult:
    """Full seniority assessment comparing JD demand against resume tenure."""
    p = params or load_seniority_params()
    jd = detect_jd_level(jd_text)
    res = detect_resume_level(resume_text, today)

    reason_codes: list[str] = []
    if jd.level is None:
        reason_codes.append("JD_LEVEL_UNKNOWN")
    if res.level is None:
        reason_codes.append("RESUME_LEVEL_UNKNOWN")

    if jd.level is None or res.level is None:
        fb = REASONS["JD_LEVEL_UNKNOWN"] if jd.level is None else REASONS["RESUME_LEVEL_UNKNOWN"]
        return SeniorityResult(
            jd=jd,
            resume=res,
            delta=None,
            multiplier=1.0,
            cap=None,
            reason_codes=tuple(reason_codes),
            feedback=fb,
        )

    delta = round(jd.level - res.level, 2)
    mult, cap = seniority_multiplier(delta, p)

    feedback = ""
    if delta >= p.hard_gap_potential:
        reason_codes.append("SENIORITY_GAP")
        feedback = REASONS["SENIORITY_GAP"].format(
            jd_level_label=_level_label(jd.level),
            jd_years=jd.min_years or 5,
            res_level_label=_level_label(res.level),
            res_years=res.effective_years or 0.0,
            n_roles=res.n_roles,
        )
    elif delta <= p.overqualified_threshold:
        reason_codes.append("OVERQUALIFIED")
        feedback = REASONS["OVERQUALIFIED"].format(
            res_level_label=_level_label(res.level),
            jd_level_label=_level_label(jd.level),
        )
    elif jd.min_years and res.effective_years and res.effective_years < jd.min_years:
        reason_codes.append("YEARS_SHORTFALL")
        feedback = REASONS["YEARS_SHORTFALL"].format(
            jd_years=jd.min_years,
            res_years=res.effective_years,
        )

    return SeniorityResult(
        jd=jd,
        resume=res,
        delta=delta,
        multiplier=mult,
        cap=cap,
        reason_codes=tuple(reason_codes),
        feedback=feedback,
    )


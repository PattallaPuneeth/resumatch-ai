"""Requirement units and open-vocabulary coverage (design D1 + D2,
docs/ITEM12_ACCURACY_DESIGN.md).

A unit is one requirement line or sentence from the job description. Its terms (stemmed words and
word pairs) are weighted by IDF from a frozen reference table. Coverage asks how much of that
weighted vocabulary the resume evidences, with a verbatim span for every hit. Everything here is
deterministic: no model, no network, no clock.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

from ml.scoring.item1_extraction import (
    NOT_MANDATORY,
    PREFERRED_CUE,
    REQUIRED_CUE,
    _evidence_credit,
    _resume_context,
)
from ml.scoring.spans import canonicalize

F = Fraction
DATA = Path(__file__).resolve().parents[1] / "data"
IDF_PATH = DATA / "jd_idf_v1.json"
MAX_UNITS = 25
SKILL_LIKE_IDF = 3.0  # terms rarer than this count as evidence that a role used the skill
CUE_WEIGHT = {"Required": F(1), "Unlabelled": F(3, 4), "Preferred": F(1, 2)}

STOP = frozenset(
    "the and for with that this are you our will your have has from not but can all any who they "
    "their about more other such into over also been being than then them these those its was were "
    "would should must may per via etc job work team role position company candidate candidates "
    "experience years year required requirements preferred skills ability strong knowledge working "
    "including include within across both each use using used able well new help make build join "
    "part day one two three plus great good best like looking seeking opportunity environment "
    "business responsible responsibilities qualifications duties general related relevant "
    "excellent proven demonstrated understanding minimum least strongly highly "
    "hands-on hand hands preferably applicant applicants fresher freshers vacancy vacancies urgent expertise proficiency proficient capabilities capability comfortable either "
    "similar principles prior previous progressive solid familiarity exposure abilities advanced "
    "complex clear based perform performing support supporting ensure various multiple "
    "independently effectively written oral verbal and/or e.g i.e".split()
)
BOILERPLATE = re.compile(
    r"equal opportunity|\beoe\b|affirmative action|without regard|veteran|disabilit|401\(?k\)?|"
    r"health insurance|dental|paid time off|\bpto\b|benefits package|compensation|salary|"
    r"pay range|diversity|inclusion|background check|e-verify|sponsorship|accommodat|"
    r"about us|who we are|our mission|our culture",
    re.I,
)
_CONFIRM_LINE = re.compile(
    r"\b(?:pay rate|hourly|per hour|/\s*hour|w-?2|1099|c2c|corp[- ]to[- ]corp|salary|ctc|lpa|"
    r"relocat\w+|must (?:reside|live|be (?:located|local))|reside in|on-?site|hybrid|"
    r"work from home|wfh|wfo|work from office|travel|night shift|rotational shift|notice period|"
    r"immediate joiner|joining (?:period|date)|bond period|service agreement|walk-?in|visa|"
    r"work authori[sz]ation|us citizen|green card|security clearance|drug (?:test|screen))\b",
    re.I,
)
_SOFT_LINE = re.compile(
    r"\b(?:communication|interpersonal|teamwork|team player|collaborat\w*|problem[- ]solving|"
    r"critical thinking|attention to detail|detail[- ]oriented|self[- ]motivated|self[- ]starter|"
    r"work independently|time management|organi[sz]ational skills|multi-?task\w*|fast[- ]paced|"
    r"leadership skills|positive attitude|work ethic|"
    r"ability to (?:learn|adapt|identify|resolve|prioriti[sz]e|work (?:under|independently|well)))\b",
    re.I,
)
_OR_LIST = re.compile(
    r"(?<![\w/])([a-z0-9_#+.]+(?:\s*,\s*[a-z0-9_#+.]+)*)\s*,?\s*(?:or|and/or)\s+([a-z0-9_#+.]+)"
)
_SECTION_KEYWORDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("skip", re.compile(r"about (?:us|the company)|who we are|company overview|benefits|perks|"
                        r"what we offer|why join|equal opportunity|how to apply", re.I)),
    ("preferred", re.compile(r"preferred|nice to have|bonus|desirable|good to have|a plus", re.I)),
    ("required", re.compile(r"requirements?|qualifications?|must have|required|what you.?ll need|"
                            r"you have|what we.?re looking for|skills|minimum", re.I)),
    ("duties", re.compile(r"responsibilit|duties|what you.?ll do|you will|the role|day to day", re.I)),
)
_HEADING_PREFIX = re.compile(
    r"^\s*(?P<h>(?:basic|minimum|preferred|key|required|additional|core)?\s*"
    r"(?:job description|qualifications?|requirements?|responsibilit(?:y|ies)|skills?|duties|"
    r"what you.?ll (?:need|do)|about (?:us|the company|the role)|benefits|perks|nice to have)"
    r"(?:\s+and\s+\w+)?)\s*:\s*",
    re.I,
)
_CHUNK = re.compile("[^\n\r\u2022\u00b7\u25aa\u2023]+")
_MARKER = re.compile(
    "^\\s*(?:#{1,6}\\s*|[-\u2013\u2022>]\\s+|\\*\\s+|\\*{2,3}(?=\\S)|_{2}(?=\\S)|\\d{1,2}[.)]\\s+)*"
)
_META = re.compile(
    r"^\s*(?P<k>job title|company|location|employment type|job type|salary|compensation|pay|"
    r"pay rate|hourly rate|rate|"
    r"duration|schedule|work (?:mode|arrangement|location|type)|reports? to|department|posted|"
    r"job id|requisition(?: id)?|position type)\b[\s*]*:[\s*]*(?P<v>.*)$",
    re.I,
)
_SENT_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")
_HEADING_SENTENCE = re.compile(
    r"^(?:job description\s*:?\s*)?(?:basic|minimum|preferred|key|required|additional|core)?\s*"
    r"(?:qualifications?|requirements?|responsibilit(?:y|ies))\b.*\b"
    r"(?:to be successful|include|are as follows|for this role|for success)\b",
    re.I,
)
_GLUE_END = re.compile(r"(?<=[a-z0-9)])\.(?=[A-Z][a-z]{2,})")  # "growth.Due to" with no space
_ROLE_CUE = re.compile(
    r"\b(?:must|required|requirements?|responsible|responsibilit\w*|years? of|experience (?:with|in|using)"
    r"|proficien\w*|knowledge of|degree|certif\w*|licen[cs]e|hiring|seeking|looking for)\b",
    re.I,
)
_DASH_BULLET = re.compile(r"\s+[-\u2013]\s+(?=[A-Z0-9(])")  # " - item - item" lists on one line
_INLINE_HEAD = re.compile(
    r"(?:Job Description|Key Responsibilities|Responsibilities|Requirements|Qualifications|"
    r"(?:Basic|Minimum|Preferred|Required|Desired) Qualifications|Nice to Have)\s*:",
    re.I,
)
_INLINE_META = re.compile(
    r"(?:Location|Job Type|Employment Type|Salary|Compensation|Pay Rate|Duration|Schedule|"
    r"Work Type|Company)\s*:",
    re.I,
)
_TOKEN = re.compile(r"\.net|[a-z][a-z0-9+#]*(?:[./_][a-z0-9+#]+)*")
_SKIP_ALIASES = {"next", "node", "es", "go", "r", "c", "ml", "ai"}


# ---------------------------------------------------------------- vocabulary and IDF
def _canon_token(name: str) -> str:
    """One token per cluster: separators become '_', a leading dot becomes 'dot'."""
    canon = re.sub(r"[^a-z0-9+#.]+", "_", name.strip().lower()).strip("_")
    return "dot" + canon[1:] if canon.startswith(".") else canon


@lru_cache(maxsize=1)
def _alias_tables() -> tuple[re.Pattern[str] | None, dict[str, str], dict[str, tuple[str, ...]]]:
    """surface -> canonical token, plus canonical -> surfaces. Built from the reviewed alias
    files; short or ambiguous aliases are skipped."""
    surface_to_canon: dict[str, str] = {}
    clusters: dict[str, set[str]] = {}

    def add(primary: str, aliases: list[str]) -> None:
        canon = _canon_token(primary)
        if not canon:
            return
        group = clusters.setdefault(canon, {primary.strip().lower()})
        for a in aliases:
            a = a.strip().lower()
            if len(a) >= 2 and a not in _SKIP_ALIASES:
                group.add(a)

    for fname in ("skills_aliases.json",):
        path = DATA / fname
        if path.exists():
            for primary, aliases in json.loads(path.read_text(encoding="utf-8")).items():
                add(primary, list(aliases))
    path = DATA / "item1_it_aliases.json"
    if path.exists():
        for row in json.loads(path.read_text(encoding="utf-8")).get("rows", []):
            add(str(row["canonical"]), list(row.get("aliases", [])))
    path = DATA / "skills_catalog_domains.json"
    if path.exists():
        for row in json.loads(path.read_text(encoding="utf-8")).get("skills", []):
            add(str(row["skill"]), list(row.get("aliases", [])))
    for canon, group in clusters.items():
        for surface in group:
            if surface not in _SKIP_ALIASES:
                surface_to_canon.setdefault(surface, canon)
    if not surface_to_canon:
        return None, {}, {}
    ordered = sorted(surface_to_canon, key=len, reverse=True)
    pattern = re.compile(
        r"(?<![a-z0-9+#])(" + "|".join(re.escape(s) for s in ordered) + r")(?![a-z0-9+#])"
    )
    canon_to_surfaces = {c: tuple(sorted(g, key=len, reverse=True)) for c, g in clusters.items()}
    return pattern, surface_to_canon, canon_to_surfaces


def normalize(text: str) -> str:
    """Lower-case and replace alias surfaces by one canonical token per cluster."""
    low = text.lower()
    pattern, mapping, _ = _alias_tables()
    return pattern.sub(lambda m: mapping[m.group(1)], low) if pattern else low


def _stem(word: str) -> str:
    # canonical alias tokens are exact names; truncating them made "services" collide with
    # "ServiceNow" and similar pairs
    if "_" in word or word in _alias_tables()[2]:
        return word
    for suf in ("ations", "ation", "ings", "ing", "ments", "ment", "ers", "er", "ies", "es", "ed", "s"):
        if len(word) > len(suf) + 3 and word.endswith(suf):
            word = word[: -len(suf)] + ("y" if suf == "ies" else "")
            break
    # six-letter prefix conflates accounting / accountant / accounts and developer / development
    if len(word) > 4 and word.endswith("e"):  # nurse / nurses, manage / managing
        word = word[:-1]
    return word[:6] if len(word) > 6 else word


def content_tokens(normalized: str) -> list[str]:
    out: list[str] = []
    for w in _TOKEN.findall(normalized):
        w = w.strip("./_")
        if (len(w) >= 3 or "+" in w or "#" in w) and w not in STOP:
            out.append(_stem(w))
    return out


def term_set(text: str) -> tuple[set[str], set[str]]:
    toks = content_tokens(normalize(text))
    return set(toks), {a + " " + b for a, b in zip(toks, toks[1:], strict=False)}


@dataclass(frozen=True)
class IdfTable:
    version: str
    n_docs: int
    df: dict[str, int]
    loaded: bool

    def idf(self, term: str) -> float:
        if not self.loaded:
            return 1.0
        df = max(1, self.df.get(term, 0))  # unseen terms weigh like df=1: no runaway on typos
        return math.log((self.n_docs + 1) / (df + 1)) + 1.0


def table_digest(df: dict[str, int]) -> str:
    h = hashlib.sha256()
    for term in sorted(df):
        h.update(f"{term}\t{df[term]}\n".encode())
    return h.hexdigest()


@lru_cache(maxsize=1)
def load_idf() -> IdfTable:
    if not IDF_PATH.exists():
        return IdfTable("none", 0, {}, False)
    data = json.loads(IDF_PATH.read_text(encoding="utf-8"))
    df = {str(k): int(v) for k, v in data["df"].items()}
    if table_digest(df) != data["table_sha256"]:
        raise ValueError("jd_idf_v1.json does not match its recorded digest")
    return IdfTable(str(data["version"]), int(data["n_docs"]), df, True)


# ---------------------------------------------------------------- JD segmentation
@dataclass(frozen=True)
class Unit:
    id: str
    text: str
    start: int
    end: int
    cue: str
    terms: tuple[str, ...]
    mass: float
    or_groups: tuple[tuple[str, ...], ...] = ()  # alternatives: the best member counts once


@dataclass(frozen=True)
class Segmentation:
    text: str  # canonical text the spans refer to
    units: tuple[Unit, ...]
    not_evaluated: int
    hidden_text: bool
    soft_skills: tuple[str, ...] = ()  # reported as feedback, never scored (Item 2 rule)


def _or_groups(body: str) -> tuple[tuple[str, ...], ...]:
    """'Python, Scala, or Java' and 'GCP and/or Spark' are one requirement with alternatives
    (spec V5): the best-evidenced member earns the credit. Only single content words qualify."""
    groups: list[tuple[str, ...]] = []
    for m in _OR_LIST.finditer(normalize(re.sub(r"\([^)]*\)", " ", body))):
        members = [x.strip() for x in m.group(1).split(",")] + [m.group(2)]
        stems: list[str] = []
        for member in members:
            toks = content_tokens(member)
            if len(toks) == 1:
                stems.append(toks[0])
        if len(set(stems)) >= 2 and len(stems) == len(members):
            groups.append(tuple(dict.fromkeys(stems)))
    return tuple(groups)


def _section_of(label: str) -> str:
    for name, pattern in _SECTION_KEYWORDS:
        if pattern.search(label):
            return name
    return "other"


def _cue_for(chunk: str, section: str) -> str:
    if NOT_MANDATORY.search(chunk):
        return "Preferred"
    req, pref = bool(REQUIRED_CUE.search(chunk)), bool(PREFERRED_CUE.search(chunk))
    if req and pref:
        return "Unlabelled"
    if req:
        return "Required"
    if pref:
        return "Preferred"
    return {"required": "Required", "preferred": "Preferred"}.get(section, "Unlabelled")


def segment(jd_text: str, idf: IdfTable | None = None) -> Segmentation:
    idf = idf or load_idf()
    text, hidden = canonicalize(jd_text or "")
    units: list[Unit] = []
    soft: list[str] = []
    section = "other"
    for line in _CHUNK.finditer(text):
        raw = line.group(0)
        base = line.start()
        # sentences inside one chunk become separate units (flattened text has long chunks)
        points = [(m.start() + 1, m.end()) for m in _SENT_END.finditer(raw)]
        points += [(m.start() + 1, m.end()) for m in _GLUE_END.finditer(raw)]
        if len(_DASH_BULLET.findall(raw)) >= 2:
            points += [(m.start(), m.end()) for m in _DASH_BULLET.finditer(raw)]
        points += [(m.start(), m.start()) for m in _INLINE_HEAD.finditer(raw) if m.start() > 0]
        points += [(m.start(), m.start()) for m in _INLINE_META.finditer(raw) if m.start() > 0]
        points.sort()
        pieces: list[tuple[int, str]] = []
        cursor = 0
        for end, nxt in points:
            if end <= cursor:
                continue
            pieces.append((cursor, raw[cursor:end]))
            cursor = max(nxt, end)
        pieces.append((cursor, raw[cursor:]))
        for off, piece in pieces:
            start = base + off
            marker = _MARKER.match(piece)
            marked_heading = piece.lstrip().startswith("#")
            piece = piece[marker.end() :]
            start += marker.end()
            piece = piece.rstrip().removesuffix("**").rstrip()
            bold_only = bool(re.fullmatch(r"[^*]+", piece)) and raw.strip().startswith("**") \
                and raw.strip().endswith("**")
            meta = _META.match(piece)
            head = _HEADING_PREFIX.match(piece)
            body = piece
            if meta:
                if meta.group("k").lower() != "job title" or not meta.group("v").strip():
                    continue  # location, salary, schedule... are confirm-only, never units
                body = meta.group("v")
                start += meta.start("v")
            elif head:
                section = _section_of(head.group("h"))
                body = piece[head.end() :]
                start += head.end()
            elif len(piece.split()) <= 12 and _HEADING_SENTENCE.search(piece):
                section = _section_of(piece)  # "Required qualifications to be successful in this role"
                continue
            elif len(piece.split()) <= 6 and (
                piece.strip().endswith(":") or piece.isupper() or marked_heading or bold_only
            ):
                section = _section_of(piece)
                continue
            if not body.strip():
                continue
            if section == "skip":
                # flattened text rarely has a heading to end the section, so a piece that states a
                # role requirement ends it instead of being discarded with the company intro
                if _ROLE_CUE.search(body):
                    section = "other"
                else:
                    continue
            noise = [m for m in (BOILERPLATE.search(body), _CONFIRM_LINE.search(body)) if m]
            if noise:
                # pay, location, visa, benefits...: shown to the user, never scored (V6). In a long
                # run-on piece only the text before the first such phrase is kept.
                cut = min(m.start() for m in noise)
                if len(body.split()) <= 20 or cut < 20:
                    continue
                body = body[:cut].rstrip(" ,;:-")
            unigrams, bigrams = term_set(body)
            if _SOFT_LINE.search(body) and len(body.split()) <= 16 and not any(
                u in _stem_to_canon() for u in unigrams
            ):
                soft.append(body.strip())
                continue
            groups = _or_groups(body)
            members = {m for g in groups for m in g}
            terms = tuple(
                sorted(
                    t
                    for t in unigrams | bigrams
                    if t not in members
                    and not (" " in t and any(tok in members for tok in t.split()))
                )
            )
            # a single-skill bullet ("SQL", "Experience with SAP") counts only if its one term is rare
            if len(unigrams) < 2 and not (
                len(unigrams) == 1 and idf.idf(next(iter(unigrams))) >= 2.5
            ):
                continue
            mass = sum(idf.idf(t) for t in terms) + sum(
                max(idf.idf(m) for m in g) for g in groups
            )
            lead = len(body) - len(body.lstrip())
            s0 = start + lead
            units.append(
                Unit(
                    "", body.strip(), s0, s0 + len(body.strip()), _cue_for(body, section),
                    terms, mass, groups,
                )
            )
    ordered = sorted(enumerate(units), key=lambda p: (p[1].cue != "Required", p[0]))
    kept = ordered[:MAX_UNITS]
    kept.sort(key=lambda p: p[0])
    final = tuple(
        Unit(f"u{i + 1}", u.text, u.start, u.end, u.cue, u.terms, u.mass, u.or_groups)
        for i, (_, u) in enumerate(kept)
    )
    return Segmentation(text, final, max(0, len(units) - MAX_UNITS), hidden, tuple(soft[:10]))


# ---------------------------------------------------------------- resume evidence
@dataclass(frozen=True)
class Hit:
    term: str
    quote: str
    start: int
    end: int
    context: str
    mult: float
    status: str  # "Direct" | "Possible"


@dataclass(frozen=True)
class UnitResult:
    unit: Unit
    credit: Fraction
    hits: tuple[Hit, ...]
    missing: tuple[str, ...]
    high_credit: Fraction | None = None



@dataclass
class ResumeIndex:
    text: str
    hidden_text: bool
    unigrams: set[str] = field(default_factory=set)
    bigrams: set[str] = field(default_factory=set)


def index_resume(resume_text: str) -> ResumeIndex:
    text, hidden = canonicalize(resume_text or "")
    uni, bi = term_set(text)
    return ResumeIndex(text, hidden, uni, bi)


@lru_cache(maxsize=1)
def _stem_to_canon() -> dict[str, str]:
    _, _, canon_to_surfaces = _alias_tables()
    return {_stem(c): c for c in canon_to_surfaces}


def _forms(part: str, canon_to_surfaces: dict[str, tuple[str, ...]]) -> str:
    canon = part if part in canon_to_surfaces else _stem_to_canon().get(part)
    if canon is not None and canon in canon_to_surfaces:
        return "(?:" + "|".join(re.escape(x) for x in canon_to_surfaces[canon]) + ")"
    return re.escape(part) + r"[a-z0-9+#]*"


def _surface_regex(term: str) -> re.Pattern[str]:
    """Regex for the surface forms (original spelling, aliases included) of a term."""
    _, _, canon_to_surfaces = _alias_tables()
    if " " in term:
        first, second = term.split(" ", 1)
        return re.compile(
            r"(?<![A-Za-z0-9])" + _forms(first, canon_to_surfaces) + r"\W+(?:\w+\W+){0,2}?"
            + _forms(second, canon_to_surfaces),
            re.I,
        )
    return re.compile(
        r"(?<![A-Za-z0-9+#])" + _forms(term, canon_to_surfaces) + r"(?![A-Za-z0-9+#])", re.I
    )


def _find_hit(index: ResumeIndex, term: str, max_tries: int = 6) -> Hit | None:
    pattern = _surface_regex(term)
    if pattern is None:
        return None
    best: Hit | None = None
    for n, m in enumerate(pattern.finditer(index.text)):
        if n >= max_tries:
            break
        quote = m.group(0)
        if index.text[m.start() : m.end()] != quote:  # verbatim by construction; keep the check
            continue
        mult, status, ctx = _evidence_credit(index.text, (quote, m.start(), m.end()))
        cand = Hit(term, quote, m.start(), m.end(), ctx, mult, status)
        if best is None or cand.mult > best.mult:
            best = cand
        if mult >= 1.0:
            break
    return best


@lru_cache(maxsize=1)
def _implications() -> dict[str, list[tuple[re.Pattern[str], float]]]:
    """implied term (stemmed canonical token) -> [(trigger surface regex, credit)]."""
    path = DATA / "skill_implications.json"
    if not path.exists():
        return {}
    table: dict[str, list[tuple[re.Pattern[str], float]]] = {}
    for row in json.loads(path.read_text(encoding="utf-8"))["rows"]:
        trigger = re.compile(
            r"(?<![A-Za-z0-9+#])(?:" + "|".join(re.escape(t) for t in row["when"]) + r")(?![A-Za-z0-9+#])",
            re.I,
        )
        for implied in row["implies"]:
            toks = content_tokens(normalize(implied))
            if len(toks) == 1:
                table.setdefault(toks[0], []).append((trigger, float(row["credit"])))
    return table


def _implied_hit(index: ResumeIndex, term: str) -> Hit | None:
    for trigger, credit in _implications().get(term, ()):
        m = trigger.search(index.text)
        if m:
            quote = m.group(0)
            mult, status, ctx = _evidence_credit(index.text, (quote, m.start(), m.end()))
            if mult > 0:
                return Hit(term, quote, m.start(), m.end(), ctx, mult * credit, status)
    return None


@lru_cache(maxsize=1)
def _siblings() -> dict[str, list[tuple[re.Pattern[str], float]]]:
    """term (stemmed canonical token) -> [(sibling_pattern, substitutability_credit)]"""
    path = DATA / "skill_siblings.json"
    if not path.exists():
        return {}
    table: dict[str, list[tuple[re.Pattern[str], float]]] = {}
    data = json.loads(path.read_text(encoding="utf-8"))
    for group in data.get("groups", []):
        cred = float(group["credit"])
        members = group["members"]
        for m in members:
            siblings = [s for s in members if s != m]
            if siblings:
                pattern = re.compile(
                    r"(?<![A-Za-z0-9+#])(?:" + "|".join(re.escape(s) for s in siblings) + r")(?![A-Za-z0-9+#])",
                    re.I,
                )
                toks = content_tokens(normalize(m))
                if len(toks) == 1:
                    table.setdefault(toks[0], []).append((pattern, cred))
    return table


def _sibling_hit(index: ResumeIndex, term: str) -> float | None:
    best_credit = 0.0
    for trigger, credit in _siblings().get(term, ()):
        m = trigger.search(index.text)
        if m:
            quote = m.group(0)
            mult, status, ctx = _evidence_credit(index.text, (quote, m.start(), m.end()))
            if mult > 0:
                best_credit = max(best_credit, mult * credit)
    return best_credit if best_credit > 0 else None


def _term_hit(index: ResumeIndex, term: str, cache: dict[str, Hit | None]) -> Hit | None:
    if term not in cache:
        present = term in index.bigrams if " " in term else term in index.unigrams
        hit = _find_hit(index, term) if present else None
        if (hit is None or hit.mult <= 0) and " " not in term:
            hit = _implied_hit(index, term) or hit
        cache[term] = hit
    hit = cache[term]
    return hit if hit is not None and hit.mult > 0 else None


def score_units(
    units: tuple[Unit, ...], index: ResumeIndex, idf: IdfTable | None = None
) -> list[UnitResult]:
    idf = idf or load_idf()
    cache: dict[str, Hit | None] = {}
    results: list[UnitResult] = []
    for unit in units:
        num = den = 0.0
        hits: list[Hit] = []
        missing: list[str] = []
        for term in unit.terms:
            w = idf.idf(term)
            den += w
            hit = _term_hit(index, term, cache)
            if hit is not None:
                num += w * hit.mult
                hits.append(hit)
            else:
                missing.append(term)
        for group in unit.or_groups:  # alternatives: the best member counts, once
            w = max(idf.idf(m) for m in group)
            den += w
            found = [h for h in (_term_hit(index, m, cache) for m in group) if h is not None]
            if found:
                best = max(found, key=lambda h: h.mult)
                num += w * best.mult
                hits.append(best)
            else:
                missing.append("/".join(group))
        credit = F(str(round(num / den, 6))) if den > 0 else F(0)
        high_num = num
        for m_term in missing:
            if "/" in m_term:
                continue
            subst = _sibling_hit(index, m_term)
            if subst is not None:
                high_num += idf.idf(m_term) * subst
        high_credit = min(F(1), F(str(round(high_num / den, 6)))) if (den > 0 and high_num > num) else None
        results.append(UnitResult(unit, min(F(1), credit), tuple(hits), tuple(missing), high_credit=high_credit))
    _apply_stuffing_guard(results, idf)
    return results


def _apply_stuffing_guard(results: list[UnitResult], idf: IdfTable) -> None:
    """Required units matched only from a skills list: list credit drops from 0.8 to 0.5."""
    required = [r for r in results if r.unit.cue == "Required"]
    matched = [r for r in required if r.hits]
    if len(required) < 5 or not matched:
        return
    list_only = [r for r in matched if all(h.context == "skills_list" for h in r.hits)]
    has_experience = any(h.context == "experience" for r in required for h in r.hits)
    if len(list_only) / len(required) < 0.8 or has_experience:
        return
    for i, r in enumerate(results):
        if r.unit.cue == "Required" and r.hits and all(h.context == "skills_list" for h in r.hits):
            mass = sum(idf.idf(t) for t in r.unit.terms) or 1.0
            num = sum(idf.idf(h.term) * 0.5 for h in r.hits)
            results[i] = UnitResult(r.unit, min(F(1), F(str(round(num / mass, 6)))), r.hits, r.missing)


def coverage(results: list[UnitResult]) -> Fraction:
    """Cue-weighted, term-mass coverage in [0, 1]."""
    num = den = F(0)
    for r in results:
        w = CUE_WEIGHT[r.unit.cue] * F(str(round(r.unit.mass, 6)))
        num += w * r.credit
        den += w
    return num / den if den else F(0)


def skill_like_spans(results: list[UnitResult], index: ResumeIndex) -> list[dict]:
    """Every occurrence of an evidenced rare term, for the years-relevance check."""
    idf = load_idf()
    spans: list[dict] = []
    seen: set[str] = set()
    for r in results:
        for h in r.hits:
            if h.term in seen or idf.idf(h.term) < SKILL_LIKE_IDF:
                continue
            seen.add(h.term)
            pattern = _surface_regex(h.term)
            if pattern is None:
                continue
            for n, m in enumerate(pattern.finditer(index.text)):
                if n >= 25:
                    break
                spans.append(
                    {"status": "Direct", "context": _resume_context(index.text, m.start()),
                     "start": m.start(), "end": m.end(), "skill": h.term}
                )
    return spans


# ==============================================================================
# Scoring v3.2: Context Weighting, Generic Capping & Thin-Job Shrinkage
# ==============================================================================

GENERIC_PATH = DATA / "generic_terms_v1.json"
CONTEXT_WEIGHTS_PATH = DATA / "context_weights_v1.json"


@dataclass(frozen=True)
class ContextCfg:
    section_priors: dict[str, float] = field(default_factory=lambda: {
        "experience": 0.85,
        "projects": 0.75,
        "certifications": 0.60,
        "summary": 0.45,
        "education": 0.40,
        "skills": 0.35,
        "skills_list": 0.35,
        "other": 0.50,
    })
    bonus_action: float = 0.10
    bonus_quantified: float = 0.08
    bonus_ownership: float = 0.06
    list_only_cap: float = 0.35


@lru_cache(maxsize=1)
def load_context_cfg() -> ContextCfg:
    if CONTEXT_WEIGHTS_PATH.exists():
        try:
            d = json.loads(CONTEXT_WEIGHTS_PATH.read_text(encoding="utf-8"))
            sec = d.get("section_priors", {})
            bon = d.get("bonuses", {})
            return ContextCfg(
                section_priors=sec,
                bonus_action=float(bon.get("action_verb", 0.10)),
                bonus_quantified=float(bon.get("quantified_outcome", 0.08)),
                bonus_ownership=float(bon.get("ownership_verb", 0.06)),
                list_only_cap=float(d.get("list_only_evidence_cap", 0.35)),
            )
        except Exception:
            pass
    return ContextCfg()


@lru_cache(maxsize=1)
def load_generic_terms() -> tuple[frozenset[str], float, float]:
    """Returns (terms_set, idf_threshold, max_generic_mass_fraction)."""
    if GENERIC_PATH.exists():
        try:
            d = json.loads(GENERIC_PATH.read_text(encoding="utf-8"))
            terms = frozenset(t.lower() for t in d.get("terms", []))
            idf_th = float(d.get("idf_threshold", 1.8))
            max_frac = float(d.get("max_generic_mass_fraction", 0.15))
            return terms, idf_th, max_frac
        except Exception:
            pass
    return frozenset(["git", "agile", "jira", "linux", "team player"]), 1.8, 0.15


_ACTION_VERBS = re.compile(
    r"\b(build|built|design|designed|develop|developed|deploy|deployed|create|created|"
    r"implement|implemented|maintain|maintained|manage|managed|optimize|optimized|"
    r"architect|architected|lead|led|scale|scaled)\b",
    re.I,
)
_QUANT_OUTCOMES = re.compile(
    r"(?:%\s*|\b\d+\s*x\b|\b\d+\s*ms\b|[$₹€£]\s*\d+|\b\d+\s*(?:percent|million|billion|k|users|requests|req/s|rps)\b)",
    re.I,
)
_OWNERSHIP_VERBS = re.compile(
    r"\b(designed|led|built|migrated|owned|architected|spearheaded)\b",
    re.I,
)


@dataclass(frozen=True)
class RequirementUnit:
    uid: str
    text: str
    span: tuple[int, int]
    idf: float
    is_generic: bool
    weight: float


@dataclass(frozen=True)
class RerankedPassage:
    passage_id: str
    text: str
    section: str
    rho: float
    span: tuple[int, int] = (0, 0)


@dataclass(frozen=True)
class Evidence:
    uid: str
    passage_id: str
    section: str
    rho: float
    ctx_weight: float
    value: float
    span: tuple[int, int]


def passage_weight(section: str, text: str, unit_text: str, cfg: Optional[ContextCfg] = None) -> float:
    """Compute context weight w(p) from section prior and bonuses."""
    c = cfg or load_context_cfg()
    sec_key = section.lower()
    w_sec = c.section_priors.get(sec_key, c.section_priors.get("other", 0.50))

    t = text or ""
    a = 1.0 if _ACTION_VERBS.search(t) else 0.0
    q = 1.0 if _QUANT_OUTCOMES.search(t) else 0.0
    o = 1.0 if _OWNERSHIP_VERBS.search(t) else 0.0

    mult = 1.0 + c.bonus_action * a + c.bonus_quantified * q + c.bonus_ownership * o
    return min(1.0, round(w_sec * mult, 4))


def unit_evidence(
    unit: RequirementUnit,
    cands: list[RerankedPassage],
    cfg: Optional[ContextCfg] = None,
) -> Optional[Evidence]:
    """Find the best supporting passage for a requirement unit."""
    c = cfg or load_context_cfg()
    if not cands:
        return None

    best_ev: Optional[Evidence] = None
    best_val = -1.0
    for cand in cands:
        w_p = passage_weight(cand.section, cand.text, unit.text, c)
        val = cand.rho * w_p
        if val > best_val:
            best_val = val
            best_ev = Evidence(
                uid=unit.uid,
                passage_id=cand.passage_id,
                section=cand.section,
                rho=round(cand.rho, 4),
                ctx_weight=w_p,
                value=round(val, 4),
                span=cand.span,
            )

    if best_ev is None:
        return None

    # Anti-keyword-stuffing rule: if all supporting passages with rho > 0.5 are skills_list
    high_cands = [p for p in cands if p.rho > 0.5]
    if high_cands and all(p.section.lower() in ("skills", "skills_list") for p in high_cands):
        capped_val = min(best_ev.value, c.list_only_cap)
        best_ev = Evidence(
            uid=best_ev.uid,
            passage_id=best_ev.passage_id,
            section=best_ev.section,
            rho=best_ev.rho,
            ctx_weight=best_ev.ctx_weight,
            value=round(capped_val, 4),
            span=best_ev.span,
        )

    return best_ev


def apply_generic_cap(units: list[RequirementUnit], max_frac: float = 0.15) -> list[RequirementUnit]:
    """Ensure generic units never exceed max_frac (default 15%) of total requirement mass."""
    if not units:
        return []
    w_total = sum(u.weight for u in units)
    if w_total <= 0:
        return units

    w_gen_raw = sum(u.weight for u in units if u.is_generic)
    if w_gen_raw <= 0:
        return units

    w_non_gen = sum(u.weight for u in units if not u.is_generic)
    # If there are non-generic units, cap generic mass so W_gen / (W_non_gen + W_gen) <= max_frac
    if w_non_gen > 0:
        w_gen_cap = min(w_gen_raw, (max_frac / (1.0 - max_frac)) * w_non_gen)
    else:
        w_gen_cap = w_gen_raw

    scale_g = w_gen_cap / w_gen_raw if w_gen_raw > 0 else 1.0

    adjusted: list[RequirementUnit] = []
    for u in units:
        if u.is_generic:
            new_w = round(u.weight * scale_g, 6)
            adjusted.append(RequirementUnit(u.uid, u.text, u.span, u.idf, u.is_generic, new_w))
        else:
            adjusted.append(u)
    return adjusted


def coverage_v32(units: list[RequirementUnit], ev: dict[str, Evidence]) -> tuple[float, float]:
    """Compute (Coverage, TotalMass) using generic-capped weights."""
    if not units:
        return 0.0, 0.0
    num = 0.0
    den = 0.0
    for u in units:
        w = u.weight
        den += w
        if u.uid in ev:
            num += w * ev[u.uid].value
    c = (num / den) if den > 0 else 0.0
    return round(c, 4), round(den, 4)


def shrink(C: float, W: float, prior: float, k: float = 6.0) -> float:
    """Reliability-weighted thin-job shrinkage toward a domain prior."""
    lam = W / (W + k) if (W + k) > 0 else 0.0
    return round(lam * C + (1.0 - lam) * prior, 4)


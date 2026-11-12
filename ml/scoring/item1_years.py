"""Item 1 V8 years evidence extraction for the Software/IT pilot."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

D = Decimal
_MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_MONTH_PATTERN = (
    r"Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?"
)
_DATE = (
    r"(?:(?P<MONTH>" + _MONTH_PATTERN + r")\.?[ ,/-]*|(?P<NUM>0?[1-9]|1[0-2])[/.-])?"
    r"(?P<YEAR>(?:19|20)\d{2})"
)


def _date_pattern(prefix: str) -> str:
    return (
        _DATE.replace("MONTH", f"{prefix}month")
        .replace("NUM", f"{prefix}num")
        .replace("YEAR", f"{prefix}year")
    )


_RANGE = re.compile(
    r"(?P<start>" + _date_pattern("s") + r")\s*(?:-|–|—|to)\s*"
    r"(?P<end>(?i:present|current|now)|" + _date_pattern("e") + r")",
    re.I,
)
_DAY_FIRST = re.compile(
    r"(?P<sd>\d{1,2})/(?P<sm>\d{1,2})/(?P<sy>\d{4})\s*(?:-|–|—|\bto\b)\s*"
    r"(?P<ed>\d{1,2})/(?P<em>\d{1,2})/(?P<ey>\d{4})"
)
_EXPERIENCE_HEAD = re.compile(
    r"\b(?:work experience|professional experience|employment history|work history|experience)\b",
    re.I,
)
_NONWORK_HEAD = re.compile(r"\b(?:education|academic|skills?|certifications?|awards?)\b", re.I)
_SELF_YEARS = re.compile(
    r"\b(?P<years>\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+)?experience\b",
    re.I,
)
_REQUIRED_YEARS = re.compile(
    r"\b(?P<low>\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*(?:\+\s*)?(?:years?|yrs?)\b"
    r"|\b(?P<plus>\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\b"
    r"|\b(?:(?:at\s+least|minimum(?:\s+of)?|min\.)\s*)?(?P<single>\d+(?:\.\d+)?)\s*(?:years?|yrs?)(?:\s+(?:of\s+)?(?:relevant\s+)?experience)?\b",
    re.I,
)
_SKILL_LINE = re.compile(
    r"\b(?:Python|JavaScript|TypeScript|Java|Kubernetes|K8s|Docker|PostgreSQL|Postgres|SQL|"
    r"Redis|MongoDB|AWS|Amazon Web Services|GCP|Google Cloud Platform|Azure|Microsoft Azure|"
    r"React|Node\.js|FastAPI|Django|Flask|Spring|GraphQL|REST API|Terraform|Ansible|Kafka|"
    r"Jenkins|GitHub Actions|Linux|Git|Microservices)\b",
    re.I,
)
_EDU_CUE = re.compile(
    r"\b(?:bachelor|master|ph\.?d|doctorate|gpa|expected|university|college|degree|diploma|"
    r"graduat\w*|b\.?tech|m\.?tech|b\.?sc|m\.?sc|mba)\b",
    re.I,
)
_TITLE_STOP = {
    "senior", "junior", "lead", "principal", "staff", "associate", "the", "and", "for", "with",
    "job", "title", "description", "position", "role", "remote", "hybrid", "full", "time",
    "part", "contract", "hire", "experienced", "driven", "talented", "seeking", "looking",
}
_TITLE_END = {"location", "duration", "type", "company", "salary", "about", "department"}
_LIST_HEAD = re.compile(r"\b(?:skills?|technical stack|technologies|tooling)\b", re.I)


@dataclass(frozen=True)
class TenureResult:
    required_years: Decimal | None
    candidate_years: Decimal | None
    low_years: Decimal | None
    high_years: Decimal | None
    source: str
    dated_roles: int
    years_component: Decimal | None
    low_component: Decimal | None
    high_component: Decimal | None
    flags: tuple[str, ...]


def _to_date(
    month: str | None, year: str, *, end: bool, as_of: date, num: str | None = None
) -> date:
    if num is not None:
        return date(int(year), int(num), 1)
    if month is None:
        return date(int(year), 1, 1)
    mon = _MONTHS[month.casefold().rstrip(".")]
    return date(int(year), mon, 1)


def extract_required_years(jd_text: str) -> Decimal | None:
    """Extract the smallest numeric minimum from a JD years range or plus expression."""
    values: list[Decimal] = []
    for match in _REQUIRED_YEARS.finditer(jd_text or ""):
        raw = match.group("low") or match.group("plus") or match.group("single")
        if raw:
            value = D(raw)
            if D(0) <= value <= D(50):
                values.append(value)
    return min(values) if values else None


def _experience_sections(text: str) -> list[tuple[int, int]]:
    """Text regions that may hold work history: everything except sections headed Education,
    Skills, Certifications or Awards. Regions are cut at those headings only, so adding or removing
    an Experience heading cannot make the rest of the resume disappear (and text with no readable
    headings is scanned whole; study dates are skipped by the education guard)."""
    regions: list[tuple[int, int]] = []
    open_start: int | None = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        clean = line.strip().rstrip(":")
        words = clean.split()
        heading = bool(clean) and len(words) <= 6 and not re.search(r"[.!?]", clean)
        if heading and _NONWORK_HEAD.search(clean) and not _EXPERIENCE_HEAD.search(clean):
            if open_start is not None and offset > open_start:
                regions.append((open_start, offset))
            open_start = None
        elif heading and _EXPERIENCE_HEAD.search(clean) and open_start is None:
            open_start = offset + len(line)
        offset += len(line)
    if open_start is not None and len(text) > open_start:
        regions.append((open_start, len(text)))
    return regions or ([(0, len(text))] if text.strip() else [])


def _ranges_in_section(
    text: str, begin: int, end: int, as_of: date
) -> list[tuple[date, date, bool, int, int]]:
    section = text[begin:end]
    found: list[tuple[date, date, bool, int, int]] = []
    cursor = 0
    for line in section.splitlines(keepends=True):
        day_match = _DAY_FIRST.search(line)
        if day_match:
            try:
                start = date(int(day_match["sy"]), int(day_match["sm"]), int(day_match["sd"]))
                finish = date(int(day_match["ey"]), int(day_match["em"]), int(day_match["ed"]))
                if finish > start:
                    found.append((start, finish, False, begin + cursor, begin + cursor + len(line)))
            except ValueError:
                pass
        else:
            for match in _RANGE.finditer(line):
                window = line[max(0, match.start() - 40) : match.end() + 40]
                if _EDU_CUE.search(window):
                    continue  # a study period, not a job
                start_text = match.group("start")
                end_text = match.group("end")
                start_m = re.search(_date_pattern("s"), start_text, re.I)
                end_m = (
                    None
                    if re.fullmatch(r"(?i:present|current|now)", end_text)
                    else re.search(_date_pattern("e"), end_text, re.I)
                )
                if not start_m:
                    continue
                start = _to_date(
                    start_m.group("smonth"),
                    start_m.group("syear"),
                    end=False,
                    as_of=as_of,
                    num=start_m.group("snum"),
                )
                if end_m is None:
                    finish = as_of
                else:
                    finish = _to_date(
                        end_m.group("emonth"),
                        end_m.group("eyear"),
                        end=True,
                        as_of=as_of,
                        num=end_m.group("enum"),
                    )
                if finish <= start:
                    if end_m is not None and end_m.group("emonth") is None and start_m.group("smonth") is None:
                        finish = date(start.year + 1, 1, 1)
                    elif end_m is not None and (end_m.group("emonth") is not None or end_m.group("enum") is not None):
                        if start.month == 12:
                            finish = date(start.year + 1, 1, 1)
                        else:
                            finish = date(start.year, start.month + 1, 1)
                if finish > start:
                    year_only = (start_m.group("smonth") is None and start_m.group("snum") is None) or (
                        end_m is not None
                        and end_m.group("emonth") is None
                        and end_m.group("enum") is None
                    )
                    # Match-level offsets so several roles on one flattened line stay separate.
                    found.append(
                        (
                            start,
                            finish,
                            year_only,
                            begin + cursor + match.start(),
                            begin + cursor + match.end(),
                        )
                    )
        cursor += len(line)
    return found


def _interval_union_days(intervals: Iterable[tuple[date, date]]) -> int:
    ordered = sorted(intervals, key=lambda item: item[0])
    if not ordered:
        return 0
    total = 0
    start, end = ordered[0]
    for next_start, next_end in ordered[1:]:
        if next_start <= end:
            end = max(end, next_end)
        else:
            total += (end - start).days
            start, end = next_start, next_end
    return total + (end - start).days


def _interval_union_months(intervals: Iterable[tuple[date, date]]) -> int:
    ordered = sorted(intervals, key=lambda item: item[0])
    if not ordered:
        return 0
    total = 0
    start, end = ordered[0]
    for next_start, next_end in ordered[1:]:
        if next_start <= end:
            end = max(end, next_end)
        else:
            total += (end.year - start.year) * 12 + end.month - start.month
            start, end = next_start, next_end
    return total + (end.year - start.year) * 12 + end.month - start.month


def _uncertain_union_clusters(intervals: Iterable[tuple[date, date, bool]]) -> int:
    """Count disjoint tenure periods whose precision depends on year-only dates."""
    ordered = sorted(intervals, key=lambda item: item[0])
    if not ordered:
        return 0
    uncertain_clusters = 0
    _, end, uncertain = ordered[0]
    for next_start, next_end, next_uncertain in ordered[1:]:
        if next_start <= end:
            end = max(end, next_end)
            uncertain = uncertain or next_uncertain
        else:
            uncertain_clusters += int(uncertain)
            end, uncertain = next_end, next_uncertain
    return uncertain_clusters + int(uncertain)


def jd_title_text(jd_text: str) -> str:
    """The job title as written (best effort): a 'Job Title:' line, a 'Job description - X' header,
    'seeking a X', or a short first line. Empty when none is found."""
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", jd_text or "")
    title = ""
    patterns = (
        r"job\s*title\s*[:\-\u2013]\s*(?P<t>[^\n]{3,80})",
        r"job\s*description\s*[-\u2013:]\s*(?P<t>[^\n]{3,80})",
        r"(?:seeking|looking\s+for|hiring)\s+(?:an?\s+|the\s+)?(?P<t>[A-Za-z][A-Za-z /&-]{2,60}?)"
        r"(?=[.,\n]| to | who | with | for | in )",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            title = match.group("t")
            break
    if not title:
        first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
        title = first if len(first.split()) <= 8 else ""
    title = re.sub(r"[*_#]+", " ", title)
    title = re.split(r"\b(?:location|duration|type|company|salary|department)\b\s*:", title, flags=re.I)[0]
    return " ".join(title.split())


def jd_title_terms(jd_text: str) -> frozenset[str]:
    """Five-letter stems of the words in the job title, used to decide whether a past role
    is relevant when the skill catalogue does not cover the field."""
    title = jd_title_text(jd_text)
    stems: set[str] = set()
    for word in re.findall(r"[A-Za-z]+", title.lower()):
        if word in _TITLE_END:
            break
        if len(word) >= 4 and word not in _TITLE_STOP:
            stems.add(word[:5])
    return frozenset(stems)


def _role_matches_title(text: str, start: int, end: int, stems: frozenset[str]) -> bool:
    if not stems:
        return False
    window = text[max(0, start - 80) : min(len(text), end + 160)]
    window = re.sub(r"([a-z])([A-Z])", r"\1 \2", window).lower()  # heading glued to a title
    words = {w[:5] for w in re.findall(r"[a-z]+", window) if len(w) >= 4}
    # a two-word title ("Data Engineer") needs both words in the role header, so a generic word
    # such as "engineer" alone does not make an unrelated role relevant
    return len(stems & words) >= min(2, len(stems))


def _role_has_nonlist_skill_evidence(
    text: str, start: int, end: int, skill_units: Iterable[dict]
) -> bool:
    block = text[start:end]
    _ = block  # evidence is decided by the matched skill spans below
    # The role must contain a matched non-list-only skill unit and the exact evidence span.
    for unit in skill_units:
        if unit.get("status") not in {"Direct", "Concept"} or unit.get("context") == "skills_list":
            continue
        span_start, span_end = unit.get("start"), unit.get("end")
        if (
            isinstance(span_start, int)
            and isinstance(span_end, int)
            and start <= span_start < span_end <= end
        ):
            return True
    return False


def assess_years(
    resume_text: str,
    jd_text: str,
    skill_units: Iterable[dict],
    as_of: date | None = None,
) -> TenureResult:
    """Assess V8 years without turning missing dates into a knockout.

    Dated relevant role intervals are unioned. Year-only intervals receive the
    design's +/- one-year precision range. With no dated roles, a self-reported
    total is discounted by 0.75; otherwise the assessable years credit is zero.
    """
    as_of = as_of or date.today()
    required = extract_required_years(jd_text)
    if required is None or required == D(0):
        return TenureResult(
            required,
            None,
            None,
            None,
            "not_required" if required == D(0) else "not_stated_in_jd",
            0,
            None,
            None,
            None,
            (),
        )
    sections = _experience_sections(resume_text)
    title_stems = jd_title_terms(jd_text)
    skill_units = list(skill_units)
    relevant: list[tuple[date, date, bool]] = []
    for section_start, section_end in sections:
        ranges = _ranges_in_section(resume_text, section_start, section_end, as_of)
        for start, finish, year_only, line_start, _line_end in ranges:
            # Role evidence runs from this date line to the next date line, or section end.
            next_start = section_end
            for later in ranges:
                if later[3] > line_start:
                    next_start = min(next_start, later[3])
            if _role_has_nonlist_skill_evidence(
                resume_text, line_start, next_start, skill_units
            ) or _role_matches_title(resume_text, line_start, _line_end, title_stems):
                relevant.append((start, finish, year_only))
    flags: list[str] = []
    if relevant:
        base_days = _interval_union_days((start, finish) for start, finish, _ in relevant)
        base_years = D(base_days) / D("365.2425")
        if all(start.day == finish.day == 1 for start, finish, _ in relevant):
            base_years = D(
                _interval_union_months((start, finish) for start, finish, _ in relevant)
            ) / D(12)
        uncertainty = _uncertain_union_clusters(relevant)

        # Decision D4: Stale "Present" role clamp in Low Scenario
        stale_clamped = False
        low_intervals = []
        non_current_finishes = [f for s, f, _ in relevant if f != as_of]
        last_evidence = max(non_current_finishes) if non_current_finishes else None

        for start, finish, _yo in relevant:
            if finish == as_of and (as_of.year - start.year) * 12 + as_of.month - start.month >= 60:
                min_tenure_date = date(start.year + 5, start.month, min(start.day, 28))
                effective_evidence = max(last_evidence, min_tenure_date) if last_evidence else min_tenure_date
                clamped_end = min(as_of, effective_evidence)
                if clamped_end < finish:
                    low_intervals.append((start, clamped_end))
                    stale_clamped = True
                    continue
            low_intervals.append((start, finish))

        if stale_clamped:
            flags.append("stale_current_role_clamped")
            low_days = _interval_union_days(low_intervals)
            low_base_years = D(low_days) / D("365.2425")
            if all(s.day == f.day == 1 for s, f in low_intervals):
                low_base_years = D(_interval_union_months(low_intervals)) / D(12)
            low = max(D(0), low_base_years - D(uncertainty))
        else:
            low = max(D(0), base_years - D(uncertainty))

        high = base_years + D(uncertainty)
        if uncertainty:
            flags.append("year_only_date_precision")
        candidate = base_years
        source = "dated_relevant_roles"
        count = len(relevant)
    else:
        self_reported = [D(m.group("years")) for m in _SELF_YEARS.finditer(resume_text or "")]
        if self_reported:
            candidate = max(self_reported) * D("0.75")
            low = candidate
            high = max(self_reported)
            source = "self_reported_discounted"
            count = 0
            flags.append("self_reported_years")
        else:
            candidate = D(0)
            low = D(0)
            high = required
            source = "no_dated_experience"
            count = 0
            flags.append("no_dated_experience")
    component = min(D(1), candidate / required)
    low_component = min(D(1), low / required)
    high_component = min(D(1), high / required)
    return TenureResult(
        required,
        candidate,
        low,
        high,
        source,
        count,
        component,
        low_component,
        high_component,
        tuple(flags),
    )

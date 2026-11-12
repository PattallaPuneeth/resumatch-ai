# ResuMatch AI — Items 1 + 2: Unified Final Rules (v3.0 DRAFT)

**Status:** design sheet agreed with the owner on 2026-11-11. It replaces the overlap between
`ITEM1_CURRENT_STATUS_SPECIFICATION.md` (V1–V18) and `ITEM2_CURRENT_STATUS_SPECIFICATION.md`.
Where those two disagree, this sheet decides. Nothing here is implemented yet; section 11 lists the build order.

## 0. Owner decisions (locked)

| # | Decision |
|---|---|
| D-1 | **One scoring engine** for Items 1 and 2: one score, one band, one range. Exact `Fraction` arithmetic. |
| D-2 | **Sibling-tool credit (MySQL for PostgreSQL) is range-only.** It never raises the observed score; it appears in the "if accepted" range and the gap list. |
| D-3 | **Mandatory gates = a required degree, or a licence/registration the law requires for the role.** Salary, location, notice period, shift, age, gender, GPA, university name etc. are shown in a "self-check" panel and never scored or capped. |
| D-4 | **First 5 domains:** Software/IT, Healthcare, Skilled trades, Accounting & finance, Legal. Any other domain still scores (skills + years + education); it just has no licence registry, so licence gates read `Unknown`. |
| D-5 | **`Unknown`** = a degree/licence the JD requires but the resume doesn't state (left out of the score). **`Not evidenced`** = a JD skill absent from the resume (counts against the score). |
| D-6 | Real resume/JD test pairs with the owner's verdicts are supplied **after** this design is finished. |

## 1. What the user sees (explainable output)

Every result must contain all of these, in plain language:

1. **Score 0–100** and **band**: No Fit 0–39, Potential Fit 40–69, Good Fit 70–100.
2. **Range** when something is unresolved: "Observed 71. If your licence is confirmed: 71. If not: 63."
3. **Why this score**: per component (skills, years, education/credentials), its credit, its weight, and the points it contributed.
4. **What matched**: each JD requirement with the resume quote that proves it.
5. **What's missing**: each requirement with status `Not evidenced`, `Partial`, `Not met` or `Unknown`, worded as "Not evidenced on the resume", never "you lack".
6. **How to fix it** (deterministic, per gap): the points that gap costs and the action ("Add a bullet showing where you used Kubernetes: +4.2 pts"). The point values come from re-running the scorer with that gap closed.
7. **Please confirm** list: licences/degrees marked `Unknown`, and the self-check panel (salary, location, etc.).
8. **Confidence** (High/Medium/Low) with the reason.

No ATS score, readability grade or formatting score is shown anywhere (Item 4). Parse quality only feeds confidence (section 8).

## 2. Status vocabulary

| Status | Meaning | In score? |
|---|---|---|
| `Met` | Evidence found and requirement satisfied | Yes, credit 1.0 (times context multiplier) |
| `Partial` | Related or in-progress evidence | Yes, credit per section 4 |
| `Not met` | Resume affirmatively shows a shortfall (e.g. lists Diploma as highest when Bachelor's is required; licence expiry date in the past) | Yes, credit 0 |
| `Not evidenced` | JD **skill** not on the resume | Yes, credit 0 |
| `Unknown` | Mandatory **gate** or **dates** not stated or unparseable | No (excluded; shown in range) |
| `Confirm-only` | Section 3 classes; vague "or equivalent" with no formula | No, never |
| `Not assessable` | JD term not in the skill graph and no literal hit; or text in an unsupported script | No (excluded from denominator) |

## 3. Confirm-only classes (never scored, never capped)

Salary/CTC, notice period, work mode/location/relocation, shifts/travel, age/DOB/gender/marital status/photo/caste/nationality/domicile,
physical or medical standards, GPA/percentage/university pedigree, security clearance/bond.
Shown in the panel "Self-check requirements (verify before applying)".

## 4. Requirement units and skill credit

**Units.** Max 25 skill units and 10 gate units per JD (Required first, then document order); extra items listed as "not evaluated".
Repeated mentions merge to one canonical skill and keep the highest weight. "X or Y or Z" is one unit scored as the best alternative.
Generic soft skills are shown as feedback and never scored.

**Weights.** Required 1.0; Unlabelled (neutral bullet under requirements) 0.75; Preferred 0.5.
Cues come from fixed patterns only: required = must have, required, essential, mandatory, minimum qualification; preferred = preferred, nice to have, added advantage, plus, desirable.

**Credit ladder `c`** (takes the highest rung found):

| Rung | `c` | Status |
|---|---|---|
| Direct literal or verified alias | 1.0 | Met |
| Child implies parent (FastAPI → Python) | 0.9 | Met |
| Parent concept for a specific tool (Container orchestration → Kubernetes) | 0.6 | Partial |
| Sibling tool (MySQL → PostgreSQL) | **0 observed**; high scenario = substitutability (High 0.70, Medium 0.50, Low 0.25, None 0) | Not evidenced + "if accepted" gain |
| Possible semantic match | 0 observed; high scenario 0.50 | Not evidenced + "please confirm" |
| JD skill not in graph | literal hit 1.0, else excluded | Met / Not assessable |

**Context multiplier `M`:** job/project bullet 1.0; certification 0.85; skills-list only 0.80; coursework 0.65.
Credit of a skill = max over its evidence of `c × M`, times depth factor `min(1, Y_skill / N)` only when the JD states tenure for that skill.
**Keyword-stuffing guard:** if ≥5 required skills and ≥80% of matches come only from a skills list, list multiplier drops to 0.50.

**Evidence integrity.** Every fact needs `(start, end, verbatim)` and Python must confirm `source[start:end] == verbatim` (one whitespace/Unicode-normalised retry; else discard, never crash).
Negated mentions ("no experience in X") = 0; "learning/basic exposure" = Possible (0 observed).
Hidden/zero-width text is excluded and flagged. A ≥30-token JD sentence copied ≥80% is downgraded to list-only credit.
Resume and JD text are data only; the extraction model gets no tools.

`S_sk = Σ w·credit / Σ w` over assessable units. If the assessable weight `M_sk` is below 3, the skill weight shrinks:
`W_sk_eff = 0.60 × min(1, M_sk/3)`. If `M_sk = 0`, skills are Silent.

## 5. Years of experience

- Only roles where at least one required/relevant skill is evidenced count.
- Dates become month indices over half-open intervals; **union of intervals**, so overlapping jobs count once. Year-only dates span the full year; the point estimate is the midpoint, the low/high scenarios use the pessimistic/optimistic ends.
- Role kind weight: full-time/contract/freelance 1.0; apprenticeship 1.0 observed, 0.5 low; part-time/internship 0.5 observed, 1.0 high.
- **Stale "Present" guard:** a current role started ≥5 years before `as_of` is clamped in the low scenario to `min(as_of, max(last_evidence_date, start+60 months))`. `as_of` is always passed in; the engine never reads the clock.
- `S_yr = min(1, Y / Y_req)`. Experience is continuous, never a knockout. If the JD names no years, years are Silent.
- **Missing dates (decision made here to reconcile the two specs):**
  - Dates present but ambiguous → bounded by the low/high scenarios, observed = midpoint.
  - Roles listed with **no dates at all** and a stated total ("5+ years"): `Y = stated × 0.75`, flagged "self-reported".
  - No dates and no stated total: `S_yr = 0` observed (`Not evidenced`), high scenario 1.0. Leaving dates out can never raise the score.
- An experience clause that satisfies an education alternative ("Bachelor's OR 4 years") is owned by the gate and removed from `Y_req`.

## 6. Education and credential gates

**Education ladder:** 0 None, 1 Vocational/Certificate, 2 Diploma/Associate, 3 Bachelor's, 4 Master's, 5 Doctorate (`ml/schemas/education_ladder.json`).
Met 1.0 (level ≥ required); Partial 0.5 (degree in progress); Not met 0 (resume states a lower highest degree); silent → Unknown.
"Bachelor's or N years" with numeric N: Met if `Y ≥ N`. Vague "or equivalent": Confirm-only. University name, rank and year are never read.

**Licence/credential gate** (`ml/schemas/credential_registry.json`): Met 1.0 (stated, right jurisdiction); Partial 0.5 (in progress, a lower stage on the same pathway, or another jurisdiction with a recognised transfer); Not met 0 (resume shows an expiry date in the past); silent → Unknown.
Registry entries need a source URL and review date. The engine reads what the resume says and never verifies it with an issuer.

Gate weights: mandatory 1.0, preferred 0.5. `S_ec = Σ w·credit / Σ w` over assessable gates.

## 7. Score, cap and range

Active components: skills (0.60), years (0.25), education/credentials (0.15). Domain/title overlap weight is 0 (informational).
Silent components drop out and the rest rescale:
`Raw = 100 × Σ W_i·S_i / Σ W_i` over active components. If no component is active, `score = null`, status `insufficient_jd_signal`.

**Mandatory-gate cap:** if any mandatory gate is `Partial` or `Not met`, `Score = min(Raw, 69)`.
The cap only lowers a score that is above 69. It never pushes a score below 40 into a lower band.

**Scenarios** (always `low ≤ observed ≤ high`):

| | Observed | Low | High |
|---|---|---|---|
| Unknown mandatory gate | excluded | 69 cap applies (education/credential credit not zeroed) | counts as Met |
| Unknown years | excluded (or rule in section 5) | `S_yr = 0` | `S_yr = 1` |
| Sibling / possible match | 0 | 0 | substitutability × M |
| Date uncertainty | midpoint | pessimistic | optimistic |

**Arithmetic:** `Fraction` throughout; divide once; final integer = `(2·num + den) // (2·den)` (half-up). Weights shown to the user use largest-remainder rounding so they sum to 1.000; display only.

## 8. Confidence and verdict withholding

Coverage = assessable weight ÷ total weight of units the JD asked for. Spread = high − low.

| Level | Rule |
|---|---|
| High | spread ≤ 10, coverage ≥ 70%, ≥ 2 active components, clean parse |
| Low | spread > 30, or coverage < 40%, or only 1 active component |
| Medium | everything else |

Medium is the ceiling when skills are Silent, an unknown mandatory gate exists, the parse is Degraded, or 5–50% of the text is in an unsupported script.
**Low confidence:** show the score and evidence but withhold the band ("Insufficient comparable data for a reliable verdict").
Parse `Failed`, or ≥50% unsupported script: abstain. Public-sector notices (Advt No., age relaxation, pay matrix): withhold the band ("comparison score only").
(Reconciliation: Item 1 used 80%/50% coverage cut-offs, Item 2 used 70%/40%. This sheet uses Item 2's, the later version.)

## 9. The only two LLM calls

| Call | When | Does | Never does |
|---|---|---|---|
| **1. Extraction** | before scoring | returns verbatim spans with offsets for skills, roles/dates, education, credentials and JD requirements with their cue words | score, rank, pick a band, decide a canonical name or a status |
| **2. Explanation** | after scoring | rewrites the deterministic result (section 1) as supportive advice | change any number, status, band or order |

PII (phone, email, address, national ID) is removed before either call. Item 3 (improvements) adds its own separate summary call and obeys the same "no numbers" rule; its fixes and checks are deterministic linters.
If the LLM is unavailable the user still gets the full deterministic result.

## 10. Rules for the first five domains

| Domain | What counts as a mandatory gate | Notes |
|---|---|---|
| Software/IT | A stated required degree. Certifications (AWS etc.) are skills-with-context, not gates, unless the JD says mandatory. | Many JDs have no gate; education/credentials then goes Silent. |
| Healthcare | Required degree (e.g. BSc Nursing) and the council/state registration | Registration unstated → Unknown (range shown), never a failure. |
| Skilled trades | Trade certificate (e.g. ITI) or licence (wireman permit) | "ITI or 3 yrs field experience" is an OR gate; the experience is owned by the gate. |
| Accounting & finance | Professional membership (CA, CPA) and certificate of practice if the JD requires it | Stage below the required one (CA Inter for CA) = Partial 0.5. NISM-type certificates have validity years, but expiry is never inferred from a date. |
| Legal | Bar enrolment where the JD requires it | Inter-state transfer per the registry's recognition mode. |

Registry rows for these five must each carry a verified source and review date before they ship. Section 11 tracks this.

## 11. Build order after this sheet

1. Fix this sheet with the owner's review (current step).
2. Registry data for the five domains with verified sources (existing rows: NISM XV, NISM XXV-A, IT certs).
3. Unified scorer and tests: Item 2 fixtures F1–F7 and Item 1's 34 golden cases must all pass.
4. Gate evaluation (education ladder + credential registry).
5. Extraction call wiring with span verification.
6. Fix-tip generator (re-score with each gap closed).
7. Owner's 10–20 real pairs as the acceptance test.
8. Remove ATS score/readability UI and the old `job_match` / hybrid scorer paths.

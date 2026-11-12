# ResuMatch AI — Item 1: Complete Status & Deploy-Ready Verdict Specification
**Document ID:** `SPEC-ITEM1-VERDICT-V2.1`  
**Date:** 10 November 2026  
**Status:** Unified Design Specification & Current Implementation State  
**Deploy-Readiness Estimate:** ~55% (Core Logic & Arithmetic: 100% | Authority Data: 30% | E2E Integration: 40%)

---

## 1. Executive Summary & Core Architectural Principles

Item 1 defines the **verdict engine** for ResuMatch AI: mapping an arbitrary Resume + Job Description (JD) pair into one of three candidate guidance bands (**No Fit**, **Potential Fit**, **Good Fit**), enforcing deterministic caps on mandatory gates, and delivering explainable, evidence-grounded feedback.

### Non-Negotiable Core Principles
1. **Deterministic Execution:** The verdict band and all gate caps are computed by 100% deterministic Python code. **An LLM never assigns a score, selects a verdict band, or determines a cap.**
2. **LLMs as Verbatim Extractors and Explanators Only:**
   - *Extraction (Pre-scoring):* Extracts exact text spans with character offsets (`start_char`, `end_char`).
   - *Explanation (Post-scoring):* Summarizes deterministic findings into supportive candidate guidance.
3. **Evidence-Grounded (Silence Is Never Failure):**
   - Unstated qualifications or licenses are marked `Unknown` or `Not stated`.
   - Silence on a credential or degree never lowers a score or triggers a cap unless affirmative evidence of shortfall is present (e.g. candidate explicitly states a lower diploma when a bachelor's is required).
4. **Candidate Guidance Framing:**
   - Tone is supportive and non-punitive.
   - Outputs read: *"Not evidenced on the resume"*, never *"You lack"* or *"Candidate failed"*.
5. **Universal Domain Neutrality:**
   - Rules apply symmetrically across all 28 economic sectors (Software, Healthcare, Trades, Legal, Finance, Education, Manufacturing, etc.).
6. **No ATS Scoring (Item 4 Compliance):**
   - No ATS scores, formatting penalties, or readability grades exist. Parse quality is only an internal confidence signal.

---

## 2. Verdict Bands & Thresholds

| Band | Numeric Range | Definition & Eligibility | Candidate Guidance Display |
|:---:|:---:|---|---|
| **No Fit** | `0 – 39` | Significant shortfall across required skills and relevant experience. Less than 40% evidence coverage. | *"Significant gaps in core required competencies and experience for this role. Review the required skills list below."* |
| **Potential Fit** | `40 – 69` | Moderate alignment with core requirements, OR high raw score ($\ge 70$) that is capped due to an unmet or partial mandatory gate. | *"Solid foundation with partial alignment. You meet several core requirements, but key gaps or unconfirmed credentials should be addressed."* |
| **Good Fit** | `70 – 100` | Strong alignment across required skills, experience, and education. Requires all mandatory gates to be `Met` (or unstated/unknown) and score $\ge 70$. | *"Strong alignment with the role's stated requirements and experience profile."* |

---

## 3. The Complete Verdict Rules Engine (V1 to V18)

### V1 — Input Ingestion & Language Gate
- Supported inputs: UTF-8 text from PDF, DOCX, TXT.
- Unsupported script token ratio $L = \frac{\text{unsupported script chars}}{\text{total chars}}$:
  - $L \le 0.05$: Process normally (informational banner).
  - $0.05 < L < 0.50$: Unsupported spans are ignored and listed; unmatched skills become `Not assessable` (not penalized as gaps); confidence capped at `Medium`.
  - $L \ge 0.50$: Engine **abstains**: *"Unsupported language or script; no reliable match possible."*
- Scanned documents: OCR processed. If mean character confidence $< 0.85$ or clean text $< 200$ characters, trigger user review of extracted text before scoring, else abstain.

### V2 — Parse Quality & Structural Confidence
- Parse statuses: `OK`, `Degraded`, `Failed`.
- `Failed`: Engine abstains.
- `Degraded`: Confidence capped at `Medium`. If roles cannot be dated, experience defaults to `Not assessable` (see V8 date-stripping protection).

### V3 — Verbatim Evidence Verification
- Every extracted fact carries `(doc_id, start_char, end_char, verbatim_text)`.
- The engine slices `source_text[start_char:end_char]`. If it does not match `verbatim_text`, the fact is discarded.
- No verified span $\rightarrow$ zero credit.

### V4 — Evidence Integrity & Anti-Gaming Guards
- **Hidden Text:** Off-page, white-on-white, zero-font, or zero-width character text is excluded, flagged, and shown as *"hidden text excluded"*.
- **Negation Guard:** Any mention within a 6-token window of negative markers (*"no experience in"*, *"never used"*, *"not familiar with"*) receives zero credit ($c=0$).
- **In-Progress Guard:** Mentions with *"learning"*, *"basic exposure"*, *"pursuing"* receive `Possible` status ($0$ point credit; listed under *"Confirm your proficiency"*).
- **JD Echo / Verbatim Copying:** Verbatim copy $\ge 80\%$ of a $\ge 30$-token JD sentence is downgraded to `skills_list_only` credit and flagged for review.
- **Prompt Injection Defense:** Resumes and JDs are parsed strictly as passive string data inside typed schemas. Tools/functions are never exposed to the extraction LLM prompt.

### V5 — JD Requirement Segmentation & Priority Tagging
- Section headings dictate default bullet weights.
- Priority parsed strictly from deterministic cue patterns:
  - **Required (weight 1.0):** *"must have"*, *"required"*, *"essential"*, *"minimum qualification"*, *"mandatory"*, *"compulsory"*.
  - **Preferred (weight 0.5):** *"preferred"*, *"nice to have"*, *"added advantage"*, *"plus"*, *"desirable"*.
  - **Unlabelled (weight 0.75):** Neutral bullet in requirements section without explicit cue.
- Upper caps: Maximum 25 skill units and 10 gate units per JD (evaluated in order: Required first, then document order). Excess items are listed as *"not evaluated"*.
- **OR Groups:** *"X or Y or Z"* parsed as a single unit taking $\max(\text{credit})$ of the alternatives.

### V6 — Universal Confirm-Only Classes (Never Scored, Never Capped)
The following parameters are **strictly excluded** from score calculations and caps across all domains:
1. Salary / CTC / LPA expectations
2. Notice period / Immediate joiner
3. Work mode / On-site / Remote / Hybrid / Relocation
4. Shift timings / Night shift / Travel willingness
5. Protected characteristics: Age, Date of Birth, Gender, Marital/Family status, Photo, Caste/Category, Nationality, Domicile/Native place
6. Physical standards / Appearance / Medical fitness
7. Academic percentage / GPA / University pedigree (e.g. "IIT/NIT only")
8. Security clearance / Bond requirements
*Action:* Displayed cleanly in a separate UI panel: *"Self-check requirements (verify before applying)"*.

### V7 — Skill Matching Ladder & Credits
Skill matching strictly follows this priority hierarchy:
1. **Direct Match ($1.0$ credit):** Exact verbatim hit or verified alias in the skill graph. Status: `Met`.
2. **Implied Edge ($0.9$ credit):** Child skill implies parent tool (e.g. *FastAPI* implies *Python*; *React* implies *JavaScript*). Status: `Met`.
3. **Parent Concept Subsumption ($0.6$ credit):** Candidate mentions high-level concept when JD requests a tool, or vice versa (e.g. *Workflow Orchestration* for *Airflow*). Status: `Partial`.
4. **Sibling Tool Substitution ($C_{\text{subst}}$ credit):** If both tools share a parent concept, credit is governed by that concept's substitutability:
   - High Substitutability: $0.70$ (e.g., Snowflake vs BigQuery, Jenkins vs GitLab CI)
   - Medium Substitutability: $0.50$ (e.g., React vs Vue, Postgres vs MySQL)
   - Low Substitutability: $0.25$ (e.g., MongoDB vs Cassandra)
   - None: $0.00$ (e.g., Python vs C++)
   *(Note: under Item 2 latest update, sibling/concept substitutions are range-only by default unless owner enables scored sibling credit).*
5. **Context Evidence Multipliers:**
   - Evidenced in Job / Project bullet: $\times 1.0$
   - Evidenced in Certification: $\times 0.85$
   - Evidenced in Coursework: $\times 0.65$
   - Skills section list only: $\times 0.80$ (default)
6. **Keyword Stuffing Guard:** If $\ge 5$ required skills exist and $\ge 80\%$ are matched **only** from a skills-list section with zero project/job bullet evidence, the list multiplier drops to $\times 0.50$ and displays: *"Add described project/job experience for listed skills"*.
7. **Unmapped Skills:** A JD term missing from the skill graph is tested for exact literal match ($1.0$). If missing, it is marked `Not assessable` and **excluded** from the cap denominator, preventing penalization for graph omissions.

### V8 — Experience & Continuous Years Calculation
- Candidate years $Y_{\text{cand}}$: Sum of months of the **interval union** of dated roles where at least one required or relevant skill was evidenced (concurrent overlapping jobs are counted exactly once).
- $S_{\text{yr}} = \min\left(1.0, \frac{Y_{\text{cand}}}{Y_{\text{req}}}\right)$.
- **No Knockout:** Experience is continuous, not a hard barrier.
- **Date-Stripping Guard:** If dates are missing or omitted:
  - If candidate states a total years number in summary (e.g. *"5+ years experience"*): $Y_{\text{self}} \times 0.75$, flagged *"self-reported"*.
  - If no dates and no summary: $S_{\text{yr}} = 0$ (`Not evidenced`), with if-confirmed range shown. Omitting dates can **never** raise a score.

### V9 — Education Gate Evaluation
- Ordinal levels: `0: None`, `1: Vocational/Certificate`, `2: Diploma/Associate`, `3: Bachelor's`, `4: Master's`, `5: Doctorate`.
- **Met ($1.0$):** Candidate level $\ge$ JD required level.
- **Not Met ($0.0$):** Candidate explicitly states highest completed degree below JD requirement (e.g. JD requires Bachelor's, candidate lists Diploma as highest).
- **Partial ($0.5$):** Degree currently in progress.
- **Equivalence Rule:** If JD explicitly states an experience substitution (e.g. *"Bachelor's or 4+ years relevant experience"*), candidate qualifies for `Met` if $Y_{\text{cand}} \ge 4$. If JD states vague *"or equivalent"* without a numeric formula, mark as `Confirm-only` (excluded from score calculation).
- University rank, tier, institution name, and graduation year are **never** read.

### V10 — Credential & Licensing Gate Evaluation
- Verified against a structured domain registry (`jurisdiction`, `validity_period`, `profession`, `stage`).
- **Met ($1.0$):** Resume explicitly states the credential matching the required jurisdiction.
- **Partial ($0.5$):** Credential in-progress, or held in a different jurisdiction where reciprocity/transfer applies.
- **Not Met ($0.0$):** Resume explicitly states an expiry date in the past without renewal.
- **Unknown (Excluded):** Silence on a license/credential is treated as `Unknown`—never assumed failed. Excluded from numerator and denominator; reported in the *"Please confirm"* checklist.

### V11 — Domain & Title Overlap
- Default weight set to $0.00$ (informational only). Eliminates false penalties against career-switchers or versatile candidates.

### V12 — Status Semantics & Normalization Exclusions
- Assessed statuses: `Met`, `Partial`, `Not met`, `Not evidenced`.
- Excluded statuses: `Unknown`, `Confirm-only`, `Not assessable`.
- Excluded items are removed from both numerator and denominator; remaining components renormalize smoothly.

### V13 — 0–100 Decimal Score Calculation
- Calculated via `Decimal` arithmetic with half-up rounding.
- Default weights: Skills $0.60$, Experience $0.25$, Education/Credentials $0.15$.

### V14 — The Mandatory Gate Cap (69 Potential Fit Ceiling)
- If any **mandatory gate** (Required Education or Required Regulated Credential) is affirmatively `Not met` or `Partial`:
  $$\text{Score}_{\text{final}} = \min(\text{Raw Score}, 69)$$
- **Non-punitive Boundary:** A cap only acts as a ceiling at $69$. It can **never** push a candidate from Potential Fit down into No Fit (a score between 40 and 69 remains untouched).

### V15 — Uncertainty & Scenario Ranges
- **Observed Score:** Deterministic score from verified evidence.
- **Conditional Scenario Range:** If unresolved gates (`Unknown`) exist:
  - *High Scenario:* All unresolved gates confirmed $\rightarrow$ score recomputed with `Met`.
  - *Low Scenario:* Unresolved gates not held $\rightarrow$ score recomputed with `Not met` (and cap applied).
  - Displayed as: *"Observed: 71 (Good Fit). Range if unconfirmed credentials held: 63 – 71."*

### V16 — Confidence Scoring & Verdict Withholding
- **High Confidence:** $\ge 80\%$ assessable coverage, clean parse, no band-crossing scenarios.
- **Medium Confidence:** $50\% – 79\%$ coverage, degraded parse, or conditional range crosses a band threshold.
- **Low Confidence:** $< 50\%$ coverage or $< 3$ assessable requirement units.
- **Withholding Rule:** Under Low Confidence, the numerical comparison score and evidence are displayed, but the verdict label is withheld: *"Insufficient comparable data to determine a reliable verdict."*

### V17 — Public Sector & Recruitment Notification Boundary
- If a JD exhibits public-sector notification cues (*"Advt No."*, *"Age relaxation"*, *"Pay scale matrix"*), the verdict is withheld and marked *"Comparison score only; official eligibility determined by gazette/notification terms."*

### V18 — Privacy, Anonymization & Data Hygiene
- PII (phone number, email address, home address, photo, national ID) is stripped prior to any LLM prompt.
- Resume data is processed in-memory for the comparison session and discarded according to tenant configuration.

---

## 4. Current Implementation State in Repository

### Current Code & Data Assets:
1. `ml/scoring/item1.py`:
   - Full `Decimal` implementation of `calculate_score`, `round_half_up_nonnegative`, `conditional_range`, and `verdict`.
   - All 34 golden test cases verified and matching arithmetic hand calculations.
2. `ml/scoring/item1_years.py`:
   - Exact interval union math for overlapping jobs, month calculations, and date parsing.
3. `ml/scoring/item1_extraction.py`:
   - Regex-based span validator and verified alias loader for Software/IT pilot.
4. `ml/scoring/item1_assessment.py`:
   - Complete pipeline wiring for Software/IT pilot.
5. Data files:
   - `ml/data/item1_it_aliases.json`: Software/IT canonical skills and aliases.
   - `ml/data/item1_education_levels.json`: Ordinal education ladder.
   - `ml/data/item1_in_india_credentials.json`: Initial credential registry schema.

### What is Missing for 100% Deploy-Ready State:
- **Authority Data:** Population of non-IT credentials (nursing councils, bar councils, ICAI, electrical wireman permits, commercial driver classes).
- **Extraction E2E Wiring:** Direct integration of the Fastify backend job queue (`ml/worker.py`) calling the Python span extraction endpoint and feeding `item1_assessment.py`.
- **Validation Dataset:** 10–20 hand-labeled golden pairs across diverse domains verifying end-to-end output.

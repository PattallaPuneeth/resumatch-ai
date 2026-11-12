# Research & Gap-Resolution Prompt: Bringing Item 2 to 100% Deploy-Ready

**Instructions for the Reviewer / AI System:**
You are acting as a **Principal Reliability & Distributed Systems Engineer** and **Lead Applied AI Architect**.
Your task is to conduct an adversarial, rigorous review of **ResuMatch AI — Item 2: Deterministic 0–100 Scoring Pattern & Numerical Rules Specification** (attached as Document 1: `ITEM2_CURRENT_STATUS_SPECIFICATION.md`) and the **Technical Reference Dossier** (Document 3: `ITEM2_AI_TOOL_REFERENCE_DOSSIER.md`).

Your objective is to find every remaining numerical flaw, mathematical anomaly, cross-domain failure, unhandled boundary condition, or component-weight distortion in Item 2, and provide **concrete, deterministic, production-grade solutions** so the scoring engine can be deployed immediately across all 28 major economic sectors.

---

## 1. Non-Negotiable Project Constraints (Do NOT Violate)

When proposing fixes, you must obey these permanent system invariants:
1. **Zero LLM Scoring:** The 0–100 score, component sub-scores, scenario bounds, and caps MUST be computed 100% by deterministic code. An LLM may NEVER assign scores, adjust weights, or choose canonical names.
2. **Fixed 2-Call LLM Operating Budget:**
   - Call 1: Combined verbatim extraction (literal string spans with character offsets).
   - Call 2: Candidate guidance explanation (translating deterministic scoring JSON into supportive feedback).
3. **Evidence-Grounded (Silence Is Never Failure):** Unstated credentials, skills, or experience are marked `Unknown` and excluded from scoring. Silence is never assumed failure.
4. **Dynamic Rescaling Invariant:** When a component is silent in the JD, the active weights must rescale proportionally to sum exactly to 1.0 (100%), and the active set must be reported.
5. **No ATS Scoring (Item 4 Compliance):** Absolutely no ATS scores, readability grades, layout penalties, or keyword stuffing multipliers are surfaced to users.
6. **Decimal Precision & Rounding:** All intermediate calculations must use exact rational arithmetic or `Decimal` with half-up rounding $\lfloor x + 0.5 \rfloor$.

---

## 2. Specific Investigation Areas You Must Audit

### Area A: Mathematical Robustness & Boundary Arithmetic
- **Division by Zero:** How does the engine behave if a JD has 0 required skills, or if all extracted JD skills are unmapped in the graph? Does $\sum w_k = 0$ throw an exception or produce NaN?
- **Extreme Imbalance:** What happens if a JD has 25 skills and 0 years experience required, versus a JD with 1 skill and 10 years experience required? Does dynamic weight rescaling warp the relative value of skills vs experience?
- **Single Component Active:** If a JD only states "Must have 3 years experience" and lists no specific skills or degree, does the score rely 100% on $S_{yr}$? How is this communicated in confidence ratings?
- **Decimal Rounding Drift:** Do cumulative floating point calculations in multi-unit JDs introduce rounding errors that push borderline candidates across band boundaries (e.g. 69.4999 vs 69.5)?

### Area B: Cross-Domain Scoring Mechanics (Beyond Tech)
- **Regulated Healthcare / Nursing:** A nurse has 8 years of clinical experience and 100% direct skill matches, but their state registration is unstated. The Observed Score is 95, but what is the Low Scenario score? Does the Low Scenario correctly bind the mandatory cap at 69 without dropping below 40?
- **Skilled Trades & Vocational (ITI / Polytechnic):** How does the experience union calculate apprentice hours versus full-time journeyman experience? If a trade JD asks for "ITI or 3 years field experience", how does the engine evaluate a candidate with an ITI and 1 year experience?
- **Chartered Accountancy & Finance:** A candidate has "CA Inter" (completed articleship, intermediate exams passed, final pending). How does $S_{ec}$ score this against a JD requiring a full "Chartered Accountant"? Does the 0.5 partial credit trigger a mandatory cap?
- **Sales & Operations:** Sales JDs frequently omit hard degrees and emphasize soft negotiation skills or generic business processes. How does the engine score JDs where 80% of bullets are soft skills?

### Area C: Sibling Substitutability & Domain Adjacency
- **The Versatility Penalty:** In naive vector/histogram matching, a candidate with broad experience across multiple domains (e.g., Data Science + DevOps) is penalized compared to a narrow specialist. How does the Item 2 formula guarantee that broad candidates are never penalized for extraneous skills?
- **Sibling Credit Calibration:** When a JD asks for *BigQuery* and the candidate only has *Snowflake*, should the Observed Score give 0 credit or partial credit? If default observed credit is 0.0, how should the High Scenario reflect substitutability without confusing the candidate?
- **Graph Gap Shield:** When an obscure industry tool is requested by a JD and does not exist in the skill graph, how does the engine ensure the candidate's score is not artificially depressed?

### Area D: Date & Chronology Parsing Edge Cases
- **Concurrent Roles & Freelancing:** If a candidate worked as a full-time engineer while running a freelance consultancy during the exact same 18-month window, does the date interval union correctly count 18 months, or does it double-count to 36 months?
- **Year-Only Uncertainty:** If a role is listed as "2022 – 2023", the point estimate is 2 years, but the actual span could be 2 days (31 Dec 2022 to 1 Jan 2023) or 24 months (1 Jan 2022 to 31 Dec 2023). How does the engine bound this uncertainty in the scenario ranges?
- **Ongoing / Current Roles:** If `is_current: true` but the role started 8 years ago, how does the engine guard against abandoned resumes where the user never updated the end date?

---

## 3. Required Output Format

Provide your analysis in the following strict schema:

### Part 1: Comprehensive Gap Register
A markdown table with columns:
`| Gap ID | Affected Rules / Formulas | Area / Domain | Vulnerability / Failure Mode | Concrete Failure Example | Proposed Deterministic Fix | Severity (High/Med/Low) |`

### Part 2: Concrete Deterministic Fixes for Scoring Formulas
Provide exact mathematical definitions, Python pseudocode, and algorithm updates for:
1. The Unified Scoring Formula with Rescaling ($\text{Raw}$, $\text{Active Weights}$, $\text{Denominator Safety}$).
2. Skill Credit Ladder and Context Multipliers ($c_k, M_{\text{ctx}}$).
3. Date Interval Union and Chronological Parsing algorithm.
4. Education & Credential Gate evaluation ($S_{ec}$).
5. Scenario Range Formulas ($\text{Score}_{\text{obs}}, \text{Score}_{\text{high}}, \text{Score}_{\text{low}}$).

### Part 3: Golden Boundary Test Fixtures
Provide at least **5 new edge-case test cases** covering:
1. Zero required skills JD (Experience and Education only).
2. Healthcare JD with valid clinical skills and unstated state council registration.
3. Skilled Trades JD with "ITI or 3 years field experience" equivalence.
4. Candidate with overlapping concurrent contracts and year-only dates.
5. High substitutability sibling tool match (e.g. AWS vs GCP, PostgreSQL vs MySQL).
*For each test case, show: Raw Inputs, Step-by-Step Numerical Calculations, Sub-Scores ($S_{sk}, S_{yr}, S_{ec}$), Observed Score, Scenario Range, and Cap Status.*

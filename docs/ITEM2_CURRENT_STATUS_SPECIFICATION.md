# ResuMatch AI — Item 2: Complete Status & Deploy-Ready Scoring Specification
**Document ID:** `SPEC-ITEM2-SCORING-V2.2`  
**Date:** 10 November 2026  
**Status:** Finalized & Adversarially Audited Specification  
**Design Completeness:** 100% | **Overall Deploy-Readiness:** ~85% (Specification Finalized, Reference Code Verified, Data Ingestion in Progress)

---

## 1. Executive Summary & Non-Negotiable Scoring Principles

Item 2 defines the **deterministic 0–100 scoring pattern, numerical rules engine, and uncertainty bounds** for ResuMatch AI. It calculates the alignment between an arbitrary Resume and Job Description (JD) pair across all 28 economic sectors.

### Non-Negotiable Core Invariants
1. **Zero LLM Scoring:** The 0–100 score, component sub-scores, scenario bounds, and caps are computed **exclusively by deterministic Python code**. An LLM never assigns a score, chooses a weight, or shifts a point.
2. **Fixed 2-Call LLM Operating Budget:**
   - *Call 1 (Pre-scoring):* Extracts literal, uninterpreted text spans with exact character offsets (`start_char`, `end_char`).
   - *Call 2 (Post-scoring):* Translates deterministic scoring JSON and gap breakdowns into constructive candidate feedback.
3. **Evidence-Grounded (Terminology Invariant):**
   - **`Unknown`** applies strictly to unstated mandatory gates (occupational licenses, formal degrees) and ambiguous/unparseable dates. Silence on a gate is excluded from the Observed Score.
   - **`Not evidenced`** ($c=0.0$) applies to JD skills absent from the resume. An unstated skill counts in the denominator as an unmet requirement.
4. **Universal Domain Neutrality:**
   - Formulas apply symmetrically across all 28 economic sectors (Healthcare, Skilled Trades, Software, Legal, Banking, Education, Public Sector, Manufacturing, etc.).
5. **No ATS Scoring (Item 4 Compliance):**
   - No ATS readability scores, formatting deductions, or keyword-density metrics exist. Parse quality serves solely as an internal confidence flag.
6. **Exact Rational Arithmetic (`Fraction`) & Rounding:**
   - All internal calculations run using Python `fractions.Fraction` to completely eliminate floating-point drift and IEEE 754 precision errors.
   - Division occurs exactly once at the end. Final scores use integer half-up rounding: `(2 * num + den) // (2 * den)`.
   - Display weights use the largest-remainder method (Hamilton-Hare) to sum to exactly `1.000` (display-only; never fed back into arithmetic).

---

## 2. Score Architecture & Mathematical Formulation

The overall score is built from a weighted linear combination of distinct components, dynamically rescaled when components are absent or silent.

### 2.1 Component Weights & Baseline Distribution

$$\text{Raw Score} = 100 \times \frac{\sum_{i \in \text{Active}} W_i \cdot S_i}{\sum_{i \in \text{Active}} W_i}$$

| Component | Symbol | Base Weight ($W_i$) | Description |
|---|:---:|:---:|---|
| **Required Skills** | $S_{sk}$ | `3/5` (`0.60`) | Coverage and depth of required core hard & domain skills. |
| **Experience / Years** | $S_{yr}$ | `1/4` (`0.25`) | Calendar duration of relevant dated experience against JD target. |
| **Education & Credentials** | $S_{ec}$ | `3/20` (`0.15`)| Minimum education tier and occupational licenses. |
| **Domain & Title** | $S_{dom}$ | `0` (`0.00`) | *Disabled by default* pending domain-adjacency calibration. |
| **Preferred Skills** | $S_{pref}$ | Folded into $S_{sk}$ | Weighted at half-value ($w=0.50$) within skill formula. |

---

### 2.2 Mathematical Safeguards & Denominator Safety

#### A. Division-by-Zero Guard (`insufficient_jd_signal`)
If a JD has 0 assessable skills, 0 years required, and 0 education/credential requirements (or all terms are unmapped in the graph):
$$\sum_{i \in \text{Active}} W_i = 0 \implies \text{Score} = \text{null}$$
- **API Status:** Returns `status: "insufficient_jd_signal"`, verdict band withheld.
- **Call 2 Guidance:** Explains to the user that the JD lacks assessable criteria for comparison.

#### B. Thin-Skill Shrinkage (Decision D1)
When a JD specifies fewer than 3 effective skill units (where Required $= 1.0$, Unlabelled $= 0.75$, Preferred $= 0.50$), a single missed skill could otherwise unfairly penalize up to 70% of the entire score.
- Let $M_{\text{sk}} = \sum_{k \in \text{Assessable}} w_k$.
- The effective skill weight is shrunk:
$$W_{\text{sk, effective}} = W_{\text{sk}} \times \min\left(1, \frac{M_{\text{sk}}}{3}\right)$$
- If $M_{\text{sk}} = 0$, $S_{sk}$ is marked **Silent** and excluded from the active set.

#### C. Dynamic Weight Rescaling
When a component is **Silent** in the JD (e.g. no years requested):
- The component is dropped from both numerator and denominator.
- Active weights rescale proportionally to sum to $1.0$.
- The API response explicitly reports `active_set`, `unknown_components`, and `basis` (e.g., `"skills_only"`, `"years_and_education"`).

---

## 3. Detailed Component Formulations

### 3.1 Component 1: Skill Score ($S_{sk}$)

#### A. Requirement Units & Deduplication
- Units are extracted up to a hard cap of **25 units** per JD (Required first, then document order).
- **Deduplication:** Repeated skill mentions merge to their canonical graph ID, taking the maximum cue weight:
  - Required ($w=1.0$): *"must have"*, *"required"*, *"essential"*, *"minimum qualification"*, *"mandatory"*.
  - Unlabelled ($w=0.75$): Neutral bullet in requirements section.
  - Preferred ($w=0.50$): *"preferred"*, *"nice to have"*, regex `\b(is|are)?\s*a plus\b`.
- **Soft Skills:** Generic soft skills (`class=soft`, e.g. "strong communication") are reported in candidate feedback but **never scored** in $S_{sk}$.

#### B. Skill Credit Ladder ($c_k$)
1. **Direct Match ($c=1.0$):** Literal match or verified alias in `skills_aliases.json`. Status: `Met`.
2. **Implied Parent Match ($c=0.9$):** Candidate has child skill, JD requests parent (e.g. candidate has *FastAPI*, JD asks for *Python*). Status: `Met`.
3. **Concept Subsumption ($c=0.6$):** Candidate has parent concept, JD asks for specific child tool (e.g. candidate has *Container Orchestration*, JD asks for *Kubernetes*). Status: `Partial`.
4. **Sibling Tool Substitution (Observed: $c=0.0$ | High Scenario: $C_{\text{subst}}$):**
   - High Substitutability ($0.70$): Snowflake vs BigQuery, Jenkins vs GitLab CI, Cloud Providers (AWS / GCP / Azure).
   - Medium Substitutability ($0.50$): PostgreSQL vs MySQL, React vs Vue.
   - Low Substitutability ($0.25$): MongoDB vs Cassandra.
   - None ($0.00$): Python vs C++.
5. **Possible Semantic Match (Observed: $c=0.0$ | High Scenario: $0.50$):** Contextual hit flagged for user confirmation.
6. **Unmapped JD Skills:** If a JD skill is absent from the seed graph, literal matches score $1.0$; misses are marked `Not assessable` and excluded from the denominator.

#### C. Context Multipliers ($M_{\text{ctx}}$) & Depth Factor
$$\text{Credit}_k = \max_{\text{evidences}}(c \times M_{\text{ctx}}) \times D_k$$
- $M_{\text{ctx}}$: Work Experience / Job bullet ($\times 1.0$), Certification ($\times 0.85$), Skills List Only ($\times 0.80$), Academic Coursework ($\times 0.65$).
- Depth Factor: $D_k = \min(1, Y_{\text{skill}} / N)$ if the JD specifies skill-specific tenure (e.g. "5 years Python"), otherwise $1.0$.

#### D. Aggregation Formula
$$S_{sk} = \frac{\sum_{k \in \text{Assessable}} w_k \cdot \text{Credit}_k}{\sum_{k \in \text{Assessable}} w_k}$$

---

### 3.2 Component 2: Experience / Years Score ($S_{yr}$)

#### A. Fractional-Month Half-Open Union (Decision D3)
To eliminate double-counting when roles transition mid-month, dates are parsed as continuous month indices ($12 \times \text{Year} + \text{Month} - 1$) over half-open intervals $[S, E)$:
- **Day-level:** $v = \text{idx}(y, m) + \frac{d-1}{\text{dim}(y, m)}$.
- **Month-level:** $v = \text{idx}(y, m)$ to $\text{idx}(y, m) + 1$.
- **Year-only:** $[12y, 12y + 12)$.
- **Point Estimate:** Midpoint of endpoints (e.g. "Jun 2021 – Aug 2023" = exactly 26.0 months).

#### B. Role Kind Weights
| Employment Kind | Observed Weight | Low Scenario Weight | High Scenario Weight |
|---|:---:|:---:|:---:|
| Full-time, Contract, Freelance | `1.0` | `1.0` | `1.0` |
| Apprenticeship | `1.0` | `0.5` | `1.0` |
| Part-time, Internship | `0.5` | `0.5` | `1.0` |

#### C. Stale Current Role Safeguard (Decision D4)
- An explicit evaluation parameter `as_of` (ISO date) is injected into every execution.
- If a role is marked `is_current: true` ("Present") and started $\ge 5$ years ago ($S + 60 \text{ months} \le \text{as\_of}$), the Low Scenario clamps the tenure at:
$$E_{\text{low}} = \min(\text{as\_of}, \max(\text{last\_evidence\_date}, S + 60))$$
This guards against stale resumes where an abandoned job was left as "Present".

#### D. Weighted Union Duration ($Y$)
$$Y = \frac{\text{Weighted Union Months}}{12}, \quad S_{yr} = \min\left(1.0, \frac{Y}{Y_{\text{req}}}\right)$$

---

### 3.3 Component 3: Education & Credential Gates ($S_{ec}$)

#### A. Gate Alternatives & Span Ownership (G12)
Gates support compound OR logic: e.g. *"Bachelor's OR 4 years relevant experience"*, *"ITI OR 3 years field experience"*.
- **Span Ownership Invariant:** Any experience clause consumed to satisfy an education alternative is **owned by the gate** and removed from $Y_{\text{req}}$, preventing double-counting in $S_{yr}$.

#### B. Staged Credentials & Ladders (CA / Healthcare)
- Professional credentials support ladder progression (e.g. Chartered Accountant: Foundation $\rightarrow$ CA Inter / Articleship $\rightarrow$ Final Membership).
- Candidate holding the stage immediately below the JD requirement receives Credit $= 0.5$, Status `Partial`.

#### C. Score Formula
$$S_{ec} = \frac{\sum_{j \in \text{Assessable Gates}} w_j \cdot \text{Credit}_j}{\sum_{j \in \text{Assessable Gates}} w_j}$$
*(Mandatory gates $w=1.0$; Preferred gates $w=0.50$)*.

---

## 4. Uncertainty Scenarios & Confidence Function

To ensure absolute transparency without false precision, the engine outputs three strictly monotonic scores: $\text{Score}_{\text{low}} \le \text{Score}_{\text{obs}} \le \text{Score}_{\text{high}}$.

### 4.1 Scenario Specifications

| Dimension | Observed Score ($\text{Score}_{\text{obs}}$) | Low Scenario ($\text{Score}_{\text{low}}$) | High Scenario ($\text{Score}_{\text{high}}$) |
|---|---|---|---|
| **Dates** | Midpoint estimates | Pessimistic bounds; stale role clamp | Optimistic bounds |
| **Unknown Years** | Excluded from calculation | $S_{yr} = 0$, weight active | $S_{yr} = 1.0$ |
| **Unknown Gate** | Excluded from calculation | **Mandatory triggers 69 cap only** (Decision D2; does NOT zero $S_{ec}$) | Credited as `Met` ($1.0$) |
| **Staged / Partial Gate**| Stated credit ($0.5$) | Stated credit ($0.5$); triggers cap | Stated credit ($0.5$); not upgraded |
| **Sibling Substitution** | $0.0$ credit | $0.0$ credit | $C_{\text{subst}} \times M_{\text{ctx}}$ |
| **Possible Match** | $0.0$ credit | $0.0$ credit | $0.50 \times M_{\text{ctx}}$ (Decision D5) |

### 4.2 Deterministic Confidence Function

Confidence is evaluated after score calculation:
- **`High`:** Spread $(\text{High} - \text{Low}) \le 10$, skill coverage $\ge 70\%$, $\ge 2$ active components, no degraded parse flags.
- **`Low`:** Spread $> 30$, OR skill coverage $< 40\%$, OR only 1 component active.
- **`Medium`:** All standard matches not meeting High or Low.
- **Confidence Ceiling:** If skills are **Silent**, or an **Unknown mandatory gate** is present, confidence is capped at `Medium`.

---

## 5. Golden Boundary Test Fixtures (Verified Reference Outputs)

All fixtures evaluated under base weights $W_{\text{sk}} = 0.60, W_{\text{yr}} = 0.25, W_{\text{ec}} = 0.15$:

### Fixture F1: Zero Required Skills (Experience + Education Only)
- **JD:** "3+ years in retail operations; Bachelor's required."
- **Candidate:** B.Com (Level 3, Met). 2.25 weighted years ($S_{yr} = 2.25 / 3.0 = 0.75$).
- **Weights:** $S_{sk}$ Silent ($W=0$). Active weights rescale to $0.625 / 0.375$.
- **Score:** Observed **84**, Range **84–84**, Confidence **Medium** (skills silent).

### Fixture F2: Regulated Healthcare (Registration Unstated)
- **JD:** 6 clinical skills, 5 yrs, BSc Nursing (L3), Mandatory state council registration.
- **Candidate:** 8 yrs ($S_{yr}=1.0$), 6/6 skills evidenced ($S_{sk} = 0.9167$), BSc Nursing Met. Registration unstated (`Unknown`).
- **Score:** Observed **95** (no cap). Low **69** (mandatory cap binds; $S_{ec}$ preserved). High **95**.
- **Result:** Range **69–95**, Confidence **Medium**, `gate_cap: low_only`.

### Fixture F3: Skilled Trades ("ITI or 3 Years Field Experience")
- **JD:** Panel wiring, Motor winding, Reading drawings. Gate = OR[ITI(L1), 3 yrs field experience].
- **Candidate:** ITI Electrician Met. Apprenticeship 1 yr. Skills evidenced ($S_{sk} = 0.8833$).
- **Rule Check:** Experience clause owned by gate $\rightarrow S_{yr}$ is Silent. Gate alt ITI is Met $\rightarrow S_{ec} = 1.0$.
- **Score:** Observed **91**, Range **91–91**, Confidence **Medium**.
- *Variant (No ITI, 1 yr experience only):* Gate Partial ($1/3$). Raw $77.3$ capped to **69**. Range **69–69**.

### Fixture F4: Concurrent Contracts with Year-Only Dates
- **JD:** Python and SQL required, 4 yrs. Candidate: Python (job), SQL (list, $0.8$). $S_{sk} = 0.90$.
- **Roles:** 3 overlapping contracts spanning 2021–2024.
- **Interval Union:** Disjoint duration gives 36 months ($Y=3.0$), NOT naive sum of 48 months.
- **Score:** Observed **86**, Low **71**, High **93**, Range **71–93**, Confidence **Medium**.

### Fixture F5: Sibling Tool Substitution
- **JD:** Python, PostgreSQL, AWS; 3 yrs. Candidate: Python (job), MySQL (job), GCP (job), 4 yrs.
- **Substitutability:** Relational DB (0.50), Cloud Provider (0.70).
- **Score:** Observed **53** (Potential Fit). High **81** (Good Fit).
- **Output:** Surfaces deterministic substitution gain: *PostgreSQL +11.8 pts, AWS +16.5 pts if accepted as equivalent*.

### Fixture F6: Staged Credential (CA Inter)
- **JD:** Required skills Direct ($S_{sk}=1.0$), 3 yrs ($S_{yr}=1.0$), B.Com Met, Mandatory Chartered Accountant.
- **Candidate:** CA Inter (stage just below $\rightarrow$ Partial $0.5$).
- **Score:** Raw $96.25 \rightarrow$ capped at **69** (mandatory gate Partial). High **69** (staged not upgraded). Range **69–69**.

### Fixture F7: Division-by-Zero Guard
- **JD:** Vague job posting with 0 mapped skills, 0 years, 0 education.
- **Score:** `score: null`, `status: "insufficient_jd_signal"`, verdict band withheld. Call 2 explains missing JD requirements.

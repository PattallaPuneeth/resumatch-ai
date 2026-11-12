# Technical Reference Dossier: Grounding Context for ResuMatch AI Item 1

**Document ID:** `REF-ITEM1-DOSSIER-V2.1`  
**Purpose:** Grounding documentation and technical dossier for AI review systems auditing and fixing Item 1.  
**System Target:** Production-grade, deterministic resume matching and candidate guidance platform.

---

## 1. System Architecture & Distributed Flow

ResuMatch AI is engineered as a secure, distributed, modular platform:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend (TypeScript)                   │
│          • Displays guidance, scores, scenario ranges, and gaps        │
│          • Strictly passive: zero scoring or business logic            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / REST
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Fastify Backend (Node.js / TypeScript)               │
│          • Auth, Tenant Isolation, File Storage (S3 / MinIO)           │
│          • PostgreSQL (Prisma + pgvector) for match histories          │
│          • BullMQ + Redis for asynchronous job scheduling              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Redis Job Queue
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     ML Worker Service (Python / FastAPI)               │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 1. Text Parsing & PDF Ingestion (pdfplumber, pypdf)            │   │
│   │ 2. PII Sanitization & Safety Gate                              │   │
│   │ 3. LLM Span Extraction (Call 1 — Verbatim JSON only)           │   │
│   │ 4. Deterministic Scoring & Verdict Engine (Item 1 & Item 2)    │   │
│   │    - Decimal arithmetic, Skill Graph, Interval Union Years     │   │
│   │    - Gate evaluation & Caps                                    │   │
│   │ 5. LLM Explanation & Guidance Generator (Call 2)               │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. LLM Call Budget & Operating Contracts

The system operates under a strict budget of **at most 2 LLM calls per resume + JD match**:

### Call 1: Combined Verbatim Extraction
- **Input:** Raw resume text + raw JD text (PII stripped).
- **Prompt:** Instructs model to extract exact literal spans without semantic interpretation.
- **Output JSON Schema:**
```json
{
  "skills": [
    {
      "text": "Java",
      "doc": "resume",
      "start": 120,
      "end": 124,
      "section": "experience",
      "role_id": "role_1"
    }
  ],
  "roles": [
    {
      "id": "role_1",
      "title": "Software Engineer",
      "start_date": "2021-06-01",
      "end_date": "2023-08-31",
      "is_current": false,
      "employment_type": "full_time"
    }
  ],
  "education": [
    {
      "degree": "B.Tech",
      "field": "Computer Science",
      "status": "completed",
      "institution": "State University"
    }
  ],
  "credentials": [
    {
      "name": "AWS Certified Solutions Architect",
      "jurisdiction": "Global",
      "status": "active"
    }
  ],
  "jd_requirements": [
    {
      "id": "req_1",
      "text": "Java",
      "type": "skill",
      "cue": "must have",
      "class": "required"
    }
  ]
}
```
- **Integrity Validation:** Python code validates `source_text[start:end] == text`. If offsets do not match, a sliding window substring search verifies literal presence. Mismatches are discarded.

### Call 2: Candidate Guidance Explanation
- **Input:** Deterministic JSON output from the scoring engine (`score_raw`, `score_display`, `verdict`, `components`, `missing_skills`, `gates_observed`).
- **Prompt:** Translates numbers and gaps into supportive, constructive candidate advice.
- **Constraint:** Model cannot modify any number, status, or band.

---

## 3. Mathematical Specifications

### Fixed-Point Decimal Arithmetic
All calculations use Python's `decimal.Decimal` with `ROUND_FLOOR` for half-up rounding:
$$\text{round\_half\_up}(x) = \lfloor x + 0.5 \rfloor$$

### Component Baseline Weights & Level Interpolation
Nominal weights vary by job seniority level $L$ (interpolated across anchors $L \in [2, 5, 8]$):
- $L \le 2$ (Entry): Skills $60\%$, Experience $15\%$, Preferred $15\%$, Education $10\%$.
- $L = 5$ (Mid): Skills $55\%$, Experience $20\%$, Preferred $15\%$, Education $10\%$.
- $L \ge 8$ (Senior/Lead): Skills $50\%$, Experience $30\%$, Preferred $15\%$, Education $5\%$.
- Domain/Title weight is set to $0\%$ (informational only).

### Experience Calculation (Interval Union Algorithm)
To prevent double-counting concurrent overlapping employment:
1. Each dated role $r$ containing at least one verified required/relevant skill is converted to an open-closed interval $[s_r, e_r)$.
2. Calculate the union: $U = \bigcup_{r} [s_r, e_r)$.
3. Duration $Y_{\text{cand}} = \frac{\text{Total Months in } U}{12}$.
4. $S_{\text{yr}} = \min\left(1.0, \frac{Y_{\text{cand}}}{Y_{\text{req}}}\right)$.

### Gate Evaluation & The 69 Cap
- **Mandatory Gates:** Education level and mandatory regulated licenses (e.g. state nursing council registration, bar admission, wireman permit).
- **Status Mapping:**
  - `Met`: Full qualification evidenced $\rightarrow$ credit $1.0$.
  - `Partial`: In-progress degree/exam, or license held in an out-of-state reciprocal jurisdiction $\rightarrow$ credit $0.5$.
  - `Not met`: Explicit shortfall (e.g. JD requires Bachelor's, candidate lists Diploma as highest) $\rightarrow$ credit $0.0$.
  - `Unknown`: License or degree not mentioned on resume $\rightarrow$ **excluded from calculation** (never penalized).
- **Cap Rule:**
  $$\text{Final Score} = \begin{cases} 
  \min(\text{Raw Score}, 69) & \text{if any mandatory gate is } \text{Not met} \text{ or } \text{Partial} \\
  \text{Raw Score} & \text{otherwise}
  \end{cases}$$

---

## 4. Multi-Domain Taxonomy (28 Sectors Covered)

The platform evaluates resumes across 28 distinct sectors:
1. Software Engineering
2. Data & Analytics
3. AI & Machine Learning
4. Cloud & DevOps
5. Cybersecurity
6. IT & Networking
7. QA & Testing
8. Project / Product / Business Analysis
9. Finance & Accounting
10. Banking & Financial Risk
11. Sales & Business Development
12. Marketing & Growth
13. Human Resources
14. Legal & Corporate Compliance
15. Healthcare & Nursing
16. Life Sciences & Clinical Research
17. Mechanical & Electrical Engineering
18. Civil & Structural Engineering
19. Construction Management
20. Skilled Trades & ITI
21. Manufacturing & Quality Engineering
22. Energy, Oil & Utilities
23. Agriculture & Food Science
24. Geospatial & Earth Sciences
25. Supply Chain & Logistics
26. Education & Teaching
27. Design, Creative & Media
28. Public Sector, Social Services & Defense

---

## 5. Regulatory & Compliance Grounding

### Indian Regulatory Context
1. **Digital Personal Data Protection Act (DPDP) 2023 / Rules 2025:**
   - Strict purpose limitation: resumes processed solely for the user-requested job comparison.
   - PII stripping (contact details, photo, national ID) performed in-memory prior to any external LLM call.
   - Logs retained without PII payload text.
2. **Affirmative Equality & Constitutional Safeguards (Arts. 15–16):**
   - The engine strictly prohibits reading, storing, or scoring caste, religion, sex, age, native place/domicile, or university pedigree.
3. **Public Sector Recruitment Boundary:**
   - JDs containing government notification patterns (*"Advt No."*, *"Age relaxation"*, *"Pay band"*) trigger an automatic verdict withholding, returning: *"Comparison score only; official eligibility determined by gazette notification terms."*
4. **Professional Regulatory Councils:**
   - Medical: National Medical Commission (NMC) & State Medical Councils.
   - Nursing: Indian Nursing Council (INC) & State Nursing Councils.
   - Legal: Bar Council of India (BCI) & State Bar Councils.
   - Accounting: Institute of Chartered Accountants of India (ICAI).
   - Electrical: Central Electricity Authority (CEA) & State Electrical Licensing Boards.
   - Securities: Securities and Exchange Board of India (SEBI) & NISM.

---

## 6. Complete Verified Reference Fixtures (Golden Test Suite)

All 34 test cases in `ml/scoring/item1.py` pass with exact decimal precision:
- **T1 (Software):** Java + Spring + SQL, 4 yrs vs 3 yrs, B.Tech Met $\rightarrow$ Score: **97**, Verdict: **Good Fit**.
- **T2 (Data):** Vague equivalence rule, resume no degree $\rightarrow$ Gate: `Confirm-only`, Score: **71**, Verdict: **Good Fit** (Medium confidence, range 61–76).
- **T3 (Healthcare):** Unstated nursing license $\rightarrow$ Gate: `Unknown`, Score: **70**, Verdict: **Good Fit** (Provisional: confirm registration, range 63–70).
- **T4 (Healthcare):** Expired nursing license $\rightarrow$ Gate: `Not met`, Raw: 62.5 $\rightarrow$ Score: **63**, Verdict: **Potential Fit**.
- **T5 (Finance):** CA in-progress ("CA Inter") $\rightarrow$ Gate: `Partial`, Raw: 92.5 $\rightarrow$ Capped: **69**, Verdict: **Potential Fit**.
- **T6b (Law):** Provisional bar enrollment $\rightarrow$ Gate: `Partial`, Raw: 96.25 $\rightarrow$ Capped: **69**, Verdict: **Potential Fit**.
- **T10c (Trades):** Out-of-state wireman permit $\rightarrow$ Gate: `Partial`, Raw: 76.25 $\rightarrow$ Capped: **69**, Verdict: **Potential Fit**.
- **E8 (Natural Low Match):** 1 of 4 skills, 2 of 5 years, degree Not met $\rightarrow$ Raw: 25 $\rightarrow$ Score: **25**, Verdict: **No Fit** (Score derived from evidence, not from an artificial cap).
- **E10 (Missing Dates):** Resume roles omit dates $\rightarrow$ Years: 0, Raw: 71.57 $\rightarrow$ Score: **72**, Verdict: **Good Fit** (Range 72–97).
- **E11 (Keyword Stuffing):** 5 skills listed only in skills section $\rightarrow$ Stuffing guard triggers ($0.5$ credit), Score: **50**, Verdict: **Potential Fit**.

# Technical Reference Dossier: Grounding Context for ResuMatch AI Item 2

**Document ID:** `REF-ITEM2-DOSSIER-V2.1`  
**Purpose:** Grounding documentation and technical dossier for AI review systems auditing and fixing Item 2.  
**System Target:** Production-grade, deterministic resume scoring and candidate alignment engine.

---

## 1. System Architecture & Distributed Scoring Flow

ResuMatch AI is engineered as a secure, distributed, modular platform:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend (TypeScript)                   │
│          • Displays numerical score (0-100), scenario ranges, and gaps │
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
│   │ 4. Deterministic Scoring Engine (Item 2)                       │   │
│   │    - Decimal arithmetic & Dynamic weight rescaling             │   │
│   │    - Skill Graph matching & Context depth multipliers          │   │
│   │    - Date interval union duration engine                       │   │
│   │    - Gate evaluation & 69 Potential Fit cap                    │   │
│   │ 5. LLM Explanation & Guidance Generator (Call 2)               │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. LLM Call Budget & Operating Contracts

The system operates under a strict budget of **at most 2 LLM calls per resume + JD match**:

### Call 1: Combined Verbatim Extraction
- **Input:** Raw resume text + raw JD text (PII stripped).
- **Prompt:** Instructs model to extract exact literal spans without semantic interpretation or scoring.
- **Output JSON Schema:**
```json
{
  "skills": [
    {
      "text": "PostgreSQL",
      "doc": "resume",
      "start": 120,
      "end": 130,
      "section": "experience",
      "role_id": "role_1"
    }
  ],
  "roles": [
    {
      "id": "role_1",
      "title": "Backend Software Engineer",
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
      "institution": "State Technical University"
    }
  ],
  "credentials": [
    {
      "name": "AWS Certified Solutions Architect",
      "issuing_body": "Amazon Web Services",
      "status": "active",
      "valid_until": "2026-12-31"
    }
  ]
}
```

### Call 2: Candidate Guidance Explanation
- **Input:** Deterministic scoring JSON (numerical score, active weights, component sub-scores, scenario range, verified evidence quotes, missing requirement list).
- **Prompt:** Instructs model to synthesize supportive candidate guidance explaining the score without modifying numbers or verdict bands.

---

## 3. Skill Graph Schema & Taxonomy Structure

The skill graph is loaded from versioned JSON files (`ml/data/skills_aliases.json` and seed taxonomies):

```json
{
  "domains": {
    "software": {
      "concepts": {
        "relational_database": {
          "substitutability": "medium",
          "children": {
            "PostgreSQL": {
              "aliases": ["Postgres", "psql", "Postgre SQL"],
              "implies": ["SQL", "Relational Database"]
            },
            "MySQL": {
              "aliases": ["MariaDB", "My SQL"],
              "implies": ["SQL", "Relational Database"]
            }
          }
        }
      }
    }
  }
}
```

### Substitutability Hierarchy:
- **`high` ($0.70$):** Tools that serve identical functional roles with near-zero transfer friction (e.g. Jenkins vs GitLab CI; Snowflake vs BigQuery).
- **`medium` ($0.50$):** Tools with shared architectural paradigms but different query languages or APIs (e.g. PostgreSQL vs MySQL; React vs Vue).
- **`low` ($0.25$):** Tools within the same broad domain with distinct paradigms (e.g. MongoDB vs Cassandra).
- **`none` ($0.00$):** Incompatible or non-transferable tools (e.g. Python vs C++).

---

## 4. Date & Experience Union Parsing Algorithm

To prevent double-counting concurrent roles or inflated durations:

```python
from datetime import date
from typing import List, Tuple

def compute_disjoint_experience_months(intervals: List[Tuple[date, date]]) -> int:
    """
    Merges overlapping date intervals and returns the total disjoint duration in months.
    """
    if not intervals:
        return 0
    
    # Sort by start date
    sorted_intervals = sorted(intervals, key=lambda x: x[0])
    merged = []
    
    curr_start, curr_end = sorted_intervals[0]
    for start, end in sorted_intervals[1:]:
        if start <= curr_end:
            curr_end = max(curr_end, end)
        else:
            merged.append((curr_start, curr_end))
            curr_start, curr_end = start, end
    merged.append((curr_start, curr_end))
    
    total_months = 0
    for start, end in merged:
        # Month approximation: (end - start).days / 30.4375
        months = ((end.year - start.year) * 12) + (end.month - start.month) + 1
        total_months += max(1, months)
        
    return total_months
```

---

## 5. Comprehensive Parameter & Constant Reference Ledger

| Parameter Name | Target Constant | Units / Type | Code Location | System Invariant |
|---|:---:|:---:|---|---|
| `WEIGHT_SKILLS` | `0.60` | `Decimal` | `ml/scoring/job_match.py` | Default base weight for skills. |
| `WEIGHT_YEARS` | `0.25` | `Decimal` | `ml/scoring/job_match.py` | Default base weight for experience. |
| `WEIGHT_EDUCATION` | `0.15` | `Decimal` | `ml/scoring/job_match.py` | Default base weight for education/credentials. |
| `WEIGHT_DOMAIN` | `0.00` | `Decimal` | `ml/scoring/job_match.py` | Disabled until domain-adjacency table is calibrated. |
| `MANDATORY_GATE_CAP` | `69` | `int` | `ml/scoring/item1.py` | Max score when mandatory gate is Not Met or Partial. |
| `MAX_SKILL_UNITS` | `25` | `int` | `ml/scoring/job_match.py` | Maximum evaluated skill bullets from JD. |
| `MAX_GATE_UNITS` | `10` | `int` | `ml/scoring/job_match.py` | Maximum evaluated gate bullets from JD. |
| `CREDIT_DIRECT` | `1.00` | `Decimal` | `ml/scoring/job_match.py` | Verbatim or canonical synonym match. |
| `CREDIT_IMPLIED` | `0.90` | `Decimal` | `ml/scoring/job_match.py` | Implied child-to-parent skill hit. |
| `CREDIT_CONCEPT` | `0.60` | `Decimal` | `ml/scoring/job_match.py` | Broad concept subsumption credit. |
| `CTX_JOB_PROJECT` | `1.00` | `Decimal` | `ml/scoring/job_match.py` | Evidence in work experience / project bullet. |
| `CTX_CERTIFICATION`| `0.85` | `Decimal` | `ml/scoring/job_match.py` | Evidence in verified certification. |
| `CTX_COURSEWORK` | `0.65` | `Decimal` | `ml/scoring/job_match.py` | Evidence in academic coursework. |
| `CTX_LIST_ONLY` | `0.80` | `Decimal` | `ml/scoring/job_match.py` | Evidence in skills list only. |
| `BAND_NO_FIT` | `0 - 39` | Range | `ml/scoring/item1.py` | Low alignment threshold. |
| `BAND_POTENTIAL` | `40 - 69` | Range | `ml/scoring/item1.py` | Moderate alignment threshold. |
| `BAND_GOOD_FIT` | `70 - 100` | Range | `ml/scoring/item1.py` | High alignment threshold. |

---

## 6. End-to-End Golden Verification Scenarios

### Scenario A: Balanced Senior Software Engineer
- **JD Requirements:**
  - Required Skills ($w=1.0$): Python, FastAPI, PostgreSQL, Docker
  - Preferred Skills ($w=0.5$): Kubernetes, AWS
  - Experience Required: 4 years
  - Education Required: Bachelor's degree (Level 3)
- **Candidate Profile:**
  - Python (Job bullet, $c=1.0, M=1.0 \rightarrow 1.0$)
  - FastAPI (Job bullet, $c=1.0, M=1.0 \rightarrow 1.0$)
  - PostgreSQL (Job bullet, $c=1.0, M=1.0 \rightarrow 1.0$)
  - Docker (Skills list only, $c=1.0, M=0.8 \rightarrow 0.8$)
  - AWS (Job bullet, $c=1.0, M=1.0 \rightarrow 1.0$, preferred $w=0.5$)
  - Kubernetes (Not evidenced, $c=0.0$, preferred $w=0.5$)
  - Total Experience: 5 years relevant disjoint experience ($Y=5.0$)
  - Education: B.Tech Computer Science (Level 3 $\ge 3 \rightarrow \text{Met}, c=1.0$)
- **Step-by-Step Numerical Calculation:**
  1. Skill Score ($S_{sk}$):
     $$\sum w = 1.0 + 1.0 + 1.0 + 1.0 + 0.5 + 0.5 = 5.0$$
     $$\sum (w \cdot \text{credit}) = 1.0(1.0) + 1.0(1.0) + 1.0(1.0) + 1.0(0.8) + 0.5(1.0) + 0.5(0.0) = 3.8 + 0.5 = 4.3$$
     $$S_{sk} = \frac{4.3}{5.0} = 0.860$$
  2. Experience Score ($S_{yr}$):
     $$S_{yr} = \min\left(1.0, \frac{5.0}{4.0}\right) = 1.000$$
  3. Education Score ($S_{ec}$):
     $$S_{ec} = 1.000$$
  4. Raw Score:
     $$\text{Raw} = 100 \times [0.60(0.860) + 0.25(1.000) + 0.15(1.000)] = 100 \times [0.516 + 0.250 + 0.150] = 91.60$$
  5. Final Score:
     $$\lfloor 91.60 + 0.5 \rfloor = 92$$
  6. Verdict: **Good Fit** (Score: 92, Confidence: High).

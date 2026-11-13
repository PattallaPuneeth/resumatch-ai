# ResuMatch AI — Scoring v3.2 Design (Cross-Encoder Weaknesses & Deterministic Layer)

**Status:** Approved Architecture Specification (Recorded: 2026-11-12)  
**Scope:** `ml/scoring/{roles,units,gates,scorer}.py` plus supporting data files in `ml/scoring/data/` or `ml/data/`.  
**Architecture Principle:** Deterministic mathematical layer around the existing `ms-marco-MiniLM-L-6-v2` cross-encoder. **LLMs are strictly forbidden from generating or altering scores.**

---

## 0. Executive Summary & Architecture Decision

| Question | Answer |
|---|---|
| **Will a bigger reranker fix the 3 issues?** | **No.** Issue 1 (seniority) and Issue 3 (credentials) are *missing-signal* problems, not capacity problems. Issue 2 improves marginally at best. |
| **Change the ML model?** | **Keep `ms-marco-MiniLM-L-6-v2`.** Add a deterministic layer: `roles.py` (seniority), context weights + shrinkage in `scorer.py`, and `gates.py` (credentials). |
| **Optional model optimizations** | Export MiniLM to ONNX int8 for latency headroom; benchmark `bge-reranker-base` only as an offline experiment (§4). |
| **Final Scoring Pipeline** | `retrieve → rerank → evidence(ctx-weighted) → coverage → shrinkage → seniority multiplier → curve_v1 → caps (gates, seniority) → band` |

**Key Invariant:** Every step in this pipeline is either a pure function of `(resume_text, jd_text, frozen_json_config)` or a `min()` cap. Mathematical determinism, auditability, and curve monotonicity are strictly preserved.

---

## 1. Issue 1 — Seniority & Level Mapping (`roles.py`)

### 1.1 Level Scale
Continuous float scale in $[0, 5]$:
```
0.0 INTERN/FRESHER  ──►  1.0 JUNIOR  ──►  2.0 MID  ──►  3.0 SENIOR  ──►  4.0 LEAD/STAFF  ──►  5.0 PRINCIPAL/DIRECTOR/ARCHITECT
```
*Note:* Continuous floats allow intermediate mappings (e.g., 4 years experience lands at level 2.5 between Mid and Senior).

### 1.2 Years-to-Level Mapping `f(y)` (Stored in `level_curve_v1.json`)
Piecewise linear interpolation clamped to $[0, 5]$:
| Experience (Years) | 0 | 1 | 3 | 5 | 8 | 12+ |
|---|---|---|---|---|---|---|
| Mapped Level | 0.0 | 1.0 | 2.0 | 3.0 | 4.0 | 5.0 |

### 1.3 Title-to-Level Regex Rules (High to Low Priority)
```python
TITLE_RULES = [
    (5.0, r"\b(principal|director|head of|vp|vice president|chief|architect|distinguished)\b"),
    (4.0, r"\b(staff|lead|team lead|tech lead|manager|engineering manager)\b"),
    (3.0, r"\b(senior|sr\.?|iii|iv)\b"),
    (1.0, r"\b(junior|jr\.?|associate|graduate|entry[- ]level|i)\b"),
    (0.0, r"\b(intern|trainee|apprentice|fresher|student)\b"),
]
DEFAULT_TITLE_LEVEL = 2.0  # Plain "Engineer/Analyst" with no modifier
```
*Disambiguation Rules:*
- `"architect"` alone evaluates to 4.5 unless preceded by `"principal|chief"` (5.0).
- Negative lookaheads ensure phrases like `"lead generation"` or `"lead scoring"` are ignored.

### 1.4 Job Description Level Detection ($\ell_j$)
Combines up to three signals:
1. `t_j`: Title level from regex matching on JD title (weight 0.50).
2. `y_j`: `f(min_years_required)` extracted from regex `(\d+)\s*\+?\s*(?:-\s*\d+)?\s*(?:years|yrs)` near `experience|exp` (weight 0.30). (If range "3–5 years", use lower bound + $0.25 \times \text{width} = 3.5$).
3. `s_j`: Scope score from leadership/ownership verbs (weight 0.20):
   - Ownership: `own|architect|define strategy|mentor|roadmap|stakeholder|lead|drive` (+0.5 per hit, mapped as $\min(5.0, 1.5 + \text{hits})$).
   - Support: `assist|support|learn|under guidance` (pulls level toward 1.0).

$$\ell_j = \frac{\sum w_i s_i}{\sum w_i} \quad \text{over available signals}$$
If no signals exist, $\ell_j = \text{None}$, seniority adjustment is skipped, and reason code `JD_LEVEL_UNKNOWN` is emitted.

### 1.5 Resume Level Detection ($\ell_r$)
1. **Parse Roles:** Extract `(title, company, start_date, end_date, is_internship, bullets)`. If "Present", `end_date = injected_today`.
2. **Effective Experience ($Y_{\text{eff}}$):** Sweep-line interval union (overlapping jobs are merged, not double-counted). Full-time roles have weight 1.0; internships have weight 0.5; academic projects have weight 0.0.
3. **Recent Title Level ($t_r$):** Maximum title level among roles ending within the last 5 years, discounted by $\min(1.0, \text{tenure\_years} / 1.0)$ for short stints under 1 year.
4. **Scope Score ($s_r$):** Verb scoring applied strictly to work experience bullets.

$$\ell_r = 0.55 \cdot f(Y_{\text{eff}}) + 0.30 \cdot t_r + 0.15 \cdot s_r$$
If dates/titles cannot be reliably parsed, $\ell_r = \text{None}$ and reason code `RESUME_LEVEL_UNKNOWN` is emitted. **Parse failures must never penalize the candidate.**

### 1.6 Delta Calculation & Score Scaling
$$\Delta = \ell_j - \ell_r \quad (\text{positive means candidate is under-qualified})$$
$$\Delta^+ = \max(0, \Delta - \delta_0), \quad \delta_0 = 0.5 \text{ (half-level dead zone)}$$
$$m_{\text{sen}} = \max(m_{\text{floor}}, 1 - \kappa \cdot \Delta^+), \quad \kappa = 0.22, \; m_{\text{floor}} = 0.40$$

| Delta ($\Delta$) | $\le 0.5$ | 1.0 | 2.0 | 3.0 | 4.0+ |
|---|---|---|---|---|---|
| **Multiplier ($m_{\text{sen}}$)** | 1.00 | 0.89 | 0.67 | 0.45 | 0.40 |

*Application:* Pre-curve coverage scaling: $C_{\text{final}} = C_{\text{shrunk}} \cdot m_{\text{sen}}$.  
*Hard Band Ceilings (Applied Post-Curve via $\min$):*
- If $\Delta \ge 2.0$: Hard cap at **69** (*Potential Fit ceiling*).
- If $\Delta \ge 3.0$: Hard cap at **39** (*No Fit ceiling*).
- If $\Delta < 0$ (Over-qualified): **No penalty**. Informational flag `OVERQUALIFIED` emitted only if $\Delta \le -2.0$.

### 1.7 Explainable Feedback Templates
```python
REASONS = {
    "SENIORITY_GAP": "Your technical skills align well, but this role is {jd_level_label} "
                     "(requires about {jd_years}+ years of ownership-level work); your experience "
                     "reads as {res_level_label} (about {res_years:.1f} years across {n_roles} roles).",
    "YEARS_SHORTFALL": "The posting asks for {jd_years}+ years; your dated roles total about {res_years:.1f}.",
    "JD_LEVEL_UNKNOWN": "The posting does not state a clear seniority level, so no seniority adjustment was applied.",
    "RESUME_LEVEL_UNKNOWN": "We couldn't read dates or titles reliably, so no seniority adjustment was applied.",
}
```

---

## 2. Issue 2 — Practical Capability & Length Normalization (`units.py`)

### 2.1 Context Multipliers & Anti-Keyword Stuffing
For requirement unit $u$, the cross-encoder returns calibrated passage relevance $\rho(u, p) \in [0, 1]$.
The effective passage weight is:
$$w(p) = \min(1.0, \; w_{\text{sec}}(p) \cdot (1 + 0.10 \cdot a(p) + 0.08 \cdot q(p) + 0.06 \cdot o(p)))$$

* **Section Priors ($w_{\text{sec}}$):**
  - Experience: `0.85`
  - Projects: `0.75`
  - Certifications: `0.60`
  - Summary: `0.45`
  - Education: `0.40`
  - **Skills List: `0.35`**
* **Modifiers:**
  - $a(p)$: Action verb present within 8 tokens of the skill (+0.10).
  - $q(p)$: Quantified outcome present (%, $, ₹, ms, counts) (+0.08).
  - $o(p)$: Ownership verb present (*designed, led, built, migrated, owned*) (+0.06).

**Anti-Keyword Stuffing Guard:**
$$\text{If all supporting passages with } \rho > 0.5 \text{ originate from skills lists: } e_u = \min(e_u, 0.35)$$

### 2.2 Generic Requirement Cap (Long-JD Inflation Guard)
A unit is generic if $\text{IDF}(u) < \tau_g$ (e.g. Git, Agile, Jira, Linux, "team player").
Generic requirements are capped at a maximum of **15% of total requirement mass**:
$$W_{\text{gen}} = \min(W_{\text{gen\_raw}}, \; 0.15 \cdot W_{\text{total}})$$

### 2.3 Thin-Job Shrinkage (Short-JD Fairness Guard)
To prevent candidates from receiving artificially depressed scores on short 2-to-3 line job postings, we apply reliability-weighted shrinkage toward a **domain-affinity prior**:
$$\lambda(W) = \frac{W}{W + k}, \quad k = 6.0 \text{ (approx weight of 5 average units)}$$
$$C_{\text{shrunk}} = \lambda \cdot C + (1 - \lambda) \cdot C_{\text{prior}}$$
* $C_{\text{prior}} = \text{clamp}(g(\text{domain\_sim}), 0.30, 0.80)$
* $\text{domain\_sim} = \text{cosine}(\text{JD title + first 2 units}, \text{top-3 resume experience passages})$
* **Thin-Job Policy:** If $n_{\text{units}} < 4$, set `confidence = "low"` and **forbid "No Fit"** unless a hard credential gate fails or seniority $\Delta \ge 3.0$.

---

## 3. Issue 3 — Hard Gates (`gates.py` + `credential_registry.json`)

### 3.1 Registry Schema (`credential_registry.json`)
```json
{
  "version": "credential_registry_v1",
  "entries": [
    {
      "id": "mbbs",
      "label": "MBBS (or equivalent medical degree)",
      "kind": "degree",
      "jd_patterns": ["\\bM\\.?B\\.?B\\.?S\\.?\\b", "\\bmedical degree\\b"],
      "resume_patterns": ["\\bM\\.?B\\.?B\\.?S\\.?\\b", "\\bMD\\b", "\\bBachelor of Medicine\\b"],
      "equivalents": ["do", "mbchb"],
      "scope": ["education", "certifications", "header"],
      "on_missing": {"action": "cap", "cap": 69, "severity": "hard"},
      "on_unverifiable": "flag"
    },
    {
      "id": "ca_cpa",
      "label": "CA / CPA / CMA",
      "kind": "license",
      "jd_patterns": ["\\bCPA\\b", "\\bChartered Accountant\\b", "\\bICAI\\b"],
      "resume_patterns": ["\\bCPA\\b", "\\bC\\.?A\\.?\\b(?=.*(ICAI|Chartered|qualified))"],
      "equivalents": ["acca", "cma", "icmai"],
      "scope": ["education", "certifications", "summary"],
      "on_missing": {"action": "cap", "cap": 69, "severity": "hard"},
      "on_unverifiable": "flag"
    },
    {
      "id": "work_auth",
      "label": "Work Authorization",
      "kind": "work_auth",
      "jd_patterns": ["authorized to work", "no sponsorship required"],
      "resume_patterns": ["citizen", "permanent resident", "authorized to work"],
      "scope": ["header", "summary"],
      "on_missing": {"action": "flag", "severity": "soft"},
      "on_unverifiable": "flag"
    }
  ],
  "strength_markers": {
    "mandatory": ["must have", "must hold", "required", "mandatory", "essential", "is a must"],
    "preferred": ["preferred", "nice to have", "a plus", "desirable", "advantage", "or equivalent experience"]
  },
  "marker_window_chars": 120
}
```

*Rules on Actions:*
- Only `degree`, `license`, and `certification` may set `action: "cap"`.
- `work_auth`, `clearance`, and `location` default to `action: "flag"` (absence on a resume is not proof of lack of eligibility).
- Phrases like `"or equivalent experience"` within the 120-character window downgrade mandatory requirements to preferred.
- Low-confidence OCR results set `status = UNVERIFIABLE` and **never trigger hard caps**.

### 3.2 Monotone Curve & Hard Cap Interaction
$$\text{raw\_score} = \text{round}(\text{curve\_v1}(C_{\text{final}}))$$
$$\text{final\_score} = \min(\text{raw\_score}, \; \text{gate\_caps}, \; \text{seniority\_caps})$$
Because $\min(\text{curve}(x), \text{cap})$ is non-decreasing, **monotonicity is mathematically preserved**. The calibration curve file remains untouched.

---

## 4. Model Architecture Evaluation & Recommendation

| Model | Params | RAM (Weights) | Latency (20 Pairs on CPU) | Fits 2GB Docker? | <150ms SLA? | Recommendation |
|---|---|---|---|---|---|---|
| **`ms-marco-MiniLM-L-6-v2`** | 22M | ~90 MB | 60–120 ms | **Yes** | **Yes** | **Keep as Primary Reranker** |
| MiniLM-L-6 ONNX int8 | 22M | ~25 MB | 30–60 ms | **Yes** | **Yes** | **Adopt for 2x Latency Win** |
| `ms-marco-MiniLM-L-12-v2` | 33M | ~130 MB | 120–220 ms | Yes | Borderline | Not worth 2x latency |
| `BAAI/bge-reranker-base` | 278M | ~1.1 GB | 800–1500 ms | Tight | **No** | Offline benchmark only |
| `BAAI/bge-reranker-large` | 560M | ~2.2 GB | 2000–4000 ms | **OOM** | **No** | Reject |

**Conclusion:** Keep `ms-marco-MiniLM-L-6-v2`. Neural rerankers cannot solve seniority or legal credential gates; our deterministic layer solves them with zero GPU overhead and < 5ms execution time.

---

## 5. File Structure & Rollout Plan

### Files Added / Modified:
1. `ml/scoring/roles.py`: Seniority ladder, interval unions, level deltas, multipliers.
2. `ml/scoring/units.py`: Context multipliers, anti-keyword stuffing cap, generic cap, shrinkage.
3. `ml/scoring/gates.py`: Credential registry parser, strength classifier, hard caps.
4. `ml/scoring/scorer.py`: Top-level orchestration function `score_pair()`.
5. `ml/scoring/data/`:
   - `level_curve_v1.json`
   - `seniority_params_v1.json`
   - `context_weights_v1.json`
   - `generic_terms_v1.json`
   - `domain_prior_v1.json`
   - `credential_registry.json`

### Verification Test Suite (`ml/tests/scoring/`):
- `test_score_is_bit_identical_across_runs` (Determinism check).
- `test_no_wall_clock_dependency` (Injected `today: date`).
- `test_junior_vs_principal_on_same_skills_ranks_principal_higher`.
- `test_skills_list_only_evidence_capped` (Max 0.35 credit).
- `test_mbbs_missing_caps_at_69_and_reports_reason`.
- `test_every_span_is_verbatim` (Zero-hallucination character offset check).
- `test_capped_curve_is_monotone` (Hypothesis property-based math test).

### Phased Rollout:
1. **Shadow Mode:** Run `roles.py` and `gates.py` behind feature flag `SCORING_V32_SHADOW=1` (log calculations without changing user scores).
2. **Offline Calibration:** Tune $\kappa, \delta_0, k$ on owner-provided human-labeled evaluation pairs.
3. **Live Gate Flip:** Promote to default `SCORING_ENGINE=v32` after verifying zero false-positive regressions.

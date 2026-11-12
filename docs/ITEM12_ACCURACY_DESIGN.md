# ResuMatch AI — Items 1 + 2: Accuracy and Coverage Design (v3.1 DRAFT)

**Status:** design only, written 2026-11-11. Nothing here is implemented. It extends
`ITEM12_UNIFIED_RULES.md` (v3.0). Every number comes from a command run on the repo's own data
(scripts: `featstudy.py`, `study2.py`, `evalhuman.py` in the session scratchpad; they are
described in section 2 so they can be re-created in `ml/eval/`).

> **Update 2026-11-11:** at the owner's request all 180 labeled pairs and the 10-pair sample were
> deleted. The numbers below are historical, show the shape of the problem only, and cannot be
> reproduced. Section 2 now applies to the fresh blind-labeled set, which is the only test data.

## 0. Implementation status (2026-11-12)

Built and tested with code-only strings (no labeled data exists in the repo):

| Design item | Where | State |
|---|---|---|
| D1 requirement units, frozen IDF | `ml/scoring/units.py`, `ml/data/jd_idf_v1.json` (built by `ml/evalkit/build_idf.py` from 375 unlabeled job texts; digest-checked at load) | done |
| D2 coverage with verbatim evidence | `ml/scoring/units.py`, `ml/scoring/pipeline_v31.py` | done |
| D3 score curve | `ml/scoring/curve.py`, `ml/data/coverage_curve_v1.json` | code done; **curve is an unfitted placeholder** until labels exist |
| D9/D10 tiers and confidence | `ml/scoring/engine.py` | done; unfitted curve forces `Tentative` |
| D5 level/hard-requirement signals | `signals` in the payload | explanation only, no cap (decision Q4) |
| E0 harness with locked test | `ml/evalkit/item12_eval.py`, `ml/evalkit/metrics12.py` | done |
| Fallback to the previous engine | `ITEM12_ENGINE=v30` | done |
| D7 semantic tier, D8 LLM units | — | not built; only after the first measurement |

Run once the owner's labeled CSV exists (columns `resume_text`, `job_description_text`, `label`):
`python -m ml.evalkit.item12_eval evaluate --input pairs.csv --split tune`, then `fit-curve`, and
`evaluate --split test --final` exactly once per engine version.

## 1. The problem in numbers

Ground truth used: the owner's **180 human labels** (`human_hard` 50, `real_fit_human` 100,
`score_details_human` 30; weak 72 / medium 57 / strong 51). The 8K-CSV labels are not used: the repo
already measured them at 42% agreement with the owner (kappa 0.14).

| System (3-class band accuracy) | Result | Note |
|---|---|---|
| Majority class | 40% | baseline |
| v3.0 engine as shipped (100 `real_fit_human`) | 24% right, 30% wrong, **46% no verdict**; 44% when it answers | fixed 40/70 bands |
| v3.0 skill coverage alone (catalogue) | 42% (CI 34–49) | barely above baseline |
| Old hybrid pipeline (cross-encoder blend), same 100 | 52% | from ML_FAILURE_ANALYSIS 8.16 |
| **IDF-weighted JD-term coverage, one number** | **59–60% (CI 52–68)**; binary weak-vs-fit **71%**; within one band **88–91%** | leave-one-job-out |
| Everything combined in one logistic model | 51% | overfits at n=180 |

What the study showed, and what it means for the design:

1. **The closed skill catalogue is the bottleneck, not the arithmetic.** Jobs list 10–30
   requirements; the catalogue sees 3–5 (matched 15–29%). Open-vocabulary coverage of the job's own
   terms beats it by 17 points.
2. **Coverage separates the labels monotonically** (mean coverage weak 0.123 / medium 0.172 /
   strong 0.226), but the bands overlap. The middle class is the hard one (22 of 57 right).
3. **Years, catalogue skills, level gap and score blends added nothing** on top of coverage
   (all within ±2 points, inside the noise). They stay in the design for explainability, but must
   earn their weight in a test (section 6).
4. **Most variants are indistinguishable.** Stemming, bigrams, requirement-lines-only and
   must-have weighting all land at 54–60%, with a ±7-point interval. Do not tune among them;
   pick the simplest explainable one.
5. **No-verdict is a policy problem, not a data problem.** 46% abstained because the rule "one
   active component → Low → withhold" fires on skills-only jobs.
6. **Realistic ceiling.** Claude agreed with the owner on 18/30 blind pairs, GPT-4o on 15/30.
   Human labels carry noise; the target is the best honest number, not 90%.

## 2. Targets and how success is measured (the acceptance gate)

| Gate | Target | Why |
|---|---|---|
| 3-class band accuracy, **new** blind test set | **≥ 58%, lower CI bound ≥ 52%** | the 16 coverage variants tried average 57% (best 60% is a pick-the-best number, so it is optimistic); v3.0 is 24–44% |
| Binary weak vs fit | ≥ 75% | now 71% |
| Within one band | ≥ 92% | never calling a strong pair weak |
| Opposite-extreme errors (strong→weak, weak→strong) | ≤ 8% | the errors users notice |
| No-verdict rate | **≤ 5%** (hard abstains only, section 4.7) | now 46% |
| Determinism | identical output on identical input, 100 runs | owner invariant |
| Explanations | every unit shows evidence span or "not evidenced" | owner invariant |

Protocol (fixed before any tuning):
- **The existing 180 labels are now development data only.** The feature study in section 1 was run
  on all 180 (including their old `test` splits) and the best variant was picked from 16, so they
  can no longer give an unbiased score. The **locked test set must be the new blind labels**
  (section 5), scored once per release candidate, with a 95% bootstrap CI.
- Until those labels exist, report 180-label numbers as "development, optimistic".
- **Splits by job**, never by resume. Leave-one-job-out cross-validation on the 180 for model
  selection.
- A change counts only if it improves **every** set and exceeds the CI half-width (~7 points), or
  is confirmed on the new 300-pair blind set (section 7). No threshold fitting on test.
- The 8K CSV is used only for the texts and for a smoke test of crashes and abstain rates.

## 3. Architecture v3.1 (what changes)

```
resume + JD ──► Stage A: segmentation + canonicalisation (deterministic)
              ► Stage B: requirement units from the JD (deterministic baseline; LLM 1a optional)
              ► Stage C: evidence matching per unit (deterministic; embedding tier optional)
              ► Stage D: components (skills/coverage, years, education/credentials) + gates
              ► Stage E: coverage-to-score curve  ► bands, range, confidence
              ► Stage F: explanation (LLM call 2, numbers frozen)
```

### D1. Open-vocabulary requirement units replace the catalogue as the source of skills
- A **unit** is one requirement line or sentence from the JD's requirement sections (bullets, "must
  have", "required", "responsibilities", "you will"). Fallback when no sections are found: all
  sentences ≤ 30 words.
- Each unit carries: text span, cue (Required 1.0 / Unlabelled 0.75 / Preferred 0.5, same patterns as
  v3.0, "or" alternatives merged), and a set of **terms** (stemmed unigrams plus bigrams, stop-words
  and boilerplate removed).
- Term weight = IDF from a **frozen reference corpus** (`ml/data/jd_idf_v1.json`, built once from a
  versioned set of job postings, SHA-recorded). Frozen means scores never drift when new jobs
  arrive. Must-have terms (in a Required unit) get weight ×2.
- The skill catalogue and `skills_aliases.json` become the **synonym source**: a JD term hits if the
  resume has the term, its stem, or any alias in its cluster. They no longer decide what is
  scored.
- This does not break "silence is never failure": every scored unit is the job's own text, so an
  absent term is genuinely `Not evidenced`. The old "unmapped skill → Not assessable" exemption was
  protecting against catalogue gaps; with open vocabulary, the protection moves to synonym
  clusters and the optional semantic tier (D7).

### D2. Continuous unit credit
- `credit(u) = Σ idf(t)·hit(t) / Σ idf(t)` over the unit's terms, `hit ∈ {0,1}`; a hit needs a
  verbatim span in the resume (offsets verified as in `spans.py`).
- Context multipliers stay (bullet 1.0, skills list 0.8, certification 0.85, coursework 0.65),
  keyword-stuffing guard stays.
- Output per unit: matched terms with quotes, missing terms, credit. This is the fix-tip source:
  "add evidence for *kubernetes, helm*" with the exact points it is worth.
- `S_sk = Σ w·credit / Σ w` as before; `W_sk_eff` thin-job shrinkage stays (3 effective units).

### D3. Coverage-to-score curve (this is what fixes the bands)
- Raw coverage lives in 0.05–0.35 on real postings (weak 0.12, strong 0.23). Mapping it straight
  to 0–100 puts nearly everything in No Fit; that is the "score compression" the repo reported.
- Define `S_sk = g(C)`, a **monotone piecewise-linear curve** with ≤ 6 knots, stored in
  `ml/data/coverage_curve_v1.json`. Fitted once by isotonic regression on tune labels (knots
  rounded, committed, versioned). Deterministic, explainable ("your coverage 18% sits where
  Potential Fit resumes typically do"), and the fixed 40/70 band thresholds stay as the owner
  defined them.
- Guard: curve must be non-decreasing, g(0)=0, g(1)=1, each segment slope ≤ 6 (no cliffs).
- Refit rule: only with ≥ 300 blind labels and a locked test; otherwise the shipped curve stays.

### D4. The other two components are kept, but must earn their weight
- Years: unchanged math, but a role counts only if a **unit has evidence inside that role's text**
  (already fixed); title matching is used only when no unit can be formed.
- Education/credentials: unchanged (gates, cap 69, Unknown handling).
- Study result: neither added measurable accuracy over coverage. Experiment E4 decides whether
  the fixed 0.60/0.25/0.15 weights stay, move to skills-dominant (e.g. 0.75/0.15/0.10), or years
  becomes a gate-style tag only. The owner's spec keeps its explainable fixed weights until E4
  proves otherwise.

### D5. Level and hard-requirement signals (the repo's known "weak scored high" failure)
- **Level:** JD level from title or first sentence (intern/junior 0, mid 1, senior 2,
  lead/manager 3, director+ 4); resume level from role titles, weighted by recency. The gap is
  shown in the explanation ("this role is senior; your most recent titles are junior").
- **Hard requirements** (language, licence, domain such as "gaming", clearance-free): JD terms
  flagged by "must", "required" plus a closed list of hard classes. A missing hard requirement
  caps the score at 69 (Potential Fit), the same ceiling as the credential gate.
- Gated by experiment E5: ships only if it improves accuracy on every set. The study's level
  feature gave +1 point (noise), so this is **explanation-first, cap-second**.
- Needs an owner decision (question Q4): domain-field mismatch as a cap vs information only.

### D6. Education/credential work (already built) stays as is.

### D7. Optional semantic evidence tier (decision Q1)
- For a unit whose terms miss, find the best resume sentence by cosine similarity with the
  already-installed `all-MiniLM-L6-v2` (pinned version, normalised vectors, fixed seed, cached per
  document). If cosine ≥ τ (fit on tune), the unit gets partial credit ≤ 0.5 and is marked
  `Possible match`; it shows the sentence for the user to confirm.
- Deterministic given the pinned model and CPU; no LLM; note that it replaces v3.0's rule that
  possible matches earn 0 in the observed score. High scenario keeps the full credit.
- Experiment E3 measures it; ship only if it beats D1 alone by more than the CI.

### D8. LLM calls, restructured for cost and quality (decision Q1)
The two-call budget stays, but the first call splits so the expensive part is cached:

| Call | Input | Output | Cache key | Calls for the 180-pair set |
|---|---|---|---|---|
| 1a JD extraction | JD text | requirement units (verbatim spans, cue, type: skill/duty/degree/licence/years/level/domain), title, level | JD sha256 | 72 |
| 1b Resume extraction | resume text | roles (title, dates, spans), skill/tool spans, education, credentials | resume sha256 | 147 |
| 2 Explanation | finished score JSON | supportive text | none | not needed for accuracy tests |

- All outputs still pass `spans.py` verification; judgement fields are rejected; the model never sees
  a score; PII is stripped.
- Marginal cost of a new resume against an already-seen JD is **zero extraction calls**.
- E2 compares D1 (no LLM) against D1 with 1a/1b units. The LLM only decides *what the requirement
  units are* and *where in the resume they appear*; coverage is still arithmetic.
- 219 calls evaluates all 180 pairs once. That exceeds the standing 4-request budget in
  `RULE.md`, so it needs explicit approval (Q1).

### D9. Verdict policy and the no-verdict rate (decision Q2)
Replace "withhold on Low confidence" with tiers:

| Tier | When | Shown |
|---|---|---|
| Firm | confidence High or Medium | score, band, range |
| Tentative | confidence Low but ≥ 1 assessable unit | score and the **range band** ("Potential Fit to Good Fit"), amber label with the reason |
| Abstain | parse Failed, ≥ 50% unsupported script, public-sector notice, **zero** assessable units | no score, explained |

Expected effect: no-verdict falls from 46% to the abstain rate only (< 5% on the labeled sets).
Confidence stays honest: Low is shown, not hidden.

### D10. Smaller fixes already identified
- Remove the confidence rule "only one component → Low" for jobs with ≥ 3 assessable units.
- Spread (high − low) is computed from scenarios that matter; "no dates at all" widens the range
  by design, so cap its effect on confidence to Medium.
- Unknown years from unparseable dates: surface a "dates unreadable" prompt instead of widening.

## 4. Experiments (ordered; each has a stop rule)

| # | Question | Method | Stop / ship rule |
|---|---|---|---|
| E0 | Reproduce the 59–60% baseline inside `ml/eval/` as a committed script | LOJO on 180 | must match ±1 point |
| E1 | D1+D2+D3 deterministic (no LLM, no embeddings) | LOJO, then locked test once | ship if ≥ 58% and abstain ≤ 5% |
| E2 | Add LLM units (1a/1b) | 219 cached calls, same splits | ship if > E1 by ≥ 7 points, else stay deterministic |
| E3 | Add semantic tier (D7) | local model | ship if > E1 by ≥ 5 points on every set |
| E4 | Component weights / years as tag | grid of 5 weight sets, LOJO | keep owner weights unless another is better by > CI |
| E5 | Level and hard-requirement caps | ablation | ship only if every set improves |
| E6 | Confidence calibration | does "High" mean ≥ 70% right? | else re-derive the High/Medium cut-offs |

## 5. Data and labels

- Frozen reference corpus for IDF: all unique JDs from the three human sets (72) plus the 8K JDs
  (71 unique in test, ~300 in train). Build script and hash committed.
- **New labels needed: 300 blind pairs** (the repo's own note says "several hundred" for ±5
  points). Stratify: 100 random; 80 same-field wrong-level or missing hard requirement; 60 strong
  candidates on short JDs; 60 across the five domains with licences (nursing, trades, accounting,
  legal, finance). Names hidden, model scores hidden, **no pre-filled labels** (anchoring: the
  owner changed 0 of 50 pre-filled, 12 of 30 blind).
- 30 of the 300 are repeats, to measure the owner's own consistency (sets the true ceiling).
- Optional second labeler for 100 pairs to measure inter-rater agreement.

## 5b. Operating rules added after review

- **LLM failure falls back, never blocks.** If call 1a or 1b fails, times out, or fails span
  verification, the engine uses the deterministic D1 units and marks the result
  `extraction: "deterministic"`. A result is never delayed or dropped because of the LLM.
- **Every result records its versions**: `engine`, `idf_corpus`, `coverage_curve`,
  `alias_set`, `extraction` (deterministic / llm + prompt version), and the model id. Same input +
  same versions must give the same output.
- **Embedding determinism (D7).** Float results can differ by hardware. Round similarity to 3
  decimals and keep τ at least 0.02 away from the densest score region; an automated test runs 100
  repeats and compares to a stored fixture.
- **Cost and latency budget.** Deterministic path under 1 s per pair; with caches a new pair
  needs 0 extraction calls when both texts were seen, at most 2 otherwise, plus the explanation call.

## 6. Risks and honest limits

- **Selection bias:** 59–60% is the best of 16 variants; expect about 57% on fresh data.
- **Segmentation may not matter.** Whole-job coverage and requirement-lines-only scored the same
  within noise. Units are kept mainly because they make fix tips and evidence quotes possible, not
  because they raise accuracy.
- n = 180 is small: intervals are ±7 points. Several of the gains in this document are not
  separable from noise, which is why variants are not tuned against each other.
- Lexical coverage cannot tell a strong match with different wording from a weak one that shares
  boilerplate. E2/E3 are the only routes beyond ~60%.
- Domain/level caps may punish career-switchers (v3.0 deliberately avoided this); they are
  gated by data and by the owner's call.
- IDF corpus is mostly IT, finance and BA postings; trades and healthcare IDF will be thin until
  more postings are added (the registry domains have no JD sample).
- A rules engine that answers on weak evidence will be wrong sometimes; Tentative labels make
  that visible instead of hiding it.

## 7. Decisions

**Recorded 2026-11-11 (owner chose the recommended option on all four):**
Q1 = approve about 219 cached OpenRouter calls, used only for E2 and only after E1 is measured
(this overrides the 4-request limit in `RULE.md` for that experiment only); Q2 = three tiers;
Q3 = fitted monotone curve; Q4 = explain first, cap only if E5 proves it. **Q5 (labels) is open.**

The original options, for the record:

| Q | Decision | Options (recommended first) |
|---|---|---|
| Q1 | LLM extraction for experiments and production | (a) approve ~219 cached OpenRouter calls for E2, then decide; (b) deterministic + local embeddings only; (c) deterministic only |
| Q2 | Verdict policy | (a) three tiers: Firm / Tentative / Abstain; (b) keep withholding |
| Q3 | Learned coverage curve (D3) | (a) allowed: monotone, ≤ 6 knots, versioned file; (b) keep a hand-set linear map |
| Q4 | Domain / level mismatch | (a) explanation first, cap at 69 only if E5 proves it; (b) never cap; (c) cap now |
| Q5 | Labels | how many blind pairs can you label, and by when |

## 8. Build order once approved

1. E0 harness in `ml/eval/` (script, splits, bootstrap CI, locked test file).
2. D1/D2 requirement units and frozen IDF; D3 curve; D9/D10 policy; tests.
3. E1 run; report with CIs; freeze or iterate on tune only.
4. LLM 1a/1b contracts and caches (only if Q1 = a); E2.
5. E3–E6 as the data allows; update `ITEM12_UNIFIED_RULES.md` to v3.1 with the final choices.
6. Wire into the worker behind a feature flag; keep v3.0 as fallback until the gate passes.

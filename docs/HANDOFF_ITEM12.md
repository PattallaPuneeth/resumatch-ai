# Hand-off: Items 1 + 2 verdict engine (read this first when resuming)

Updated 2026-11-12 (v3.2 Engine Implemented & Passing All Tests). Owner rules: commit locally only when asked; never invent evaluation samples;
only fresh owner-labeled pairs are test data; reply simply; honest counts (correct / wrong / no verdict).

## IMPORTANT: v3.2 Scoring Architecture Implemented & Verified
- **Single Source of Truth for v3.2:** See [SCORING_V32_DESIGN.md](SCORING_V32_DESIGN.md) for full mathematical formulas, schemas, and test suites.
- **Implementation Status:**
  1. **Seniority & Tenure Engine (`ml/scoring/roles.py`):** 5-level continuous scale, date interval sweep-line union, seniority delta penalty ($\kappa = 0.22$, dead zone $\delta_0 = 0.5$), hard caps at 69 ($\Delta \ge 2$) and 44 ($\Delta \ge 3$), and template-based explainable feedback.
  2. **Practical Capability & Anti-Keyword Stuffing (`ml/scoring/units.py`):** Section priors ($w_{\text{sec}}$), action/quantified outcome multipliers, skills-list-only credit cap at 0.35, generic requirement cap at 15% mass, and thin-job shrinkage ($k = 6.0$).
  3. **Hard Credential Gates (`ml/scoring/gates.py` + `ml/data/credential_registry_v1.json`):** Mandatory vs. preferred classification, hard caps at 69 for missing licenses/degrees, OCR unverified guards, work-auth flag-only safety.
  4. **Engine Pipeline (`ml/scoring/pipeline_v32.py`):** Fully integrated and verified. Switchable via `ITEM12_ENGINE=v32` (or `v31` for previous engine).
  5. **Verification Test Suite (`ml/tests/test_scoring_v32.py`):** 26 tests covering determinism, boundaries, monotonicity, anti-keyword stuffing, and verbatim spans — **100% PASS (26/26)**.

## Where things stand
- Design: `docs/SCORING_V32_DESIGN.md` (v3.2 Implemented), `docs/ITEM12_ACCURACY_DESIGN.md` (v3.1 historical), and
  `docs/ITEM12_UNIFIED_RULES.md` (rules v3.0).
- Engine: `pipeline_v32.py` is ready; `pipeline.py` routes to `v32` when `ITEM12_ENGINE=v32` and defaults to `v31` for complete backward compatibility.
- Data files: `ml/data/level_curve_v1.json`, `ml/data/seniority_params_v1.json`, `ml/data/context_weights_v1.json`, `ml/data/generic_terms_v1.json`, `ml/data/domain_prior_v1.json`, `ml/data/credential_registry_v1.json`.
- Data files: `ml/data/jd_idf_v1.json` (frozen, digest-checked), `ml/data/coverage_curve_v1.json`
  (**unfitted placeholder**, so every result shows as Tentative), `ml/data/credential_registry.json`
  (draft, owner review pending).
- Harness: `ml/evalkit/item12_eval.py` (evaluate, fit-curve, locked final test) and
  `ml/evalkit/metrics12.py`.
- Cleanup done: ATS score removed from UI/API/worker; old Job Match card, `job_match.py`,
  `ats_scoring_engine.py` and the two ATS docs deleted.
- Nothing is accuracy-measured yet. All earlier samples and labels were deleted at the owner's request.

## Next steps, in order
1. Owner sends labeled pairs (first batch: 47). CSV columns: `resume_text`, `job_description_text`,
   `label` (No Fit / Potential Fit / Good Fit). Save outside the repo or under a gitignored folder.
2. `python -m ml.evalkit.item12_eval evaluate --input <csv> --split tune` and report counts.
   The split is by job, about 60/40. With 47 pairs this is a first read only (test side is ~19 pairs,
   interval about ±20 points). `fit-curve` refuses fewer than 100 tune pairs; keep the placeholder.
3. Only when a bigger set exists (300 recommended): `fit-curve`, then `evaluate --split test --final`
   once per engine version. Gate targets are in design section 2.
4. If rules-only falls short: LLM extraction units (design D8). The approved ~219 calls were sized for
   the deleted set; re-size and ask the owner again before any live call. OpenRouter only.
5. Later: semantic tier (D7), weight and level experiments (E4/E5), repo-wide lint cleanup.

## How to run checks
- ML: `PYTHONPATH=<dir with redis, boto3, bullmq, python-docx, pymupdf, pytesseract, pytest-asyncio>`
  `python -m pytest ml/tests -q`. Known environment-only failures: Postgres and OCR tests (17 failed,
  8 errors on this machine).
- Frontend: `cd frontend && npx tsc --noEmit && npx vitest run` (160 tests).
- Backend: `cd backend && npx vitest run <file>`; the full run crashed once in this environment.

## Latest measurements
- 2026-11-12 (IST), first batch: 47 owner-labeled pairs in `eval-inbox/pairs_47.csv` (gitignored; from
  the owner's `realistic_resume_and_jd_dataset.md`; 12 No Fit, 16 Potential Fit, 19 Good Fit; 44 unique jobs).
  Split by job: 28 tune, 19 test. **Test split is untouched** (final run still to do, once).
  Tune result, placeholder curve: 18 correct, 10 wrong, 0 no verdict = 64.3% (95% CI 46-82%);
  fit-vs-not 86%, within one band 96%, opposite-extreme errors 4%. Mistakes: 6 Good Fit pairs called
  Potential Fit, 3 Potential called No Fit, 1 Good called No Fit (placeholder curve is likely too strict).
  Too few pairs to fit the curve (needs 100 tune) or pass the gate.
- Format fixes made before this first run (structure only, no label fitting): markdown headings and
  bold metadata lines in job text, numeric MM/YYYY dates, "competencies" as a skills list, single rare
  skill bullets as units.
- The scheduled auto-resume task was declined by the owner; resume by typing "continue".

## Session 2026-11-12 (later): rules, domain knowledge and robustness
- Owner goal: client enters resume + job text and gets a score plus tips to match the job; must hold
  for unseen resumes in any domain, so fixes follow the written rules, not the sample pairs.
- Rules added (spec V5/V6/V7 and Item 2): alternatives ("Python, Scala, or Java", "GCP and/or Spark")
  count the best member once; pay, location, visa and similar lines are never units; soft-skill lines are
  listed in `soft_skills_not_scored`; implied skills (`ml/data/skill_implications.json`, PySpark ->
  Python at 0.9); plural degree wording; generic requirement words ignored; markdown headings, bold
  metadata, inline " - " lists and glued sentences are handled; boilerplate ends a run-on line instead
  of discarding it; years logic is monotone (adding evidence never lowers a score).
- Domain knowledge: `ml/data/domain_knowledge_v1.json` (424 O*NET 31.0 occupations for software/IT,
  healthcare, skilled trades, accounting/finance, legal; CC BY 4.0, built by
  `ml/evalkit/build_domain_knowledge.py`). `ml/scoring/roles.py` maps the job title and the resume's
  role titles to occupations and reports same role / related role / same field / different field.
  Explanation only; no cap yet (decision Q4: cap only if proven on labeled data).
- Robustness: `python -m ml.evalkit.metamorphic --input <csv>` runs label-free checks (format noise,
  determinism, added/removed evidence, self-match, hostile text, keyword stuffing, 24 fuzz inputs).
  All pass on the 47 pairs' texts and on 120 unlabeled third-party pairs.
- Practice split after these fixes (placeholder curve): 20 of 28 correct (71%, CI 54-86%), 0 no verdict;
  test split still untouched. Firecrawl was not needed and not used (no credits spent); no LLM calls.
- Open: role relation is "unknown" for many job titles (titles O*NET does not list); fit the curve with
  100+ tune pairs; consider the different-field cap once labels support it; verify the credential
  registry against official pages.

## Session 2026-11-12 (latest): India-first and meaning matching
- Owner decisions: primary market is India; OpenRouter approved for LLM extraction/matching (hard cap
  in code, default 300 requests, ledger in `eval-output/llm_ledger.jsonl`, OpenRouter only).
- India-first: Indian date styles (Apr'19, Mar-22, till date, 01.04.2023) are made uniform in the
  canonical text (`spans.canonicalize`); Indian degree wording (BTech, MTech, B.E, LLB, MBBS, PG
  Diploma, B.Sc Nursing; short ambiguous forms like BE/MA/MS are deliberately excluded); confirm-only
  wording (WFH, notice period, bond, walk-in, rotational shift); government notice wording (Advt No.,
  notification no., pay matrix/level, OBC/EWS); `ml/data/india_titles.json` maps Indian job-title
  wording to O*NET titles (draft, extend from NCO-2015 and real postings). O*NET itself is US data.
- Meaning matching (built, NOT run live): `ml/scoring/llm_match.py` + `llm_client.py`. For requirements
  with credit under 0.7 the model returns only resume quotes; code verifies each quote, drops negated
  or hostile ones, and gives a fixed 0.6 credit; cached by text hash; PII redacted; any failure falls
  back to literal matching; a resume containing an injection phrase is never sent. Enable in the
  harness with `evaluate --llm --llm-cap N`. First live run must wait for the owner's go-ahead on
  the call count for the new Indian pairs.
- Tests: ML 572 pass; the 17 failures and 8 errors are Postgres/OCR environment tests.


## Session 2026-11-12 (India data expansion, no labels used)
- Owner gave free hand: improve what needs no labeled pairs, India first, across the five domains.
- Research (web, 2026-11-12): Indian accountant JDs (Tally Prime, GSTR-1/3B, TDS 24Q/26Q, e-invoice,
  e-way bill), NMC / State Medical Council registration, PCI / State Pharmacy Council, INC and state
  nursing councils (ANM, GNM, B.Sc Nursing), ICSI CS, ICMAI CMA, IIBF JAIIB/CAIIB, DGT/NCVT ITI trades.
  Sources were mostly secondary (coaching sites, aggregators); every new entry is `draft`.
- `skills_catalog_domains.json`: 16 -> 309 skills (Indian accounting/tax, BFSI, healthcare, legal,
  trades and manufacturing, IT service-company stacks, Indian languages). Distinctive names only.
- `india_titles.json`: +186 title phrases (IT, BFSI, healthcare, legal, trades). Targets that the
  five-domain O*NET index cannot resolve were skipped (safety officer, quality inspector, storekeeper).
- `skill_implications.json`: GST returns -> GST, SAP modules -> SAP, TDS forms -> TDS, JS frameworks,
  welding processes, AWS/Azure services.
- `credential_registry.json` 0.2.0: +8 entries (ICSI CS, ICMAI CMA, IIBF JAIIB/CAIIB, NMC registration,
  pharmacist state registration, ITI Fitter/Welder/Turner). Still draft, owner review pending.
- `units.py` STOP: generic Indian JD filler words added (hands, preferably, applicant, fresher,
  vacancy, urgent). Fixes "Hands-on experience with X" creating a bogus "hand" requirement term.
- Checks: tune split unchanged at 20/28 before and after (test split untouched); ML tests for the
  touched modules 220 pass; metamorphic checks all PASS on the 120 unlabeled pairs; new file
  `ml/tests/test_india_data_v32.py`.
- Still open: verify drafts against official pages; curve fitting needs 100+ tune pairs; LLM meaning
  matching not run live; role relation for titles outside the five domains stays "unknown".

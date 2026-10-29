# ResuMatch AI: Model Card

Every number on this page links to the run or analysis it comes from
([ML failure analysis](eval/ML_FAILURE_ANALYSIS.md)). Nothing here is estimated.

## 1. What it does

Scores how well a resume matches a job description (0–100), assigns a band (strong ≥ 75,
medium 45–74, weak < 45), and explains the score with matched and missing skills and the resume
passages that matched. **Scores come from the ML pipeline only, never from an LLM.** An optional
LLM writes a summary and suggestions, checked against the resume text.

**Intended use:** helping a candidate see how a resume reads for a given job, and ranking
candidates for one job. **Not for:** automatic hiring or rejection decisions; a person should read
every result. The band is far less reliable than the ranking (section 3).

## 2. Pipeline

| Stage | Component | Setting (source) |
| :--- | :--- | :--- |
| Chunking | Section-aware chunker | ≤ 240 tokens (`ml/pipelines/embeddings/chunker.py`) |
| Lexical retrieval | PostgreSQL `tsvector` (BM25-style) with a GIN index | |
| Dense retrieval | `sentence-transformers/all-MiniLM-L6-v2`, 384-d, pgvector HNSW | |
| Fusion | Reciprocal Rank Fusion | k = 60 |
| Reranking | `cross-encoder/ms-marco-MiniLM-L-6-v2` | top 20 passages (`TOP_K_CANDIDATES`) |
| Calibration | sigmoid of the reranker logit | shift −3.5, temperature 2.8 (`scorer.py`) |
| Final score | 0.65 × reranker + 0.25 × skill coverage + 0.10 × vector similarity | `scorer.py` |
| Skill coverage | taxonomy + aliases; preferred skills at half weight; "X or Y" counts once | `skill_gap.py` |

Every saved match records the model names and these settings in its explanation
(`modelMetadata`), so a stored score can be traced to what produced it.

## 3. Measured performance

**On human-labeled pairs (the numbers that matter).** 95% intervals from a 1,000-resample
bootstrap ([§8.16](eval/ML_FAILURE_ANALYSIS.md#816-baseline-on-all-180-human-labels-two-opposite-failures),
[§8.17](eval/ML_FAILURE_ANALYSIS.md#817-how-precise-are-these-numbers-bootstrap-confidence-intervals)):

| Set | Pairs | Pairwise ordering | Band accuracy |
| :--- | :---: | :---: | :---: |
| `human_hard` (hardest pairs) | 50 | 75.8% (62.4–86.6) | 44.0% (30.0–58.0) |
| `real_fit_human` (real long postings) | 100 | 73.4% (65.1–81.2) | 52.0% (43.0–62.0) |
| `score_details_human` (labeled blind) | 30 | 77.1% (63.1–90.0) | 46.7% (29.9–63.3) |
| All 180 | 180 | 72.4% | 48.9% |

Ranking candidates **within one job** is right 78.3% of the time (138 comparisons). Across all 180
pairs the band is right about half the time: 31 of 51 strong pairs and 37 of 72 weak pairs are
called medium.

**On synthetic or auto-labeled sets** (easier, cited for completeness): handwritten set (32
pairs) pairwise 98.2%, band 93.8%; Kaggle-domain test split pairwise 99.6%, band 80.6%
([README](../README.md#measured-results-every-number-links-to-its-source)).

## 4. Known failure modes

1. **Weak candidates from the same field score too high**: right field but wrong level (a
   junior analyst for a senior role), or a missed hard requirement ("bilingual Chinese is a
   must"). The reranker gives these 73–93 ([§8.16](eval/ML_FAILURE_ANALYSIS.md#816-baseline-on-all-180-human-labels-two-opposite-failures)).
2. **Strong candidates on short job posts score too low** (reranker 27–49). Because the two
   failures pull in opposite directions, no single threshold change fixes the bands.
3. **Seniority is shown, not scored.** Penalties based on years were measured and rejected
   ([§8.11](eval/ML_FAILURE_ANALYSIS.md#811-human-check-of-the-real_fit-labels-the-source-labels-are-unreliable)).
4. **Small evaluation sets.** With 30–100 pairs per set, differences under about 10 points are
   within noise.

## 5. Bias and label checks

- **Name swap** ([§8.14](eval/ML_FAILURE_ANALYSIS.md#814-label-bias-and-name-bias-blind-labels-redaction-and-a-name-swap-test)):
  40 pairs scored 10 times each, only the name changed (5 origins × 2 genders). Mean score female
  45.96 / male 45.98; origins between 45.90 and 46.07 (largest group gap 0.17 points). Per pair
  the score moved 0.32 points on average and at most 2.9 points (through chunk boundaries); one
  pair of 40 changed band. No systematic name bias.
- **Personal details** (name, date of birth, gender, marital status, nationality, religion, ID
  numbers) are removed from the `score_details` resumes before labeling or scoring.
- **Label quality** ([§8.15](eval/ML_FAILURE_ANALYSIS.md#815-blind-labels-claude-is-too-strict-gpt-4o-is-weaker-and-the-pre-filled-audit-was-anchored)):
  against a person's blind labels, Claude's labels agree 18 of 30 (always one band stricter) and
  GPT-4o's 15 of 30. Pre-filled labels anchored the reviewer (0 of 50 changed), so only blind
  labels are used as ground truth.

## 6. Monitoring

The worker exports `resumatch.match.final_score`, `resumatch.match.component_score`,
`resumatch.match.verdict` and `resumatch.match.zero_passages` over OTLP (off by default). The
Grafana dashboard `observability/dashboards/model-monitoring.json` (loaded automatically with the
observability profile) shows the score distribution and the share of matches scored with no
retrieved passages, the symptom of the embedding race fixed on 29 Oct 2026.
`observability/alerts/model-alerts.yaml` defines Prometheus alert rules for both, but no service
loads it yet: it has to be added to a Prometheus or Grafana alerting setup to fire.

## 7. Reproduce

```bash
python -m ml.eval.run --dataset ml/eval/datasets/human_hard   # report with 95% intervals
python -m ml.eval.compare --latest-2                          # last two runs: is the change bigger than the noise?
python -m ml.eval.name_swap --dataset ml/eval/datasets_local/score_details --split test --pairs 40
```

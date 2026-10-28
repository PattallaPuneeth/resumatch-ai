# Human labeling: hard pairs

`hard_pairs_to_label.csv` holds 50 resume/JD pairs for a person to label by hand. The labels
will be used to refit **only** the two band thresholds (45 and 75 in `ml/eval/metrics.py`).
They do not change weights or any other part of scoring.

Regenerate the sheet (heavy, so run it in a one-off ML container, never while a k6 load test
is running: `docker ps | grep k6`):

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace -e PYTHONPATH=/workspace -e GIT_COMMIT="$(git rev-parse --short HEAD)" -e GIT_ML_DIRTY="$([ -n "$(git status --porcelain -- ml)" ] && echo 1 || echo 0)" project-cbp-ml:latest python -m ml.eval.mine_hard_pairs
```

The image has no git, so the two `GIT_*` variables pass the host's commit and whether `ml/` had
uncommitted changes. Both go into the selection JSON. `model_score` reflects the code that was
checked out at run time.

## How pairs were picked

`ml/eval/mine_hard_pairs.py` scores every labeled pair in `ml/eval/datasets/kaggle_domain`
(tune and test) and `test-data/extended_dataset` with the production eval path
(`ml/eval/runner.py`), then ranks them by hardness:

- `+3` for a hand-checked label error (R0118 for Accountant, R0239 for Data Analyst; see
  `docs/eval/ML_FAILURE_ANALYSIS.md`);
- `+1` per band between the model's band and the auto label (0 to 2);
- up to `+1` for a score within 7 points of 45 or 75 (1 at the edge, 0 at 7 points away).

It keeps 8 extended-set pairs and splits the other 42 evenly across the six Kaggle fields. Ties
are broken by `pair_id`, so the same scores always give the same sheet.
`hard_pairs_to_label_selection.json` records why each row was picked. It is kept out of the
sheet so it does not steer the labeler.

`model_score` and `auto_label` are in the sheet for reference. **Do not copy them into
`human_label`.** The auto labels came from keyword counting and some are known to be wrong.

## Labeling guidance

Read the resume excerpt and JD excerpt and decide what a hiring manager screening for this job
would do. The excerpts are cut at 600 characters. Open the full files (`resume_id` and `job_id`
under the dataset's `resumes/` and `jobs/`) if the excerpt is not enough.

| Label | Meaning |
| :--- | :--- |
| `strong` | Would be shortlisted. Has done this job or a very close one, covers most of the required skills with real evidence (titles, duties, results, not just keywords), and fits the seniority. |
| `medium` | Worth a second look. Related background or transferable experience, but clear gaps: some required skills missing, adjacent role, or a seniority mismatch. |
| `weak` | Would not be shortlisted. Different field, or only a keyword overlap without matching experience. |

Rules of thumb:

- Judge the evidence, not the vocabulary. "A/R reporting" counts as accounts receivable, and a
  bare "SQL, Excel" line does not make someone a data analyst.
- Use `medium` when you are honestly unsure between two bands. Do not leave it blank.
- Use `notes` for a short reason, especially when you disagree with `auto_label` or the pair
  is unusable (e.g. a broken resume text). Write `skip` in `notes` to exclude a row.

## Import (done)

A later importer will read this CSV and refit the thresholds on it. It will:

1. split `pair_id` (`<dataset>:<split>:<resume file>:<job file>`) to find the pair;
2. drop rows with an empty `human_label` or `skip` in `notes`, and reject any value other
   than `strong`, `medium` or `weak`;
3. re-score the pairs with the code at that time, instead of trusting `model_score` here;
4. report results for rows from the Kaggle `test` split separately. Those pairs are in the
   held-out split, so a threshold fitted on them must not be reported as a held-out
   Kaggle result.

Keep the column names and order as they are so the importer can rely on them.

The labeled sheet was imported with `python -m ml.eval.import_human_labels` (it reads .xlsx or
.csv) into `ml/eval/datasets/human_hard/`. Results are in `docs/eval/ML_FAILURE_ANALYSIS.md`
section 8.8.

# ResuMatch AI — Evaluation Harness Report

> **Dataset Type:** Synthetic Benchmark
> **Total Evaluated Pairs:** 32

## 1. Benchmark Summary (Production Configuration)

- **Pairwise Ordering Accuracy:** 97.6%
- **Label Classification Accuracy:** 87.5%
- **Mean Score (Strong):** 83.6
- **Mean Score (Medium):** 55.4
- **Mean Score (Weak):** 21.2
- **Strong-to-Medium Margin:** +28.2 pts
- **Medium-to-Weak Margin:** +34.2 pts

## 2. Component Ablation Study

### Ablation Study (Synthetic Evaluation Dataset)

> **Note:** All figures in this table are computed against a synthetic evaluation benchmark.

| Pipeline Configuration | Ordering Acc | Label Acc | Mean (Strong) | Mean (Medium) | Mean (Weak) | Strong-Medium Gap | Medium-Weak Gap |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Lexical Only (BM25)** | 92.6% | 43.8% | 34.2 | 23.9 | 19.4 | +10.3 | +4.5 |
| **Semantic Only (Dense Cosine)** | 80.9% | 46.9% | 40.6 | 33.9 | 28.7 | +6.8 | +5.1 |
| **RRF Only (Internal Chunk Ranker)*** | 58.1% | 25.0% | 100.0 | 100.0 | 99.9 | +0.0 | +0.1 |
| **RRF + Cross-Encoder** | 96.7% | 75.0% | 89.8 | 57.2 | 19.0 | +32.6 | +38.2 |
| **RRF + Cross-Encoder + Skill-Gap** | 97.6% | 87.5% | 88.2 | 57.9 | 20.5 | +30.4 | +37.4 |
| **Full Blend (Production)** | 97.6% | 87.5% | 83.6 | 55.4 | 21.2 | +28.2 | +34.2 |

\* *Note on RRF Only: RRF operates on chunk ranks (1 / (60 + rank)) within each resume to select candidate passages for Cross-Encoder reranking. Because every resume has a rank-1 chunk, intra-document RRF scores cluster near ~0.040 and do not act as an independent cross-resume score. Cross-Encoder reranking provides the subsequent cross-candidate discrimination.*

**Key Observations:**
- Cross-encoder reranking yields strong discrimination with 96.7% pairwise ordering accuracy.
- Note: Skill-gap and vector blending slightly compresses the Strong-to-Medium margin (+28.2 vs +32.6 in pure CE), highlighting the need for recalibration in Phase 3C-2.

## 3. Score Calibration Analysis

### Score Calibration Analysis (Train vs. Held-Out Splits)

> **Note:** Evaluated on synthetic benchmark pairs. Optimization conducted on train split, evaluated on unseen held-out split.

- **Train Pairs:** 19 | **Held-Out Pairs:** 13 (Seed: 42)
- **Baseline Parameters:** shift=-3.5, temp=2.8, weights=(0.65/0.25/0.1)
- **Fitted Parameters:** shift=-3.0, temp=1.8, weights=(0.7/0.2/0.1)

| Metric | Train (Baseline) | Train (Fitted) | Held-Out (Baseline) | Held-Out (Fitted) | Held-Out Delta |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Pairwise Ordering Acc** | 98.3% | 100.0% | 96.3% | 96.3% | +0.0% |
| **Strong-to-Medium Gap** | +24.1 pts | +27.8 pts | +34.2 pts | +41.9 pts | +7.7 pts |
| **Medium-to-Weak Gap** | +39.9 pts | +47.6 pts | +25.9 pts | +27.7 pts | +1.9 pts |
| **Mean Score (Strong)** | 84.0 | 87.9 | 83.0 | 87.0 | - |
| **Mean Score (Medium)** | 59.8 | 60.1 | 48.8 | 45.2 | - |
| **Mean Score (Weak)** | 19.9 | 12.6 | 22.9 | 17.4 | - |

## 4. Evaluated Pairs Detail

| Resume | Job | Expected | Final Score | CE Logit | CE Calibrated | Skill Cov | Vector Sim |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `resume_01_backend_node.docx` | `job_01_senior_backend_node.txt` | **STRONG** | **82.5** | 2.28 | 88.8 | 89% | 26.3% |
| `resume_01_backend_node.docx` | `job_02_backend_python.txt` | **MEDIUM** | **63.1** | 0.73 | 81.9 | 25% | 35.6% |
| `resume_01_backend_node.docx` | `job_03_fullstack_react.txt` | **MEDIUM** | **64.1** | -1.95 | 63.5 | 80% | 28.0% |
| `resume_01_backend_node.docx` | `job_08_android_developer.txt` | **WEAK** | **11.2** | -8.67 | 13.6 | 0% | 23.0% |
| `resume_02_backend_python.pdf` | `job_02_backend_python.txt` | **STRONG** | **84.6** | 4.53 | 94.6 | 75% | 43.7% |
| `resume_02_backend_python.pdf` | `job_01_senior_backend_node.txt` | **MEDIUM** | **61.9** | -0.09 | 77.2 | 33% | 34.1% |
| `resume_02_backend_python.pdf` | `job_04_ml_nlp_engineer.txt` | **MEDIUM** | **59.2** | -2.25 | 61.0 | 67% | 28.9% |
| `resume_02_backend_python.pdf` | `job_06_digital_marketing_lead.txt` | **WEAK** | **38.5** | -8.13 | 16.1 | 100% | 30.5% |
| `resume_03_fullstack_react.docx` | `job_03_fullstack_react.txt` | **STRONG** | **86.0** | 4.89 | 95.2 | 80% | 41.0% |
| `resume_03_fullstack_react.docx` | `job_01_senior_backend_node.txt` | **MEDIUM** | **24.2** | -7.36 | 20.1 | 33% | 28.3% |
| `resume_03_fullstack_react.docx` | `job_06_digital_marketing_lead.txt` | **WEAK** | **39.6** | -7.72 | 18.1 | 100% | 27.8% |
| `resume_03_fullstack_react.docx` | `job_08_android_developer.txt` | **WEAK** | **18.8** | -6.81 | 23.5 | 0% | 35.4% |
| `resume_04_data_scientist.docx` | `job_04_ml_nlp_engineer.txt` | **STRONG** | **79.6** | 3.04 | 91.2 | 67% | 36.6% |
| `resume_04_data_scientist.docx` | `job_02_backend_python.txt` | **MEDIUM** | **71.8** | -0.36 | 75.5 | 75% | 40.3% |
| `resume_04_data_scientist.docx` | `job_01_senior_backend_node.txt` | **WEAK** | **12.4** | -9.39 | 10.9 | 11% | 25.3% |
| `resume_04_data_scientist.docx` | `job_05_devops_engineer.txt` | **WEAK** | **30.2** | -6.00 | 29.1 | 33% | 29.1% |
| `resume_05_devops_sre.pdf` | `job_05_devops_engineer.txt` | **STRONG** | **82.3** | 4.34 | 94.3 | 67% | 43.6% |
| `resume_05_devops_sre.pdf` | `job_01_senior_backend_node.txt` | **MEDIUM** | **66.4** | -0.20 | 76.5 | 56% | 28.3% |
| `resume_05_devops_sre.pdf` | `job_02_backend_python.txt` | **MEDIUM** | **36.7** | -4.48 | 41.4 | 25% | 35.8% |
| `resume_05_devops_sre.pdf` | `job_08_android_developer.txt` | **WEAK** | **11.8** | -8.65 | 13.7 | 0% | 28.3% |
| `resume_06_marketing_manager.docx` | `job_06_digital_marketing_lead.txt` | **STRONG** | **87.3** | 2.45 | 89.3 | 100% | 42.3% |
| `resume_06_marketing_manager.docx` | `job_01_senior_backend_node.txt` | **WEAK** | **8.3** | -9.96 | 9.1 | 0% | 24.4% |
| `resume_06_marketing_manager.docx` | `job_05_devops_engineer.txt` | **WEAK** | **8.8** | -10.00 | 8.9 | 0% | 29.5% |
| `resume_06_marketing_manager.docx` | `job_08_android_developer.txt` | **WEAK** | **10.7** | -9.25 | 11.4 | 0% | 32.9% |
| `resume_07_fresher_java.docx` | `job_07_junior_java_developer.txt` | **STRONG** | **85.1** | 1.30 | 84.7 | 100% | 50.6% |
| `resume_07_fresher_java.docx` | `job_08_android_developer.txt` | **MEDIUM** | **63.0** | -3.38 | 51.1 | 100% | 47.5% |
| `resume_07_fresher_java.docx` | `job_01_senior_backend_node.txt` | **WEAK** | **18.3** | -8.30 | 15.2 | 22% | 28.3% |
| `resume_07_fresher_java.docx` | `job_02_backend_python.txt` | **WEAK** | **57.5** | -1.86 | 64.3 | 50% | 32.0% |
| `resume_08_mobile_kotlin.pdf` | `job_08_android_developer.txt` | **STRONG** | **81.3** | 0.43 | 80.3 | 100% | 41.2% |
| `resume_08_mobile_kotlin.pdf` | `job_07_junior_java_developer.txt` | **MEDIUM** | **43.7** | -6.74 | 23.9 | 100% | 31.8% |
| `resume_08_mobile_kotlin.pdf` | `job_01_senior_backend_node.txt` | **WEAK** | **8.8** | -9.77 | 9.6 | 0% | 25.1% |
| `resume_08_mobile_kotlin.pdf` | `job_03_fullstack_react.txt` | **WEAK** | **22.4** | -7.04 | 22.0 | 20% | 30.5% |
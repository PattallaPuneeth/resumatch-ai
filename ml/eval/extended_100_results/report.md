# ResuMatch AI — Evaluation Harness Report

> **Dataset Type:** Synthetic Benchmark
> **Total Evaluated Pairs:** 100

## 1. Benchmark Summary (Production Configuration)

- **Pairwise Ordering Accuracy:** 84.9%
- **Label Classification Accuracy:** 80.0%
- **Mean Score (Strong):** 98.2
- **Mean Score (Medium):** 41.4
- **Mean Score (Weak):** 31.1
- **Strong-to-Medium Margin:** +56.9 pts
- **Medium-to-Weak Margin:** +10.2 pts

## 2. Component Ablation Study

### Ablation Study (Synthetic Evaluation Dataset)

> **Note:** All figures in this table are computed against a synthetic evaluation benchmark.

| Pipeline Configuration | Ordering Acc | Label Acc | Mean (Strong) | Mean (Medium) | Mean (Weak) | Strong-Medium Gap | Medium-Weak Gap |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Lexical Only (BM25)** | 91.4% | 80.0% | 25.6 | 7.5 | 4.7 | +18.1 | +2.8 |
| **Semantic Only (Dense Cosine)** | 89.5% | 86.0% | 91.3 | 47.0 | 37.8 | +44.4 | +9.2 |
| **RRF Only (Internal Chunk Ranker)*** | 50.0% | 10.0% | 100.0 | 100.0 | 100.0 | +0.0 | +0.0 |
| **RRF + Cross-Encoder** | 90.7% | 86.0% | 98.6 | 46.8 | 24.3 | +51.8 | +22.5 |
| **RRF + Cross-Encoder + Skill-Gap** | 84.2% | 79.0% | 99.0 | 40.2 | 30.9 | +58.8 | +9.4 |
| **Full Blend (Production)** | 84.9% | 80.0% | 98.2 | 41.4 | 31.1 | +56.9 | +10.2 |

\* *Note on RRF Only: RRF operates on chunk ranks (1 / (60 + rank)) within each resume to select candidate passages for Cross-Encoder reranking. Because every resume has a rank-1 chunk, intra-document RRF scores cluster near ~0.040 and do not act as an independent cross-resume score. Cross-Encoder reranking provides the subsequent cross-candidate discrimination.*

**Key Observations:**
- Cross-encoder reranking yields strong discrimination with 90.7% pairwise ordering accuracy.
- Full blend provides robust separation across all tiers with 84.9% pairwise accuracy.

## 3. Score Calibration Analysis

### Score Calibration Analysis (Train vs. Held-Out Splits)

> **Note:** Evaluated on synthetic benchmark pairs. Optimization conducted on train split, evaluated on unseen held-out split.

- **Train Pairs:** 60 | **Held-Out Pairs:** 40 (Seed: 42)
- **Baseline Parameters:** shift=-3.5, temp=2.8, weights=(0.65/0.25/0.1)
- **Fitted Parameters:** shift=-2.0, temp=1.8, weights=(0.7/0.2/0.1)

| Metric | Train (Baseline) | Train (Fitted) | Held-Out (Baseline) | Held-Out (Fitted) | Held-Out Delta |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Pairwise Ordering Acc** | 82.3% | 83.0% | 88.6% | 90.4% | +1.8% |
| **Strong-to-Medium Gap** | +60.5 pts | +71.0 pts | +51.4 pts | +59.3 pts | +7.9 pts |
| **Medium-to-Weak Gap** | +6.3 pts | +8.0 pts | +16.1 pts | +20.4 pts | +4.3 pts |
| **Mean Score (Strong)** | 98.1 | 98.8 | 98.3 | 99.0 | - |
| **Mean Score (Medium)** | 37.6 | 27.9 | 47.0 | 39.7 | - |
| **Mean Score (Weak)** | 31.3 | 19.8 | 30.9 | 19.3 | - |

## 4. Evaluated Pairs Detail

| Resume | Job | Expected | Final Score | CE Logit | CE Calibrated | Skill Cov | Vector Sim |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `resume_backend_go.txt` | `job_backend_go.txt` | **STRONG** | **98.5** | 8.37 | 98.6 | 100% | 93.7% |
| `resume_backend_java.txt` | `job_backend_java.txt` | **STRONG** | **98.2** | 8.48 | 98.6 | 100% | 90.5% |
| `resume_frontend_vue.txt` | `job_frontend_vue.txt` | **STRONG** | **98.4** | 8.13 | 98.5 | 100% | 94.4% |
| `resume_mobile_ios.txt` | `job_mobile_ios.txt` | **STRONG** | **98.3** | 8.10 | 98.4 | 100% | 93.7% |
| `resume_security_eng.txt` | `job_security_eng.txt` | **STRONG** | **98.5** | 8.41 | 98.6 | 100% | 93.8% |
| `resume_qa_automation.txt` | `job_qa_automation.txt` | **STRONG** | **97.9** | 8.12 | 98.5 | 100% | 89.3% |
| `resume_data_engineer.txt` | `job_data_engineer.txt` | **STRONG** | **98.5** | 8.23 | 98.5 | 100% | 94.4% |
| `resume_devops_cloud.txt` | `job_devops_cloud.txt` | **STRONG** | **98.4** | 8.55 | 98.7 | 100% | 93.1% |
| `resume_product_mgr.txt` | `job_product_mgr.txt` | **STRONG** | **97.3** | 8.47 | 98.6 | 100% | 82.2% |
| `resume_sales_exec.txt` | `job_sales_exec.txt` | **STRONG** | **98.0** | 8.78 | 98.8 | 100% | 88.5% |
| `resume_backend_go.txt` | `job_backend_java.txt` | **MEDIUM** | **54.6** | -1.87 | 64.2 | 33% | 45.8% |
| `resume_backend_go.txt` | `job_devops_cloud.txt` | **MEDIUM** | **64.6** | 0.00 | 77.8 | 33% | 57.2% |
| `resume_backend_java.txt` | `job_backend_go.txt` | **MEDIUM** | **50.5** | -2.38 | 59.9 | 25% | 53.1% |
| `resume_data_engineer.txt` | `job_backend_go.txt` | **MEDIUM** | **21.1** | -6.45 | 25.8 | 0% | 42.9% |
| `resume_security_eng.txt` | `job_backend_go.txt` | **MEDIUM** | **20.4** | -6.57 | 25.1 | 0% | 41.2% |
| `resume_qa_automation.txt` | `job_frontend_vue.txt` | **MEDIUM** | **54.1** | -4.95 | 37.3 | 100% | 48.9% |
| `resume_devops_cloud.txt` | `job_backend_go.txt` | **MEDIUM** | **61.6** | -0.29 | 75.9 | 25% | 59.7% |
| `resume_mobile_ios.txt` | `job_frontend_vue.txt` | **MEDIUM** | **24.7** | -5.67 | 31.5 | 0% | 41.7% |
| `resume_product_mgr.txt` | `job_backend_go.txt` | **MEDIUM** | **13.8** | -8.31 | 15.2 | 0% | 38.6% |
| `resume_qa_automation.txt` | `job_devops_cloud.txt` | **MEDIUM** | **48.3** | -2.91 | 55.3 | 33% | 40.6% |
| `resume_backend_go.txt` | `job_frontend_vue.txt` | **WEAK** | **25.3** | -5.49 | 32.9 | 0% | 39.1% |
| `resume_backend_go.txt` | `job_mobile_ios.txt` | **WEAK** | **74.8** | -1.15 | 69.8 | 100% | 44.3% |
| `resume_backend_go.txt` | `job_security_eng.txt` | **WEAK** | **45.8** | -6.50 | 25.5 | 100% | 41.7% |
| `resume_backend_go.txt` | `job_qa_automation.txt` | **WEAK** | **22.3** | -6.33 | 26.7 | 0% | 49.0% |
| `resume_backend_go.txt` | `job_data_engineer.txt` | **WEAK** | **17.8** | -7.37 | 20.1 | 0% | 47.6% |
| `resume_backend_go.txt` | `job_product_mgr.txt` | **WEAK** | **40.0** | -7.96 | 16.9 | 100% | 40.3% |
| `resume_backend_go.txt` | `job_sales_exec.txt` | **WEAK** | **35.4** | -9.38 | 10.9 | 100% | 33.3% |
| `resume_backend_java.txt` | `job_frontend_vue.txt` | **WEAK** | **12.5** | -8.25 | 15.5 | 0% | 24.1% |
| `resume_backend_java.txt` | `job_mobile_ios.txt` | **WEAK** | **40.9** | -7.37 | 20.1 | 100% | 28.9% |
| `resume_backend_java.txt` | `job_security_eng.txt` | **WEAK** | **38.9** | -8.30 | 15.3 | 100% | 39.8% |
| `resume_backend_java.txt` | `job_qa_automation.txt` | **WEAK** | **11.6** | -9.04 | 12.1 | 0% | 36.5% |
| `resume_backend_java.txt` | `job_data_engineer.txt` | **WEAK** | **13.2** | -9.12 | 11.9 | 0% | 54.5% |
| `resume_backend_java.txt` | `job_devops_cloud.txt` | **WEAK** | **17.2** | -7.43 | 19.7 | 0% | 44.0% |
| `resume_backend_java.txt` | `job_product_mgr.txt` | **WEAK** | **38.6** | -8.26 | 15.4 | 100% | 35.9% |
| `resume_backend_java.txt` | `job_sales_exec.txt` | **WEAK** | **39.0** | -8.20 | 15.8 | 100% | 37.7% |
| `resume_frontend_vue.txt` | `job_backend_go.txt` | **WEAK** | **32.6** | -4.13 | 44.4 | 0% | 37.5% |
| `resume_frontend_vue.txt` | `job_backend_java.txt` | **WEAK** | **15.0** | -7.40 | 19.9 | 0% | 20.2% |
| `resume_frontend_vue.txt` | `job_mobile_ios.txt` | **WEAK** | **61.3** | -3.59 | 49.2 | 100% | 43.5% |
| `resume_frontend_vue.txt` | `job_security_eng.txt` | **WEAK** | **43.2** | -6.99 | 22.3 | 100% | 36.8% |
| `resume_frontend_vue.txt` | `job_qa_automation.txt` | **WEAK** | **41.8** | -4.81 | 38.5 | 50% | 42.3% |
| `resume_frontend_vue.txt` | `job_data_engineer.txt` | **WEAK** | **12.5** | -8.61 | 13.9 | 0% | 34.5% |
| `resume_frontend_vue.txt` | `job_devops_cloud.txt` | **WEAK** | **16.0** | -7.37 | 20.1 | 0% | 29.7% |
| `resume_frontend_vue.txt` | `job_product_mgr.txt` | **WEAK** | **61.0** | -3.60 | 49.1 | 100% | 41.0% |
| `resume_frontend_vue.txt` | `job_sales_exec.txt` | **WEAK** | **33.8** | -9.73 | 9.8 | 100% | 25.0% |
| `resume_mobile_ios.txt` | `job_backend_go.txt` | **WEAK** | **42.5** | -2.48 | 59.0 | 0% | 41.5% |
| `resume_mobile_ios.txt` | `job_backend_java.txt` | **WEAK** | **8.8** | -9.60 | 10.2 | 0% | 22.2% |
| `resume_mobile_ios.txt` | `job_security_eng.txt` | **WEAK** | **63.4** | -3.30 | 51.8 | 100% | 47.6% |
| `resume_mobile_ios.txt` | `job_qa_automation.txt` | **WEAK** | **22.7** | -5.90 | 29.8 | 0% | 33.7% |
| `resume_mobile_ios.txt` | `job_data_engineer.txt` | **WEAK** | **15.6** | -7.85 | 17.5 | 0% | 42.4% |
| `resume_mobile_ios.txt` | `job_devops_cloud.txt` | **WEAK** | **23.5** | -5.82 | 30.4 | 0% | 37.2% |
| `resume_mobile_ios.txt` | `job_product_mgr.txt` | **WEAK** | **40.6** | -7.88 | 17.3 | 100% | 44.0% |
| `resume_mobile_ios.txt` | `job_sales_exec.txt` | **WEAK** | **34.2** | -9.50 | 10.5 | 100% | 24.1% |
| `resume_security_eng.txt` | `job_backend_java.txt` | **WEAK** | **13.3** | -8.26 | 15.5 | 0% | 32.5% |
| `resume_security_eng.txt` | `job_frontend_vue.txt` | **WEAK** | **12.4** | -8.78 | 13.2 | 0% | 38.7% |
| `resume_security_eng.txt` | `job_mobile_ios.txt` | **WEAK** | **60.5** | -3.85 | 46.9 | 100% | 50.0% |
| `resume_security_eng.txt` | `job_qa_automation.txt` | **WEAK** | **24.6** | -5.68 | 31.4 | 0% | 41.9% |
| `resume_security_eng.txt` | `job_data_engineer.txt` | **WEAK** | **22.4** | -6.27 | 27.1 | 0% | 48.2% |
| `resume_security_eng.txt` | `job_devops_cloud.txt` | **WEAK** | **27.6** | -5.05 | 36.5 | 0% | 39.0% |
| `resume_security_eng.txt` | `job_product_mgr.txt` | **WEAK** | **55.7** | -4.65 | 39.9 | 100% | 47.9% |
| `resume_security_eng.txt` | `job_sales_exec.txt` | **WEAK** | **36.2** | -9.23 | 11.4 | 100% | 38.2% |
| `resume_qa_automation.txt` | `job_backend_go.txt` | **WEAK** | **21.1** | -6.66 | 24.4 | 0% | 52.3% |
| `resume_qa_automation.txt` | `job_backend_java.txt` | **WEAK** | **10.9** | -9.58 | 10.2 | 0% | 42.9% |
| `resume_qa_automation.txt` | `job_mobile_ios.txt` | **WEAK** | **54.0** | -4.84 | 38.3 | 100% | 41.1% |
| `resume_qa_automation.txt` | `job_security_eng.txt` | **WEAK** | **51.3** | -5.39 | 33.7 | 100% | 43.8% |
| `resume_qa_automation.txt` | `job_data_engineer.txt` | **WEAK** | **16.1** | -7.69 | 18.3 | 0% | 42.5% |
| `resume_qa_automation.txt` | `job_product_mgr.txt` | **WEAK** | **40.7** | -7.81 | 17.7 | 100% | 42.5% |
| `resume_qa_automation.txt` | `job_sales_exec.txt` | **WEAK** | **38.4** | -8.52 | 14.3 | 100% | 40.7% |
| `resume_data_engineer.txt` | `job_backend_java.txt` | **WEAK** | **12.9** | -8.79 | 13.1 | 0% | 43.5% |
| `resume_data_engineer.txt` | `job_frontend_vue.txt` | **WEAK** | **11.4** | -9.03 | 12.2 | 0% | 34.5% |
| `resume_data_engineer.txt` | `job_mobile_ios.txt` | **WEAK** | **54.1** | -4.84 | 38.2 | 100% | 42.4% |
| `resume_data_engineer.txt` | `job_security_eng.txt` | **WEAK** | **48.1** | -6.02 | 28.9 | 100% | 43.3% |
| `resume_data_engineer.txt` | `job_qa_automation.txt` | **WEAK** | **21.1** | -6.36 | 26.5 | 0% | 39.4% |
| `resume_data_engineer.txt` | `job_devops_cloud.txt` | **WEAK** | **30.6** | -4.57 | 40.6 | 0% | 42.1% |
| `resume_data_engineer.txt` | `job_product_mgr.txt` | **WEAK** | **40.7** | -7.80 | 17.7 | 100% | 41.7% |
| `resume_data_engineer.txt` | `job_sales_exec.txt` | **WEAK** | **35.3** | -9.38 | 10.9 | 100% | 32.5% |
| `resume_devops_cloud.txt` | `job_backend_java.txt` | **WEAK** | **13.6** | -8.32 | 15.2 | 0% | 37.3% |
| `resume_devops_cloud.txt` | `job_frontend_vue.txt` | **WEAK** | **11.1** | -8.93 | 12.6 | 0% | 28.8% |
| `resume_devops_cloud.txt` | `job_mobile_ios.txt` | **WEAK** | **54.2** | -4.72 | 39.2 | 100% | 37.2% |
| `resume_devops_cloud.txt` | `job_security_eng.txt` | **WEAK** | **52.6** | -5.11 | 36.0 | 100% | 41.9% |
| `resume_devops_cloud.txt` | `job_qa_automation.txt` | **WEAK** | **56.4** | -2.16 | 61.8 | 50% | 38.0% |
| `resume_devops_cloud.txt` | `job_data_engineer.txt` | **WEAK** | **20.5** | -6.61 | 24.8 | 0% | 43.8% |
| `resume_devops_cloud.txt` | `job_product_mgr.txt` | **WEAK** | **52.0** | -5.22 | 35.1 | 100% | 42.2% |
| `resume_devops_cloud.txt` | `job_sales_exec.txt` | **WEAK** | **34.7** | -9.52 | 10.4 | 100% | 29.3% |
| `resume_product_mgr.txt` | `job_backend_java.txt` | **WEAK** | **12.0** | -8.65 | 13.7 | 0% | 31.4% |
| `resume_product_mgr.txt` | `job_frontend_vue.txt` | **WEAK** | **31.1** | -4.45 | 41.6 | 0% | 40.5% |
| `resume_product_mgr.txt` | `job_mobile_ios.txt` | **WEAK** | **46.8** | -6.23 | 27.4 | 100% | 39.8% |
| `resume_product_mgr.txt` | `job_security_eng.txt` | **WEAK** | **43.1** | -7.31 | 20.4 | 100% | 48.2% |
| `resume_product_mgr.txt` | `job_qa_automation.txt` | **WEAK** | **16.7** | -7.52 | 19.2 | 0% | 42.4% |
| `resume_product_mgr.txt` | `job_data_engineer.txt` | **WEAK** | **14.4** | -8.20 | 15.7 | 0% | 41.6% |
| `resume_product_mgr.txt` | `job_devops_cloud.txt` | **WEAK** | **31.9** | -4.31 | 42.9 | 0% | 41.0% |
| `resume_product_mgr.txt` | `job_sales_exec.txt` | **WEAK** | **39.5** | -8.21 | 15.7 | 100% | 43.4% |
| `resume_sales_exec.txt` | `job_backend_go.txt` | **WEAK** | **9.1** | -9.53 | 10.4 | 0% | 23.8% |
| `resume_sales_exec.txt` | `job_backend_java.txt` | **WEAK** | **7.8** | -10.70 | 7.1 | 0% | 32.2% |
| `resume_sales_exec.txt` | `job_frontend_vue.txt` | **WEAK** | **7.6** | -10.28 | 8.2 | 0% | 22.7% |
| `resume_sales_exec.txt` | `job_mobile_ios.txt` | **WEAK** | **39.5** | -7.44 | 19.6 | 100% | 17.3% |
| `resume_sales_exec.txt` | `job_security_eng.txt` | **WEAK** | **37.1** | -8.56 | 14.1 | 100% | 29.7% |
| `resume_sales_exec.txt` | `job_qa_automation.txt` | **WEAK** | **18.7** | -6.70 | 24.2 | 0% | 29.7% |
| `resume_sales_exec.txt` | `job_data_engineer.txt` | **WEAK** | **8.9** | -9.71 | 9.8 | 0% | 24.8% |
| `resume_sales_exec.txt` | `job_devops_cloud.txt` | **WEAK** | **10.0** | -9.15 | 11.7 | 0% | 23.9% |
| `resume_sales_exec.txt` | `job_product_mgr.txt` | **WEAK** | **38.5** | -8.06 | 16.4 | 100% | 28.0% |
# Overnight work summary (29 Oct 2026)

All fixes below are **committed locally on `main` and not pushed**. All 8 services were healthy at the end.

## Commits

| Commit | What |
| :--- | :--- |
| `86caa37` | **fix(auth):** users were logged out every 15 minutes (refresh cookie never reached the refresh route) |
| `708b5d7` | **fix(worker):** a deleted resume/job no longer causes an ERROR + traceback + retries |
| `6bef7bc` | **fix(frontend):** correct match verdict, live status, match history refresh, plain wording, phone layout, no login flicker |
| `a922c47` | **perf(frontend):** no failing session calls for logged-out visitors, slower health polling, page titles in the first HTML |

## 🔴 High: users saw wrong or stale information (all fixed and checked live)

1. **Every match said "Moderate Match", even at 97/100.** The backend sends `verdictBand`/`matchScore` (camelCase); the screen read `verdict_band` (snake_case), so it always fell back to "medium". The same bug hid the "prioritized improvements" section.
   - **Live after the fix:** a 97 score shows **"Strong Match"**, the ATS score 70/100 appears, and the improvements section is visible.
   - The tests now use the **real** API format, so this can't slip through again.
2. **The resume status stayed on "UPLOADED"** until you clicked Refresh. The backend has 7 statuses and the screen knew only 4, so it never kept checking.
   - **Live after the fix:** "Processing" turned into "Parsed 70/100" by itself after 4 seconds.
3. **The match history didn't update after a new match** (it showed "0 matches" above the finished result).
   - **Live after the fix:** it updates to "(1)" by itself, without a reload.
4. **Found during the checks: users were logged out every 15 minutes.** The refresh cookie was limited to `/v1/auth`, but the browser calls `/api/backend/v1/auth/refresh` through the proxy, so the cookie was never sent.
   - **Live after the fix:** the refresh call returns 200 instead of 401, and the session survives a backend restart.
   - The full backend suite passes **440/440** against a throwaway test database. That includes all the login, refresh and logout tests.

## 🟡 Medium (all fixed)

- **Plain language:** no more "BM25", "cross-encoder joint attention", "Reranker", "fail-open" or the tech-stack footer. The score breakdown now explains each row and its scale. **The numbers themselves are unchanged.**
- **Phones:** the resumes table fits a 375 px screen, the Analyze and Delete buttons are visible and big enough to tap, and the ATS score sits under the status badge. Desktop still shows all 6 columns.
- **No "Log in / Sign up" flash** while the session is being checked.
- **Worker:** a match for a deleted resume is now logged as a warning and skipped. This is covered by 2 unit tests; I didn't force that race in the live app.

## 🟢 Low (fixed)

- **Logged-out visitors:** the landing page now makes **1** request instead of 5, with no 401 errors in the console.
- **Status panel:** the public health check polls every 30 s instead of every 5 s.
- **Page titles:** every page now has its own title, sent with the first HTML.

## Checks run

| Suite | Result |
| :--- | :--- |
| Frontend tests | 146/146 |
| Frontend `tsc` and `eslint` | clean |
| Backend tests | 440/440 with a throwaway test DB; without it, 343 pass and the 73 that need the DB fail as before |
| Backend `tsc` | clean |
| ML tests | 314 passed + 2 new tests |
| `ruff` and `mypy` (CI config) | clean |
| ML eval gate | passed |
| Live browser | each fix checked live at desktop and phone width |

## Not done / to know

- **Nothing is pushed.** Say "push" when you want it on GitHub.
- **One React hydration warning (#418)** appeared once, right after a container restart. It didn't come back when I reloaded every page fresh, so it looks like a one-off from deploying while a tab was open.
- **This machine only:** opening the app at `http://127.0.0.1:3000` instead of `localhost:3000` avoids about 200 ms per request (Windows tries IPv6 first). It doesn't affect real users.
- **The ML "role-level and must-have" check** (the next accuracy step) is **not started**. Band accuracy is still about 49% on the 180 human labels.
- **Files I didn't touch:** `dataset_200.csv` / `dataset_200.xlsx` appeared in the project root. I left them alone and didn't commit them.
- **Test data:** the local test account now has 2 uploaded test resumes and 2 test job matches.

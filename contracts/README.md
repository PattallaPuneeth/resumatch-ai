# Cross-service contracts

The analysis result is written by the ML worker, stored by the backend as JSON and read by the
frontend. Nothing generates types across the three, so each side tests against the same sample:

| File | Writer check | Reader check |
| :--- | :--- | :--- |
| `analysis-result.json` | `ml/tests/test_contracts.py`: the worker's `StructuredAnalysisResult` reads and writes this exact JSON | `frontend/src/lib/__tests__/contracts.test.tsx`: the normaliser and the results screen show every field |

Resume statuses are checked the same way: the frontend test reads the `ResumeStatus` enum from
`backend/db/schema.prisma` and fails if the UI does not know a status.

When a field changes, change this file first; both tests then show what else has to change.

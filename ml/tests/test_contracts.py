"""The worker's analysis payload must match the shared contract the frontend is tested against."""

from __future__ import annotations

import json
from pathlib import Path

from ml.pipelines.llm.models import StructuredAnalysisResult

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "analysis-result.json"


def test_worker_writes_exactly_the_contract_shape() -> None:
    sample = json.loads(CONTRACT.read_text(encoding="utf-8"))
    # The worker stores model_dump(by_alias=True); a round trip must reproduce the file exactly,
    # so a renamed, added or removed field fails here before it reaches the frontend.
    dumped = StructuredAnalysisResult.model_validate(sample).model_dump(by_alias=True)
    assert dumped == sample

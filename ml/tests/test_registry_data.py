import json
from pathlib import Path

import jsonschema

ML = Path(__file__).resolve().parents[1]


def test_credential_registry_matches_schema_and_has_sources():
    schema = json.loads((ML / "schemas/credential_registry.json").read_text(encoding="utf-8"))
    doc = json.loads((ML / "data/credential_registry.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(doc)
    ids = [e["credential_id"] for e in doc["entries"]]
    assert len(ids) == len(set(ids))
    assert all(e["provenance"]["source_urls"] for e in doc["entries"])
    sectors = {s for e in doc["entries"] for s in e["sector_ids"]}
    assert {9, 14, 15, 20} <= sectors  # finance, legal, healthcare, trades covered

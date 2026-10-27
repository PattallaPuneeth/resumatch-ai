"""Shared pytest configuration for the ML service tests."""

from __future__ import annotations

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    # Any test that opens the real database through the db_conn fixture needs the migrated
    # Postgres schema, so it runs with the other integration tests inside the compose stack.
    for item in items:
        if "db_conn" in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.integration)

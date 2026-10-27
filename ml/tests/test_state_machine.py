"""
Phase 10A - Item C2: State Machine Unit Tests (Python / ML)

Validates state transitions for resume and analysis processing:
- Allowed forward transitions
- Non-terminal failure transitions
- Idempotent self-transitions
- Rejection of invalid / backward transitions from terminal states (PARSED, FAILED)
"""

import pytest
from ml.pipelines.intake.state_machine import (
    evaluate_resume_transition,
    ALLOWED_RESUME_TRANSITIONS,
)


def test_resume_valid_forward_transitions() -> None:
    # Standard text-layer path
    assert evaluate_resume_transition("UPLOAD_PENDING", "UPLOADED").allowed
    assert evaluate_resume_transition("UPLOADED", "EXTRACTING").allowed
    assert evaluate_resume_transition("EXTRACTING", "PARSED").allowed

    # OCR path
    assert evaluate_resume_transition("EXTRACTING", "NEEDS_OCR").allowed
    assert evaluate_resume_transition("NEEDS_OCR", "OCR_PROCESSING").allowed
    assert evaluate_resume_transition("OCR_PROCESSING", "PARSED").allowed


def test_resume_failure_from_active_states() -> None:
    active_states = [
        "UPLOAD_PENDING",
        "UPLOADED",
        "EXTRACTING",
        "NEEDS_OCR",
        "OCR_PROCESSING",
    ]
    for s in active_states:
        res = evaluate_resume_transition(s, "FAILED")
        assert res.allowed
        assert not res.is_noop


def test_resume_idempotent_self_transitions() -> None:
    all_states = [
        "UPLOAD_PENDING",
        "UPLOADED",
        "EXTRACTING",
        "NEEDS_OCR",
        "OCR_PROCESSING",
        "PARSED",
        "FAILED",
    ]
    for s in all_states:
        res = evaluate_resume_transition(s, s)
        assert res.allowed
        assert res.is_noop


def test_resume_terminal_parsed_immutability() -> None:
    targets = [
        "UPLOAD_PENDING",
        "UPLOADED",
        "EXTRACTING",
        "NEEDS_OCR",
        "OCR_PROCESSING",
        "FAILED",
    ]
    for t in targets:
        res = evaluate_resume_transition("PARSED", t)
        assert not res.allowed
        assert not res.is_noop


def test_resume_terminal_failed_immutability() -> None:
    targets = [
        "UPLOAD_PENDING",
        "UPLOADED",
        "EXTRACTING",
        "NEEDS_OCR",
        "OCR_PROCESSING",
        "PARSED",
    ]
    for t in targets:
        res = evaluate_resume_transition("FAILED", t)
        assert not res.allowed
        assert not res.is_noop


def test_resume_forbidden_skipped_transitions() -> None:
    assert not evaluate_resume_transition("UPLOAD_PENDING", "PARSED").allowed
    assert not evaluate_resume_transition("UPLOAD_PENDING", "EXTRACTING").allowed
    assert not evaluate_resume_transition("UPLOADED", "PARSED").allowed

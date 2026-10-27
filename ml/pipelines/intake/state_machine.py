"""
State machine guard for resume and analysis processing lifecycles.
"""

from typing import NamedTuple

ALLOWED_RESUME_TRANSITIONS: dict[str, set[str]] = {
    "UPLOAD_PENDING": {"UPLOADED", "FAILED"},
    "UPLOADED": {"EXTRACTING", "FAILED"},
    "EXTRACTING": {"NEEDS_OCR", "OCR_PROCESSING", "PARSED", "FAILED"},
    "NEEDS_OCR": {"OCR_PROCESSING", "FAILED"},
    "OCR_PROCESSING": {"PARSED", "FAILED"},
    "PARSED": set(),  # Terminal
    "FAILED": set(),  # Terminal
}

ALLOWED_ANALYSIS_TRANSITIONS: dict[str, set[str]] = {
    "PENDING": {"PROCESSING", "FAILED"},
    "PROCESSING": {"COMPLETED", "FAILED"},
    "COMPLETED": set(),
    "FAILED": set(),
}


class TransitionResult(NamedTuple):
    allowed: bool
    is_noop: bool
    reason: str = ""


def evaluate_resume_transition(current: str, target: str) -> TransitionResult:
    """Evaluates whether transitioning from current to target status is valid."""
    if current == target:
        return TransitionResult(allowed=True, is_noop=True)

    allowed_targets = ALLOWED_RESUME_TRANSITIONS.get(current)
    if allowed_targets is None:
        return TransitionResult(
            allowed=False, is_noop=False, reason=f"Unknown status '{current}'"
        )

    if target in allowed_targets:
        return TransitionResult(allowed=True, is_noop=False)

    return TransitionResult(
        allowed=False,
        is_noop=False,
        reason=f"Transition from '{current}' to '{target}' is forbidden",
    )

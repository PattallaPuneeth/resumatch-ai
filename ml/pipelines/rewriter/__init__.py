"""
Fact-grounded STAR bullet rewriter module (Phase 4B).
"""

from ml.pipelines.rewriter.models import (
    BulletRewriteRequest,
    EvidenceSpan,
    RewriterServiceResponse,
    VerifiedRewriteOption,
)
from ml.pipelines.rewriter.service import BulletRewriterService
from ml.pipelines.rewriter.verifier import BulletRewriteVerifier, VerificationResult

__all__ = [
    "BulletRewriteRequest",
    "BulletRewriterService",
    "BulletRewriteVerifier",
    "EvidenceSpan",
    "RewriterServiceResponse",
    "VerificationResult",
    "VerifiedRewriteOption",
]

"""
Tests for Phase 3A Embedding Generation (ml/pipelines/embeddings/embedder.py).
"""

import numpy as np
import pytest

from ml.pipelines.embeddings.chunker import TextChunk
from ml.pipelines.embeddings.embedder import (
    EXPECTED_EMBEDDING_DIM,
    generate_chunk_embeddings,
    generate_embeddings,
    get_embedder,
)


def test_embedder_singleton_reuse():
    """Verifies the model is loaded as a singleton within the worker process."""
    m1 = get_embedder()
    m2 = get_embedder()
    assert m1 is m2, "get_embedder() must return the same singleton instance"


def test_generate_embeddings_dimension_and_finite_values():
    """Verifies that generated embeddings have 384 dimensions and finite float values."""
    texts = [
        "Senior Software Engineer specializing in distributed databases and Python.",
        "Bachelor of Science in Computer Science from UC Berkeley.",
        "Technical skills include PostgreSQL, Redis, Docker, and PyTorch.",
    ]
    vectors = generate_embeddings(texts)

    assert len(vectors) == len(texts)

    for vec in vectors:
        assert len(vec) == EXPECTED_EMBEDDING_DIM
        arr = np.array(vec, dtype=np.float32)
        # Verify finite values
        assert np.isfinite(arr).all()
        # Verify L2 normalized (for cosine distance)
        norm = np.linalg.norm(arr)
        assert pytest.approx(norm, abs=1e-3) == 1.0


def test_generate_embeddings_empty_list():
    """Verifies that an empty input list returns an empty vector list."""
    assert generate_embeddings([]) == []


def test_generate_chunk_embeddings_correspondence():
    """Verifies 1:1 correspondence between TextChunk input and output tuples."""
    chunks = [
        TextChunk(
            chunk_index=0,
            section_type="SUMMARY",
            heading="SUMMARY",
            content="Summary content text",
            start_char=0,
            end_char=20,
            token_count=3,
            metadata={},
        ),
        TextChunk(
            chunk_index=1,
            section_type="EXPERIENCE",
            heading="EXPERIENCE",
            content="Experience content text with more details",
            start_char=25,
            end_char=66,
            token_count=6,
            metadata={},
        ),
    ]

    paired = generate_chunk_embeddings(chunks)
    assert len(paired) == 2

    for (chunk, vec), original_chunk in zip(paired, chunks, strict=True):
        assert chunk is original_chunk
        assert len(vec) == EXPECTED_EMBEDDING_DIM
        assert np.isfinite(vec).all()


def test_generate_embeddings_raises_on_overlong_text():
    """Verifies that generate_embeddings rejects texts that exceed model max sequence length."""
    # Create text with 300 words which is well over 256 WordPiece tokens
    overlong_text = "word " * 350
    with pytest.raises(ValueError, match="exceeds the embedding model maximum sequence length"):
        generate_embeddings([overlong_text])


def test_generate_chunk_embeddings_uses_heading_context_without_altering_content():
    """
    Verifies that generate_chunk_embeddings encodes embedding_text (which incorporates heading)
    without mutating chunk.content or offsets.
    """
    chunk = TextChunk(
        chunk_index=0,
        section_type="EXPERIENCE",
        heading="WORK EXPERIENCE",
        content="Lead Architect at TechCorp (2020-2023).",
        start_char=100,
        end_char=138,
        token_count=12,
        metadata={},
    )
    # heading is not prefix of content
    assert chunk.embedding_text == "WORK EXPERIENCE\nLead Architect at TechCorp (2020-2023)."
    assert chunk.content == "Lead Architect at TechCorp (2020-2023)."

    paired = generate_chunk_embeddings([chunk])
    assert len(paired) == 1
    returned_chunk, vec = paired[0]
    assert returned_chunk.content == "Lead Architect at TechCorp (2020-2023)."
    assert len(vec) == EXPECTED_EMBEDDING_DIM


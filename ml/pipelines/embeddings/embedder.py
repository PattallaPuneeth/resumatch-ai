"""
Phase 3A: Embedding Generation for ResuMatch AI.

Generates 384-dimensional normalized vector embeddings using
sentence-transformers/all-MiniLM-L6-v2 with process-level singleton caching,
strict dimension validation, and finite value checks.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import numpy as np
from ml.config import settings
from sentence_transformers import SentenceTransformer

if TYPE_CHECKING:
    from ml.pipelines.embeddings.chunker import TextChunk

logger = logging.getLogger("resumatch-ml-embedder")

EXPECTED_EMBEDDING_DIM = getattr(settings, "embedding_dimension", 384)
MODEL_NAME = getattr(settings, "embedding_model_name", "sentence-transformers/all-MiniLM-L6-v2")

_MODEL_INSTANCE: SentenceTransformer | None = None


def get_embedder() -> SentenceTransformer:
    """
    Returns the singleton SentenceTransformer instance.
    Loaded once per worker process to conserve memory and avoid repeated disk/network I/O.
    """
    global _MODEL_INSTANCE
    if _MODEL_INSTANCE is None:
        logger.info("Loading embedding model %s into worker process memory...", MODEL_NAME)
        _MODEL_INSTANCE = SentenceTransformer(MODEL_NAME)
        logger.info("Embedding model %s loaded successfully.", MODEL_NAME)
    return _MODEL_INSTANCE


def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Generates normalized 384-dimensional embeddings for a list of texts.

    Args:
        texts: List of text strings to embed.

    Returns:
        List of 384-element float lists.

    Raises:
        ValueError: If dimensions mismatch, text exceeds max sequence length,
                    or any values are non-finite (NaN / Inf).
    """
    if not texts:
        return []

    model = get_embedder()

    # Prevent silent model truncation by verifying input lengths against model.max_seq_length
    tokenizer = getattr(model, "tokenizer", None)
    if tokenizer is not None:
        for idx, text in enumerate(texts):
            encoded = tokenizer.encode(text, add_special_tokens=True)
            if len(encoded) > model.max_seq_length:
                raise ValueError(
                    f"Text at index {idx} has {len(encoded)} tokens, which exceeds "
                    f"the embedding model maximum sequence length of {model.max_seq_length}. "
                    "Cannot generate embedding without silent truncation."
                )

    # Batch encode with cosine normalization enabled
    raw_embeddings = model.encode(
        texts,
        batch_size=32,
        show_progress_bar=False,
        normalize_embeddings=True,
    )

    if len(raw_embeddings) != len(texts):
        raise ValueError(
            f"Embedding count mismatch: expected {len(texts)} vectors, "
            f"received {len(raw_embeddings)}"
        )

    vectors: list[list[float]] = []
    for idx, vec in enumerate(raw_embeddings):
        arr = np.asarray(vec, dtype=np.float32)

        # Dimension validation
        if arr.shape != (EXPECTED_EMBEDDING_DIM,):
            raise ValueError(
                f"Invalid embedding dimension at index {idx}: "
                f"expected {EXPECTED_EMBEDDING_DIM}, got {arr.shape[0]}"
            )

        # Finite value check (reject NaN or Inf)
        if not np.isfinite(arr).all():
            raise ValueError(
                f"Non-finite values (NaN/Inf) detected in embedding vector at index {idx}"
            )

        vectors.append(arr.tolist())

    return vectors


QUERY_WINDOW_OVERLAP_TOKENS = 48


def embed_query_text(text: str) -> list[float]:
    """
    Embeds a retrieval query of any length (e.g. job title + full job description).

    generate_embeddings() refuses texts longer than the model window so stored chunk
    vectors are never silently truncated. A query has no such contract, so a long query
    is split into overlapping token windows that each fit the model, every window is
    embedded, and the L2-normalized mean of the window vectors is returned. Queries that
    already fit are embedded as a single text, exactly as before.
    """
    if not text or not text.strip():
        raise ValueError("Cannot embed an empty query text")

    model = get_embedder()
    tokenizer = getattr(model, "tokenizer", None)
    max_len = int(getattr(model, "max_seq_length", 256))
    if tokenizer is None:
        return generate_embeddings([text])[0]

    if len(tokenizer.encode(text, add_special_tokens=True)) <= max_len:
        return generate_embeddings([text])[0]

    encoding = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True, verbose=False)
    offsets = encoding["offset_mapping"]
    window = max_len - 2  # room for [CLS] and [SEP]
    stride = window - QUERY_WINDOW_OVERLAP_TOKENS

    windows: list[str] = []
    for start in range(0, len(offsets), stride):
        end = min(start + window, len(offsets))
        piece = text[offsets[start][0] : offsets[end - 1][1]].strip()
        if piece:
            windows.append(piece)
        if end == len(offsets):
            break

    # Decoded token boundaries can re-tokenize slightly longer; shrink any window that does.
    safe_windows: list[str] = []
    for piece in windows:
        while len(tokenizer.encode(piece, add_special_tokens=True)) > max_len:
            piece = piece[: int(len(piece) * 0.9)]
        safe_windows.append(piece)

    vectors = np.asarray(generate_embeddings(safe_windows), dtype=np.float32)
    mean = vectors.mean(axis=0)
    norm = float(np.linalg.norm(mean))
    if norm == 0.0 or not np.isfinite(norm):
        raise ValueError("Query window embeddings averaged to a zero or non-finite vector")
    return [float(v) for v in (mean / norm)]


def generate_chunk_embeddings(
    chunks: list[TextChunk],
) -> list[tuple[TextChunk, list[float]]]:
    """
    Embeds a sequence of TextChunk instances and pairs each chunk with its vector.
    Uses chunk.embedding_text to retain semantic heading context while keeping
    chunk.content as the canonical raw text slice.

    Args:
        chunks: List of TextChunk objects.

    Returns:
        List of (TextChunk, embedding_vector) tuples.
    """
    if not chunks:
        return []

    texts = [
        c.embedding_text if hasattr(c, "embedding_text") else c.content
        for c in chunks
    ]
    vectors = generate_embeddings(texts)

    if len(chunks) != len(vectors):
        raise ValueError(
            f"Chunk-to-vector correspondence error: {len(chunks)} chunks vs {len(vectors)} vectors"
        )

    return list(zip(chunks, vectors, strict=True))

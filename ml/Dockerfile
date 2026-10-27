FROM python:3.11-slim

WORKDIR /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/workspace \
    PORT=8000 \
    HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -u 1000 -m -s /bin/bash appuser && \
    mkdir -p /home/appuser/.cache/huggingface /workspace && \
    chown -R appuser:appuser /home/appuser /workspace

COPY requirements.txt ./ml/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r ./ml/requirements.txt

# Pre-download embedding and cross-encoder model weights per SPEC § 7.1.
# Baked into /opt/hf, outside /home/appuser/.cache: compose mounts a tmpfs there, which hid the
# baked copy and made every container start re-download the models into RAM.
ENV HF_HOME=/opt/hf
RUN python -c "from sentence_transformers import SentenceTransformer, CrossEncoder; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2'); CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')" && \
    chmod -R a+rX /opt/hf
# Load only the baked models at runtime: no network calls, fails fast if a model is missing.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

COPY . ./ml/
RUN chown -R appuser:appuser /workspace

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=5 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "ml.main:app", "--host", "0.0.0.0", "--port", "8000"]

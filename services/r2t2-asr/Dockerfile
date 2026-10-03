# Reasonate AI — R2T2 ASR service
#
# NOTE: this image is CPU-capable for build/CI, but R2T2 inference uses vLLM and
# therefore needs an NVIDIA GPU at runtime (`docker run --gpus all ...`). The
# upstream project recommends its GPU image `qwenllm/qwen3-asr` as a base when
# you want a ready-made CUDA + vLLM runtime; see README.md.

FROM python:3.12-slim

# ffmpeg is required to decode browser/mobile audio (webm/opus, m4a/aac, ogg)
# that pure-Python decoders cannot read. curl is used by HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first so Docker can cache this layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Application code.
COPY app.py ./

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# The product points at  http://<host>:8081/v1
ENV ASR_PORT=8081 \
    PYTHONUNBUFFERED=1
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ASR_PORT:-8081}/healthz" || exit 1

# Shell form so ${ASR_PORT} is expanded at container start.
CMD uvicorn app:app --host 0.0.0.0 --port ${ASR_PORT:-8081}

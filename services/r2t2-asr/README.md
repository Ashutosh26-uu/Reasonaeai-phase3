# R2T2 ASR service (Reasonate AI)

A small, self-hosted, OpenAI-compatible HTTP service that wraps
[**Confucius4-R2T2**](https://github.com/netease-youdao/Confucius4-R2T2) — NetEase
Youdao's low-latency, high-accuracy **true streaming** ASR model — so that the
Reasonate product's replaceable ASR adapter can talk to it through the same
`/audio/transcriptions` contract it uses for any other provider.

Everything here is self-hosted and open-weight: no paid third-party inference
API is involved. Only `app.py` is product code; the model runs on your GPU via
vLLM.

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/v1/audio/transcriptions` | Multipart (`file`, optional `model`, optional `language`) → `{"text": "..."}` |
| `GET`  | `/healthz` | `{"status":"ok","model":"<model id>"}` — reports liveness/config **without loading the model** |
| `GET`  | `/v1/models` | `{"data":[{"id":"<model id>"}]}` (OpenAI compatibility nicety) |

`POST /v1/audio/transcriptions` enforces the product's **25 MiB** upload cap
(`ASR_MAX_UPLOAD_BYTES`, default `26_214_400`) and an allowlist of media types:
`audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`, `audio/mpeg`. Uploads are
decoded with **ffmpeg** to 16 kHz mono float32 (browsers record webm/opus, which
pure-Python decoders cannot reliably read). Zero-byte or undecodable audio is a
`400` with a service-written message; ffmpeg stderr is never returned to clients.
The service is stateless and append-only output semantics are preserved
per offline call.

## Layout

```
services/r2t2-asr/
├── app.py            # FastAPI service (the whole thing)
├── requirements.txt  # pinned Python dependencies
├── Dockerfile        # python:3.12-slim + ffmpeg, non-root, HEALTHCHECK
├── README.md         # this file
└── .dockerignore
```

These directories are intentionally **not** pnpm workspace members: they are
Python/compose services and live outside `apps/*` / `packages/*`.

## Configuration

All configuration is via environment variables (never hard-code secrets).

| Variable | Required | Default | Meaning |
| -------- | -------- | ------- | ------- |
| `ASR_MODEL_PATH` | **yes** | — | HF repo id (`netease-youdao/Confucius4-R2T2`) or a local checkpoint directory. Service refuses to start without it. |
| `ASR_PORT` | no | `8081` | Port uvicorn binds. |
| `ASR_MAX_UPLOAD_BYTES` | no | `26214400` | Max request audio size (25 MiB, matches the product cap). |
| `ASR_REQUEST_TIMEOUT_SEC` | no | `120` | Wall-clock budget per transcription; `0` disables. |
| `ASR_LANGUAGE_DEFAULT` | no | unset | Language hint used when the client sends none (e.g. `Chinese`). Unset → auto-detect. |
| `CUDA_VISIBLE_DEVICES` | no | `0` (vLLM default) | Passed through to vLLM/PyTorch; restricts which GPUs the model sees. |
| `ASR_GPU_MEMORY_UTILIZATION` | no | `0.5` | vLLM GPU memory fraction. |
| `ASR_MAX_MODEL_LEN` | no | `16384` | vLLM context length. |
| `ASR_MAX_NEW_TOKENS` | no | `4096` | Generation cap for offline (one-shot) transcription. |
| `ASR_FFMPEG_BIN` | no | `ffmpeg` | ffmpeg executable path. |
| `ASR_LOG_LEVEL` | no | `INFO` | Structured (JSON-lines) log level. |

`REASONATE_ASR_API_KEY` is accepted by the product but not required by this
service; there is no auth layer because the service is expected to run on a
private network / behind the product's own gateway.

### Structured logging

Logs are JSON lines containing only non-sensitive fields: request id, path,
status, duration (ms), audio bytes, decoded seconds. **Audio bytes, client
filenames and transcript text are never logged.**

## Local run

```bash
cd services/r2t2-asr

python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows (PowerShell):
#   .venv\Scripts\Activate.ps1

# vLLM needs a torch wheel matching your CUDA runtime; install it first.
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt

export ASR_MODEL_PATH=netease-youdao/Confucius4-R2T2   # or /path/to/checkpoint
export ASR_PORT=8081
export CUDA_VISIBLE_DEVICES=0

python app.py
# equivalent, and what the container runs:
#   uvicorn app:app --host 0.0.0.0 --port 8081
```

The first transcription request downloads/loads the checkpoint (that is the slow
one); `/healthz` answers immediately because the model is loaded lazily.

## Docker

The image is `python:3.12-slim` + `ffmpeg`. R2T2 inference uses vLLM, which needs
an NVIDIA GPU, so run it with the NVIDIA Container Toolkit
(`--gpus all`). Kubernetes/Compose deployments should request a GPU the same way.

```bash
docker build -t reasonate-r2t2-asr ./services/r2t2-asr

docker run --gpus all --rm \
  -p 8081:8081 \
  -e ASR_MODEL_PATH=netease-youdao/Confucius4-R2T2 \
  -e CUDA_VISIBLE_DEVICES=0 \
  -e ASR_LANGUAGE_DEFAULT=English \
  -v "$HOME/.cache/huggingface:/home/appuser/.cache/huggingface" \
  --shm-size=4gb \
  reasonate-r2t2-asr
```

`--shm-size` matters: vLLM uses shared memory for its engine IPC.

### GPU image alternative

If you would rather not assemble the CUDA/vLLM stack yourself, the upstream
project recommends building **on top of its prebuilt GPU image**,
[`qwenllm/qwen3-asr`](https://hub.docker.com/r/qwenllm/qwen3-asr), which ships
every runtime library R2T2 needs. Swap the `FROM python:3.12-slim` line for the
Qwen3-ASR image and keep the same `app.py` / `requirements.txt` / `CMD`. The
slim-based Dockerfile here is provided so the service builds and its CPU paths
(health, decoding, contract tests) can be exercised in CI without a GPU.

## Pointing the product at it

The product resolves this backend from environment variables:

```dotenv
REASONATE_ASR_URL=http://localhost:8081/v1/audio/transcriptions
REASONATE_ASR_API_KEY=not-required
REASONATE_ASR_MODEL=netease-youdao/Confucius4-R2T2
```

`REASONATE_ASR_URL` is the **exact** `/audio/transcriptions` endpoint URL; the
product's adapter posts to this URL unchanged.

## Model checkpoints

Choose the checkpoint that matches the inference backend:

| Inference backend | Model | HF repo | Notes |
| ----------------- | ----- | ------- | ----- |
| vLLM (this service) | `Confucius4-R2T2` | [`netease-youdao/Confucius4-R2T2`](https://huggingface.co/netease-youdao/Confucius4-R2T2) | Standard checkpoint. What `ASR_MODEL_PATH` should point at here. |
| llama.cpp | `Confucius4-R2T2-GGUF` | [`netease-youdao/Confucius4-R2T2-GGUF`](https://huggingface.co/netease-youdao/Confucius4-R2T2-GGUF) | Several quantization variants; used by the upstream `r2t2_llama` package, not by this vLLM service. |

ModelScope mirrors exist for both.

## Performance

### Latency / streaming behaviour (upstream specification)

- **Latency:** 200–600 ms average, at a representative 160 ms decode chunk.
- **Output:** append-only / stable-prefix — emitted text is committed and never
  revised, which is what makes it usable for live captioning and downstream
  agents.
- **Chunking:** configurable decode chunks from **80 ms to 2 s**
  (latency/accuracy trade-off).
- **Offline accuracy:** adding streaming support does not degrade offline
  recognition.

This service performs a single offline (one-shot) transcription per request. The
streaming path is delivered by the upstream WebSocket server — see
[Streaming ASR (future)](#streaming-asr-future).

### Benchmark summary

All figures below are **vendor-reported by NetEase Youdao**, lower is better,
English = WER (%), Chinese = CER (%). R2T2 means are over the model's published
tables (9 English sets, 5 Chinese sets); comparator figures are the summary
numbers quoted by the upstream project and are included for orientation only.

| Model | English (mean WER) | Chinese (mean CER) |
| ----- | ------------------ | ------------------ |
| **R2T2 (160 ms streaming)** | **6.13** | **6.42** |
| Qwen3-ASR (offline) | 4.95 | 5.31 |
| AssemblyAI (min-latency mode) | 5.98 | — |
| Voxtral (160 ms) | 8.56 | — |
| X-ASR (160 ms) | 8.63 | — |
| WhisperRT (200 ms) | 16.29 | — |

R2T2 is the best-scoring *streaming* system in the comparison, and close to
offline Qwen3-ASR (its own base model), while running at 200–600 ms latency with
append-only output.

## Verification

Run the service (local or Docker), then:

```bash
# 1. Liveness + configured model id (does not load the model).
curl -sS http://localhost:8081/healthz
# {"status":"ok","model":"netease-youdao/Confucius4-R2T2"}

# 2. OpenAI-compatible model list.
curl -sS http://localhost:8081/v1/models
# {"data":[{"id":"netease-youdao/Confucius4-R2T2","object":"model"}]}

# 3. Transcribe the sample WAV shipped by the upstream repository.
curl -sS -X POST http://localhost:8081/v1/audio/transcriptions \
  -F "file=@resources/test.wav;type=audio/wav" \
  -F "language=English"
# {"text":"..."}
```

Get `resources/test.wav` from the upstream repo:

```bash
git clone --depth 1 https://github.com/netease-youdao/Confucius4-R2T2.git /tmp/Confucius4-R2T2
# the file is at /tmp/Confucius4-R2T2/resources/test.wav
```

The documented `curl` above reproduces the OpenAI-compatible contract exactly:
multipart `file` (+ optional `model`/`language`) in, strict JSON `{"text": ...}`
out. Extra OpenAI form fields are ignored.

## Streaming ASR (future)

The upstream repository ships a ready-to-run **WebSocket** streaming server
(`ws_server.py`, launched by `run_start_server.sh`) that this HTTP service does
not wrap. The product's real-time voice mode will bridge to it later.

```bash
./run_start_server.sh start \
    --model_path /path/to/Confucius4-R2T2 \
    --vad_model_path /path/to/Stream-VAD \
    --port 8272 \
    --gpu 0
```

| Property | Value |
| -------- | ----- |
| Endpoint | `ws://<host>:8272/asr_stream_api_v1` |
| Client → server | raw **16 kHz mono int16 PCM** frames (≈160 ms each) |
| End-of-stream | send the string `YOUDAO_ONETIME_ASR_STREAM_EOS` |
| Server → client | JSON `{status, requestId, msg:{text, reset, asr_cost_ms, total_cost_ms}}` where `text` is the **incremental** new segment |

Concatenate `msg.text` client-side to build the full transcript; because output
is append-only, previously emitted text is never revised. Note the WS server
also needs a streaming VAD model (`FireRedVAD` / `Stream-VAD`).

When voice mode lands, the natural shape is a second adapter in the product that
speaks this WebSocket protocol instead of `/v1/audio/transcriptions`; this
service's HTTP contract can remain the batch/fallback path.

## License

- **Service code** (`app.py`, `Dockerfile`, this README) is provided under the
  Apache License 2.0, consistent with the Reasonate AI codebase.
- **Confucius4-R2T2 code** is released under the **Apache License 2.0**.
- **Confucius4-R2T2 model weights** are released under the **NetEase Youdao
  Model Use License Agreement** (`MODEL_LICENSE` in the upstream repository) —
  not Apache 2.0. Key terms:
  - Free **commercial** use is permitted **below 100M monthly active users** and
    **below RMB 1 billion annual revenue** for the prior calendar period;
    exceeding either requires a **separate license** requested from NetEase
    Youdao.
  - You may **not use the model or its outputs to improve any other AI model**,
    except the R2T2 model itself, its derivative works, or **non-commercial** AI
    models.
  - **High-risk uses are prohibited** (medical diagnosis, autonomous driving,
    military, critical-infrastructure control, large-scale biometric
    surveillance, automated credit/employment decisions, …).
  - Governed by the laws of the **People's Republic of China**; disputes go to
    **CIETAC arbitration in Beijing**.
  - Copyright notices and a copy of the agreement must be retained in every copy
    you distribute.

  → **Keep `MODEL_LICENSE` with any redistributed copy of the weights**, and
  surface these obligations to downstream recipients.

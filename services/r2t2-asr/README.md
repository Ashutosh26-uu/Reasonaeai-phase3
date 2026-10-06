# R2T2 ASR service (Reasonate AI)

A small, self-hosted, OpenAI-compatible HTTP service that wraps
[**Confucius4-R2T2**](https://github.com/netease-youdao/Confucius4-R2T2) — NetEase
Youdao's low-latency, high-accuracy **true streaming** ASR model — so that the
Reasonate product's replaceable ASR adapter can talk to it through the same
`/audio/transcriptions` contract it uses for any other provider.

Everything here is self-hosted and open-weight: no paid third-party inference
API is involved. Only `app.py` is product code.

The model runs through one of two backends, selected by `ASR_INFER_MODE`:

| `ASR_INFER_MODE` | Weights | Needs | Fits |
| ---------------- | ------- | ----- | ---- |
| `llama` | one quantized GGUF pair — a model `*.gguf` beside its `mmproj*.gguf` projector | an NVIDIA GPU, ~4 GB VRAM | 6 GB consumer laptops |
| `vllm` (code default) | the bf16 HF checkpoint | a large GPU (~24 GB) | datacenter cards |

The `llama` backend is what the image is built for and what the acceptance run
exercises: it serves a Q8 GGUF through a llama.cpp built in the image, which is
the only path that fits a 6 GB GPU. `vllm` is the optional extra documented
under [vLLM backend](#vllm-backend) and is **not** installed in this image, so
a container started without `ASR_INFER_MODE=llama` refuses to serve.

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
├── requirements.txt  # pinned Python dependencies of the runtime stage
├── Dockerfile        # multi-stage: CUDA llama.cpp builder + slim GPU runtime
├── README.md         # this file
└── .dockerignore
```

These directories are intentionally **not** pnpm workspace members: they are
Python/compose services and live outside `apps/*` / `packages/*`.

## Configuration

All configuration is via environment variables (never hard-code secrets).

| Variable | Required | Default | Meaning |
| -------- | -------- | ------- | ------- |
| `ASR_INFER_MODE` | no | `vllm` | `llama` serves a GGUF through the in-image llama.cpp; `vllm` serves the HF checkpoint. The image only implements `llama`. |
| `ASR_GGUF_DIR` | in `llama` mode | — | Directory holding exactly one model `*.gguf` and one `mmproj*.gguf`. Service refuses to start without it in `llama` mode. |
| `ASR_MODEL_PATH` | in `vllm` mode | — | HF repo id (`netease-youdao/Confucius4-R2T2`) or a local checkpoint directory. Service refuses to start without it in `vllm` mode. |
| `ASR_N_THREADS` | no | `8` | CPU threads llama.cpp may use for the parts of a request that stay on the host. |
| `ASR_PORT` | no | `8081` | Port uvicorn binds. |
| `ASR_MAX_UPLOAD_BYTES` | no | `26214400` | Max request audio size (25 MiB, matches the product cap). |
| `ASR_REQUEST_TIMEOUT_SEC` | no | `120` | Wall-clock budget per transcription; `0` disables. |
| `ASR_LANGUAGE_DEFAULT` | no | unset | Language hint used when the client sends none (e.g. `Chinese`). Unset → auto-detect. |
| `CUDA_VISIBLE_DEVICES` | no | `0` | Restricts which GPUs the backend sees. |
| `ASR_GPU_MEMORY_UTILIZATION` | no | `0.5` | vLLM only; ignored by the llama.cpp backend. |
| `ASR_MAX_MODEL_LEN` | no | `16384` | Context length: `n_ctx` for llama.cpp, `max_model_len` for vLLM. |
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

## Local run (vLLM mode)

The llama.cpp path is delivered by the image, because it needs a compiled
`qwen3asr_native` extension plus the llama.cpp libraries beside it — the
`llama-builder` stage of `Dockerfile` is that recipe (clone the pinned
llama.cpp revision, configure `r2t2_llama` with `-DGGML_CUDA=ON`, rebuild
`r2t2_llama/bin/`). Running it outside a container means reproducing that
build by hand. What follows is the vLLM path for a large GPU:

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

The image is built in two stages. The builder installs a host compiler and
rebuilds the CPU backend of the pinned llama.cpp against the x86-64 baseline
(`GGML_NATIVE=OFF`) together with the `qwen3asr_native` pybind extension; that
pair is what removes the AVX-512 instructions the package's prebuilt CPU
libraries carry. The runtime stage is `python:3.12-slim` plus ffmpeg, torch-CPU,
the `qwen-asr` modeling code, the rebuilt CPU backend, and
`libcublas12`/`libcublaslt12`/`libcudart12` from trixie's non-free section — no
compiler, no toolkit. Inference needs an NVIDIA GPU, so run it with the NVIDIA
Container Toolkit (`--gpus all`).

```bash
docker build -t reasonate-r2t2-asr:slim ./services/r2t2-asr

docker run -d --gpus all --name r2t2-asr \
  -p 127.0.0.1:8081:8081 \
  -e ASR_INFER_MODE=llama \
  -e ASR_GGUF_DIR=/models/gguf \
  -v "$HOME/.cache/models/Confucius4-R2T2-GGUF:/models/gguf" \
  reasonate-r2t2-asr:slim
```

The GGUF directory is mounted read-only in spirit: the service only reads the
two files, and the container user (`appuser`, uid 10001) needs read access to
them. On Windows, path mounts work the same way —
`-v C:/Users/you/.cache/models/Confucius4-R2T2-GGUF:/models/gguf`.

### Startup: the cold cost is paid before traffic, not by the first caller

Loading the model is expensive and it is a one-time cost: about **2 minutes**
for the Q8_0 pair, of which ~40 s is importing torch/transformers and ~75 s is
reading 2.2 GB and building the CUDA graphs. The service therefore loads the
model in a background thread as it starts, so no request ever pays for it:

| | observed |
| --- | --- |
| container start → `ready: true` | ~122 s |
| **first transcription after ready** | **1.9 s** |
| second and later transcriptions | ~1.3 s |

`GET /healthz` answers immediately and reports both facts, which is also what
the container's health probe keys on:

```bash
curl -sS http://localhost:8081/healthz
# {"status":"ok","model":"/models/gguf","ready":true}
```

A request that arrives *while* the weights are still loading waits for that
load and is then served normally — it never starts a second load, because two
copies of a 2.2 GB pair do not fit the 6 GB this service targets. The
`HEALTHCHECK` has a 240 s start period for the same reason, so `docker ps`
reports `starting` and then `healthy` instead of flapping.

Bind-mounted weights are the slow part of the load (measured at ~86 MB/s here,
against multi-GB/s inside the VM). Copying the pair into a named volume
(`docker volume create r2t2-gguf`, then a one-shot container to copy it in)
removes roughly 20 s of startup — worth it only where container restarts are
frequent, since it costs as much disk as the weights themselves.

`BUILD_JOBS` (default `4`) is the one build knob: `cmake --build` runs with it
instead of `nproc`, because the build happens inside the container's memory
limit, where an unbounded `-j` is OOM-killed rather than reporting a compile
error. Lower it on a small machine, raise it on a large one.

The CUDA backend itself (`libggml-cuda.so`) is used exactly as the package ships
it, and the Dockerfile header records why: rebuilding it needs `nvcc`, which
this environment cannot obtain, and the shipped library already targets this
CPU baseline's CPU half while covering `89-real`. Debian's own
`nvidia-cuda-toolkit` in trixie's non-free section is the supported route to
rebuilding it too, and the header carries the exact configure line.

### vLLM backend

`ASR_INFER_MODE=vllm` serves the bf16 checkpoint through vLLM instead, which
this image deliberately does not carry (~14 GB of CUDA wheels). Build a
separate image for it — the same `app.py` and `requirements.txt` with torch
from the CUDA index and `qwen-asr[vllm]` — or start from the upstream's
prebuilt [`qwenllm/qwen3-asr`](https://hub.docker.com/r/qwenllm/qwen3-asr)
image and keep `app.py` unchanged. `--shm-size=4gb` matters on that path: vLLM
uses shared memory for its engine IPC.


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

| `ASR_INFER_MODE` | Model | HF repo | Notes |
| ---------------- | ----- | ------- | ----- |
| `llama` (this image) | `Confucius4-R2T2-GGUF` | [`netease-youdao/Confucius4-R2T2-GGUF`](https://huggingface.co/netease-youdao/Confucius4-R2T2-GGUF) | **Default path.** The image serves the `Q8_0` quantization; `ASR_GGUF_DIR` must hold the model `*.gguf` and its `mmproj-*.gguf` projector, and nothing else that ends in `.gguf`. |
| `vllm` | `Confucius4-R2T2` | [`netease-youdao/Confucius4-R2T2`](https://huggingface.co/netease-youdao/Confucius4-R2T2) | The bf16 checkpoint for a vLLM image; `ASR_MODEL_PATH` points at it. |

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

Run the service (local or Docker), then transcribe. Every command and output
below is from a real run of this image on an RTX 4050 Laptop GPU (6 GB), with
the `Q8_0` GGUF mounted at `/models/gguf`:

```bash
# 1. Liveness + configured model id (does not load the model).
curl -sS http://localhost:8081/healthz
# {"status":"ok","model":"/models/gguf"}

# 2. OpenAI-compatible model list.
curl -sS http://localhost:8081/v1/models
# {"data":[{"id":"/models/gguf","object":"model"}]}

# 3. Transcribe audio. The model is already loaded — the service warms it up at
#    startup (see "Startup" above) — so a ~4 s clip answers in ~2 s. Poll
#    /healthz for "ready":true if you call straight after a container restart.
curl -sS -X POST http://localhost:8081/v1/audio/transcriptions \
  -F "file=@recording.mp3;type=audio/mpeg" \
  -F "language=English"
# {"text":"Reason8 AI verified your build through the real speech model."}
```

That the run is on the GPU, and not quietly on the CPU, is visible in the
container's own log:

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 6140 MiB):
llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 4050 Laptop GPU) - 5072 MiB free
load_tensors: layer   0 assigned to device CUDA0, is_swa = 0
```

A backend that is not registered looks different: every
`load_tensors` line reads `assigned to device CPU`, and a few seconds of audio
then takes minutes. Check that line first if transcripts are slow.

Through the product, the same audio arrives as the authorized upload the browser
sends — session cookie plus the CSRF header, scoped to an organization and
project:

```bash
curl -sS -X POST \
  "http://127.0.0.1:4111/v1/voice/transcriptions?organizationId=$ORG&projectId=$PROJECT" \
  -H "Origin: http://localhost:3219" \
  -H "x-reasonate-csrf: $CSRF" \
  -b cookies.txt \
  -F "audio=@recording.mp3;type=audio/mpeg" \
  -F "language=English"
# {"language":"English","provider":"openai-compatible","text":"Reason8 AI verified your build through the real speech model."}
```

The service's own contract is the OpenAI-compatible one: multipart `file` (+
optional `model`/`language`) in, strict JSON `{"text": ...}` out. Extra OpenAI
form fields are ignored. The product route names its field `audio` instead, and
the adapter maps it — see `apps/api/src/mastra/adapters/asr.ts`.


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

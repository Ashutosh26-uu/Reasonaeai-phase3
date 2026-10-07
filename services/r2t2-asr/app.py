# coding=utf-8
# Copyright 2026 Reasonate AI.
# SPDX-License-Identifier: Apache-2.0
#
# OpenAI-compatible HTTP wrapper around Confucius4-R2T2, a true streaming ASR
# model from NetEase Youdao (https://github.com/netease-youdao/Confucius4-R2T2).
#
# The product resolves this backend purely from environment variables:
#   REASONATE_ASR_URL   = http://<host>:8081/v1/audio/transcriptions (exact endpoint)
#   REASONATE_ASR_API_KEY   (accepted but not required by this service)
#   REASONATE_ASR_MODEL     (advisory; the served checkpoint is fixed by ASR_MODEL_PATH)
#
# Surface:
#   POST /v1/audio/transcriptions   multipart file(+model,+language) -> {"text": ...}
#   GET  /healthz                   {"status":"ok","model": ...,"ready": bool}
#   GET  /v1/models                 {"data":[{"id": ...}]}
#
# Design note on vLLM and the __main__ guard
# ------------------------------------------
# vLLM uses Python's "spawn" multiprocessing start method and re-imports the
# __main__ module inside its engine subprocesses. Loading the model at import
# time therefore recurses (the classic vLLM "spawn" error). We avoid the
# problem structurally: this module never touches vLLM at import time. The
# R2T2/vLLM import and model construction happen in the app's startup hook
# (see "Startup warm-up" below), inside a background thread, and only if that
# thread has not already succeeded does a transcription request load the model
# itself. The `if __name__ == "__main__"` block at the bottom is only the local
# entrypoint that boots uvicorn, so no engine state is ever created during the
# import that spawn re-runs. This is why /healthz can answer, and report
# whether the weights are ready, with zero GPU work of its own.

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Optional, Tuple

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, Header, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

ALLOWED_MEDIA_TYPES = frozenset(
    {"audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"}
)

ALLOWED_MEDIA_TYPE_MESSAGE = "Allowed media types: audio/webm, audio/mp4, audio/ogg, audio/wav, audio/mpeg"


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - startup misconfiguration
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:  # pragma: no cover - startup misconfiguration
        raise RuntimeError(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class Config:
    model_path: Optional[str]
    port: int
    max_upload_bytes: int
    request_timeout_sec: float
    language_default: Optional[str]
    gpu_memory_utilization: float
    max_model_len: int
    max_new_tokens: int
    decode_timeout_sec: float
    min_decoded_seconds: float
    ffmpeg_bin: str
    # "vllm" serves the bf16 checkpoint through vLLM (needs a large GPU);
    # "llama" serves a quantized GGUF through the bundled llama.cpp backend,
    # which is the path that fits a 6 GB consumer GPU.
    infer_mode: str
    gguf_dir: Optional[str]
    n_threads: int

    @property
    def model_id(self) -> str:
        return (self.gguf_dir or "") if self.infer_mode == "llama" else (self.model_path or "")


def _load_config() -> Config:
    model_path = _env("ASR_MODEL_PATH")
    infer_mode = (_env("ASR_INFER_MODE", "llama") or "llama").lower()
    gguf_dir = _env("ASR_GGUF_DIR")
    if infer_mode == "llama":
        if not gguf_dir:
            if os.path.isdir("/models/gguf"):
                gguf_dir = "/models/gguf"
            else:
                # Fail fast: run this check at import time so uvicorn refuses to
                # boot with an obviously broken configuration instead of failing
                # per-request.
                raise RuntimeError(
                    "ASR_GGUF_DIR is required when ASR_INFER_MODE=llama: a "
                    "directory holding one model *.gguf and one mmproj*.gguf "
                    "projector from the Confucius4-R2T2-GGUF repository."
                )
    elif not model_path:
        # Fail fast: run this check at import time so uvicorn refuses to boot
        # with an obviously broken configuration instead of failing per-request.
        raise RuntimeError(
            "ASR_MODEL_PATH is required (a Hugging Face repo id such as "
            "'netease-youdao/Confucius4-R2T2' or a local directory containing "
            "the checkpoint). Set it in the environment before starting the "
            "service."
        )
    return Config(
        model_path=model_path,
        port=_env_int("ASR_PORT", 8081),
        max_upload_bytes=_env_int("ASR_MAX_UPLOAD_BYTES", 26_214_400),  # 25 MiB, matches the product cap
        request_timeout_sec=_env_float("ASR_REQUEST_TIMEOUT_SEC", 120.0),
        language_default=_env("ASR_LANGUAGE_DEFAULT"),
        gpu_memory_utilization=_env_float("ASR_GPU_MEMORY_UTILIZATION", 0.5),
        max_model_len=_env_int("ASR_MAX_MODEL_LEN", 16384),
        max_new_tokens=_env_int("ASR_MAX_NEW_TOKENS", 4096),
        decode_timeout_sec=_env_float("ASR_DECODE_TIMEOUT_SEC", 60.0),
        min_decoded_seconds=_env_float("ASR_MIN_DECODED_SECONDS", 0.05),
        ffmpeg_bin=_env("ASR_FFMPEG_BIN", "ffmpeg") or "ffmpeg",
        infer_mode=infer_mode,
        gguf_dir=gguf_dir,
        n_threads=_env_int("ASR_N_THREADS", 8),
    )


CONFIG = _load_config()


# --------------------------------------------------------------------------- #
# Structured logging (JSON lines)
# --------------------------------------------------------------------------- #
# Only whitelisted, non-sensitive fields are ever emitted. Client filenames,
# raw audio bytes and transcript text MUST NOT appear in logs.

logging.basicConfig(
    level=os.environ.get("ASR_LOG_LEVEL", "INFO").upper(),
    format="%(message)s",
    stream=sys.stdout,
)
_LOGGER = logging.getLogger("r2t2-asr")


def _log(event: str, *, level: str = "info", **fields: Any) -> None:
    record: Dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "event": event,
    }
    for key, value in fields.items():
        if value is not None:
            record[key] = value
    getattr(_LOGGER, level, _LOGGER.info)(json.dumps(record, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# Language normalization
# --------------------------------------------------------------------------- #
# R2T2 expects canonical language names ("Chinese", "English", ...). The product
# may send either a name or a BCP-47-ish tag ("en-US", "zh-Hans", "cmn"), so we
# resolve the common cases locally before handing the hint to the model.

_LANGUAGE_ALIASES = {
    # Chinese family -> the model only distinguishes Chinese vs Cantonese.
    "zh": "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", "zh-sg": "Chinese",
    "cmn": "Chinese", "zho": "Chinese", "chi": "Chinese",
    "yue": "Cantonese", "zh-hk": "Cantonese", "zh-mo": "Cantonese", "zh-yue": "Cantonese",
    "en": "English", "en-us": "English", "en-gb": "English", "eng": "English",
    "ar": "Arabic", "ara": "Arabic",
    "de": "German", "deu": "German", "ger": "German",
    "fr": "French", "fra": "French", "fre": "French",
    "es": "Spanish", "spa": "Spanish",
    "pt": "Portuguese", "por": "Portuguese",
    "id": "Indonesian", "ind": "Indonesian",
    "it": "Italian", "ita": "Italian",
    "ko": "Korean", "kor": "Korean",
    "ru": "Russian", "rus": "Russian",
    "th": "Thai", "tha": "Thai",
    "vi": "Vietnamese", "vie": "Vietnamese",
    "ja": "Japanese", "jpn": "Japanese",
    "tr": "Turkish", "tur": "Turkish",
    "hi": "Hindi", "hin": "Hindi",
    "ms": "Malay", "msa": "Malay", "may": "Malay",
    "nl": "Dutch", "nld": "Dutch", "dut": "Dutch",
    "sv": "Swedish", "swe": "Swedish",
    "da": "Danish", "dan": "Danish",
    "fi": "Finnish", "fin": "Finnish",
    "pl": "Polish", "pol": "Polish",
    "cs": "Czech", "ces": "Czech", "cze": "Czech",
    "fil": "Filipino", "tl": "Filipino",
    "fa": "Persian", "fas": "Persian", "per": "Persian",
    "el": "Greek", "ell": "Greek", "gre": "Greek",
    "ro": "Romanian", "ron": "Romanian", "rum": "Romanian",
    "hu": "Hungarian", "hun": "Hungarian",
    "mk": "Macedonian", "mkd": "Macedonian", "mac": "Macedonian",
}


class UnsupportedLanguage(ValueError):
    """Raised when a client language hint cannot be mapped to a model language."""


_SUPPORTED_LANGUAGES: Any = None
_SUPPORTED_LANGUAGES_RESOLVED = False


def _supported_languages() -> Optional[frozenset]:
    """Canonical language list, sourced from the installed library when present.

    Returns None when the library is unavailable (import failure), in which case
    validation is skipped and the hint is passed through unchanged. Resolution is
    attempted at most once per process.
    """
    global _SUPPORTED_LANGUAGES, _SUPPORTED_LANGUAGES_RESOLVED
    if not _SUPPORTED_LANGUAGES_RESOLVED:
        try:
            from qwen_asr.inference.utils import SUPPORTED_LANGUAGES

            _SUPPORTED_LANGUAGES = frozenset(SUPPORTED_LANGUAGES)
        except Exception:  # pragma: no cover - library import is environment-dependent
            _SUPPORTED_LANGUAGES = None
        _SUPPORTED_LANGUAGES_RESOLVED = True
    return _SUPPORTED_LANGUAGES


def resolve_language(raw: Optional[str]) -> Optional[str]:
    """Resolve a client/BCP-47 hint to a canonical R2T2 language, or None (auto)."""
    candidate = raw if raw is not None else CONFIG.language_default
    if candidate is None or not candidate.strip():
        return None
    stripped = candidate.strip()
    key = stripped.lower().replace("_", "-")
    canonical = _LANGUAGE_ALIASES.get(key)
    if canonical is None:
        canonical = _LANGUAGE_ALIASES.get(key.split("-", 1)[0])
    if canonical is None:
        # Fall back to a title-cased plain name ("english" -> "English").
        canonical = stripped[:1].upper() + stripped[1:].lower()
    supported = _supported_languages()
    if supported is not None and canonical not in supported:
        raise UnsupportedLanguage(canonical)
    return canonical


# --------------------------------------------------------------------------- #
# Audio decoding (ffmpeg -> 16 kHz mono float32)
# --------------------------------------------------------------------------- #
# Browsers record webm/opus and mobile clients produce m4a/aac; neither is
# reliably readable by pure-Python audio loaders without a system decoder. We
# shell out to ffmpeg, decode to a temporary 16 kHz mono PCM WAV, read that with
# soundfile, and always delete both temp files in a finally block.

class AudioDecodeError(ValueError):
    """Raised when uploaded bytes cannot be decoded to usable 16 kHz audio."""


def _decode_audio(raw: bytes) -> Tuple[np.ndarray, float]:
    in_fd, in_path = tempfile.mkstemp(prefix="r2t2-in-", suffix=".bin")
    out_fd, out_path = tempfile.mkstemp(prefix="r2t2-out-", suffix=".wav")
    os.close(in_fd)
    os.close(out_fd)
    try:
        with open(in_path, "wb") as handle:
            handle.write(raw)

        cmd = [
            CONFIG.ffmpeg_bin,
            "-hide_banner",
            "-nostdin",
            "-loglevel", "error",
            "-y",
            "-i", in_path,
            "-ac", "1",
            "-ar", "16000",
            "-f", "wav",
            "-acodec", "pcm_s16le",
            out_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                timeout=CONFIG.decode_timeout_sec,
            )
        except subprocess.TimeoutExpired as exc:
            raise AudioDecodeError("audio decoding timed out") from exc
        except FileNotFoundError as exc:
            raise AudioDecodeError("audio decoding backend (ffmpeg) is not installed") from exc

        if proc.returncode != 0:
            # Never surface ffmpeg stderr to the client.
            raise AudioDecodeError("audio could not be decoded")

        try:
            data, sample_rate = sf.read(out_path, dtype="float32", always_2d=False)
        except Exception as exc:  # pragma: no cover - decoder output is ours
            raise AudioDecodeError("audio could not be read after decoding") from exc

        if sample_rate != 16000:
            raise AudioDecodeError("audio could not be resampled to 16 kHz")

        wav = np.asarray(data, dtype=np.float32)
        if wav.ndim > 1:
            wav = wav.mean(axis=1, dtype=np.float32)
        wav = np.ascontiguousarray(wav, dtype=np.float32)

        if wav.size == 0:
            raise AudioDecodeError("audio contained no samples")

        seconds = float(wav.size) / 16000.0
        if seconds < CONFIG.min_decoded_seconds:
            raise AudioDecodeError("audio is too short to transcribe")
        return wav, seconds
    finally:
        for path in (in_path, out_path):
            try:
                os.unlink(path)
            except OSError:
                pass


# --------------------------------------------------------------------------- #
# Model (never constructed at import time; loaded by the startup warm-up)
# --------------------------------------------------------------------------- #

_GPU_LOCK = threading.Lock()
_MODEL: Any = None


def _discover_gguf(gguf_dir: str) -> Tuple[str, str]:
    """The one model file and the one projector file in a GGUF directory."""
    names = sorted(n for n in os.listdir(gguf_dir) if n.endswith(".gguf"))
    model = [n for n in names if not n.startswith("mmproj")]
    projector = [n for n in names if n.startswith("mmproj")]
    if len(model) != 1 or len(projector) != 1:
        raise RuntimeError(
            "ASR_GGUF_DIR must hold exactly one model *.gguf and one "
            f"mmproj*.gguf projector; found {names}"
        )
    return os.path.join(gguf_dir, model[0]), os.path.join(gguf_dir, projector[0])


def _load_model_locked() -> Any:
    global _MODEL
    if _MODEL is None:
        if CONFIG.infer_mode == "llama":
            # Imported here, not at module scope, so that /healthz never
            # touches the GPU. This is the bundled llama.cpp backend: quantized
            # weights, no PyTorch encoder, sized for a 6 GB consumer GPU.
            from r2t2_llama.llama_native_backend import (
                LlamaNativeConfig,
                LlamaNativeOnetime,
            )

            model_gguf, mmproj_gguf = _discover_gguf(CONFIG.gguf_dir or "")
            _log("model_load_start", model=CONFIG.model_id, backend="llama")
            _MODEL = LlamaNativeOnetime(
                LlamaNativeConfig(
                    model=model_gguf,
                    mmproj=mmproj_gguf,
                    n_ctx=CONFIG.max_model_len,
                    n_threads=CONFIG.n_threads,
                    max_tokens=CONFIG.max_new_tokens,
                )
            )
            _log("model_load_done", model=CONFIG.model_id, backend="llama")
            return _MODEL

        # Imported here, not at module scope, so that (a) importing this module
        # in vLLM's spawned children is cheap, and (b) /healthz never touches
        # the GPU.
        from r2t2 import R2T2ASRModel

        _log("model_load_start", model=CONFIG.model_id)
        _MODEL = R2T2ASRModel.LLM(
            model=CONFIG.model_path,
            gpu_memory_utilization=CONFIG.gpu_memory_utilization,
            max_model_len=CONFIG.max_model_len,
            max_new_tokens=CONFIG.max_new_tokens,
        )
        _log("model_load_done", model=CONFIG.model_id)
    return _MODEL


def _transcribe_sync(wav: np.ndarray, language: Optional[str]) -> str:
    """Blocking one-shot transcription. Serialized: one inference at a time."""
    with _GPU_LOCK:
        model = _load_model_locked()
        if CONFIG.infer_mode == "llama":
            result = model.generate_once(wav, language=language)
            return (result["text"] or "").strip()
        results = model.transcribe(
            audio=[(wav, 16000)],
            language=[language],
            return_time_stamps=False,
        )
    if not results:
        return ""
    return results[0].text or ""


# --------------------------------------------------------------------------- #
# Startup warm-up
# --------------------------------------------------------------------------- #
# The weights are read through the operator's mount — 2.2 GB for the Q8_0 pair,
# about 90 seconds at the ~24 MB/s a Docker Desktop bind mount delivers, plus the
# engine's own init and CUDA graph capture. Paying that on the first request
# makes the first caller wait two minutes for a three-second transcription, so
# it is paid once here instead, at startup, and every request is served warm.

_MODEL_READY = False


def _warm_up() -> None:
    """Load the model and exercise it, so no request pays the cold cost."""
    global _MODEL_READY
    started = time.perf_counter()
    _log("warmup_start", model=CONFIG.model_id, backend=CONFIG.infer_mode)
    try:
        # Under the GPU lock, so a request that arrives while the weights are
        # still loading waits for this load instead of starting a second one —
        # two copies of a 2.2 GB pair do not fit the 6 GB this targets.
        with _GPU_LOCK:
            _load_model_locked()
    except Exception as exc:  # noqa: BLE001 - reported; the next request retries
        # Not fatal: the failure is logged with its type, `/healthz` keeps
        # reporting `ready: false`, and the first request still tries the load
        # and answers its caller with the backend's own refusal.
        _log("warmup_failed", level="error", error=type(exc).__name__)
        return
    _MODEL_READY = True
    try:
        # A quarter second of silence goes through the same path a request does:
        # the audio encoder, the prefill and one decode step, which is what
        # compiles the CUDA graphs. Best effort — the model is already usable.
        _transcribe_sync(np.zeros(4000, dtype=np.float32), CONFIG.language_default)
        _log("warmup_inference_done")
    except Exception as exc:  # noqa: BLE001
        _log("warmup_inference_failed", level="error", error=type(exc).__name__)
    _log(
        "warmup_done",
        model=CONFIG.model_id,
        backend=CONFIG.infer_mode,
        seconds=round(time.perf_counter() - started, 2),
    )


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # A thread, not an await: uvicorn starts serving immediately, so /healthz
    # answers while the weights load and reports readiness honestly.
    threading.Thread(target=_warm_up, name="r2t2-warmup", daemon=True).start()
    yield


# --------------------------------------------------------------------------- #
# HTTP application
# --------------------------------------------------------------------------- #

app = FastAPI(
    title="Reasonate R2T2 ASR",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    lifespan=_lifespan,
)


def _error(status: int, message: str, request_id: str, err_type: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": err_type}},
        headers={"X-Request-ID": request_id},
    )


def _normalize_media_type(value: Optional[str]) -> str:
    if not value:
        return ""
    return value.split(";", 1)[0].strip().lower()


@app.get("/healthz")
async def healthz() -> JSONResponse:
    # Liveness first, readiness second: this answers while the weights are still
    # loading, and `ready` turns true once they are. It never loads the model
    # itself, so the check stays cheap enough for a container health probe.
    return JSONResponse(
        {"status": "ok", "model": CONFIG.model_id, "ready": _MODEL_READY}
    )


@app.get("/v1/models")
async def list_models() -> JSONResponse:
    return JSONResponse({"data": [{"id": CONFIG.model_id, "object": "model"}]})


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    request: Request,
    file: UploadFile = File(...),
    model: Optional[str] = Form(default=None),
    language: Optional[str] = Form(default=None),
    x_request_id: Optional[str] = Header(default=None),
) -> JSONResponse:
    request_id = (x_request_id or "").strip() or uuid.uuid4().hex
    started = time.perf_counter()
    path = request.url.path
    audio_bytes = 0
    decoded_seconds: Optional[float] = None

    def finish(status: int, audio: int, seconds: Optional[float]) -> None:
        _log(
            "transcription_request",
            request_id=request_id,
            path=path,
            status=status,
            duration_ms=round((time.perf_counter() - started) * 1000.0, 2),
            audio_bytes=audio,
            decoded_seconds=None if seconds is None else round(seconds, 3),
        )

    # 1. Media type allowlist (parameters such as ;codecs=... are stripped).
    media_type = _normalize_media_type(file.content_type)
    if media_type not in ALLOWED_MEDIA_TYPES:
        finish(415, audio_bytes, decoded_seconds)
        return _error(415, ALLOWED_MEDIA_TYPE_MESSAGE, request_id, "unsupported_media_type")

    # 2. Bounded read with an explicit cap (do not trust Content-Length).
    buffer = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        audio_bytes += len(chunk)
        if audio_bytes > CONFIG.max_upload_bytes:
            finish(413, audio_bytes, decoded_seconds)
            return _error(
                413,
                f"audio exceeds the maximum upload size of {CONFIG.max_upload_bytes} bytes",
                request_id,
                "payload_too_large",
            )
        buffer.extend(chunk)

    if not buffer:
        finish(400, 0, decoded_seconds)
        return _error(400, "uploaded audio is empty", request_id, "invalid_request_error")

    # 3. Decode (blocking subprocess; off the event loop).
    try:
        wav, decoded_seconds = await run_in_threadpool(_decode_audio, bytes(buffer))
    except AudioDecodeError as exc:
        finish(400, audio_bytes, decoded_seconds)
        return _error(400, str(exc), request_id, "invalid_request_error")

    # 4. Resolve the language hint (never trust the raw string blindly).
    try:
        resolved_language = resolve_language(language)
    except UnsupportedLanguage:
        finish(400, audio_bytes, decoded_seconds)
        return _error(400, "unsupported language", request_id, "invalid_request_error")

    # 5. Run inference, serialized on the GPU and bounded by a wall-clock budget.
    try:
        if CONFIG.request_timeout_sec > 0:
            text = await asyncio.wait_for(
                run_in_threadpool(_transcribe_sync, wav, resolved_language),
                timeout=CONFIG.request_timeout_sec,
            )
        else:
            text = await run_in_threadpool(_transcribe_sync, wav, resolved_language)
    except asyncio.TimeoutError:
        finish(504, audio_bytes, decoded_seconds)
        return _error(504, "transcription timed out", request_id, "timeout_error")
    except Exception:  # noqa: BLE001 - server-side detail stays server-side
        _log("transcription_failed", level="error", request_id=request_id, path=path)
        finish(503, audio_bytes, decoded_seconds)
        return _error(503, "transcription backend is unavailable", request_id, "server_error")

    finish(200, audio_bytes, decoded_seconds)
    return JSONResponse(
        status_code=200,
        content={"text": text},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
    _log("unhandled_error", level="error", path=request.url.path, error=type(exc).__name__)
    return JSONResponse(
        status_code=500,
        content={"error": {"message": "internal server error", "type": "server_error"}},
    )


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #
# See the module docstring: the model is loaded lazily per request, so running
# uvicorn (or `python app.py`) never initializes vLLM during import. This keeps
# vLLM's spawn re-import safe and lets /healthz answer before any GPU work.

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=CONFIG.port, log_level="info")

# Kokoro TTS (self-hosted)

**Status:** configuration and documentation; no product code lives here
**Owner role:** Platform / Model services

---

## Purpose

This directory stands up the self-hosted text-to-speech backend that the product's
replaceable TTS adapter talks to through `REASONATE_TTS_URL`. The model is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), served by the upstream
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) project, which exposes an
OpenAI-compatible `/v1/audio/speech` endpoint.

Nothing here is vendored: `compose.yaml` runs an upstream published image,
`.env.example` is the deployment's variable template, and this file explains how to run
it and why this model was chosen. Company policy forbids paid third-party inference
APIs; every model named in this document is open-weight and runs on hardware we control.

This service is **TTS only**. Speech-to-text lives in the sibling
`services/r2t2-asr/` directory; do not point `REASONATE_ASR_URL` at this port.

## Layout

```
services/kokoro-tts/
├── compose.yaml    # one service, upstream CPU image, loopback-only publish
├── .env.example    # non-secret knobs the compose file reads
└── README.md       # this file
```

---

## Bring-up

Docker (Compose v2) is the only prerequisite.

```bash
cd services/kokoro-tts
cp .env.example .env          # optional; the defaults in compose.yaml match it
docker compose up -d
```

The image bakes the Kokoro-82M weights in, but the named volume mounts over that path so
the cache persists across container replacement; on the **first** start the upstream
entrypoint downloads the checksum-verified weights into the volume once (roughly 330 MB).
Later starts reuse them. Watch progress with:

```bash
docker compose logs -f kokoro-tts
```

The service is ready when the healthcheck passes, which also confirms the model warmed
up and voices loaded:

```bash
docker compose ps                       # STATUS shows "healthy"
curl -fsS http://localhost:8880/health  # {"status":"healthy"}
```

Stop it with `docker compose down` (keeps the cache volume) or
`docker compose down -v` (deletes the volume, forcing a re-download next start).

## Verification

This is the exact OpenAI `/audio/speech` request shape the product sends; the response is
raw audio bytes, written straight to a file here:

```bash
curl http://localhost:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"input":"ReasonateAI verified your build.","voice":"af_heart","response_format":"mp3"}' \
  --output out.mp3
```

`out.mp3` should be a playable MP3. `model` is optional and defaults to `kokoro`;
`voice` is optional here only because the server has a `DEFAULT_VOICE` — the product
always sends one. A useful cross-check is that round-tripping the file through the ASR
service returns the same sentence.

---

## HTTP surface

| Method | Path | Contract |
| ------ | ---- | -------- |
| `POST` | `/v1/audio/speech` | JSON `{"input","voice","model","response_format","speed",...}` → raw audio bytes with a matching `content-type` |
| `POST` | `/v1/audio/voices` / `GET /v1/audio/voices` | Voice listing and voice mixing (upstream extras; the product does not need them) |
| `GET`  | `/health` | `{"status":"healthy"}` |
| `GET`  | `/docs` | Interactive OpenAPI UI (upstream) |
| `GET`  | `/web` | Built-in web player (upstream; loopback only) |

Supported `response_format` values are `mp3`, `opus`, `aac`, `flac`, `wav`, and `pcm`.

**Health endpoint differs from the shared service contract.** The phase contract names
`GET /healthz` returning `{"status":"ok"}`; upstream Kokoro-FastAPI exposes
`GET /health` returning `{"status":"healthy"}` and has no `/healthz` route, and we do not
patch upstream. Wire the platform probe (or its fronting gateway) to `/health`, or add a
path rewrite at the gateway. The "model when known" half of the contract is not reported
by this endpoint; the loaded model is the image's Kokoro-82M, and
`docker compose logs kokoro-tts` names it at warmup.

The upstream server keeps no transcript of what it synthesized beyond the bounded,
rotated container log, and the product never logs audio either; text normalization is
applied in-process and not persisted.

---

## Product wiring

The product resolves its TTS provider from environment variables on the **product** side
(`apps/api`), not here:

| Product variable | Value for this stack | Notes |
| ---------------- | -------------------- | ----- |
| `REASONATE_TTS_URL` | `http://localhost:8880/v1/audio/speech` | The exact `/audio/speech` endpoint URL; the adapter posts to this URL unchanged |
| `REASONATE_TTS_VOICE` | `af_heart` | Must match a Kokoro voicepack id; keep in step with `KOKORO_TTS_VOICE` |
| `REASONATE_TTS_MODEL` | `kokoro` (optional) | Optional; the server accepts and ignores it and defaults to `kokoro` |
| `REASONATE_TTS_API_KEY` | any non-empty string (optional) | This server authenticates nothing; a placeholder such as `not-needed` satisfies clients that require a key |

Because the dependency is resolved entirely from these variables, swapping backends is a
configuration change, not a code change.

---

## Why Kokoro-82M is the default

Selection scorecard, open-weight candidates only. Round-trip CER (lower is better) and
UTMOS MOS (higher is better) come from the Trelis **Tricky-TTS** evaluation, which
measures whether a synthesis is transcribed back to the intended text and how natural it
sounds; both columns are that benchmark's snapshot at selection time.

| Model | Tricky-TTS round-trip CER ↓ | UTMOS MOS ↑ | Speech Arena ELO | Params | Weights license |
| ----- | --------------------------: | ----------: | ---------------: | -----: | --------------- |
| **Kokoro-82M (default)** | **17%** | **4.5** | ~1058 (2026-05) | 82M | Apache 2.0 |
| Orpheus | 21% | 4.2 | — | — | — |
| Voxtral Mini | 25% | 4.1 | — | — | — |
| Piper | 28% | 3.3 | — | — | — |
| Chatterbox | 86% | 4.0 | — | — | — |
| Fish Audio S2 Pro | — | — | ~1123 | — | research-only (excluded) |

Kokoro has the **best round-trip fidelity and the best naturalness of the open-weight
field in that test**: it is the model least likely to garble the product's technical text,
which is exactly what milestone reporting reads aloud. Chatterbox is the cautionary row —
a respectable 4.0 MOS while mangling 86% of the tricky inputs, which is why fidelity, not
naturalness alone, is the deciding column.

Supporting facts:

- **82M parameters, CPU-capable.** It runs well on a laptop-class CPU with no GPU, so the
  stack stays cheap and portable. Larger candidates need a GPU to be usable interactively.
- **Apache 2.0 weights.** Permissive, no royalty, no per-character cost — consistent with
  the no-third-party-inference-cost policy.
- **Artificial Analysis Speech Arena ~ELO 1058** (2026-05 snapshot) places it mid-field
  among open-weight models on blind listener preference. Fish Audio S2 Pro leads the
  open-weight arena at roughly **ELO 1123** but is **excluded on licensing**: its weights
  are research-only and commercial or API use requires a separate written license, which
  this product cannot accept for a shippable deployment.
- Leaderboard numbers move over time; the exact figures above are the snapshot that was
  used to make this choice, and they should be re-measured before a future model change.

---

## Alternatives

Both alternatives are Apache 2.0 and self-hostable. Each replaces this stack behind the
same `REASONATE_TTS_URL` contract; the product code does not change.

### CosyVoice2-0.5B — recommended swap for low-latency interactive voice

CosyVoice2-0.5B (Apache 2.0) does **true streaming synthesis** and **zero-shot voice
cloning** from a short reference clip, which is the better fit when the product wants to
speak as it generates rather than synthesize a finished reply. Trade-off: it is a heavier
runtime than Kokoro and its non-streaming quality on tricky text is not established by
the same benchmark, so re-measure before switching.

What changes:

- Run the upstream CosyVoice2 server (its own FastAPI/vLLM deployment; not an image from
  this directory — nothing here is vendored) exposing an OpenAI-compatible
  `/v1/audio/speech`.
- `REASONATE_TTS_URL` → that server's `/audio/speech` endpoint URL.
- `REASONATE_TTS_MODEL` → `cosyvoice2` (or the server's advertised model id).
- `REASONATE_TTS_VOICE` → the id of a voice you saved/synthesized from a reference clip,
  instead of an `af_*` Kokoro voicepack.
- The Compose service in this directory is replaced by that server's own compose/run
  command; this file documents the swap rather than hosting it.

### Qwen3-TTS-12Hz-0.6B / 1.7B

Qwen3-TTS (Apache 2.0) is the same Qwen family as the `qwen-asr/` option recorded in
`.context/SPEC.md`, so an operator already running a Qwen runtime covers both speech
directions with one stack. The 12 Hz series ships 0.6B and 1.7B variants; the Base
checkpoints target cloning from a short reference clip, and the larger 1.7B trades more
VRAM for more expressiveness.

What changes:

- Run the Qwen3-TTS server exposing an OpenAI-compatible `/v1/audio/speech`.
- `REASONATE_TTS_URL` → that server's `/audio/speech` endpoint URL.
- `REASONATE_TTS_MODEL` → `qwen3-tts-12hz-0.6b-base` (or the 1.7B variant).
- `REASONATE_TTS_VOICE` → a named preset voice, or a saved clone of a reference clip.
- Again, this directory hosts configuration for the default only; the swap is a
  deployment change, not an edit here.

---

## Licensing

- **This stack's weights:** Kokoro-82M is released under **Apache 2.0**. The upstream
  server code is also Apache 2.0. Retain the license and notice files from the upstream
  image/project when redistributing; the model card notes some training audio under
  CC BY 3.0/4.0 with attribution, so preserve those notices as well if you redistribute
  assets.
- **Alternatives:** CosyVoice2-0.5B and Qwen3-TTS are Apache 2.0 as well. Any voice you
  clone is your responsibility — get the speaker's consent before cloning or shipping a
  voice.
- **Excluded by policy:** commercial TTS APIs — ElevenLabs, Cartesia, Inworld, Gemini —
  are not used. They bill per character and depend on a third party's infrastructure,
  which the product's no-third-party-inference-cost model forbids. Every backend named in
  this document is self-hosted open-weight.

---

## Limitations

- **English-first voice quality.** Kokoro supports several languages, but its voice packs
  and its text normalizer are strongest in English (US/GB). Non-English output is best
  treated as best-effort.
- **Text normalization is the caller's responsibility.** The Trelis Tricky-TTS benchmark
  exists precisely because symbols, abbreviations, and proper nouns are where TTS
  degrades; Kokoro led that field at 17% CER, but 17% is still one in six tricky inputs
  garbled. When the product reads back build output, code, or paths, it should expand or
  pre-normalize symbols (`&`, `@`, version strings, identifiers) before sending text, not
  rely on the synthesizer to guess.
- **Turn-based, not streaming.** This is request/response synthesis of a complete string,
  not a token-streaming voice loop. Kokoro-FastAPI can stream audio chunks within one
  request, but the product adapter treats it as turn-based. For genuinely low-latency
  interactive voice, see the CosyVoice2 alternative above.
- **No authentication and no TLS.** The loopback bind is the boundary; do not widen it.
- **Serial inference.** Uvicorn serves requests one process at a time per worker, so
  throughput is bounded by synthesis time; scale with replicas behind the product's
  gateway rather than by raising workers, which would each load their own model copy.

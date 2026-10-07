# Reasonate AI — R2T2 ASR service (OpenAI-compatible /v1/audio/transcriptions)
#
# Multi-stage on purpose. The runtime stage carries only what the llama.cpp
# backend needs (~2 GB): torch-CPU, the qwen-asr modeling code, the llama.cpp
# libraries rebuilt from source, and the CUDA runtime libraries cuBLAS/Lt link
# against. The compiler, the llama.cpp sources and the build tree stay in the
# builder stage. The vLLM backend for large GPUs (~14 GB) is an optional extra
# documented in README.md and is never part of this image.
#
# What is rebuilt, and what is not
# --------------------------------
# The package ships prebuilt x86-64 libraries, and its CPU half was built with
# -march=native: those binaries execute AVX-512 instructions and raise SIGILL on
# AVX2-only CPUs (consumer laptops). So the CPU backend is rebuilt here with
# GGML_NATIVE=OFF, together with the qwen3asr_native pybind extension that loads
# it — that pair is what makes the image portable across x86-64 hosts.
#
# Everything else in the package's bin/ is kept exactly as shipped, and that is
# a recorded decision rather than an oversight:
#
#   * libggml.so carries the backend registry — the list that decides which
#     separate libraries are even attempted at load time. It is generated from
#     llama.cpp's build configuration, so a CPU-only rebuild of it forgets CUDA
#     entirely and every layer is assigned to the CPU, which no path setting can
#     undo. The package's own copy names CUDA, and it is the file that makes the
#     GPU reachable.
#   * libggml-cuda.so is the shipped CUDA backend. Rebuilding it needs a full
#     CUDA toolkit (nvcc), which this repository's network cannot deliver: the
#     NVIDIA repository serves at ~100 kB/s and drops the connection mid-file,
#     its apt index cannot be verified at all under Debian trixie's SHA-1
#     policy, and the official devel image is a 5.4 GB pull. It was built from
#     this exact llama.cpp revision (0.23.0) with llama.cpp's default
#     architecture list, which includes `89-real` — Ampere and Ada consumer
#     GPUs — and the CUDA runtime libraries it links against are installed in
#     the runtime stage from Debian's non-free section.
#
# If the CUDA half ever needs to be rebuilt too (a different GPU generation, a
# bumped llama.cpp), install Debian's own toolkit instead of NVIDIA's — trixie's
# non-free section carries `nvidia-cuda-toolkit` (nvcc), `nvidia-cuda-dev` and
# the cuBLAS libraries over the same signed mirror this image already uses:
#
#   apt-get install -y --no-install-recommends nvidia-cuda-toolkit nvidia-cuda-dev
#   cmake ... -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=/usr/bin/nvcc \
#             -DCMAKE_CUDA_ARCHITECTURES=89-real
#
# That build takes the nvcc pass count (one per architecture) and several GB of
# toolkit on top of this image, so it is opt-in rather than the default.

# --------------------------------------------------------------------------- #
# Builder: compile llama.cpp (CPU baseline) and the pybind extension. This
# stage intentionally has no CUDA: without GGML_CUDA the build needs only a
# host compiler, and the package's CUDA library is passed through untouched.
# --------------------------------------------------------------------------- #
FROM python:3.12-slim AS llama-builder

# curl fetches the pinned llama.cpp tarball below; make is the generator CMake
# drives; git is needed by pip to install the model package from its repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake curl g++ git make ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The package sources (r2t2_llama ships native_ext.cpp + CMakeLists.txt).
RUN pip install --no-cache-dir --no-deps confucius4-r2t2==0.1.0 \
    || pip install --no-cache-dir --no-deps \
        "confucius4-r2t2 @ git+https://github.com/netease-youdao/Confucius4-R2T2.git@26d55a54ce5670cff9947a167d8ed95d569fd4d9"

# The CMakeLists configures pybind11 as a package (`find_package(pybind11
# CONFIG REQUIRED)`), and pip's pybind11 keeps its CMake config under
# site-packages, which is not a CMake search prefix — the configure step names
# the directory explicitly below.
RUN pip install --no-cache-dir pybind11

# GGML_NATIVE=OFF is the point of this build (see the header). The job count is
# an argument rather than `nproc` because the build runs inside the container's
# memory limit, where an unbounded -j is killed by the OOM killer instead of
# reporting a compile error.
#
# The fetch, the configure and the compile are one step, and the sources and
# the build tree are removed in it: this machine has very little disk headroom,
# and leaving them behind would commit roughly 2 GB of object files to a layer
# that only needs the ~200 MB of finished libraries.
#
# `r2t2_llama` is located through the import system rather than imported:
# importing it runs its `__init__`, which imports `qwen_asr` and torch, and this
# stage deliberately installs neither.
#
# CMAKE_BUILD_WITH_INSTALL_RPATH=ON keeps the extension's RPATH at the value the
# upstream project installs with ($ORIGIN/../bin) instead of the build tree.
# Without it the built extension points at /tmp/llama-build/bin and cannot load
# libmtmd/libllama once the build tree is removed — which it is, in this step.
ARG BUILD_JOBS=4
ARG LLAMA_CPP_COMMIT=ad6c66839af3c5646fba8c6c2e2087a1e4e38948
RUN SITE="$(python -c "import importlib.util as u; print(u.find_spec('r2t2_llama').submodule_search_locations[0])")" \
    && curl -fsSL --retry 20 --retry-all-errors --retry-delay 2 \
        -o /tmp/llama.tar.gz \
        "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/${LLAMA_CPP_COMMIT}" \
    && mkdir -p /tmp/llama.cpp \
    && tar -xzf /tmp/llama.tar.gz -C /tmp/llama.cpp --strip-components=1 \
    && rm -f /tmp/llama.tar.gz \
    && cmake -S "$SITE" -B /tmp/llama-build \
        -DLLAMA_CPP_DIR=/tmp/llama.cpp \
        -Dpybind11_DIR="$(python -m pybind11 --cmakedir)" \
        -DGGML_NATIVE=OFF \
        -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
        -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/llama-build -j"${BUILD_JOBS}" \
    && mkdir -p /out/bin /out/native \
    && cp -a /tmp/llama-build/bin/libggml-cpu.so* /out/bin/ \
    && cp -a "$SITE"/native/qwen3asr_native*.so /out/native/ \
    && rm -rf /tmp/llama-build /tmp/llama.cpp

# --------------------------------------------------------------------------- #
# Runtime
# --------------------------------------------------------------------------- #
FROM python:3.12-slim

# ffmpeg decodes browser/mobile audio (webm/opus, m4a/aac, ogg) that
# pure-Python decoders cannot read. curl is used by HEALTHCHECK. git is
# required because the R2T2 package is installed from its Git repository.
#
# libcudart/libcublas/libcublasLt are the CUDA runtime the package's
# libggml-cuda.so resolves at load time; a CUDA build of llama.cpp aborts that
# backend without them, and the NVIDIA driver's own libcuda.so.1 is supplied by
# `docker run --gpus all`. They come from trixie's non-free section — the same
# signed Debian mirror as everything else here — which is why the components
# line is widened.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg curl git libcublas12 libcublaslt12 libcudart12 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch comes from the CPU wheel index: the llama path never touches CUDA
# through torch, and the CUDA wheels alone are several gigabytes. The model
# package itself is installed with --no-deps because its declared dependency
# is `qwen-asr[vllm]` — selecting that extra is what drags the ~14 GB vLLM
# stack back in. `qwen-asr` (plain) is pinned in requirements.txt instead.
COPY requirements.txt ./
# --retries/--timeout are raised from pip's defaults on purpose: this build
# environment loses DNS and drops TLS connections to the PyTorch and PyPI CDNs
# mid-download ("Failed to resolve 'download-r2.pytorch.org'"). pip resumes an
# interrupted wheel, but only while it still has attempts left.
RUN pip install --no-cache-dir --retries 20 --timeout 60 --upgrade pip \
    && pip install --no-cache-dir --retries 20 --timeout 60 torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --retries 20 --timeout 60 -r requirements.txt

# `confucius4-r2t2` is fetched from its Git repository (hence `git`, installed
# with ffmpeg/curl above). Kept in its own layer, after the slow torch/qwen-asr
# stack: a transient clone or TLS failure retries in seconds instead of
# re-downloading several hundred MB of wheels on this throttled network.
RUN pip install --no-cache-dir --no-deps \
        "confucius4-r2t2 @ git+https://github.com/netease-youdao/Confucius4-R2T2.git@26d55a54ce5670cff9947a167d8ed95d569fd4d9"

# The rebuilt CPU backend replaces the package's AVX-512 one; everything else in
# bin/ is the package's own, deliberately.
#
# The backend *registry* — the list that decides which separate libraries are
# even attempted at load time — is compiled into libggml.so from llama.cpp's
# build configuration. Replacing libggml.so with a CPU-only rebuild made the
# registry forget CUDA entirely, so every layer was assigned to CPU (no path
# setting can add a backend the registry does not name). Swapping only
# libggml-cpu.so keeps the package's CUDA-aware registry and the CUDA backend
# while still removing the -march=native kernels that raise SIGILL on AVX2-only
# CPUs.
COPY --from=llama-builder /out /out
RUN SITE="$(python -c "import importlib.util as u; print(u.find_spec('r2t2_llama').submodule_search_locations[0])")" \
    && cp -a /out/bin/. "$SITE/bin/" \
    && cp -a /out/native/. "$SITE/native/"

# Where those libraries are found at run time.
#
# The extension's own RPATH is $ORIGIN/../bin and resolves its direct
# dependencies, but the llama.cpp libraries do not resolve each other: the build
# tree remains in their RUNPATH, and it is deleted by the builder stage — so
# libmtmd loads and then dies on `libggml.so.0 => not found`. The same applies to
# the CUDA library, which this image passes through from the package and whose
# RUNPATH still names the directory it was built in upstream. Naming the
# package's bin directory on the loader path covers all of them, rebuilt or not.
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/r2t2_llama/bin

# Default to the llama.cpp backend and the canonical GGUF mount point.
ENV ASR_INFER_MODE=llama
ENV ASR_GGUF_DIR=/models/gguf

# Application code.
COPY app.py ./

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8081

# The start period covers the startup warm-up: the weights are 2.2 GB read
# through the operator's mount, so becoming ready takes about two minutes on a
# bind mount, and the probe must not call that unhealthy. Keying the probe on
# `ready` is what lets `docker ps` distinguish "still loading the model" from
# "serving transcripts".
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ASR_PORT:-8081}/healthz" | grep -q '"ready":true' || exit 1

CMD uvicorn app:app --host 0.0.0.0 --port ${ASR_PORT:-8081}

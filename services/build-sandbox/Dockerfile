FROM golang:1.27.1-bookworm AS go-runtime

FROM node:22-bookworm

COPY --from=go-runtime /usr/local/go /usr/local/go

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH=/opt/reasonate/go
ENV GOCACHE=/opt/reasonate/go-build
ENV MPLBACKEND=Agg
ENV MPLCONFIGDIR=/tmp/matplotlib

ENV npm_config_cache=/opt/reasonate/npm-cache

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip python3-venv python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

COPY python/requirements.lock /opt/reasonate/python-requirements.lock

RUN python3 -m pip install \
      --break-system-packages \
      --disable-pip-version-check \
      --no-cache-dir \
      --require-hashes \
      -r /opt/reasonate/python-requirements.lock

WORKDIR /opt/reasonate/templates/next-shadcn

COPY templates/next-shadcn/package.json ./package.json
COPY templates/next-shadcn/package-lock.json ./package-lock.json
COPY templates/next-shadcn/ ./

# Populate a per-container image-layer npm cache and prove the starter installs
# from that cache without network access. The mutable workspace remains empty;
# the starter is only used when a project explicitly selects Next.js.
RUN npm install --global npm@12.2.0 \
    && node --version \
    && python3 --version \
    && go version \
    && npm ci --allow-remote=all --no-audit --no-fund \
    && rm -rf node_modules \
    && npm ci --offline --allow-remote=all --no-audit --no-fund \
    && npm test \
    && npm run build \
    && rm -rf .next

WORKDIR /workspace

CMD ["sleep", "infinity"]

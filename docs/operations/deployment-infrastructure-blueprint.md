# ReasonateAI Phase 3 — Production Deployment & Infrastructure Blueprint

**Target Delivery:** October 13, 2026 (MVP Live Rehearsal)  
**Authoritative Scope:** Control Plane (`apps/api`), Execution Plane (`apps/worker`), Web Client (`apps/web`), Sensory Cluster (`services/`), and Authoritative Storage  
**Audience:** Founder & Technical Lead (Ashutosh Mishra), Executive Leadership, and Engineering Contributors  

---

## 1. Executive Summary & Ground-Truth Context

ReasonateAI Phase 3 is an autonomous, multimodal "AI CTO" and software factory designed for non-technical users. It ingests voice, text, and visual requirements, designs architecture, executes code in isolated Linux containers, inspects running web applications, repairs failures, and delivers verified results with spoken progress milestones.

Unlike standard SaaS web applications, ReasonateAI cannot be hosted on pure serverless platforms (such as Vercel, Netlify, or AWS Lambda). The system operates as a stateful, dual-plane engine:

```
                           [ Internet Users / Browser ]
                                        │
                                        ▼
                         [ Cloudflare DNS & Edge SSL ]
                               [ app.reasonate.ai ]
                                        │
                                        ▼
                  ┌───────────────────────────────────────────┐
                  │   Caddy 2 Reverse Proxy (Unbuffered SSE)   │
                  └─────────────┬───────────────┬─────────────┘
                                │ :3000         │ :4111
                                ▼               ▼
                         ┌─────────────┐ ┌─────────────┐
                         │ apps/web    │ │ apps/api    │
                         │ Next.js 16  │ │ Mastra Core │
                         └─────────────┘ └──────┬──────┘
                                                │ (Both access host
                                                │  Docker daemon)
                                                ▼
                         ┌─────────────────────────────┐
                         │ apps/worker (Private Daemon)│
                         │ - Leases runs from Postgres │
                         │ - Spawns Docker Sandboxes   │
                         └──────────────┬──────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
      ┌─────────────┐            ┌─────────────┐            ┌─────────────┐
      │ PostgreSQL  │            │ Redis 7     │            │ services/   │
      │ 16+ Ledger  │            │ Streams     │            │ ASR (GPU)   │
      │ (:5432)     │            │ (:6379)     │            │ TTS (CPU)   │
      └─────────────┘            └─────────────┘            └─────────────┘
```

### The Architectural Invariants

1. **The Docker Daemon Colocation Imperative**:  
   `apps/worker` provisions ephemeral build containers (`reasonate-build-sandbox:node22`, constrained to 1 CPU, 2GB RAM, 256 PIDs) using the host Linux Docker daemon (`/var/run/docker.sock`). Concurrently, `apps/api` discovers running containers and binds loopback port relays to proxy live application previews to the user's browser.  
   **Crucial Rule**: `apps/api` and `apps/worker` **must** share access to the same Docker daemon. Splitting `apps/api` to Vercel and `apps/worker` to a separate VM breaks the live preview relay entirely.
2. **Path-Based Application Previews**:  
   Live web previews are served via path-based proxying (`/v1/previews/:previewId/*`), not wildcard subdomains. No wildcard DNS or wildcard SSL certificates are required for the MVP.
3. **Local Filesystem Artifact Storage**:  
   The current implementation of `@reasonateai/artifact-store` (`local.ts`) stores content-addressed artifacts and Git checkpoint bundles directly on the host NVMe filesystem (`/opt/reasonate/artifacts` and `/opt/reasonate/checkpoints`). S3/R2 adapters are not yet implemented in the codebase.
4. **Zero Paid Frontier Models Invariant**:  
   Per `.context/SPEC.md` §343, paid closed APIs (OpenAI GPT-4, Anthropic Claude, Google Gemini) are prohibited in production paths. The system runs open-weight models (`deepseek/deepseek-flash` behind spending limits or self-hosted Qwen 2.5 Coder) alongside self-hosted speech services (Confucius4-R2T2 ASR and Kokoro-82M TTS).

---

## 2. Exhaustive Technical Requirements Matrix

| Subsystem | Technology & Location | Hardware / Environment Prerequisites | Ports & Network Ingress |
| :--- | :--- | :--- | :--- |
| **Frontend PWA** | Next.js 16.3.8 (React 19.3), Tailwind CSS 4 (`apps/web`) | Node.js 22.22+, 1 vCPU, 1 GB RAM | Internal port `3000` HTTP |
| **API Control Plane** | Mastra Core Server on Hono (`apps/api`) | Node.js 22.22+, 2 vCPU, 2–4 GB RAM, access to `/var/run/docker.sock` | Internal port `4111` HTTP |
| **Worker Execution Plane** | Private TypeScript daemon (`apps/worker`) | Linux x86_64 with cgroups v2, min 4 vCPU, 16–32 GB RAM, access to `/var/run/docker.sock` | Private background process (no public port) |
| **Docker Build Sandboxes** | Custom Ubuntu/Node image (`services/build-sandbox`) | Linux Container (1 CPU, 2GB RAM, 256 PIDs, cgroups enforced) | Loopback port relay `18080` -> random host port `127.0.0.1:0` |
| **Authoritative Persistence** | PostgreSQL 16+ (`@reasonateai/project-state`) | Dedicated Postgres instance, min 2 vCPU, 4GB RAM, 20–50 GB NVMe | Internal port `5432` TCP |
| **Event Transport & Rate Limiting** | Redis 7+ Streams (`@reasonateai/project-state`) | In-memory Redis 7, min 512MB – 1GB RAM | Internal port `6379` TCP |
| **Speech-to-Text (ASR)** | Confucius4-R2T2 Q8_0 GGUF via llama.cpp CUDA (`services/r2t2-asr`) | NVIDIA GPU with **4–6 GB VRAM** (CUDA 12+) | Loopback port `8081` (`/v1/audio/transcriptions`) |
| **Text-to-Speech (TTS)** | Kokoro-82M via Kokoro-FastAPI (`services/kokoro-tts`) | CPU (2 vCPU, 1–2 GB RAM, **0 GB VRAM required**) | Loopback port `8880` (`/v1/audio/speech`) |
| **LLM Inference** | `deepseek/deepseek-flash` (or self-hosted Qwen 2.5 Coder) | DeepSeek API key (or 24GB VRAM GPU if 100% self-hosted) | Outbound HTTPS |
| **Ingress & Reverse Proxy** | Caddy 2 (or Nginx) with unbuffered SSE | Linux host, Let's Encrypt TLS | Public ports `80` (HTTP) and `443` (HTTPS) |

---

## 3. Multi-Platform Pricing & Cloud Comparison (2026 Reality)

### A. GPU Host (Worker + Docker Sandboxes + Speech AI Stack)

| Provider | Instance / Tier | Hardware Specs | Monthly Cost (24/7) | Verdict & Suitability |
| :--- | :--- | :--- | :--- | :--- |
| **RunPod (Secure Cloud)** ⭐ | Secure Cloud GPU Instance | 8 vCPU, 32GB RAM, 100GB NVMe, **1x NVIDIA RTX 4090 (24GB) or A5000** | **~$0.59/hr** (~$40–$65 staging window) | **BEST FOR OCT 13 DEMO**. Tier-3/4 datacenter, zero spot preemption risk, per-second billing. |
| **Hetzner (GEX45 Dedicated)** ⭐ | Dedicated Bare Metal Server | Intel Core i5-13500 (20t), 64GB DDR4, 2x512GB NVMe, **1x NVIDIA RTX PRO 4000 Blackwell (24GB GDDR7 ECC)** | **Flat €214/mo (~$235/mo)** + €209 setup | **BEST FOR PRODUCTION SCALE**. Bare-metal root access eliminates Docker-in-Docker overhead; 20TB free egress. |
| **AWS EC2 (`g5.xlarge` / `g6.xlarge`)** ❌ | On-Demand EC2 GPU VM | 4 vCPU, 16GB RAM, 1x NVIDIA A10G or L4 (24GB), EBS gp3 storage | **~$750 – $1,100/mo** + $0.09/GB egress | **STRICT AVOID**. 3x to 4x the price of Hetzner/RunPod with punishing disk IOPS and bandwidth fees. |
| **Lambda Labs** | Cloud GPU VM | 14 vCPU, 46GB RAM, 500GB SSD, 1x NVIDIA A10 (24GB) | ~$1.29/hr (~$930/mo) | High reliability, but chronic inventory stockouts in 2026. |
| **DigitalOcean** | GPU Droplet | 8 vCPU, 32GB RAM, 1x NVIDIA RTX 4000 Ada (20GB) | ~$0.76/hr (~$550/mo) | More expensive than RunPod Secure Cloud. |

### B. Database, Cache, and Model Services

| Component | Platform Options | Monthly Cost | Operational Assessment |
| :--- | :--- | :--- | :--- |
| **PostgreSQL 16** | Self-Hosted in Docker (Host)<br>Supabase Pro Tier<br>Neon Launch Tier | **$0.00** (Host)<br>$25.00 / mo<br>$19.00 / mo | Host container has **0ms loopback latency** and zero connection limits. Supabase Pro is the best managed alternative. |
| **Redis 7** | Self-Hosted in Docker (Host)<br>DigitalOcean Managed Redis<br>Upstash Redis | **$0.00** (Host)<br>$15.00 / mo<br>Usage-based | Live SSE text deltas emit millions of stream events. Self-hosted Redis avoids request-based billing spikes. |
| **LLM Inference** | DeepSeek Flash API (`deepseek/deepseek-flash`) | **$5.00 – $15.00 / mo** (MVP volume) | 100% compliant with `.context/SPEC.md` §343 (open-weight model behind spending limits). Context caching saves 90% of token costs. |
| **DNS & Edge SSL** | Cloudflare Free Tier | **$0.00** | Free anycast DNS, automated edge SSL, and DDoS mitigation. |

---

## 4. Systems Thinking & Risk Engineering (1st, 2nd, 3rd Order)

### 1st Order Consequences (Immediate Structural Truths)
* **API vs. Self-Hosted LLM Economics**: Running a dedicated 24GB GPU server 24/7 solely to serve a local 14B/32B coder LLM costs ~$250–$450/month even when idle. Utilizing the open-weight **DeepSeek Flash API** (already integrated in `apps/api/src/mastra/model.ts`) costs ~$5 to $15/month total, providing enterprise-grade coding intelligence at a fraction of the cost.
* **The Colocation Imperative**: Attempting to host the Next.js frontend or API on Vercel while running the worker on a separate VM will immediately break application previews, because the preview service relies on local Docker daemon socket calls (`docker port`, `docker exec`).

### 2nd Order Consequences (Runtime & Operational Pitfalls)
* **SSE Proxy Buffering Freeze**: If the reverse proxy (Caddy or Nginx) enables response buffering on `/v1/build-sessions/:id/events`, tokens are buffered until an 8KB threshold is reached. The user sees a frozen screen for 10 seconds followed by an abrupt text dump.  
  * **Requirement**: Caddy must be configured with `flush_interval -1` and Nginx with `proxy_buffering off;`.
* **Docker Disk Exhaustion**: Each user build session creates a Docker volume (`reasonate-<orgId>-<projId>-<buildSessionId>-workspace`) and installs npm dependencies. Without an automated daily prune cron (`docker system prune -af --filter "until=24h"`), a 100GB SSD will reach 100% capacity within 3 to 5 days.
* **Mastra Telemetry State Loss**: Mastra initializes `LibSQLStore` (`./mastra.db`) and `DuckDBStore` (`mastra.duckdb`) in the API directory. Running `apps/api` in an ephemeral container without a persistent host volume wipes agent execution traces on process restart.

### 3rd Order Consequences (Strategic & Demonstration Risks)
* **Spot GPU Preemption Catastrophe**: Using Spot or Community Cloud instances saves ~$0.20/hour, but spot instances can be preempted with 30 seconds notice during global GPU demand surges. If an investor or stakeholder demo is running when an instance is evicted, the demonstration fails completely.  
  * **Requirement**: Use **Secure Cloud Reserved Instances** or dedicated bare-metal. Never use Spot for live demos.
* **Transactional Outbox Connection Starvation**: The API writes events to PostgreSQL, and the private worker polls runs using `FOR UPDATE SKIP LOCKED` every 1,000ms. Database connection pool limits must be capped (API: max 20, Worker: max 10) to prevent connection saturation on PostgreSQL.

---

## 5. Two-Tier Deployment Architecture Plans

```
========================================================================================
TIER 1: SCRAPPY & ROCK-SOLID MVP STAGING (Recommended for Oct 13 Live Demo)
Target Budget: ~$55 – $70 / month | Setup Time: < 2 Hours
========================================================================================
• Host Server: 1x RunPod Secure Cloud Instance (Ubuntu 24.04, 8 vCPU, 32GB RAM, 100GB NVMe,
  1x NVIDIA RTX 4090 or A5000 with 24GB VRAM). Run during staging/demo windows (~$0.59/hr).
• Storage: Host NVMe persistent disk (/opt/reasonate/artifacts and /opt/reasonate/checkpoints).
• Persistence: PostgreSQL 16 Alpine container (:5432) on host loopback.
• Cache/Streams: Redis 7 Alpine container (:6379) on host loopback.
• Speech AI: Confucius4-R2T2 ASR in Docker on GPU (:8081) + Kokoro-82M TTS in Docker on CPU (:8880).
• LLM: DeepSeek Flash API (open-weight, costs pennies: ~$10/month).
• Ingress: Caddy 2 with automated Let's Encrypt TLS and unbuffered SSE proxying.
• Process Manager: PM2 running Next.js Web (:3000), Mastra API (:4111), and Worker daemon.

========================================================================================
TIER 2: PRODUCTION-HARDENED SCALE ARCHITECTURE (Post-Launch Target)
Target Budget: ~$250 – $345 / month | Multi-Tenant Scalable
========================================================================================
• Execution Host: Hetzner Dedicated GEX45 Bare Metal Server (€214/mo / ~$235/mo) with
  Intel Core i5-13500 (20t), 64GB DDR4, 2x 512GB NVMe SSD, and NVIDIA RTX PRO 4000 Blackwell (24GB ECC).
• Managed Database: Supabase Pro ($25/mo) with daily PITR backups and Supavisor pooling.
• Managed Cache: DigitalOcean Managed Redis ($15/mo) with automated high availability.
• Object Storage: Cloudflare R2 ($5/mo) with zero egress bandwidth fees (via S3 adapter).
• Email Delivery: Resend Pro ($20/mo) for transactional authentication magic links.
• LLM Inference: DeepSeek Flash API ($20–$50/mo) or local Qwen 2.5 Coder on the Blackwell GPU.
```

---

## 6. Actionable 72-Hour Deployment Runbook (Oct 11 – Oct 13)

### Phase 1: Host Compute & Base Environment Provisioning (Day 1 — Oct 11)

1. **Launch GPU Instance**:
   * Provision an Ubuntu 24.04 LTS host with NVIDIA GPU (min 16GB–24GB VRAM, RTX 4090 or A5000, 8 vCPU, 32GB RAM, 100GB NVMe SSD) on RunPod Secure Cloud or Hetzner.
2. **Install NVIDIA Drivers, Docker & Container Toolkit**:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 curl git ffmpeg
   
   # Setup NVIDIA Container Toolkit
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   
   # Verify GPU access inside Docker
   docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
   ```
3. **Configure DNS (Cloudflare)**:
   * Add `A` record pointing `app.yourdomain.com` to the server's public IP address.

---

### Phase 2: Persistence & Sandbox Build (Day 1 — Oct 11)

1. **Start PostgreSQL 16 & Redis 7**:
   ```bash
   sudo mkdir -p /opt/reasonate/pgdata /opt/reasonate/redisdata /opt/reasonate/artifacts /opt/reasonate/checkpoints

   docker run -d --name reasonate-pg --restart unless-stopped \
     -e POSTGRES_USER=reasonate -e POSTGRES_PASSWORD=reasonate_secure_pw -e POSTGRES_DB=reasonate \
     -v /opt/reasonate/pgdata:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:16-alpine

   docker run -d --name reasonate-redis --restart unless-stopped \
     -v /opt/reasonate/redisdata:/data -p 127.0.0.1:6379:6379 redis:7-alpine redis-server --appendonly yes
   ```
2. **Pre-build Sandbox Image**:
   ```bash
   docker build -f services/build-sandbox/Dockerfile -t reasonate-build-sandbox:node22 services/build-sandbox
   ```

---

### Phase 3: Sensory Stack Bring-Up (Day 2 — Oct 12)

1. **Download R2T2 ASR Model Weights**:
   ```bash
   mkdir -p ~/.cache/models/Confucius4-R2T2-GGUF
   curl -L -o ~/.cache/models/Confucius4-R2T2-GGUF/Confucius4-R2T2-Q8_0.gguf \
     https://huggingface.co/netease-youdao/Confucius4-R2T2-GGUF/resolve/main/Confucius4-R2T2-Q8_0.gguf
   curl -L -o ~/.cache/models/Confucius4-R2T2-GGUF/mmproj-Confucius4-R2T2-Q8_0.gguf \
     https://huggingface.co/netease-youdao/Confucius4-R2T2-GGUF/resolve/main/mmproj-Confucius4-R2T2-Q8_0.gguf
   ```
2. **Start ASR & TTS Containers**:
   ```bash
   cd services/r2t2-asr && docker compose up -d --build
   curl -sS http://127.0.0.1:8081/healthz

   cd ../kokoro-tts && docker compose up -d
   curl -sS http://127.0.0.1:8880/health
   ```

---

### Phase 4: Application Build & Execution (Day 2 — Oct 12)

1. **Production Environment File (`.env.production`)**:
   ```dotenv
   NODE_ENV=staging
   DATABASE_URL=postgres://reasonate:reasonate_secure_pw@127.0.0.1:5432/reasonate
   REDIS_URL=redis://127.0.0.1:6379
   SESSION_SECRET=1067e2a4f48b991cfb567d28399a89c89e4726bf6d5c64b630e2f18374d6c694
   REASONATE_PUBLIC_ORIGIN=https://app.yourdomain.com
   REASONATE_ALLOWED_ORIGINS=https://app.yourdomain.com
   REASONATE_ASR_URL=http://127.0.0.1:8081/v1/audio/transcriptions
   REASONATE_TTS_URL=http://127.0.0.1:8880/v1/audio/speech
   MASTRA_MODEL=deepseek/deepseek-flash
   DEEPSEEK_API_KEY=sk-your-deepseek-api-key
   REASONATE_BUILD_SANDBOX_IMAGE=reasonate-build-sandbox:node22
   REASONATE_CHECKPOINT_ROOT=/opt/reasonate/checkpoints
   ```
   *(Note: Setting `NODE_ENV=staging` enables `createMagicLinkSender` to print sign-in callback links directly to the PM2 server logs for 1-click login without crashing on missing email keys).*

2. **Build and Start Monorepo Services via PM2**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @reasonateai/web build
   pnpm --filter @reasonateai/api build
   pnpm --filter @reasonateai/worker build

   sudo npm install -g pm2
   pm2 start "pnpm --filter @reasonateai/web start --port 3000" --name reasonate-web
   pm2 start "pnpm --filter @reasonateai/api start" --name reasonate-api
   pm2 start "pnpm --filter @reasonateai/worker start" --name reasonate-worker
   pm2 save
   ```

---

### Phase 5: Caddy Ingress & Unbuffered SSE Proxy (Day 3 — Oct 13 Morning)

Install Caddy 2 (`sudo apt install -y caddy`) and write `/etc/caddy/Caddyfile`:
```caddy
app.yourdomain.com {
    # Live SSE streaming & API routes (disable proxy buffering)
    handle /v1/* {
        reverse_proxy 127.0.0.1:4111 {
            flush_interval -1
        }
    }

    # Next.js Web Application
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```
Reload Caddy: `sudo systemctl reload caddy`.

---

### Phase 6: 12-Step MVP Acceptance Scenario Rehearsal (Day 3 — Oct 13 Afternoon)

Execute the complete end-to-end rehearsal from `.context/SPEC.md` §17–34:
1. Access `https://app.yourdomain.com` and trigger magic-link authentication.
2. Retrieve the generated login callback link from `pm2 logs reasonate-api` and complete sign-in.
3. Create organization and project.
4. Speak a web application concept via the microphone input (`POST /v1/voice/transcriptions`).
5. Upload a wireframe image sketch.
6. Approve the generated architecture plan (`submit_plan`).
7. Observe live streaming tokens and container creation in `apps/worker`.
8. Verify the running application renders in the live preview panel (`/v1/previews/:previewId/`).
9. Verify defect detection, repair, and test re-run.
10. Confirm Kokoro TTS audio completion playback.
11. Test Git checkpoint restore (`POST /v1/.../workspace/restore`).
12. Confirm persistent state survives browser refresh.

---

## 7. Third-Party Credentials Checklist for Leadership

- [ ] **Cloud / GPU Provider**: RunPod account with billing enabled (or Hetzner Cloud/Dedicated account).
- [ ] **DNS Access**: Cloudflare or Route53 management to set the `A` record for `app.yourdomain.com`.
- [ ] **LLM API Key**: DeepSeek platform account with API key funding ($10–$20 deposit).
- [ ] **Email Provider Key (Post-MVP)**: Resend API key for automated production email delivery.
- [ ] **Google Cloud OAuth (Optional for PR #45)**: Client ID and Secret for Google Sign-In.

---

## 8. Summary & Recommendation

* **Do Not Waste Capital on AWS/GCP**: Hyperscaler infrastructure will cost $950–$1,400/month in idle overhead without improving performance.
* **Adopt Tier 1 for October 13**: A single RunPod Secure Cloud GPU instance (RTX 4090/A5000) running local Dockerized Postgres, Redis, ASR, TTS, and the collocated API/Worker provides 100% feature coverage for **~$55 to $70/month**.
* **Transition to Tier 2 for Production Scale**: After the MVP demonstration, migrate to a Hetzner GEX45 bare-metal dedicated host (€214/month) with Supabase Pro and Cloudflare R2 for clean multi-tenant scaling.

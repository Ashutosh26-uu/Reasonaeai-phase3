# ReasonateAI — Architecture

Canonical architecture reference. [`SPEC.md`](./SPEC.md) is authoritative for the product contract and security invariants; [`PHASE.md`](./PHASE.md) is authoritative for current scope and status. This document explains **how the system is put together** and is updated when a boundary, deployment topology, or data flow changes.

### Status legend

| Marker | Meaning |
| --- | --- |
| ✅ | Implemented and verified by tests |
| 🟡 | Partially implemented |
| ⬜ | Designed, not yet built |

---

## 1. What the system does

ReasonateAI is an autonomous AI CTO. A non-technical user describes a product; the system specifies it, plans it, obtains approval, builds it in an isolated sandbox, verifies it in a real browser, repairs what fails, and deploys it to a shareable URL.

```mermaid
flowchart LR
    A["understand"] --> B["specify"] --> C["approve"] --> D["build"]
    D --> E["run"] --> F["inspect"] --> G["repair"] --> H["verify"] --> I["deploy"]
    G -.->|"rerun the exact failed scenario"| F
```

The product is **not** a code generator and **not** a coding TUI. The accountable differentiator is that it owns the lifecycle end to end and returns a running product at a URL.

---

## 2. System context

```mermaid
flowchart TB
    subgraph users["Users"]
        U1["Non-technical product owner"]
        U2["Reviewer / Viewer"]
    end

    subgraph reasonate["ReasonateAI"]
        WEB["apps/web<br/>Authenticated PWA"]
        API["apps/api<br/>Control plane + Mastra composition root"]
        WRK["Worker fleet<br/>Mastra runtime (private)"]
        VG["apps/voice-gateway<br/>ASR / TTS"]
    end

    subgraph data["Authoritative + durable state"]
        PG[("PostgreSQL<br/>commands, state, leases, ledger")]
        RD[("Redis 7 Streams<br/>transport")]
        OBJ[("Object storage<br/>immutable artifacts")]
        GIT[("Git<br/>source checkpoints")]
    end

    subgraph exec["Execution capacity"]
        SBX["Sandbox fleet<br/>isolated project workspaces"]
        BRW["Headless browser<br/>runtime verification"]
        PRE["Preview gateway<br/>opaque IDs, authorized"]
    end

    subgraph external["External providers"]
        LLM["Model router"]
        DEP["Deployment provider"]
        SRV["Speech providers"]
    end

    U1 --> WEB
    U2 --> WEB
    WEB -->|"HTTPS JSON + SSE"| API
    WEB -->|"WebSocket / WebRTC"| VG
    VG --> SRV
    WEB -->|"preview HTTPS"| PRE

    API --> PG
    API --> OBJ
    API -->|"transactional outbox"| RD
    RD --> WRK
    WRK --> PG
    WRK --> OBJ
    WRK --> LLM
    WRK --> SBX
    WRK --> BRW
    WRK --> GIT
    WRK --> DEP
    SBX --> PRE
    DEP -->|"stable product URL"| U1
```

**Public surfaces** are only `apps/web`, the authenticated `apps/api` product routes, the voice gateway, and authorized preview URLs. Everything else is private infrastructure with no inbound client traffic.

---

## 3. Control plane and execution plane

```mermaid
flowchart LR
    subgraph public["Public — authenticated"]
        B["Browser"]
    end

    subgraph control["Control plane ✅ (partially)"]
        API["apps/api"]
        AUTH["Session + authorization"]
        ROUTES["Product routes"]
        SSE["SSE event stream"]
    end

    subgraph transport["Transport"]
        REDIS[("Redis Streams")]
    end

    subgraph workers["Execution plane — private, outbound only"]
        W1["Worker replica 1"]
        W2["Worker replica 2"]
    end

    subgraph state["Durable state"]
        PG[("PostgreSQL")]
    end

    B -->|"cookie session"| API
    API --> AUTH --> ROUTES
    ROUTES -->|"transaction + outbox"| PG
    PG -->|"relay publishes"| REDIS
    REDIS -->|"XREADGROUP + consumer group"| W1
    REDIS --> W2
    W1 -->|"append events, hold lease"| PG
    PG --> SSE -->|"Last-Event-ID replay then live"| B
```

### Why this split exists

| Concern | Control plane | Execution plane |
| --- | --- | --- |
| Latency | Must answer in milliseconds | Runs for minutes |
| Scaling | Scales with users | Scales with concurrent builds |
| Blast radius | Public attack surface | Isolated, no inbound traffic |
| Failure mode | Restart is cheap | Must survive restarts mid-run |

**Mastra's documented topology supports this without a second application.** One Mastra codebase produces two artifacts:

```bash
mastra build                                    # → .mastra/output        API role
mastra worker build --output-dir .mastra/worker # → .mastra/worker        worker role
```

The same code runs as different container roles selected by `MASTRA_WORKERS`:

| Value | Role |
| --- | --- |
| `false` | API process; runs no workers |
| `orchestration` | Pulls workflow/step events; calls back over `MASTRA_STEP_EXECUTION_URL` |
| `backgroundTasks` | Runs background tool calls |
| `scheduler` | Single replica polling schedules |

Both roles share PostgreSQL and `RedisStreamsPubSub`. `apps/api/src/mastra` is therefore the composition root, not an application that owns agent logic. Agent policy lives in `packages/cto-runtime`.

---

## 4. Trust boundaries

```mermaid
flowchart TB
    subgraph z0["Untrusted"]
        BR["Browser input"]
        EXT["External content, generated code,<br/>worker output, web pages"]
    end

    subgraph z1["Authenticated boundary ✅"]
        COOKIE["Opaque cookie token"]
        PRIN["resolveSessionPrincipal<br/>revocation + expiry re-checked"]
    end

    subgraph z2["Authorized boundary ✅"]
        POLICY["Central deny-by-default policy<br/>principal + action + org + project"]
    end

    subgraph z3["Scoped execution ⬜"]
        GRANT["Short-lived workload grant"]
        SBXZ["Sandbox: no host socket,<br/>deny-by-default egress"]
    end

    subgraph z4["Brokered secrets ⬜"]
        SEC["Metadata only until<br/>approved for one operation"]
    end

    BR --> COOKIE --> PRIN --> POLICY --> GRANT --> SBXZ
    SEC -.->|"never into model context"| SBXZ
    EXT -.->|"data, never instructions"| SBXZ
```

**Invariants enforced at these boundaries**

- A session cookie is opaque; only its SHA-256 digest is stored.
- Revocation and expiry are re-checked where a cookie becomes a principal, not only in storage.
- Every tenant-owned row carries `organization_id` and `project_id`; queries never filter cross-tenant results in application code.
- Object keys and URLs are never proof of access; signed access is issued after authorization.
- Raw Mastra route groups are denied at ingress.

---

## 5. First request — allocation and reconnect

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as apps/api
    participant P as PostgreSQL
    participant R as Redis Streams
    participant W as Worker
    participant S as Sandbox

    B->>A: POST build session (cookie, idempotency key)
    A->>A: resolve principal, authorize org + project
    A->>P: BEGIN
    P->>P: idempotency key seen? -> return existing session
    P->>P: active session for project? -> adopt (reconnect)
    P->>P: else create session + run + sandbox record
    P->>P: append run.queued at sequence 1
    P->>P: write outbox row (same transaction)
    A->>P: COMMIT
    A-->>B: 202 with session + run ids

    B->>A: GET events (Last-Event-ID: 0)
    A->>P: read ledger after cursor
    A-->>B: replay persisted events
    A->>R: subscribe live

    Note over P,R: Relay publishes committed outbox rows
    R-->>W: XREADGROUP claim
    W->>P: acquire run lease (exactly one holder)
    W->>S: allocate or restore workspace
    W->>P: append sandbox.allocated
    P-->>A: live event
    A-->>B: streamed progress
```

**Why one active session per project:** a partial unique index enforces it, so a repeat request reconnects to the existing workspace instead of silently creating a second, disconnected project.

---

## 6. Run lifecycle and event flow

```mermaid
flowchart LR
    subgraph cmd["Command path"]
        C1["Browser command"] --> C2["Authorize"] --> C3["Transaction"] --> C4[("outbox")] --> C5["Relay"] --> C6[("Redis Stream")]
    end
    subgraph evt["Event path"]
        E1[("run_events ledger")] --> E2["SSE replay"] --> E3["Browser"]
        C6 --> E4["Worker consumer group"] --> E5["Execution"] --> E1
    end
```

The ledger is the record of user-visible truth. Redis carries messages; it never holds the only copy.

| Concern | Owner | Guarantee |
| --- | --- | --- |
| Command durability | PostgreSQL `outbox` | Written in the same transaction as the state change |
| Delivery | Redis Streams | At-least-once, with reclaim and a bounded attempt cap |
| Deduplication | Consumer, by `eventId` | `event_id` is `UNIQUE` in the ledger |
| Browser resume | `run_events` | Contiguous per-run `sequence` from 1; cursor `0` = from the start |
| Single runner | `run_leases` | One holder per run, with expiry |

---

## 7. Agent delegation

```mermaid
flowchart TB
    CTO["ReasonateAI CTO<br/>full approved capability surface<br/>owns completion"]
    SCOUT["Scout<br/>read-only"]
    CODER["Coder<br/>read + write + execute"]
    DBG["Debugger<br/>reproduce → repair → rerun"]
    CUS["Custom agent<br/>ephemeral, CTO-authored role"]

    CTO -->|"investigate"| SCOUT
    CTO -->|"implement / verify"| CODER
    CTO -->|"diagnose and fix"| DBG
    CTO -->|"purpose-built role"| CUS
    CTO -.->|"does work directly when that is faster"| CTO

    SCOUT -.->|"findings"| CTO
    CODER -.->|"changes + evidence"| CTO
    DBG -.->|"cause + before/after evidence"| CTO
    CUS -.->|"bounded result"| CTO
```

Frontend, backend, database, infrastructure, accessibility, security, and release engineering are **task objectives**, not permanent agent identities. Parallel work may share a project workspace only under task ownership and per-file mutation locks.

---

## 8. Storage model

```mermaid
flowchart TB
    subgraph mutable["Mutable — disposable"]
        WS["Sandbox workspace<br/>real filesystem"]
    end
    subgraph canon["Canonical — source of truth"]
        G[("Git checkpoints<br/>atomic, diffable, restorable")]
    end
    subgraph imm["Immutable — evidence and releases"]
        O[("Object storage<br/>digest-verified manifests")]
    end
    subgraph meta["Metadata — authoritative"]
        PG[("PostgreSQL<br/>who owns what, in what state")]
    end

    WS -->|"coherent change"| G
    WS -->|"screenshots, logs, traces"| O
    G -->|"recovery"| WS
    G -->|"accepted checkpoint"| REL["Release artifact"] --> O
    PG -.->|"references only"| WS
    PG -.->|"manifest keys + scope"| O
    PG -.->|"checkpoint ids"| G
```

A complex generated project is **never** a single database object. It is a filesystem, a Git history, and a set of immutable artifacts, with metadata and authorization in PostgreSQL.

---

## 9. Data model

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ PROJECTS : contains
    USERS ||--o{ AUTH_SESSIONS : holds
    PROJECTS ||--o{ BUILD_SESSIONS : owns
    BUILD_SESSIONS ||--|| SANDBOX_ENVIRONMENTS : allocates
    BUILD_SESSIONS ||--o{ RUNS : drives
    RUNS ||--o| RUN_LEASES : "leased to one worker"
    RUNS ||--o{ RUN_EVENTS : "sequenced ledger"
    RUNS ||--o{ OUTBOX : "pending transport"
    PROJECTS ||--o{ ARTIFACTS : produces
    PROJECTS ||--o{ DEPLOYMENTS : ships
    ORGANIZATIONS ||--o{ IDEMPOTENCY_RECORDS : dedupes

    BUILD_SESSIONS {
        uuid build_session_id PK
        uuid run_id
        uuid sandbox_environment_id
        text stage
        text status
    }
    RUNS {
        uuid run_id PK
        text status
        bigint next_sequence
    }
    RUN_EVENTS {
        uuid run_id PK
        bigint sequence PK
        uuid event_id UK
        text type
        jsonb payload
    }
    RUN_LEASES {
        uuid run_id PK
        uuid lease_id
        text holder
        timestamptz expires_at
    }
    AUTH_SESSIONS {
        uuid session_id PK
        text token_hash UK
        uuid user_id FK
        timestamptz idle_expires_at
        timestamptz absolute_expires_at
        timestamptz revoked_at
    }
```

Full DDL and the invariants it encodes are in [`../packages/project-state/src/schema.ts`](../packages/project-state/src/schema.ts) and [`../packages/project-state/src/session-schema.ts`](../packages/project-state/src/session-schema.ts).

---

## 10. Deployment topology

```mermaid
flowchart TB
    subgraph edge["Edge"]
        CDN["CDN + WAF"]
    end
    subgraph pub["Public"]
        APPR["api replicas<br/>MASTRA_WORKERS=false"]
        WEBR["web (static/PWA)"]
    end
    subgraph priv["Private network"]
        ORCH["orchestration workers"]
        BG["background-task workers"]
        SCH["scheduler<br/>exactly 1 replica"]
    end
    subgraph infra["Managed infrastructure"]
        PGM[("PostgreSQL + replicas")]
        RDM[("Redis + Sentinel/Cluster")]
        S3[("Object storage")]
    end
    CDN --> APPR
    CDN --> WEBR
    APPR --> PGM
    APPR --> RDM
    APPR --> S3
    ORCH --> PGM
    ORCH --> RDM
    ORCH --> S3
    BG --> PGM
    BG --> RDM
    SCH --> PGM
    SCH --> RDM
```

| Surface | Intent |
| --- | --- |
| `app.reasonate.ai` | Authenticated product |
| `api.reasonate.ai` | Control-plane API |
| `preview-<opaque-id>.preview.reasonate.ai` | Authorized sandbox preview |
| `<project>.reasonate.app` | Promoted user deployment |
| `agent-worker.internal` | Private, no inbound client traffic |

**Open item:** single Redis is a single point of failure. Sentinel or Cluster is required before production.

---

## 11. Component map

```mermaid
flowchart TB
    subgraph apps["apps/"]
        API["api ✅<br/>control plane, composition root,<br/>ingress denial, principal resolution"]
        WEB["web ⬜<br/>PWA"]
        WRK["worker ⬜<br/>optional non-Mastra jobs"]
        VGW["voice-gateway ⬜<br/>ASR / TTS"]
    end
    subgraph pkgs["packages/"]
        CON["contracts ✅<br/>schemas, identifiers,<br/>commands, events"]
        AUTH["auth ✅<br/>deny-by-default policy"]
        CTO["cto-runtime ✅<br/>CTO + worker profiles"]
        PS["project-state ✅<br/>PostgreSQL store,<br/>outbox relay, leases"]
        ART["artifact-store ⬜<br/>manifests, object storage"]
        SBX["sandbox ⬜<br/>provider contract"]
        VER["verification ⬜<br/>browser + evidence"]
        DEP["deployment ⬜<br/>preview + release"]
        RES["resource ⬜<br/>URI router"]
        EV["model-evals ⬜"]
        UI["ui ⬜"]
    end
    API --> CON
    API --> AUTH
    API --> CTO
    API --> PS
    WEB --> UI
    CTO --> CON
    PS --> CON
    VER --> SBX
    DEP --> ART
```

Per-component documentation: [`../docs/README.md`](../docs/README.md).

---

## 12. Security invariants

Non-negotiable, from [`SPEC.md`](./SPEC.md):

1. Generated code never receives host Docker sockets or control-plane credentials.
2. Untrusted execution uses deny-by-default or explicitly allowlisted egress.
3. Internal resources are scoped by user, organization, project, session, agent, and capability.
4. Path traversal and symlink escape are rejected.
5. Bundled skills and sealed artifacts are immutable.
6. Every state-changing tool call and security-sensitive action is auditable.
7. Tool retries, agent turns, process time, resource consumption, and spend are bounded.
8. Repeated identical behaviour triggers doom-loop protection.
9. External content is untrusted data, never instructions.
10. Authentication, authorization, secrets, audit, and tenant isolation cannot be bypassed for demonstrations.
11. Raw Mastra agent, controller, Studio, and worker routes are never publicly reachable.
12. A controller session is process-local convenience state, never an authorization or recovery authority.

---

## 13. Maintaining this document

Update this file when any of the following changes:

- A service boundary, deployment unit, or network topology.
- A trust boundary or an authorization decision point.
- A data flow between components.
- The storage model or the ownership of a data class.
- A component's implementation status in the legend.

Diagrams are Mermaid so they render in GitHub, Notion, and most reviewers. Keep them structural, not decorative: if a diagram would not catch a reviewer's mistake, it does not belong here.

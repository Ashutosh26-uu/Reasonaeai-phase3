# Local Development

**Status:** ✅ working
**Owner role:** Platform, DevEx & Security

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22.22 or newer | `engines.node` in the root manifest |
| pnpm | 10, pinned by `packageManager` | Use the pinned version; do not substitute npm or Yarn |
| Docker | Any recent version | Required for PostgreSQL and Redis integration tests |

---

## First-time setup

```bash
pnpm install --frozen-lockfile
```

`prepare` installs the Lefthook pre-commit hook automatically.

---

## Required services

Integration tests for `@reasonateai/project-state` require a real PostgreSQL and Redis. Without them those tests **skip**, and they must never be treated as passing.

```bash
docker run -d --name reasonate-pg \
  -e POSTGRES_PASSWORD=reasonate \
  -e POSTGRES_USER=reasonate \
  -e POSTGRES_DB=reasonate \
  -p 55432:5432 postgres:16-alpine

docker run -d --name reasonate-redis -p 56379:6379 redis:7-alpine
```

Non-default ports avoid colliding with anything already running locally.

```bash
export DATABASE_URL="postgres://reasonate:reasonate@127.0.0.1:55432/reasonate"
export REDIS_URL="redis://127.0.0.1:56379"
```

On PowerShell:

```powershell
$env:DATABASE_URL = "postgres://reasonate:reasonate@127.0.0.1:55432/reasonate"
$env:REDIS_URL = "redis://127.0.0.1:56379"
```

Tear down when finished:

```bash
docker stop reasonate-pg reasonate-redis
docker rm reasonate-pg reasonate-redis
```

---

## Commands

Start the web app, API, and worker together from the repository root. The
command loads `apps/api/.env`, seeds missing local settings, starts required
Docker services and waits for readiness. It then streams application logs;
Ctrl+C stops the applications. Database, Redis and mailbox containers retain
their data and remain available for subsequent starts.

```powershell
pnpm dev
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Prepare services, then run web (3219), API (4111), and worker |
| `pnpm dev --services-only` | Prepare and check configured services without launching applications |
| `pnpm smoke:dev` | Exercise fresh Docker services, repeat/restart recovery, retained data, and actual app startup on isolated ports |
| `pnpm install --frozen-lockfile` | Install exactly what the lockfile pins |
| `pnpm check` | Formatting and linting across the repository |
| `pnpm fix` | Apply safe formatting and lint fixes |
| `pnpm typecheck` | Type checking across all packages |
| `pnpm test` | Run every package's tests |
| `pnpm build` | Build every package and the Mastra artifact |

Scoped variants:

```bash
pnpm --filter @reasonateai/project-state test
pnpm --filter @reasonateai/api run dev
pnpm --filter @reasonateai/contracts build
pnpm --filter @reasonateai/api smoke:checkpoint
```

`pnpm dev` builds a missing repository-owned sandbox image automatically. To
prepare it separately:

```sh
docker build -f services/build-sandbox/Dockerfile -t reasonate-build-sandbox:node22 services/build-sandbox
```

The image includes Node.js 22, Python 3.11, Go 1.27.1, and an offline npm cache. Its hash-locked Python baseline provides NumPy/pandas, FastAPI/Uvicorn with upload support, Matplotlib/Seaborn/Plotly, Pillow for common raster-image work, openpyxl for XLSX, reportlab/pypdf/pdfplumber for PDF authoring and inspection, python-docx for Word documents, and pytest/httpx/Ruff. Matplotlib uses the headless Agg backend. These packages are baked into the image, so sandbox startup does not install dependencies. A project that needs its own Python environment can inherit them with `python -m venv --system-site-packages .venv`; SciPy/scikit-learn, OpenCV, Jupyter, and deep-learning frameworks are deliberately not preloaded. The image also carries an optional Next.js/React/Tailwind/Vitest starter with dependencies installed; it does not choose or scaffold a stack. Use its files only when a new project explicitly uses Next.js. API and worker must use the same image reference through `REASONATE_BUILD_SANDBOX_IMAGE`. `smoke:checkpoint` needs Docker and this image: it snapshots a real workspace, destroys the sandbox and its volume, restores into a fresh sandbox, reads the files and history back, and proves a failed snapshot keeps the volume.

---

## Environment reference

| Variable | Used by | Effect when unset |
| --- | --- | --- |
| `DATABASE_URL` | `@reasonateai/project-state` tests, `apps/api`, `apps/worker` | Tests skip; the API and worker cannot start |
| `REDIS_URL` | `@reasonateai/project-state`, `apps/api`, `apps/worker` | Tests skip; the API keeps its last-computed rate-limit decisions and cannot fan out run events, and the worker logs `run.live.disabled` and executes runs without publishing live deltas |
| `TURSO_DATABASE_URL` | `apps/api` storage | Falls back to a local SQLite file |
| `TURSO_AUTH_TOKEN` | `apps/api` storage | No auth token |
| `DEEPSEEK_API_KEY` | Model router | Required before a real run can execute |
| `REASONATE_PUBLIC_ORIGIN` | `apps/api` | The origin a sign-in link points back at; defaults to the dev server's own address |
| `REASONATE_ALLOWED_ORIGINS` | `apps/api` | Origins allowed to make state-changing browser requests; a mismatched origin is refused |
| `SESSION_SECRET` | `apps/api` | Signing key for the CSRF pair; identity routes refuse to run without it |

Never commit a `.env` file. `.env` and `.env.*` are ignored, with `.env.example` as the documented template.

Launch identity uses configured Resend email delivery and Google OIDC. Development can use an explicitly labelled loopback Mailpit inbox; production cannot. See [authentication setup and activation](authentication.md) for provider variables, public-origin requirements, schema version 9 recovery, and verification boundaries. Use a separate database for tests when an API outbox relay is running.

### Automatic development bootstrap

Install Docker Desktop (or a local Docker engine) and the frozen workspace dependencies, then run `pnpm dev`. A fresh checkout needs no manually created database or mail container. Missing settings are saved in ignored `apps/api/.env`: development mode, a local PostgreSQL URL with a random password, Redis, Mailpit, origins, and random session/artifact signing secrets. Existing values are preserved. An empty inherited override of a saved setting is refused; remove that override rather than rotating a saved secret accidentally. Copying the example is optional; its blank database and secret fields are filled on first startup. Configure the approved model credentials separately before executing model work.

The default local ports are PostgreSQL 55432, Redis 56379 and Mailpit 58027. The mailbox at `http://localhost:58027` receives actual development sign-in and sign-up links without delivering email externally. `NODE_ENV=development` is required; the bootstrap rejects production/test mode and remote Docker contexts. Existing healthy host services are reused. Existing compatible containers are selected by configured loopback port, started if stopped, and never replaced. New containers use persistent named volumes and loopback bindings. PostgreSQL is checked with the configured credentials, Redis with PING, Mailpit through `/livez`, and the web process waits for the API's health response. A conflicting port, incorrect saved database password, unavailable custom image or other prerequisite stops startup with an actionable message. Correct the configuration and rerun; never delete user volumes to repair startup. Docker command diagnostics retain their cause internally without printing environment values.

Only configured speech endpoints are checked/started: `REASONATE_ASR_URL` for recognition and `REASONATE_TTS_URL` (or `TTS_URL`) for playback. Healthy endpoints are reused. Unavailable local HTTP endpoints start the checked-in Compose stacks with the configured port and wait for semantic readiness. Remote endpoints are checked without changing infrastructure. Recognition needs exactly one model GGUF and one `mmproj` GGUF in `R2T2_GGUF_DIR`, plus a supported NVIDIA GPU; the bootstrap does not download recognition weights. Kokoro retains its named model cache and can download its documented weights on first start. Configure local speech ports before starting a stack: existing containers are not recreated to change their bindings. See the [recognition](../../services/r2t2-asr/README.md) and [playback](../../services/kokoro-tts/README.md) prerequisites.

`REASONATE_WEB_PORT` changes the frontend port; missing origins use that value. Set `PORT` and `REASONATE_API_ORIGIN` together if replacing the API address. For an isolated invocation, `REASONATE_DEV_ENV_FILE` selects an ignored file inside the checkout. Its resolved configuration is inherited by all three applications. Startup unit regressions run as part of `pnpm test`; `pnpm smoke:dev` creates fresh dependencies on unused ports and removes only its own test containers/volumes. It does not stop the user's Docker engine or active application. Integration tests still need an explicitly isolated database/Redis environment; `pnpm test` never adopts the application's `.env` automatically.

The API's development launcher passes an env-file flag only when `apps/api/.env` exists. Isolated invocations inherit their prepared configuration instead; this avoids Node 22 Linux watch mode attempting to watch a missing optional file. Development output uses [Turborepo's streaming log order](https://turborepo.dev/docs/reference/run#--log-order-option) so persistent tasks expose readiness immediately even in CI; grouped output waits for a task to exit. Startup smoke failures retain bounded diagnostics with configured values, URL credentials and short sensitive values redacted.

Rollback is restoring the previous startup/manifests and rendering styles. Generated local `.env` settings and retained service volumes remain usable with manually started services; no database migration or published-package version change is introduced. Startup uses Node's [parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent), Docker's [Desktop start](https://docs.docker.com/reference/cli/docker/desktop/start/) and [Compose readiness](https://docs.docker.com/reference/cli/docker/compose/up/) contracts without a new dependency.

### Live streaming needs a current worker

Model text reaches a browser as live deltas published by the **worker** that claims the run, onto a bounded `reasonateai.run.live.<runId>` topic. A worker built before that publisher existed still executes runs correctly, but its runs show only durable events and tool activity — no streamed text. After pulling a change to the worker, restart it; `tsx src/main.ts` loads its source once and does not watch for changes.

---

## Caching behaviour

Two deliberate exceptions to normal Turborepo caching:

| Task | Behaviour | Why |
| --- | --- | --- |
| `@reasonateai/api#build` | Cache disabled | Mastra runs a package install into its output; caching it archived symlinked `node_modules` and could restore an artifact with no dependencies |
| `test` | Keyed on `DATABASE_URL` and `REDIS_URL` | Without this, a run with no services cached its result and later runs replayed skipped integration tests as a passing gate |

To confirm:

```bash
pnpm exec turbo run build --dry=json
```

If a cached result looks wrong, clear it:

```bash
rm -rf .turbo apps/api/.turbo packages/*/.turbo
```

---

## Git hooks

Lefthook runs Ultracite on staged files before each commit:

```yaml
pre-commit:
  commands:
    ultracite:
      glob: "*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc}"
      run: pnpm exec ultracite check {staged_files}
```

Formatting and linting are owned by Ultracite and Biome. Do not add ESLint, Prettier, or a competing formatter.

---

## Working conventions

- Work on a focused feature branch. Never push directly to the default branch.
- Commit in coherent units with a Conventional Commit subject and an explicit workspace scope.
- Run `pnpm check`, `pnpm typecheck`, and the affected package's tests before committing.
- Skip formatters, linters, and full suites inside subagent or parallel work streams; run them once at the end.

---

## Troubleshooting

### Pending-question schema recovery

Schema version 4 adds `runs.pending_tool_call_id`, `pending_mastra_run_id`, `pending_answer`, and `pending_answered_by`, and widens the one-active-run project index to include `awaiting_approval`. The migration is additive except for replacing that index, and `store.migrate()` applies it under the existing advisory lock. A deployment should migrate before starting the updated API and worker. A replacement worker needs the same Mastra storage and the retained named Docker workspace volume to resume a suspended question; it removes only the abandoned container before remounting that volume.

If this release must be rolled back, first stop new run admission and let live questions resolve or cancel them while the updated worker is still running. Confirm there are no `awaiting_approval` rows, then stop workers and restore the previous application artifact. The added columns can remain unused; they do not need to be dropped to restore the old application. Only after pending runs are cleared should an operator replace `runs_one_active_project_idx` with the previous `runs_one_running_project_idx` (`where status = 'running'`). Preserve the database and sandbox volumes if a pending worker crashed; do not delete them as a rollback shortcut.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot proceed with the frozen installation` | The catalog or a dependency changed | `pnpm install --no-frozen-lockfile`, then commit the lockfile |
| `Cannot find package '@reasonateai/…'` | A workspace dependency is not declared, or the package is not built | Declare it in the consuming manifest; run `turbo run test`, which builds dependencies first |
| `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` | Concurrent DDL from two processes | Expected to be prevented by the migration advisory lock; the migration also retries, so report it if it reappears |
| `deadlock detected` while applying a migration | A migration needs an access-exclusive lock, and a writer that holds a read lock while it upgrades past that queued request deadlocks with it | Expected to resolve: the migration waits a bounded time for the lock and retries. A persistent failure means a long-running writer holds the table |
| `deadlock detected` from integration-test teardown | Every database-backed suite shares one PostgreSQL instance and deletes its fixtures concurrently; the cascade takes the same tables in the opposite order | The teardown retries transient lock conflicts. If a suite still fails this way, re-run it and record the interleaving |
| Sandbox creation cannot find the configured image | The build sandbox image was not built or the API and worker use different references | Build the documented `reasonate-build-sandbox:node22` image and set the same `REASONATE_BUILD_SANDBOX_IMAGE` in both services |
| First sandbox run takes minutes | The Node.js base image and app starter cache are large and need a first pull/build | Build the sandbox image once before launching local services; subsequent sandboxes use the local image |
| Type tests skip silently | `DATABASE_URL` or `REDIS_URL` unset | Export both, then re-run |
| Docker-related test failures | Docker daemon not running | Start Docker Desktop and re-run |
| Docker-backed suite fails only when the whole gate runs | `apps/api` and `packages/sandbox` each start real containers, and the daemon can refuse a start while the other package is churning containers. Both packages run their test files one at a time for this reason | Re-run the gate, or serialize the packages: `pnpm exec turbo run test --concurrency=1` |

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
command loads `apps/api/.env` when present, streams each service's logs in the
terminal, and Ctrl+C stops all three processes. PostgreSQL and Redis must be
running first.

```powershell
pnpm dev
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the web app on port 3219, the API on port 4111, and the worker together |
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

Build the shared API/worker sandbox image before starting local services:

```sh
docker build -f services/build-sandbox/Dockerfile -t reasonate-build-sandbox:node22 services/build-sandbox
```

The image includes Node.js 22, Python 3.11, Go 1.27.1, and an offline npm cache. Its hash-locked Python baseline provides NumPy/pandas, FastAPI/Uvicorn with upload support, Matplotlib/Seaborn/Plotly, Pillow for common raster-image work, openpyxl for XLSX, and pytest/httpx/Ruff. Matplotlib uses the headless Agg backend. These packages are baked into the image, so sandbox startup does not install dependencies. A project that needs its own Python environment can inherit them with `python -m venv --system-site-packages .venv`; SciPy/scikit-learn, OpenCV, Jupyter, and deep-learning frameworks are deliberately not preloaded. The image also carries an optional Next.js/React/Tailwind/Vitest starter with dependencies installed; it does not choose or scaffold a stack. Use its files only when a new project explicitly uses Next.js. API and worker must use the same image reference through `REASONATE_BUILD_SANDBOX_IMAGE`. `smoke:checkpoint` needs Docker and this image: it snapshots a real workspace, destroys the sandbox and its volume, restores into a fresh sandbox, reads the files and history back, and proves a failed snapshot keeps the volume.

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

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

| Command | Purpose |
| --- | --- |
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

`smoke:checkpoint` is the one check that needs Docker and the `node:22` image: it snapshots a real workspace, destroys the sandbox and its volume, restores into a fresh sandbox, reads the files and history back, and proves a failed snapshot keeps the volume.

---

## Environment reference

| Variable | Used by | Effect when unset |
| --- | --- | --- |
| `DATABASE_URL` | `@reasonateai/project-state` tests | Tests skip |
| `REDIS_URL` | `@reasonateai/project-state` tests | Tests skip |
| `TURSO_DATABASE_URL` | `apps/api` storage | Falls back to a local SQLite file |
| `TURSO_AUTH_TOKEN` | `apps/api` storage | No auth token |
| `DEEPSEEK_API_KEY` | Model router | Required before a real run can execute |

Never commit a `.env` file. `.env` and `.env.*` are ignored, with `.env.example` as the documented template.

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

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot proceed with the frozen installation` | The catalog or a dependency changed | `pnpm install --no-frozen-lockfile`, then commit the lockfile |
| `Cannot find package '@reasonateai/…'` | A workspace dependency is not declared, or the package is not built | Declare it in the consuming manifest; run `turbo run test`, which builds dependencies first |
| `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` | Concurrent DDL from two processes | Expected to be prevented by the migration advisory lock; the migration also retries, so report it if it reappears |
| `deadlock detected` while applying a migration | A migration needs an access-exclusive lock, and a writer that holds a read lock while it upgrades past that queued request deadlocks with it | Expected to resolve: the migration waits a bounded time for the lock and retries. A persistent failure means a long-running writer holds the table |
| `deadlock detected` from integration-test teardown | Every database-backed suite shares one PostgreSQL instance and deletes its fixtures concurrently; the cascade takes the same tables in the opposite order | The teardown retries transient lock conflicts. If a suite still fails this way, re-run it and record the interleaving |
| `sh: 1: git: not found` inside a sandbox | The sandbox image carries no git, and checkpoints are Git bundles | The build sandbox uses `node:22`, not a `-slim` image. A purpose-built image must include git |
| First sandbox run takes minutes | `node:22` is a large image and is pulled on first use | Pull it once (`docker pull node:22`); it is cached afterwards |
| Type tests skip silently | `DATABASE_URL` or `REDIS_URL` unset | Export both, then re-run |
| Docker-related test failures | Docker daemon not running | Start Docker Desktop and re-run |
| Docker-backed suite fails only when the whole gate runs | `apps/api` and `packages/sandbox` each start real containers, and the daemon can refuse a start while the other package is churning containers. Both packages run their test files one at a time for this reason | Re-run the gate, or serialize the packages: `pnpm exec turbo run test --concurrency=1` |

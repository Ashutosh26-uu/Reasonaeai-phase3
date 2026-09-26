# @reasonateai/worker

The private execution plane. It is the process that turns a durable run into
work: it discovers a runnable run in PostgreSQL, claims it under a lease,
restores the project's workspace from its latest Git checkpoint, drives the run
through the ReasonateAI CTO runtime, appends every durable event to the run's
ledger, snapshots the workspace, and ends the run.

It is not a public surface. It receives no browser traffic and holds no user
session; the run row it claims is its whole authority, and the sandbox it starts
has no network.

## Running it

```bash
pnpm --filter @reasonateai/worker start          # built entry point (dist/main.js)
pnpm --filter @reasonateai/worker dev            # tsx, for local iteration
pnpm --filter @reasonateai/worker test           # real PostgreSQL, Redis, and Docker
```

`start` requires a build (`pnpm --filter @reasonateai/worker build`); `test` and
the package's `pretest` build the workspace dependencies it imports.

The worker does **not** apply migrations. Schema changes are a separately
observable deployment step, so the database must already carry
`@reasonateai/project-state`'s schema before a worker starts.

## Configuration

All configuration is environment-only; there is no config file and no secret is
read from disk.

| Variable | Default | Bound | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | — (required) | — | PostgreSQL that owns commands, leases, and the ledger. Never logged. |
| `REDIS_URL` | store default | — | Redis used by the store's rate-limit counters. |
| `MASTRA_MODEL` | `deepseek/deepseek-flash` | — | Model the CTO runs on. |
| `REASONATE_CHECKPOINT_ROOT` | `~/.reasonateai/checkpoints` | — | Host directory holding every tenant's Git checkpoint bundles. |
| `WORKER_HOLDER` | generated | 1–128 chars | Identity written to `run_leases.holder`. Generated per process as `worker-<host>-<pid>-<random>`. |
| `WORKER_LEASE_TTL_MS` | 60000 | 1000–3600000 | Lease lifetime a claim takes. |
| `WORKER_RENEW_INTERVAL_MS` | 15000 | 100–600000 | Renewal period; three renewals must fit inside the TTL. |
| `WORKER_POLL_INTERVAL_MS` | 1000 | 200–300000 | Base poll interval. |
| `WORKER_POLL_JITTER_MS` | 250 | 0–60000 | Random addition to each interval, so workers do not synchronize. |
| `WORKER_MAX_RUNS_PER_POLL` | 1 | 1–32 | Candidates claimed per poll. One run executes at a time regardless. |
| `WORKER_STOP_GRACE_MS` | 5000 | 100–120000 | How long an aborted step may take to settle before teardown proceeds. |
| `WORKER_SHUTDOWN_GRACE_MS` | 30000 | 1000–300000 | How long SIGINT/SIGTERM may take to end the run in flight. |
| `WORKER_LOG_LEVEL` | info | debug/info/warn/error | Structured log threshold. |

An incoherent configuration is refused at startup with the offending field
named: a renewal interval that cannot fit three renewals inside the lease TTL,
or a stop window longer than the shutdown window, is a configuration that cannot
hold the lease it takes.

## What one run does

1. **Claim.** `listRunnableRuns` returns runs that are not terminal and carry no
   live lease. For each candidate, `beginRun` takes the lease and moves the run
   to `running` in one conditional write. Two workers polling the same run
   therefore produce exactly one execution; the loser returns without a single
   side effect.
2. **Scope.** The four `run-scope` keys (`reasonateai.organizationId`,
   `reasonateai.projectId`, `reasonateai.buildSessionId`, `reasonateai.runId`)
   are copied from the run row into a fresh `RequestContext`. Nothing is
   invented: the runtime resolves the sandbox, the resource router, and the
   memory resource from those keys.
3. **Workspace.** The build workspace resolves the run's Docker sandbox
   (identified by organization, project, and build session) and starts it. The
   project's latest checkpoint is restored into it, so a run continues from the
   project's accepted state rather than from an empty volume.
4. **Drive.** A CTO runtime is built for this run (`controller.init()` →
   `createSession({ requestContext, resourceId: projectId, scope:
   buildSessionId })`), the session's events are subscribed, and the run's
   directive is sent. Every controller event the runtime considers durable is
   mapped through `@reasonateai/cto-runtime/run-events` and appended with
   `appendRunEvent`; the store allocates the sequence and writes the outbox row
   in the same transaction, so the ledger is the record and the outbox is what
   makes the event publishable to Redis.
5. **Renew.** The lease is renewed on an interval while the run works. A refused
   renewal, or a renewal that fails with the lease about to lapse, is a stop
   condition: the step is aborted, the run is ended, and the worker stops
   claiming that run.
6. **Finish.** The workspace is snapshotted into a Git bundle, the sandbox is
   destroyed, the workspace volume is removed — but only once the checkpoint has
   been written — and then the run is moved to its terminal status. State first,
   status last: nothing is acknowledged before it is durable.

Outcomes: `succeeded` → `completed`, `failed` → `failed`, `cancelled` →
`cancelled`.

## Guarantees

- **One execution per run.** The lease is taken by one conditional write; only
  the winner proceeds. `run.claimed` appears exactly once per attempt.
- **Never running without a lease.** Every path after a claim ends the run: a
  failed command, a lost lease, and a shutdown each record their reason and
  finish the run. The only way a run stays `running` is a holder that still owns
  a live lease.
- **Never ack before durable.** The ledger append that records an outcome
  happens before `finishRun`; a successful run's `run.completed` event carries
  the checkpoint it wrote.
- **Monotonic ledger.** Appends are serialized per run and sequenced by the
  store inside the append transaction, so a retried run adds new sequences
  rather than repeating one.
- **No leaked infrastructure.** The container is destroyed on every terminal
  path. The workspace volume is removed once the checkpoint is written, and kept
  when it is not (a failed snapshot) or when the lease moved to another worker,
  because in both cases the volume holds the only copy of the run's work.
- **Nothing secret is logged.** Log lines carry organization, project, build
  session, and run identity plus primitives; prompts, tool output, and provider
  bodies have no path into the logger, and a field named after a credential is
  redacted even if a caller passes one.

## Known limits

- **A killed worker leaves a run claimable, not recovered.** If the process dies
  without unwinding (SIGKILL, power loss), the run stays `running` with a lapsed
  lease. `listRunnableRuns` treats "no live lease" as runnable, so the next
  worker claims it once the lease expires; there is no sweeper, which is why the
  lease is the only clock that matters.
- **One run at a time per worker.** The sandbox identity is derived from
  organization, project, and build session, so two concurrent runs of one build
  session would contend for one container name and one workspace volume.
  Parallelism belongs at the worker-fleet level.
- **The outbox relay is not run here.** The worker writes the outbox row that
  makes an event publishable; publishing to the run's Redis stream is the
  relay's job and is not started by this process.
- **A run's directive is not a stored prompt.** A run row carries identity and
  sandbox facts, not an objective, so the worker sends a fixed run directive and
  the CTO's own instructions, project memory, and restored checkpoint carry the
  work. When a durable command payload exists, this is where it belongs.

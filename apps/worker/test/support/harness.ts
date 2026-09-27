import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import type { BuildSessionId } from "@reasonateai/contracts/execution";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type ProjectId,
  ProjectIdSchema,
  SessionIdSchema,
} from "@reasonateai/contracts/identity";
import { runScopeKeys } from "@reasonateai/cto-runtime/run-scope";
import {
  createProjectStateStore,
  type ProjectStateStore,
  type RunnableRun,
  type TenantScope,
} from "@reasonateai/project-state/postgres";
import {
  type CheckpointStore,
  createGitCheckpointStore,
} from "@reasonateai/sandbox/checkpoint";
import { Pool } from "pg";
import { RunExecutor } from "../../src/executor.js";
import { createLedger } from "../../src/ledger.js";
import { createLogger } from "../../src/logger.js";
import { candidateScope } from "../../src/run-context.js";
import type { RunRuntime, RunSession } from "../../src/runtime.js";
import {
  resolveBuildSandbox,
  workspaceVolumeName,
} from "../../src/workspace.js";

/**
 * The fixtures these suites run against.
 *
 * Everything the acceptance criteria call real is real here: PostgreSQL holds
 * the run, the lease, and the ledger; Docker starts the sandbox and its named
 * volume; the checkpoint store writes Git bundles. Only the agent is scripted —
 * a deterministic controller session is what makes lease contention, renewal
 * loss, and shutdown reproducible instead of dependent on a model.
 */

const execFileAsync = promisify(execFile);

export interface RunFixture {
  buildSessionId: BuildSessionId;
  candidate: RunnableRun;
  organizationId: OrganizationId;
  projectId: ProjectId;
  scope: TenantScope;
  volume: string;
}

export interface Harness {
  checkpoints: CheckpointStore;
  /** Removes the fixtures this harness created, and nothing else. */
  cleanup: () => Promise<void>;
  dispose: () => Promise<void>;
  logger: ReturnType<typeof createLogger>;
  logs: () => string[];
  pool: Pool;
  /** Records a tenant this harness created, so cleanup removes only those. */
  registerOrganization: (organizationId: OrganizationId) => void;
  store: ProjectStateStore;
}

export async function createHarness(input: {
  connectionString: string;
}): Promise<Harness> {
  const pool = new Pool({ connectionString: input.connectionString });
  const store = createProjectStateStore({
    connectionString: input.connectionString,
  });
  await store.migrate();

  const checkpointRoot = await mkdtemp(join(tmpdir(), "reasonate-worker-"));
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => {
      lines.push(line);
    },
  });
  const createdOrganizations = new Set<string>();

  return {
    checkpoints: createGitCheckpointStore({ root: checkpointRoot }),
    cleanup: async () => {
      if (createdOrganizations.size === 0) {
        return;
      }
      await pool.query(
        "delete from organizations where organization_id = any($1::uuid[])",
        [[...createdOrganizations]]
      );
      createdOrganizations.clear();
    },
    dispose: async () => {
      await store.close();
      await pool.end();
      await rm(checkpointRoot, { force: true, recursive: true });
    },
    logger,
    logs: () => lines,
    pool,
    registerOrganization: (organizationId) => {
      createdOrganizations.add(organizationId);
    },
    store,
  };
}

/**
 * A build session allocated the way the API allocates one, so the run the worker
 * claims is the same kind of row a real dispatch produces.
 */
export async function allocateRunFixture(
  harness: Harness
): Promise<RunFixture> {
  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const scope: TenantScope = { organizationId, projectId };

  await harness.pool.query(
    "insert into organizations (organization_id, name) values ($1, 'Worker test')",
    [organizationId]
  );
  await harness.pool.query(
    "insert into projects (project_id, organization_id, name) values ($1, $2, 'Worker project')",
    [projectId, organizationId]
  );
  harness.registerOrganization(organizationId);

  const allocation = await harness.store.allocateBuildSession({
    idempotencyKey: `worker-test-${randomUUID()}`,
    scope,
    userSessionId: SessionIdSchema.parse(randomUUID()),
  });

  const { runId } = allocation.buildSession;
  const candidate = (await harness.store.listRunnableRuns({ limit: 32 })).find(
    (run) => run.runId === runId
  );
  if (candidate === undefined) {
    throw new Error(
      "The run allocated for this fixture is not runnable, so no worker could discover it."
    );
  }

  return {
    buildSessionId: allocation.buildSession.buildSessionId,
    candidate,
    organizationId,
    projectId,
    scope,
    volume: workspaceVolumeName(candidateScope(candidate)),
  };
}

export function createExecutor(input: {
  harness: Harness;
  holder: string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  runtime: RunRuntime;
  /** Overrides the store, so a suite can make one operation refuse. */
  store?: ProjectStateStore;
}): RunExecutor {
  const leaseTtlMs = input.leaseTtlMs ?? 60_000;
  const renewIntervalMs = input.renewIntervalMs ?? leaseTtlMs / 4;
  const store = input.store ?? input.harness.store;
  return new RunExecutor({
    checkpoints: input.harness.checkpoints,
    config: {
      holder: input.holder,
      leaseTtlMs,
      renewIntervalMs,
      stopGraceMs: 2000,
    },
    ledger: createLedger({ store }),
    logger: input.harness.logger,
    resolveSandbox: async ({ requestContext }) =>
      await resolveBuildSandbox({ requestContext }),
    runtime: () => input.runtime,
    store,
  });
}

/**
 * The store as one suite needs it.
 *
 * A worker that claims any runnable run in the database is correct in
 * production and hostile in a test: a shared development database holds other
 * suites' fixtures, and a poll would claim those instead. This scopes discovery
 * to the tenant under test and leaves every other operation on the real store.
 */
export function storeScopedTo(input: {
  harness: Harness;
  organizationId: OrganizationId;
}): ProjectStateStore {
  const limitPerRead = 64;
  return {
    ...input.harness.store,
    listRunnableRuns: async ({ limit }) =>
      (await input.harness.store.listRunnableRuns({ limit: limitPerRead }))
        .filter((run) => run.organizationId === input.organizationId)
        .slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// The scripted controller
// ---------------------------------------------------------------------------

type SessionSendInput = Parameters<RunSession["sendMessage"]>[0];

export interface SessionScript {
  /** Events the agent emits while it works, in order. */
  events?: AgentControllerEvent[];
}

/**
 * A controller session that follows a script.
 *
 * It implements the same seam the CTO session satisfies: listeners receive
 * events in order, `abortRun` settles the step it interrupted the way an aborted
 * stream does, and the run ends when the script says so rather than when a model
 * decides. The four run-scope keys are required on the message, so a worker that
 * forgot to derive them from the run row fails here instead of inside a tool.
 */
export class ScriptedSession implements RunSession {
  aborted = false;
  readonly events: AgentControllerEvent[];
  readonly started: Promise<void>;
  sendCalls = 0;

  #fail: ((error: Error) => void) | undefined;
  #finish: (() => void) | undefined;
  readonly #listeners = new Set<(event: AgentControllerEvent) => void>();
  readonly #markStarted: () => void;

  constructor(script: SessionScript = {}) {
    this.events = script.events ?? [];
    // The repository's compiler target is ES2023, which does not declare
    // `Promise.withResolvers`, so the resolver is taken from the executor.
    const waiters: Array<() => void> = [];
    this.started = new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    this.#markStarted = () => {
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    };
  }

  abortRun = (): void => {
    this.aborted = true;
    this.#finish?.();
  };

  sendMessage = (input: SessionSendInput): Promise<void> => {
    this.sendCalls += 1;
    const { requestContext } = input;
    if (requestContext === undefined) {
      return Promise.reject(
        new Error("A run session must be sent its verified scope.")
      );
    }
    for (const key of Object.values(runScopeKeys)) {
      if (requestContext.getRaw(key) === undefined) {
        return Promise.reject(
          new Error(`The session scope is missing ${key}.`)
        );
      }
    }

    for (const event of this.events) {
      this.#emit(event);
    }
    this.#markStarted();

    return new Promise<void>((resolve, reject) => {
      this.#finish = resolve;
      this.#fail = reject;
    });
  };

  subscribe = (
    listener: (event: AgentControllerEvent) => void
  ): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Ends the scripted run, emitting the controller's closing events first. */
  complete(closing: AgentControllerEvent[] = []): void {
    for (const event of closing) {
      this.#emit(event);
    }
    this.#finish?.();
  }

  /** Fails the scripted run the way a provider call fails. */
  crash(message: string): void {
    this.#fail?.(new Error(message));
  }

  #emit(event: AgentControllerEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

export interface ScriptedRuntime {
  readonly initCalls: () => number;
  readonly runtime: RunRuntime;
  readonly sessions: ScriptedSession[];
  /** Resolves with the next session this runtime hands out, or the first already made. */
  readonly waitForSession: () => Promise<ScriptedSession>;
}

/** A runtime that hands out one scripted session per run and counts its use. */
export function scriptedRuntime(script: SessionScript = {}): ScriptedRuntime {
  const sessions: ScriptedSession[] = [];
  const waiting: Array<(session: ScriptedSession) => void> = [];
  let initCalls = 0;

  return {
    initCalls: () => initCalls,
    runtime: {
      controller: {
        createSession: () => {
          const session = new ScriptedSession(script);
          sessions.push(session);
          for (const resolve of waiting.splice(0)) {
            resolve(session);
          }
          return Promise.resolve(session);
        },
        init: () => {
          initCalls += 1;
          return Promise.resolve();
        },
      },
    },
    sessions,
    waitForSession: async () => {
      const [existing] = sessions;
      if (existing !== undefined) {
        return existing;
      }
      return await new Promise<ScriptedSession>((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Docker facts
// ---------------------------------------------------------------------------

async function dockerLines(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim().split("\n").filter(Boolean);
}

/** Containers still mounting a run's workspace volume. */
export async function containerCount(volume: string): Promise<number> {
  return (await dockerLines(["ps", "-a", "-q", "--filter", `volume=${volume}`]))
    .length;
}

export async function volumeCount(volume: string): Promise<number> {
  return (
    await dockerLines(["volume", "ls", "-q", "--filter", `name=^${volume}$`])
  ).length;
}

/** Removes whatever a failed assertion left behind, by exact name. */
export async function removeRunArtifacts(volume: string): Promise<void> {
  const containers = await dockerLines([
    "ps",
    "-a",
    "-q",
    "--filter",
    `volume=${volume}`,
  ]);
  if (containers.length > 0) {
    await execFileAsync("docker", ["rm", "-f", "-v", ...containers]);
  }
  await execFileAsync("docker", ["volume", "rm", "-f", volume]).catch(
    () => undefined
  );
}

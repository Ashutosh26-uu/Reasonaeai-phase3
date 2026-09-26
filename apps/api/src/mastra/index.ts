import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";
import {
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import {
  SessionIdSchema,
  UserIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { createMockProjectStateStore } from "./mock-store.js";
import { frontierModel } from "./model.js";
import { resolveSessionPrincipal } from "./principal.js";
import {
  BUILD_SESSION_COLLECTION_PATH,
  BUILD_SESSION_ITEM_PATH,
  createBuildSessionHandlers,
} from "./routes/build-sessions.js";
import {
  CHECKPOINT_RESTORE_PATH,
  CHECKPOINTS_BUILD_SESSION_PATH,
  createCheckpointHandlers,
} from "./routes/checkpoints.js";
import {
  createDeploymentHandlers,
  DEPLOYMENT_ROLLBACK_PATH,
  PROJECT_DEPLOYMENTS_PATH,
} from "./routes/deployments.js";
import {
  ARTIFACT_ITEM_PATH,
  createEvidenceHandlers,
  PROJECT_EVIDENCE_PATH,
} from "./routes/evidence.js";
import {
  createPreviewHandlers,
  PREVIEW_ITEM_PATH,
  PREVIEWS_BUILD_SESSION_PATH,
} from "./routes/previews.js";
import {
  createRunEventHandlers,
  RUN_EVENTS_PATH,
} from "./routes/run-events.js";
import { serverMiddleware } from "./server.js";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "./workspace.js";

/**
 * Checks whether mock state store is explicitly enabled.
 */
export function isMockModeEnabled(): boolean {
  return process.env.PROJECT_STATE_MODE === "mock";
}

/**
 * The authoritative store. Created lazily so the artifact can be built without a
 * database present. In production, DATABASE_URL is required and startup fails if missing.
 * In-memory mock store is used ONLY when PROJECT_STATE_MODE=mock is explicitly set.
 */
let projectStateStore: ProjectStateStore | undefined;

export function resetStateStoreForTest(): void {
  projectStateStore = undefined;
}

export function stateStore(): ProjectStateStore {
  if (projectStateStore) {
    return projectStateStore;
  }
  if (isMockModeEnabled()) {
    projectStateStore = createMockProjectStateStore();
    return projectStateStore;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required: the authoritative project store is not configured."
    );
  }
  projectStateStore = createProjectStateStore({ connectionString });
  return projectStateStore;
}

export const DEFAULT_DEV_PRINCIPAL: UserPrincipal = {
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  kind: "user" as const,
  revokedAt: null,
  sessionId: SessionIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  userId: UserIdSchema.parse("00000000-0000-4000-8000-000000000001"),
};

export const resolvePrincipal = async ({
  cookieHeader,
}: {
  cookieHeader: string | undefined;
}) => {
  const resolved = await resolveSessionPrincipal({
    cookieHeader,
    sessions: stateStore().sessions,
  });
  if (resolved) {
    return resolved;
  }
  if (isMockModeEnabled()) {
    return DEFAULT_DEV_PRINCIPAL;
  }
};

const buildSessionHandlers = createBuildSessionHandlers({
  resolvePrincipal,
  store: stateStore,
});

const runEventHandlers = createRunEventHandlers({
  resolvePrincipal,
  store: stateStore,
});

const checkpointHandlers = createCheckpointHandlers({
  resolvePrincipal,
  store: stateStore,
});

const previewHandlers = createPreviewHandlers({
  resolvePrincipal,
  store: stateStore,
});

const evidenceHandlers = createEvidenceHandlers({
  resolvePrincipal,
  store: stateStore,
});

const deploymentHandlers = createDeploymentHandlers({
  resolvePrincipal,
  store: stateStore,
});

const storage = new MastraCompositeStore({
  default: new LibSQLStore({
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    id: "mastra-storage",
    url: process.env.TURSO_DATABASE_URL || "file:./mastra.db",
  }),
  domains: {
    observability: await new DuckDBStore().getStore("observability"),
  },
  id: "composite-storage",
});

export const reasonateCtoRuntime = createReasonateCtoRuntime({
  ...buildSandboxEnvironment,
  model: frontierModel,
  storage,
  workspace: reasonateBuildWorkspace,
  workspaceRoot: SANDBOX_WORKING_DIRECTORY,
});

export const mastra = new Mastra({
  agentControllers: {
    reasonateCto: reasonateCtoRuntime.controller,
  },
  agents: {
    reasonateCto: reasonateCtoRuntime.mainAgent,
  },
  bundler: {
    externals: ["@duckdb/node-bindings"],
    transpilePackages: [
      "@reasonateai/auth",
      "@reasonateai/contracts",
      "@reasonateai/cto-runtime",
      "@reasonateai/project-state",
    ],
  },
  observability: new Observability({
    configs: {
      default: {
        exporters: [new MastraStorageExporter()],
        serviceName: "reasonateai-api",
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  server: {
    apiRoutes: [
      registerApiRoute(BUILD_SESSION_COLLECTION_PATH, {
        handler: (c) => buildSessionHandlers.allocate(c),
        method: "POST",
        openapi: {
          description:
            "Idempotently allocates the project's active build session and its sandbox environment.",
          summary: "Allocate a build session",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(BUILD_SESSION_ITEM_PATH, {
        handler: (c) => buildSessionHandlers.read(c),
        method: "GET",
        openapi: {
          description:
            "Reads one build session within the caller's organization and project scope.",
          summary: "Read a build session",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(RUN_EVENTS_PATH, {
        handler: (c) => runEventHandlers.stream(c),
        method: "GET",
        openapi: {
          description:
            "Streams a run's durable events as server-sent events, replaying from Last-Event-ID before following live.",
          summary: "Follow build session events",
          tags: ["Build sessions"],
        },
      }),
      // --- Checkpoints ---
      registerApiRoute(CHECKPOINTS_BUILD_SESSION_PATH, {
        handler: (c) => checkpointHandlers.create(c),
        method: "POST",
        openapi: {
          description: "Creates a new Git checkpoint for a build session.",
          summary: "Create a checkpoint",
          tags: ["Checkpoints"],
        },
      }),
      registerApiRoute(CHECKPOINTS_BUILD_SESSION_PATH, {
        handler: (c) => checkpointHandlers.list(c),
        method: "GET",
        openapi: {
          description: "Lists Git checkpoints recorded for a build session.",
          summary: "List checkpoints",
          tags: ["Checkpoints"],
        },
      }),
      registerApiRoute(CHECKPOINT_RESTORE_PATH, {
        handler: (c) => checkpointHandlers.restore(c),
        method: "POST",
        openapi: {
          description: "Requests a checkpoint restore / Git reset operation.",
          summary: "Restore a checkpoint",
          tags: ["Checkpoints"],
        },
      }),
      // --- Previews ---
      registerApiRoute(PREVIEWS_BUILD_SESSION_PATH, {
        handler: (c) => previewHandlers.create(c),
        method: "POST",
        openapi: {
          description: "Allocates a new application preview session.",
          summary: "Create a preview session",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEWS_BUILD_SESSION_PATH, {
        handler: (c) => previewHandlers.listActive(c),
        method: "GET",
        openapi: {
          description: "Lists active preview sessions for a build session.",
          summary: "List active previews",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEW_ITEM_PATH, {
        handler: (c) => previewHandlers.get(c),
        method: "GET",
        openapi: {
          description: "Retrieves details of a preview session.",
          summary: "Get a preview session",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEW_ITEM_PATH, {
        handler: (c) => previewHandlers.update(c),
        method: "PATCH",
        openapi: {
          description:
            "Updates preview session status, health, proxy URL, or error details.",
          summary: "Update preview status",
          tags: ["Previews"],
        },
      }),
      // --- Evidence & Artifacts ---
      registerApiRoute(PROJECT_EVIDENCE_PATH, {
        handler: (c) => evidenceHandlers.listEvidence(c),
        method: "GET",
        openapi: {
          description: "Lists runtime evidence records captured for a project.",
          summary: "List project evidence",
          tags: ["Evidence"],
        },
      }),
      registerApiRoute(ARTIFACT_ITEM_PATH, {
        handler: (c) => evidenceHandlers.getArtifact(c),
        method: "GET",
        openapi: {
          description:
            "Retrieves metadata and download details for an artifact.",
          summary: "Get artifact details",
          tags: ["Evidence"],
        },
      }),
      // --- Deployments & Rollbacks ---
      registerApiRoute(PROJECT_DEPLOYMENTS_PATH, {
        handler: (c) => deploymentHandlers.list(c),
        method: "GET",
        openapi: {
          description: "Lists deployment records for a project.",
          summary: "List deployments",
          tags: ["Deployments"],
        },
      }),
      registerApiRoute(PROJECT_DEPLOYMENTS_PATH, {
        handler: (c) => deploymentHandlers.create(c),
        method: "POST",
        openapi: {
          description: "Records a new deployment attempt.",
          summary: "Create a deployment",
          tags: ["Deployments"],
        },
      }),
      registerApiRoute(DEPLOYMENT_ROLLBACK_PATH, {
        handler: (c) => deploymentHandlers.rollback(c),
        method: "POST",
        openapi: {
          description:
            "Executes a deployment rollback to a historical target deployment.",
          summary: "Rollback deployment",
          tags: ["Deployments"],
        },
      }),
    ],
    middleware: serverMiddleware,
  },
  storage,
});

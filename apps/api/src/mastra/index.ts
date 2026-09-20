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
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { resolveSessionPrincipal } from "./principal";
import {
  BUILD_SESSION_COLLECTION_PATH,
  BUILD_SESSION_ITEM_PATH,
  createBuildSessionHandlers,
} from "./routes/build-sessions";
import { serverMiddleware } from "./server";
import { reasonateBuildWorkspace } from "./workspace";

export const frontierModel = "deepseek/deepseek-flash";

/**
 * The authoritative store. Created lazily so the artifact can be built without a
 * database present, and so a missing configuration is reported as a clear
 * request failure rather than a silent fallback to different storage.
 */
let projectStateStore: ProjectStateStore | undefined;

function stateStore(): ProjectStateStore {
  if (projectStateStore) {
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

const buildSessionHandlers = createBuildSessionHandlers({
  resolvePrincipal: async ({ cookieHeader }) =>
    await resolveSessionPrincipal({
      cookieHeader,
      sessions: stateStore().sessions,
    }),
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
  model: frontierModel,
  storage,
  workspace: reasonateBuildWorkspace,
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
    ],
    middleware: serverMiddleware,
  },
  storage,
});

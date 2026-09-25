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
import { createMagicLinkSender } from "./adapters/magic-link-sender";
import { createCsrfMiddleware } from "./middleware";
import { frontierModel } from "./model";
import { resolveSessionPrincipal } from "./principal";
import {
  AUTH_CALLBACK_PATH,
  AUTH_SESSION_PATH,
  createAuthHandlers,
  MAGIC_LINKS_PATH,
  SESSION_IDLE_TTL_MS,
} from "./routes/auth";
import {
  BUILD_SESSION_COLLECTION_PATH,
  BUILD_SESSION_ITEM_PATH,
  createBuildSessionHandlers,
} from "./routes/build-sessions";
import {
  createOrganizationHandlers,
  ORGANIZATION_COLLECTION_PATH,
} from "./routes/organizations";
import {
  createProjectHandlers,
  PROJECT_COLLECTION_PATH,
} from "./routes/projects";
import { createRunEventHandlers, RUN_EVENTS_PATH } from "./routes/run-events";
import { serverMiddleware } from "./server";
import {
  buildSandboxEnvironment,
  reasonateBuildWorkspace,
  SANDBOX_WORKING_DIRECTORY,
} from "./workspace";

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
  projectStateStore = createProjectStateStore({
    connectionString,
    // A session that is used is extended to the idle window this deployment
    // issues it with; the store's own default would silently replace it.
    sessionIdleTtlMs: SESSION_IDLE_TTL_MS,
  });
  return projectStateStore;
}

const environment = process.env.NODE_ENV ?? "";

/**
 * The secret that keys CSRF tokens. Read when the first token is minted rather
 * than at import, so the artifact can be built and inspected without the
 * deployment's secrets present. A deployment that never provides one fails its
 * first sign-in loudly, because the alternative is issuing tokens anyone can
 * forge.
 */
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is required: browser sessions cannot be protected without it."
    );
  }
  return secret;
}

/**
 * Origins allowed to issue browser commands. They are configured and never
 * inferred from a request, because an `Origin` header is chosen by the caller
 * the check exists to refuse.
 */
const allowedOrigins = (process.env.REASONATE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Where a sign-in link points back at, which is this API's own public address.
 * Development falls back to the address the dev server listens on; a
 * deployment must state its own, because the fallback would mail a link nobody
 * outside this machine can open.
 */
const publicOrigin =
  process.env.REASONATE_PUBLIC_ORIGIN ?? "http://localhost:4111";

const resolvePrincipalFrom = async (input: {
  cookieHeader: string | undefined;
}) =>
  await resolveSessionPrincipal({
    cookieHeader: input.cookieHeader,
    sessions: stateStore().sessions,
  });

const authHandlers = createAuthHandlers({
  csrfSecret: sessionSecret,
  publicOrigin,
  secureCookies: environment === "production",
  sender: createMagicLinkSender({ environment }),
  store: stateStore,
});

const organizationHandlers = createOrganizationHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const projectHandlers = createProjectHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const csrfMiddleware = createCsrfMiddleware({
  csrfSecret: sessionSecret,
  origins: allowedOrigins,
  sessions: () => stateStore().sessions,
});

const buildSessionHandlers = createBuildSessionHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const runEventHandlers = createRunEventHandlers({
  resolvePrincipal: resolvePrincipalFrom,
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
      registerApiRoute(MAGIC_LINKS_PATH, {
        handler: (c) => authHandlers.requestMagicLink(c),
        method: "POST",
        openapi: {
          description:
            "Accepts a sign-in request for an email address. The answer is identical whether or not the address has an account.",
          summary: "Request a sign-in link",
          tags: ["Identity"],
        },
      }),
      registerApiRoute(AUTH_CALLBACK_PATH, {
        handler: (c) => authHandlers.callback(c),
        method: "GET",
        openapi: {
          description:
            "Redeems a single-use sign-in token, establishes the browser session, and redirects to a same-origin path.",
          summary: "Redeem a sign-in link",
          tags: ["Identity"],
        },
      }),
      registerApiRoute(AUTH_SESSION_PATH, {
        handler: (c) => authHandlers.readSession(c),
        method: "GET",
        openapi: {
          description:
            "Reads the caller's own session: its deadlines and the organizations the caller belongs to.",
          summary: "Read the current session",
          tags: ["Identity"],
        },
      }),
      registerApiRoute(AUTH_SESSION_PATH, {
        handler: (c) => authHandlers.signOut(c),
        method: "DELETE",
        openapi: {
          description:
            "Revokes the caller's session and clears its cookies. Enforced against CSRF like every other command.",
          summary: "End the current session",
          tags: ["Identity"],
        },
      }),
      registerApiRoute(ORGANIZATION_COLLECTION_PATH, {
        handler: (c) => organizationHandlers.create(c),
        method: "POST",
        openapi: {
          description:
            "Creates an organization the caller owns, with owner membership and an audit record, in one transaction.",
          summary: "Create an organization",
          tags: ["Tenancy"],
        },
      }),
      registerApiRoute(PROJECT_COLLECTION_PATH, {
        handler: (c) => projectHandlers.create(c),
        method: "POST",
        openapi: {
          description:
            "Creates a project in an organization the caller is authorized to add projects to, with the caller's membership and an audit record, in one transaction.",
          summary: "Create a project",
          tags: ["Tenancy"],
        },
      }),
    ],
    // The built-in route denials come first; every product command then passes
    // the CSRF and origin check before its handler runs.
    middleware: [...serverMiddleware, csrfMiddleware],
  },
  storage,
});

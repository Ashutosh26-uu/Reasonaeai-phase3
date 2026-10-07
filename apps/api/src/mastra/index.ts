import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ArtifactStore } from "@reasonateai/artifact-store";
import { createLocalArtifactStore } from "@reasonateai/artifact-store/local";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { resolveAsrAdapter } from "./adapters/asr";
import { createMagicLinkSender } from "./adapters/magic-link-sender";
import { createTtsAdapterFromEnv } from "./adapters/tts";
import { conversationCheckpoint } from "./conversation-checkpoint";
import { createCsrfMiddleware } from "./middleware";
import { frontierModel } from "./model";
import { startOutboxRelay } from "./outbox-relay";
import { createPreviewService } from "./preview-service";
import { resolveSessionPrincipal } from "./principal";
import {
  ARTIFACT_ACCESS_PATH,
  ARTIFACT_COLLECTION_PATH,
  ARTIFACT_DOWNLOAD_PATH,
  createArtifactHandlers,
} from "./routes/artifacts";
import {
  AUTH_CALLBACK_PATH,
  AUTH_PROFILE_PATH,
  AUTH_SESSION_PATH,
  createAuthHandlers,
  MAGIC_LINKS_PATH,
  SESSION_IDLE_TTL_MS,
} from "./routes/auth";
import {
  BUILD_SESSION_COLLECTION_PATH,
  BUILD_SESSION_ITEM_PATH,
  CONVERSATION_MESSAGES_PATH,
  CONVERSATION_TURNS_PATH,
  createBuildSessionHandlers,
  PROJECT_CONVERSATIONS_PATH,
  RUN_ANSWER_PATH,
  RUN_CANCELLATION_PATH,
  RUN_RETRY_PATH,
} from "./routes/build-sessions";
import {
  CONVERSATION_BRANCH_PATH,
  CONVERSATION_FEEDBACK_PATH,
  createConversationActionHandlers,
} from "./routes/conversation-actions";
import {
  createOrganizationHandlers,
  ORGANIZATION_COLLECTION_PATH,
  ORGANIZATION_ITEM_PATH,
  ORGANIZATION_USAGE_PATH,
} from "./routes/organizations";
import {
  BUILD_SESSION_PREVIEW_PATH,
  createPreviewHandlers,
  PREVIEW_ITEM_PATH,
  PREVIEW_PROXY_PATH,
  PREVIEW_STATUS_PATH,
} from "./routes/previews";
import {
  createProjectHandlers,
  PROJECT_COLLECTION_PATH,
} from "./routes/projects";
import { createRunEventHandlers, RUN_EVENTS_PATH } from "./routes/run-events";
import {
  createRunSteeringHandlers,
  RUN_STEERING_PATH,
} from "./routes/steering";
import {
  createVoiceHandlers,
  VOICE_SPEECH_PATH,
  VOICE_TRANSCRIPTION_PATH,
} from "./routes/voice";
import {
  createWorkspaceHandlers,
  WORKSPACE_CHECKPOINT_DIFF_PATH,
  WORKSPACE_FILE_PATH,
  WORKSPACE_RESTORE_PATH,
  WORKSPACE_TREE_PATH,
} from "./routes/workspace";
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
let projectStateMigration: Promise<void> | undefined;

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

function migrateProjectState(): Promise<void> {
  projectStateMigration ??= stateStore()
    .migrate()
    .catch((error: unknown) => {
      projectStateMigration = undefined;
      throw error;
    });
  return projectStateMigration;
}

/**
 * Where the local filesystem artifact store keeps its tenant-scoped objects.
 * A deployment points the same provider-neutral contract at private object
 * storage; locally it is a private host directory outside the repository, so a
 * run never writes artifacts into version control.
 */
const artifactRoot =
  process.env.REASONATE_ARTIFACT_ROOT ?? join(tmpdir(), "reasonate-artifacts");

/**
 * The secret that keys short-lived artifact download URLs. Like the session
 * secret it is read when the first URL is minted rather than at import, so the
 * artifact can be built without the deployment's secrets and a deployment that
 * never provides one fails its first signed URL loudly.
 */
function artifactUrlSecret(): string {
  const secret = process.env.REASONATE_ARTIFACT_URL_SECRET;
  if (!secret) {
    throw new Error(
      "REASONATE_ARTIFACT_URL_SECRET is required: signed artifact URLs cannot be protected without it."
    );
  }
  return secret;
}

let artifactStore: ArtifactStore | undefined;

function localArtifacts(): ArtifactStore {
  if (artifactStore) {
    return artifactStore;
  }
  artifactStore = createLocalArtifactStore({ root: artifactRoot });
  return artifactStore;
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

const projectStateMigrationMiddleware = {
  handler: async (_context: unknown, next: () => Promise<void>) => {
    await migrateProjectState();
    await next();
  },
  path: "/v1/*",
};

const buildSessionHandlers = createBuildSessionHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});
const conversationActions = createConversationActionHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const runEventHandlers = createRunEventHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const steeringHandlers = createRunSteeringHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

const workspaceHandlers = createWorkspaceHandlers({
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

/**
 * The preview service owns sandboxes for previews, not for runs: it restores a
 * project's latest checkpoint into its own container and starts the app there.
 * One service per process, so its idle sweep and its exit teardown cover every
 * preview this process started.
 */
const previewService = createPreviewService({
  onOrphansRemoved: (count) => {
    // Reported rather than cleaned silently: a deployment that keeps finding
    // orphans is telling you its API is restarting more than it should.
    console.info(
      `Previews: removed ${count} container(s) left by a previous process.`
    );
  },
  onPreviewRecovered: (previewId, port) => {
    console.info(
      `Previews: recovered live preview ${previewId} on loopback port ${port}.`
    );
  },
  onPreviewRetired: (previewId, reason) => {
    console.info(
      `Previews: retired preview ${previewId} during restart (${reason}).`
    );
  },
  previewStore: () => stateStore().previews,
  resolveCheckpoint: (record, checkpoints) =>
    conversationCheckpoint({
      buildSessionId: record.buildSessionId,
      checkpoints,
      scope: {
        organizationId: record.organizationId,
        projectId: record.projectId,
      },
      store: stateStore(),
    }),
});
// When configured, ensure schema migrations are applied so the persistent
// preview registry is available before recovering previews at startup.
if (process.env.DATABASE_URL) {
  await migrateProjectState();
}
await previewService.sweepOrphans();

const previewHandlers = createPreviewHandlers({
  previews: previewService,
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
});

/**
 * Transcription is resolved per request: a deployment with no ASR endpoint
 * configured has no adapter, and the route says so rather than inventing text.
 */
const voiceHandlers = createVoiceHandlers({
  asr: () => resolveAsrAdapter(process.env),
  resolvePrincipal: resolvePrincipalFrom,
  store: stateStore,
  tts: () => createTtsAdapterFromEnv(process.env),
});

const artifactHandlers = createArtifactHandlers({
  artifacts: localArtifacts,
  publicOrigin,
  resolvePrincipal: resolvePrincipalFrom,
  secret: artifactUrlSecret,
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
  enableBrowserVerification: true,
  enableTestRunner: true,
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
      registerApiRoute(PROJECT_CONVERSATIONS_PATH, {
        handler: (c) => buildSessionHandlers.listConversations(c),
        method: "GET",
      }),
      registerApiRoute(CONVERSATION_MESSAGES_PATH, {
        handler: (c) => buildSessionHandlers.history(c),
        method: "GET",
      }),
      registerApiRoute(CONVERSATION_TURNS_PATH, {
        handler: (c) => buildSessionHandlers.appendTurn(c),
        method: "POST",
      }),
      registerApiRoute(RUN_ANSWER_PATH, {
        handler: (c) => buildSessionHandlers.answerRun(c),
        method: "POST",
      }),
      registerApiRoute(RUN_RETRY_PATH, {
        handler: (c) => conversationActions.retry(c),
        method: "POST",
        openapi: {
          description:
            "Idempotently restores the source before a saved user turn, replaces that turn with its stored or edited input and original attachments, and removes later turns from active history while preserving audit records.",
          summary: "Retry or edit a saved user turn",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(CONVERSATION_BRANCH_PATH, {
        handler: (c) => conversationActions.branch(c),
        method: "POST",
        openapi: {
          description:
            "Idempotently creates an independent conversation through a completed turn with its saved checkpoint, retained history, and separate model thread and workspace identity.",
          summary: "Branch through a saved answer",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(CONVERSATION_FEEDBACK_PATH, {
        handler: (c) => conversationActions.feedback(c),
        method: "PUT",
        openapi: {
          description:
            "Saves or clears the authenticated user's positive or negative feedback for a completed answer in the selected conversation.",
          summary: "Save answer feedback",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(RUN_CANCELLATION_PATH, {
        handler: (c) => buildSessionHandlers.cancelRun(c),
        method: "POST",
        openapi: {
          description:
            "Requests cancellation of an active run in the caller's authorized project scope.",
          summary: "Stop a run",
          tags: ["Build sessions"],
        },
      }),
      registerApiRoute(RUN_STEERING_PATH, {
        handler: (c) => steeringHandlers.steer(c),
        method: "POST",
        openapi: {
          description:
            "Idempotently requests a bounded user message for the active scoped run; the lease-owning worker delivers it at the controller's next signal boundary.",
          summary: "Steer the active CTO run",
          tags: ["Build sessions"],
        },
      }),
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
      registerApiRoute(WORKSPACE_TREE_PATH, {
        handler: (c) => workspaceHandlers.tree(c),
        method: "GET",
        openapi: {
          description:
            "Lists the selected conversation's checkpoint as workspace-relative paths, excluding dependencies, caches, and repository metadata. A verified empty starting tree returns an empty listing.",
          summary: "List a conversation's generated source",
          tags: ["Workspace"],
        },
      }),
      registerApiRoute(WORKSPACE_FILE_PATH, {
        handler: (c) => workspaceHandlers.file(c),
        method: "GET",
        openapi: {
          description:
            "Reads one file from the selected conversation's checkpoint. A binary or oversized file is reported as binary with no body, and centralized project authorization guards both workspace reads.",
          summary: "Read a generated source file",
          tags: ["Workspace"],
        },
      }),
      registerApiRoute(WORKSPACE_CHECKPOINT_DIFF_PATH, {
        handler: (c) => workspaceHandlers.checkpointDiff(c),
        method: "GET",
        openapi: {
          description:
            "Reads a bounded file diff from a saved turn checkpoint after project authorization and durable run provenance verification.",
          summary: "Read a turn checkpoint diff",
          tags: ["Workspace"],
        },
      }),
      registerApiRoute(WORKSPACE_RESTORE_PATH, {
        handler: (c) => workspaceHandlers.restore(c),
        method: "POST",
        openapi: {
          description:
            "Restores the project workspace from a durable Git checkpoint bundle into the build sandbox and records an audit log entry.",
          summary: "Restore workspace from checkpoint",
          tags: ["Workspace"],
        },
      }),
      registerApiRoute(BUILD_SESSION_PREVIEW_PATH, {
        handler: (c) => previewHandlers.create(c),
        method: "POST",
        openapi: {
          description:
            "Starts the generated app from the project's latest checkpoint in its own sandbox and returns the preview's status and proxied address. Calling it again while a preview is live returns that preview rather than starting a second one.",
          summary: "Start a preview",
          tags: ["Previews"],
        },
      }),
      // Order matters here. The item path is the running app's own root, so the
      // status route sits on its own path, the root is proxied, and the
      // wildcard follows — a page load must never receive the status document.
      registerApiRoute(PREVIEW_STATUS_PATH, {
        handler: (c) => previewHandlers.status(c),
        method: "GET",
        openapi: {
          description:
            "Reads one preview's status, including why it failed when it did.",
          summary: "Read a preview",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEW_ITEM_PATH, {
        handler: (c) => previewHandlers.proxy(c),
        method: "GET",
        openapi: {
          description:
            "Serves the running preview's own root document. The preview's tenant scope is resolved from the preview itself, never from the request.",
          summary: "Serve a running preview",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEW_PROXY_PATH, {
        handler: (c) => previewHandlers.proxy(c),
        method: "ALL",
        openapi: {
          description:
            "Serves the running preview's own responses. The preview's tenant scope is resolved from the preview itself, never from the request.",
          summary: "Serve a running preview",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(PREVIEW_ITEM_PATH, {
        handler: (c) => previewHandlers.stop(c),
        method: "DELETE",
        openapi: {
          description:
            "Stops a preview and destroys the sandbox that was serving it.",
          summary: "Stop a preview",
          tags: ["Previews"],
        },
      }),
      registerApiRoute(VOICE_TRANSCRIPTION_PATH, {
        handler: (c) => voiceHandlers.transcribe(c),
        method: "POST",
        openapi: {
          description:
            "Transcribes one recorded message through the deployment's configured speech-to-text adapter. A deployment with no adapter answers with a typed refusal that names what is missing.",
          summary: "Transcribe a recorded message",
          tags: ["Voice"],
        },
      }),
      registerApiRoute(VOICE_SPEECH_PATH, {
        handler: (c) => voiceHandlers.synthesize(c),
        method: "POST",
        openapi: {
          description:
            "Synthesizes spoken audio from text through the deployment's configured text-to-speech adapter. A deployment with no adapter answers with a typed refusal that names what is missing.",
          summary: "Synthesize speech from text",
          tags: ["Voice"],
        },
      }),
      registerApiRoute(ARTIFACT_COLLECTION_PATH, {
        handler: (c) => artifactHandlers.record(c),
        method: "POST",
        openapi: {
          description:
            "Records an artifact for a run: the bytes are written to tenant-scoped object storage and their metadata is persisted, so the two agree.",
          summary: "Record an artifact",
          tags: ["Artifacts"],
        },
      }),
      registerApiRoute(ARTIFACT_COLLECTION_PATH, {
        handler: (c) => artifactHandlers.list(c),
        method: "GET",
        openapi: {
          description:
            "Lists the caller's artifacts for a project. A caller outside the organization or project is refused rather than shown an empty list.",
          summary: "List a project's artifacts",
          tags: ["Artifacts"],
        },
      }),
      registerApiRoute(ARTIFACT_ACCESS_PATH, {
        handler: (c) => artifactHandlers.access(c),
        method: "GET",
        openapi: {
          description:
            "Mints a short-lived signed download URL for one artifact after authorization. It returns a URL, never the bytes and never a permanent link.",
          summary: "Mint artifact access",
          tags: ["Artifacts"],
        },
      }),
      registerApiRoute(ARTIFACT_DOWNLOAD_PATH, {
        handler: (c) => artifactHandlers.download(c),
        method: "GET",
        openapi: {
          description:
            "Streams artifact bytes for a verified signed token. A tampered, expired, or foreign-tenant token is refused with no bytes.",
          summary: "Download an artifact",
          tags: ["Artifacts"],
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
      registerApiRoute(AUTH_PROFILE_PATH, {
        handler: (c) => authHandlers.readProfile(c),
        method: "GET",
        openapi: {
          description:
            "Reads the authenticated caller's own account profile without exposing account data to other principals.",
          summary: "Read account profile",
          tags: ["Identity"],
        },
      }),
      registerApiRoute(AUTH_PROFILE_PATH, {
        handler: (c) => authHandlers.updateProfile(c),
        method: "PATCH",
        openapi: {
          description: "Updates the authenticated caller's display name.",
          summary: "Update account profile",
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
      registerApiRoute(ORGANIZATION_ITEM_PATH, {
        handler: (c) => organizationHandlers.rename(c),
        method: "PATCH",
        openapi: {
          description:
            "Renames an organization after centralized authorization and records the change in the audit ledger.",
          summary: "Rename a workspace",
          tags: ["Tenancy"],
        },
      }),
      registerApiRoute(ORGANIZATION_USAGE_PATH, {
        handler: (c) => organizationHandlers.usage(c),
        method: "GET",
        openapi: {
          description:
            "Reads the authorized organization's current plan entitlements and metered usage.",
          summary: "Read plan and usage",
          tags: ["Tenancy"],
        },
      }),
      registerApiRoute(PROJECT_COLLECTION_PATH, {
        handler: (c) => projectHandlers.list(c),
        method: "GET",
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
    middleware: [
      ...serverMiddleware,
      projectStateMigrationMiddleware,
      csrfMiddleware,
    ],
  },
  storage,
});

/**
 * Committed events reach a run's topic only if something moves them there, so
 * this process — the one that commits them — is the one that publishes them.
 * The record is already durable in PostgreSQL before the relay sees it, which
 * is what makes a broker outage cost delivery time and nothing else.
 *
 * The store is resolved on each drain rather than here, so importing this
 * module still neither requires a database nor opens a connection to one; a
 * drain that cannot resolve it fails, is logged, and is retried.
 */
export const outboxRelay = startOutboxRelay({
  redisUrl: process.env.REDIS_URL,
  store: {
    listPendingOutbox: (limit) => stateStore().listPendingOutbox(limit),
    markOutboxPublished: (outboxIds) =>
      stateStore().markOutboxPublished(outboxIds),
  },
});

/**
 * The generated server drains HTTP and shuts Mastra down on these signals, and
 * then exits the process. Releasing the transport is registered here, and is
 * allowed to be cut short: a record is marked delivered only after it is
 * published, so an interrupted drain republishes rather than loses.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    outboxRelay?.stop().catch(() => undefined);
  });
}

import { createHash } from "node:crypto";
import {
  ArtifactIntegrityError,
  type ArtifactStore,
  artifactObjectKeyFor,
  signArtifactUrl,
  verifyArtifactUrl,
} from "@reasonateai/artifact-store";
import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import {
  ArtifactIdSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  type OrganizationId,
  OrganizationIdSchema,
  type Permission,
  type ProjectId,
  ProjectIdSchema,
  type UserPrincipal,
} from "@reasonateai/contracts/identity";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { z } from "zod";
import {
  apiErrorResponse,
  readJsonBody,
  unauthenticatedResponse,
} from "../principal";
import type { HandlerContext } from "./build-sessions";

/**
 * Artifact routes.
 *
 * Bytes live in immutable, tenant-scoped object storage; PostgreSQL holds the
 * artifact's metadata and manifest. The two are written together so a reader
 * that sees metadata can rely on the bytes existing, and never the other way
 * around.
 *
 * Neither an object key nor a URL is authorization. Every route below decides
 * through the same centralized policy as the rest of the product, and a signed
 * download URL is a short-lived capability that is only minted after that
 * decision. A caller outside the organization is refused; it is never shown an
 * empty list that would read as "this project has no artifacts".
 */

/**
 * Product routes live outside the `/api` prefix on purpose, the same as the
 * other product routes: the ingress denial blocks every built-in Mastra route
 * group under `/api`.
 */
export const ARTIFACT_COLLECTION_PATH = "/v1/artifacts";
export const ARTIFACT_ACCESS_PATH = "/v1/artifacts/:artifactId/access";
export const ARTIFACT_DOWNLOAD_PATH = "/v1/artifacts/download";

/** How long a minted download URL stays valid. Short by design. */
const ARTIFACT_URL_TTL_MS = 5 * 60 * 1000;

/** Largest single artifact body this route accepts, in bytes. */
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** Strict base64, so a malformed body is refused rather than silently truncated. */
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The artifact as the product returns it: the durable tenant-scoped metadata
 * row. It deliberately omits the content-addressed object key, which lives
 * only inside the store and inside a signed token, so no response hands a
 * client something it could mistake for an access grant.
 */
const ArtifactRecordViewSchema = z.strictObject({
  artifactId: z.string().min(1).max(64),
  createdAt: z.iso.datetime(),
  kind: z.string().min(1).max(64),
  manifestObjectKey: z.string().min(1).max(1024),
  sha256: z.string().max(64),
  status: z.string().min(1).max(64),
  totalSize: z.number().int().nonnegative(),
});

const ArtifactCollectionSchema = z.strictObject({
  artifacts: z.array(ArtifactRecordViewSchema),
});

const ArtifactRecordedSchema = z.strictObject({
  artifact: ArtifactRecordViewSchema,
});

const ArtifactAccessSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  url: z.url(),
});

/**
 * One artifact is one logical unit of output recorded from one request: the
 * bytes arrive base64-encoded, and the manifest that describes them is built
 * here rather than trusted from the caller.
 */
const RecordArtifactBodySchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  buildSessionId: z.uuid().nullable(),
  contentBase64: z
    .string()
    .min(1)
    .max(64 * 1024 * 1024),
  kind: z.string().min(1).max(64),
  mediaType: z.string().min(1).max(128),
  occurredAt: z.iso.datetime(),
  organizationId: OrganizationIdSchema,
  path: z.string().min(1).max(1024),
  projectId: ProjectIdSchema,
  runId: z.uuid().nullable(),
});

const ArtifactParamsSchema = z.strictObject({ artifactId: z.uuid() });

const ArtifactScopeQuerySchema = z.strictObject({
  organizationId: z.uuid(),
  projectId: z.uuid(),
});

const ArtifactDownloadQuerySchema = z.strictObject({
  organizationId: z.uuid(),
  projectId: z.uuid(),
  token: z.string().min(1).max(4096),
});

const DENIAL_BY_REASON: Record<string, ApiErrorCode> = {
  CAPABILITY_EXPIRED: "unauthenticated",
  MEMBERSHIP_PRINCIPAL_MISMATCH: "forbidden",
  ORGANIZATION_MEMBERSHIP_INACTIVE: "forbidden",
  ORGANIZATION_MEMBERSHIP_REQUIRED: "forbidden",
  ORGANIZATION_SCOPE_MISMATCH: "forbidden",
  PERMISSION_DENIED: "forbidden",
  PROJECT_MEMBERSHIP_INACTIVE: "forbidden",
  PROJECT_MEMBERSHIP_REQUIRED: "forbidden",
  PROJECT_SCOPE_MISMATCH: "forbidden",
  SESSION_EXPIRED: "unauthenticated",
  SESSION_REVOKED: "unauthenticated",
  UNAUTHENTICATED: "unauthenticated",
};

/** The status a recorded artifact carries once its bytes are durably stored. */
const STORED_STATUS = "stored";

export interface ArtifactRouteDeps {
  /** The durable bytes store, resolved per request so it is created only when used. */
  artifacts: () => ArtifactStore;
  /**
   * The clock, injectable so a test can prove expiry without waiting for it.
   * Defaults to the process clock.
   */
  nowMs?: (() => number) | undefined;
  /** This API's own public origin, used to build an absolute download URL. */
  publicOrigin: string;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /** The secret that keys signed download URLs. Read lazily so import stays secret-free. */
  secret: () => string;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

async function authorizeProjectAction(input: {
  action: Permission;
  deps: ArtifactRouteDeps;
  organizationId: OrganizationId;
  principal: UserPrincipal;
  projectId: ProjectId;
}) {
  const organizationMembership = await input.deps
    .store()
    .memberships.getOrganizationMembership({
      organizationId: input.organizationId,
      userId: input.principal.userId,
    });

  const projectMembership = await input.deps
    .store()
    .memberships.getProjectMembership({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.principal.userId,
    });

  return authorize({
    action: input.action,
    now: new Date().toISOString(),
    organizationMembership: organizationMembership ?? null,
    principal: input.principal,
    projectMembership: projectMembership ?? null,
    resource: {
      kind: "artifact",
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: null,
    },
  });
}

/** Decode a strict base64 body, or `undefined` when it is not valid base64. */
function decodeBase64(value: string): Uint8Array | undefined {
  if (!BASE64_RE.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}

export function createArtifactHandlers(deps: ArtifactRouteDeps) {
  const nowMs = deps.nowMs ?? (() => Date.now());

  return {
    /**
     * Mints a short-lived signed URL for one artifact. The URL is a capability,
     * not an authorization: it is only ever issued after the same centralized
     * decision that guards every other project action.
     */
    access: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const params = ArtifactParamsSchema.safeParse({
        artifactId: c.req.param("artifactId"),
      });
      const query = ArtifactScopeQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
      });
      if (!(params.success && query.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "An artifact id and both scope identifiers are required.",
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.parse(
        query.data.organizationId
      );
      const projectId = ProjectIdSchema.parse(query.data.projectId);

      const decision = await authorizeProjectAction({
        action: "artifact:read",
        deps,
        organizationId,
        principal,
        projectId,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to read this project's artifacts.",
          requestId: rid,
        });
      }

      const artifact = (
        await deps.store().listArtifacts({
          organizationId,
          projectId,
        })
      ).find((candidate) => candidate.artifactId === params.data.artifactId);

      // A record without a digest cannot be located, and an artifact that is
      // not in the caller's project is indistinguishable from one that does not
      // exist, so both are the same answer.
      if (!artifact || artifact.sha256.length === 0) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such artifact.",
          requestId: rid,
        });
      }

      const expiresAtMs = nowMs() + ARTIFACT_URL_TTL_MS;
      const token = signArtifactUrl({
        expiresAtMs,
        key: artifactObjectKeyFor({
          artifactId: artifact.artifactId,
          digest: artifact.sha256,
          organizationId,
          projectId,
        }),
        organizationId,
        secret: deps.secret(),
      });

      const url = new URL(ARTIFACT_DOWNLOAD_PATH, deps.publicOrigin);
      url.searchParams.set("organizationId", organizationId);
      url.searchParams.set("projectId", projectId);
      url.searchParams.set("token", token);

      return c.json(
        ArtifactAccessSchema.parse({
          expiresAt: new Date(expiresAtMs).toISOString(),
          url: url.toString(),
        }),
        200
      );
    },

    /**
     * Streams the bytes behind a verified signed token. A token that is
     * tampered with, expired, minted for another organization, or paired with a
     * mismatched project yields a typed refusal and no bytes: verification
     * happens before the store is ever asked for content.
     */
    download: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const query = ArtifactDownloadQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
        token: c.req.query("token"),
      });
      if (!query.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "A download token and both scope identifiers are required.",
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.parse(
        query.data.organizationId
      );
      const projectId = ProjectIdSchema.parse(query.data.projectId);

      const verified = verifyArtifactUrl({
        nowMs: nowMs(),
        organizationId,
        secret: deps.secret(),
        token: query.data.token,
      });
      if (verified === undefined) {
        return apiErrorResponse({
          code: "forbidden",
          message: "This download link is not valid.",
          requestId: rid,
        });
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.artifacts().read({
          key: verified.key,
          organizationId,
          projectId,
        });
      } catch (error) {
        if (error instanceof ArtifactIntegrityError) {
          return apiErrorResponse({
            code: "internal",
            message: "The stored artifact failed its integrity check.",
            requestId: rid,
          });
        }
        throw error;
      }

      // The store returns `Uint8Array<ArrayBufferLike>`, while the DOM
      // `BodyInit` contract only accepts a view over a plain `ArrayBuffer`.
      // Re-viewing the identical memory narrows that type without copying the
      // bytes: same buffer, same offset, same length.
      const body = new Uint8Array(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength
      );

      return new Response(body, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": "application/octet-stream",
        },
        status: 200,
      });
    },

    /**
     * Lists the caller's artifacts for a project. A caller with no membership
     * in the organization or the project is refused, never handed an empty
     * list: "nothing here" and "not yours" must not look alike.
     */
    list: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const query = ArtifactScopeQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
      });
      if (!query.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "Both scope identifiers are required.",
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.parse(
        query.data.organizationId
      );
      const projectId = ProjectIdSchema.parse(query.data.projectId);

      const decision = await authorizeProjectAction({
        action: "artifact:read",
        deps,
        organizationId,
        principal,
        projectId,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to read this project's artifacts.",
          requestId: rid,
        });
      }

      const artifacts = await deps.store().listArtifacts({
        organizationId,
        projectId,
      });

      return c.json(ArtifactCollectionSchema.parse({ artifacts }), 200);
    },
    /**
     * Records one artifact for a run. The bytes are written first and the
     * tenant-scoped metadata second, so a row exists only for bytes that do,
     * and the digest in the metadata is the digest of the bytes that were
     * actually stored.
     */
    record: async (c: HandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const body = RecordArtifactBodySchema.safeParse(
        await readJsonBody(c.req)
      );
      if (!body.success) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "The body must be a complete artifact manifest with base64 content.",
          requestId: rid,
        });
      }

      const content = decodeBase64(body.data.contentBase64);
      if (content === undefined) {
        return apiErrorResponse({
          code: "invalid_request",
          message: "The artifact content must be valid base64.",
          requestId: rid,
        });
      }
      if (content.byteLength > MAX_ARTIFACT_BYTES) {
        return apiErrorResponse({
          code: "invalid_request",
          message: `An artifact may not exceed ${MAX_ARTIFACT_BYTES} bytes.`,
          requestId: rid,
        });
      }

      const organizationId = OrganizationIdSchema.parse(
        body.data.organizationId
      );
      const projectId = ProjectIdSchema.parse(body.data.projectId);

      const decision = await authorizeProjectAction({
        action: "artifact:read",
        deps,
        organizationId,
        principal,
        projectId,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message:
            "You are not authorized to record artifacts in this project.",
          requestId: rid,
        });
      }

      const digest = createHash("sha256").update(content).digest("hex");
      const manifest = ArtifactManifestSchema.parse({
        artifactId: body.data.artifactId,
        buildSessionId: body.data.buildSessionId,
        files: [
          {
            mediaType: body.data.mediaType,
            objectKey: artifactObjectKeyFor({
              artifactId: body.data.artifactId,
              digest,
              organizationId,
              projectId,
            }),
            path: body.data.path,
            sha256: digest,
            size: content.byteLength,
          },
        ],
        kind: body.data.kind,
        occurredAt: body.data.occurredAt,
        organizationId,
        projectId,
        runId: body.data.runId,
        schemaVersion: 1,
        totalSize: content.byteLength,
      });

      const stored = await deps.artifacts().put({
        content,
        manifest,
        organizationId,
        projectId,
      });

      // The store hashes what it was given. If its digest or byte count differs
      // from what this route computed, the bytes on disk are not the bytes the
      // manifest describes, so nothing is recorded.
      if (stored.digest !== digest || stored.bytes !== content.byteLength) {
        throw new Error(
          "Artifact storage returned a digest that does not match the recorded content."
        );
      }

      // The persisted manifest is rebuilt from what the store actually wrote,
      // so metadata and bytes agree by construction rather than by assumption.
      const recorded: ArtifactManifest = ArtifactManifestSchema.parse({
        ...manifest,
        files: [
          {
            ...manifest.files[0],
            objectKey: stored.key,
            sha256: stored.digest,
            size: stored.bytes,
          },
        ],
        totalSize: stored.bytes,
      });

      const artifact = await deps
        .store()
        .recordArtifact(recorded, STORED_STATUS);

      return c.json(ArtifactRecordedSchema.parse({ artifact }), 201);
    },
  };
}

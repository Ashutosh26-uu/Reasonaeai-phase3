import { authorize } from "@reasonateai/auth/authorize";
import type { ApiErrorCode } from "@reasonateai/contracts/api-error";
import { BuildSessionIdSchema } from "@reasonateai/contracts/execution";
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
  PREVIEW_PUBLIC_PATH_PREFIX,
  type PreviewId,
  PreviewIdSchema,
  type PreviewService,
  type PreviewTarget,
} from "../preview-service";
import { apiErrorResponse, unauthenticatedResponse } from "../principal";
import type { HandlerContext } from "./build-sessions";

/**
 * Preview routes.
 *
 * A preview is the project's latest checkpoint running in its own sandbox, and
 * these routes are how a browser reaches it: one route starts it, one reports
 * and stops it, and one proxies every request the framed app makes.
 *
 * The proxy is the only place a sandbox port is ever reached, and it is reached
 * from the host's loopback interface. The scope the proxy authorizes against is
 * read from the preview itself — never from the URL — so a preview id can never
 * be pointed at another tenant's project.
 *
 * The `frame-ancestors` policy below names the local web origin so the workspace
 * panel can frame the preview during development, where the panel and the API
 * are reached through one origin. Production does not frame a proxied path at
 * all: the preview gateway serves each preview on its own hostname and the
 * panel frames that origin, which is what keeps a preview a separate origin in
 * every environment that matters.
 */

export const BUILD_SESSION_PREVIEW_PATH =
  "/v1/build-sessions/:buildSessionId/preview";
export const PREVIEW_ITEM_PATH = `${PREVIEW_PUBLIC_PATH_PREFIX}/:previewId`;
export const PREVIEW_PROXY_PATH = `${PREVIEW_ITEM_PATH}/*`;
/**
 * The status of one preview, on its own path.
 *
 * It cannot live at the item path: the item path is also the running app's own
 * root, and a router that treats a trailing slash as the same path would hand
 * every page load the status document instead of the page.
 */
export const PREVIEW_STATUS_PATH = `${PREVIEW_ITEM_PATH}/status`;

/** The only origin allowed to frame a preview in local development. */
const LOCAL_PREVIEW_FRAME_ANCESTOR = "http://localhost:3219";
const PREVIEW_FRAME_ANCESTORS = `frame-ancestors ${LOCAL_PREVIEW_FRAME_ANCESTOR}`;

/** A proxied request is a page load, not a job: it may not hang a browser. */
const PROXY_TIMEOUT_MS = 30_000;

/**
 * Headers that belong to one hop and are not forwarded: RFC 9110's connection
 * headers, plus the ones the proxy has to own. `host` would name the API rather
 * than the app, `content-length` is recomputed from the body, and
 * `accept-encoding` is pinned to `identity` so the bytes that come back are the
 * bytes that are forwarded — a compressed body would be decompressed by the
 * runtime and sent on with a header that no longer describes it.
 */
const STRIPPED_REQUEST_HEADERS = [
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/**
 * The product's own credentials are not forwarded: the app being previewed is a
 * separate origin, and it must not be able to read, echo, or act with the
 * viewer's session. `set-cookie` on the way back is dropped for the same
 * reason: a preview must not write cookies onto the API's origin.
 */
const STRIPPED_CREDENTIAL_HEADERS = ["authorization", "cookie"] as const;

/**
 * Response headers the proxy owns. `x-frame-options` and the app's own
 * `content-security-policy` would decide how the preview may be framed, and a
 * generated app that sets either one would otherwise render as a blank panel,
 * so the proxy's policy replaces them. `content-encoding` and `content-length`
 * are dropped because the body is re-sent decoded and re-chunked.
 */
const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
] as const;

const PreviewParamsSchema = z.strictObject({ previewId: PreviewIdSchema });

const PreviewScopeQuerySchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
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

export interface PreviewRouteDeps {
  previews: PreviewService;
  resolvePrincipal: (input: {
    cookieHeader: string | undefined;
  }) => Promise<UserPrincipal | undefined>;
  /**
   * Resolved per request so the store is created only when the authoritative
   * database is configured, and so tests can inject their own.
   */
  store: () => ProjectStateStore;
}

/**
 * The slice of a Hono request these handlers use beyond the shared surface.
 * Declaring it structurally keeps the handlers unit-testable without a server,
 * and Hono's real context stays assignable.
 */
export type PreviewHandlerContext = HandlerContext & {
  req: {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    method?: string;
    path?: string;
    raw?: Request;
    url?: string;
  };
};

/** A request already authorized for one preview, and the preview it names. */
interface AuthorizedPreview {
  readonly previewId: PreviewId;
  readonly target: PreviewTarget;
}

type PreviewAccess = { readonly refusal: Response } | AuthorizedPreview;

async function authorizeProjectAction(input: {
  action: Permission;
  deps: PreviewRouteDeps;
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
      kind: "project",
      organizationId: input.organizationId,
      projectId: input.projectId,
      resourceId: null,
    },
  });
}

/**
 * The preview a request names, once the caller has been authenticated and
 * allowed. The scope the decision is made against comes from the preview — not
 * from the URL, and not from the caller — so a preview id cannot be used to
 * reach another tenant's project.
 */
async function authorizePreviewRequest(input: {
  context: PreviewHandlerContext;
  deps: PreviewRouteDeps;
  requestId: string;
}): Promise<PreviewAccess> {
  const principal = await input.deps.resolvePrincipal({
    cookieHeader: input.context.req.header("cookie"),
  });
  if (!principal) {
    return { refusal: unauthenticatedResponse(input.requestId) };
  }

  const params = PreviewParamsSchema.safeParse({
    previewId: input.context.req.param("previewId"),
  });
  if (!params.success) {
    return {
      refusal: apiErrorResponse({
        code: "invalid_request",
        message: "A preview id is required.",
        requestId: input.requestId,
      }),
    };
  }

  const target = await input.deps.previews.target(params.data.previewId);
  if (target === undefined) {
    return {
      refusal: apiErrorResponse({
        code: "not_found",
        message: "No such preview.",
        requestId: input.requestId,
      }),
    };
  }

  const decision = await authorizeProjectAction({
    action: "project:read",
    deps: input.deps,
    organizationId: target.organizationId,
    principal,
    projectId: target.projectId,
  });
  if (!decision.allowed) {
    return {
      refusal: apiErrorResponse({
        code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
        message: "You are not authorized to preview this project.",
        requestId: input.requestId,
      }),
    };
  }

  return { previewId: params.data.previewId, target };
}

/**
 * The path the app should see, relative to the preview's own mount point. The
 * client's full path is used rather than a wildcard parameter so the result
 * does not depend on how the route was mounted under a base path.
 */
function upstreamPathOf(requestPath: string, previewId: string): string {
  const marker = `${PREVIEW_PUBLIC_PATH_PREFIX}/${previewId}`;
  const index = requestPath.indexOf(marker);
  if (index === -1) {
    return "/";
  }

  const rest = requestPath.slice(index + marker.length);
  if (rest.length === 0) {
    return "/";
  }
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** The client's query string, taken verbatim so its encoding survives the hop. */
function searchOf(requestUrl: string | undefined): string {
  if (requestUrl === undefined) {
    return "";
  }
  const index = requestUrl.indexOf("?");
  return index === -1 ? "" : requestUrl.slice(index);
}

/** The client's headers, minus the ones this hop owns. */
function forwardedHeadersOf(original: Headers | undefined): Headers {
  const headers = new Headers(original);
  for (const name of [
    ...STRIPPED_REQUEST_HEADERS,
    ...STRIPPED_CREDENTIAL_HEADERS,
  ]) {
    headers.delete(name);
  }
  return headers;
}

/**
 * Sends one request to the app and returns its answer. A body is streamed back
 * as it arrives, under the app's own content type, with the framing policy
 * applied and the app's own framing headers removed.
 */
async function forwardToPreview(input: {
  body: ArrayBuffer | undefined;
  headers: Headers;
  method: string;
  url: string;
  requestId: string;
}): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(input.url, {
      body: input.body,
      headers: input.headers,
      method: input.method,
      redirect: "manual",
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return apiErrorResponse({
      code: "internal",
      message: timedOut
        ? `The preview did not answer within ${PROXY_TIMEOUT_MS / 1000} seconds.`
        : "The preview is not answering requests.",
      requestId: input.requestId,
    });
  }

  const headers = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  headers.set("Content-Security-Policy", PREVIEW_FRAME_ANCESTORS);

  return new Response(upstream.body, {
    headers,
    status: upstream.status,
  });
}

export function createPreviewHandlers(deps: PreviewRouteDeps) {
  return {
    /**
     * Starts — or adopts — the one live preview for this build session. The
     * request is answered as soon as the preview exists: a preview is ready
     * when its status says so, so the panel polls rather than holding one
     * request open for as long as the app takes to boot.
     */
    create: async (c: PreviewHandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();

      const principal = await deps.resolvePrincipal({
        cookieHeader: c.req.header("cookie"),
      });
      if (!principal) {
        return unauthenticatedResponse(rid);
      }

      const buildSessionId = BuildSessionIdSchema.safeParse(
        c.req.param("buildSessionId")
      );
      const scope = PreviewScopeQuerySchema.safeParse({
        organizationId: c.req.query("organizationId"),
        projectId: c.req.query("projectId"),
      });
      if (!(buildSessionId.success && scope.success)) {
        return apiErrorResponse({
          code: "invalid_request",
          message:
            "A build session id and both scope identifiers are required.",
          requestId: rid,
        });
      }

      const decision = await authorizeProjectAction({
        action: "project:read",
        deps,
        organizationId: scope.data.organizationId,
        principal,
        projectId: scope.data.projectId,
      });
      if (!decision.allowed) {
        return apiErrorResponse({
          code: DENIAL_BY_REASON[decision.reason] ?? "forbidden",
          message: "You are not authorized to preview this project.",
          requestId: rid,
        });
      }

      // A preview is only ever of a session in the caller's own scope, so a
      // session in another tenant is indistinguishable from one that is absent.
      const buildSession = await deps.store().getBuildSession(
        {
          organizationId: scope.data.organizationId,
          projectId: scope.data.projectId,
        },
        buildSessionId.data
      );
      if (!buildSession) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such build session.",
          requestId: rid,
        });
      }

      const preview = await deps.previews.start({
        buildSessionId: buildSessionId.data,
        organizationId: scope.data.organizationId,
        projectId: scope.data.projectId,
      });

      return c.json(preview, 202);
    },

    /**
     * Forwards one request to the running app and streams its answer back. A
     * preview that has not reached `ready` is refused here, with the reason it
     * gave, rather than proxied to a port nothing is listening on.
     */
    proxy: async (c: PreviewHandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const access = await authorizePreviewRequest({
        context: c,
        deps,
        requestId: rid,
      });
      if ("refusal" in access) {
        return access.refusal;
      }

      const { previewId, target } = access;
      const { detail, hostPort, status } = target;
      if (status !== "ready" || hostPort === null) {
        return apiErrorResponse({
          code: "conflict",
          message: detail ?? "This preview is not serving requests yet.",
          requestId: rid,
        });
      }

      const method = (c.req.method ?? "GET").toUpperCase();
      return await forwardToPreview({
        // A body is forwarded as it arrived; a bodyless method is sent with
        // none, which is what a framework expects for `GET` and `HEAD`.
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : await c.req.arrayBuffer?.(),
        headers: forwardedHeadersOf(c.req.raw?.headers),
        method,
        requestId: rid,
        url: `http://127.0.0.1:${hostPort}${upstreamPathOf(
          c.req.path ?? "",
          previewId
        )}${searchOf(c.req.url)}`,
      });
    },

    /** The current state of one preview, scoped to the preview's own tenant. */
    status: async (c: PreviewHandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const access = await authorizePreviewRequest({
        context: c,
        deps,
        requestId: rid,
      });
      if ("refusal" in access) {
        return access.refusal;
      }

      const report = await deps.previews.status(access.previewId);
      if (report === undefined) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such preview.",
          requestId: rid,
        });
      }

      return c.json(report.view, 200);
    },

    /** Tears the preview down, container included. Safe to repeat. */
    stop: async (c: PreviewHandlerContext): Promise<Response> => {
      const rid = c.req.header("x-request-id") ?? crypto.randomUUID();
      const access = await authorizePreviewRequest({
        context: c,
        deps,
        requestId: rid,
      });
      if ("refusal" in access) {
        return access.refusal;
      }

      const stopped = await deps.previews.stop(access.previewId);
      if (stopped === undefined) {
        return apiErrorResponse({
          code: "not_found",
          message: "No such preview.",
          requestId: rid,
        });
      }

      return c.json(stopped, 202);
    },
  };
}

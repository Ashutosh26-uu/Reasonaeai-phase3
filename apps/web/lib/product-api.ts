import { CSRF_COOKIE, CSRF_HEADER } from "@reasonateai/contracts/auth";
import { networkManager } from "./network-state";

/**
 * The product API, as the browser calls it.
 *
 * One place owns how a request is authenticated and how a failure is turned
 * into a message a person can read, so a route added later cannot invent its own
 * CSRF header or lose the server's own explanation of a refusal.
 */

function csrfToken(): string | undefined {
  const cookie = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return cookie
    ? decodeURIComponent(cookie.slice(CSRF_COOKIE.length + 1))
    : undefined;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    message: string,
    requestId?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApiRequestError";
    this.status = status;
    this.requestId = requestId;
  }
}

export async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {}
): Promise<T> {
  const csrf = csrfToken();
  const requestId = crypto.randomUUID();
  const diagnose = (status: number, reason: string) =>
    console.warn(
      JSON.stringify({
        event: "product.request.failed",
        path: path.split("?")[0],
        reason,
        requestId,
        status,
      })
    );
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "x-request-id": requestId,
      ...(init.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(csrf && init.method && init.method !== "GET"
        ? { [CSRF_HEADER]: csrf }
        : {}),
      ...init.headers,
    },
  }).catch((cause: unknown) => {
    if (init.signal?.aborted) {
      const reason: unknown = init.signal.reason;
      const timedOut =
        reason instanceof DOMException && reason.name === "TimeoutError";
      diagnose(0, timedOut ? "request_timeout" : "request_aborted");
      // Cancelling one request does not establish that the live stream or
      // network is offline. Preserve the request failure for its caller.
      throw new Error(
        timedOut
          ? "The product API request timed out. Retry the request."
          : "The product API request was cancelled.",
        { cause }
      );
    }
    diagnose(0, "network_or_timeout");
    networkManager.notifyNetworkFailure();
    throw new Error(
      "The product API could not be reached. Retry when the connection returns.",
      { cause }
    );
  });
  networkManager.notifyNetworkSuccess();
  let body: unknown;
  let unreadable = false;
  let decodingFailure: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    unreadable = true;
    decodingFailure = cause;
  }
  if (unreadable) {
    diagnose(response.status, "non_json_response");
    const message =
      response.status === 404
        ? "This feature is unavailable in the running API (404). Restart the API with the latest branch, then retry."
        : `The product API returned an unreadable response (${response.status}). Retry when the service is ready.`;
    throw new ApiRequestError(response.status, message, requestId, {
      cause: decodingFailure,
    });
  }
  if (!response.ok) {
    diagnose(response.status, "api_refusal");
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        throw new ApiRequestError(response.status, error.message);
      }
    }
    throw new ApiRequestError(
      response.status,
      `Request failed (${response.status}).`
    );
  }
  return parse(body);
}

/** The scope every project route requires, as a query string. */
export const scopeQuery = (organizationId: string, projectId: string) =>
  `organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;

export function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

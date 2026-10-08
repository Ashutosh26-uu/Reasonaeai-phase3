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
  readonly code: string | undefined;

  constructor(
    status: number,
    message: string,
    requestId?: string,
    options?: ErrorOptions & { code?: string | undefined }
  ) {
    super(message, options);
    this.name = "ApiRequestError";
    this.status = status;
    this.requestId = requestId;
    this.code = options?.code;
  }
}

function extractApiError(
  body: unknown
): { code?: string | undefined; message: string } | undefined {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as {
      error?: { code?: unknown; message?: unknown };
    };
    if (
      typeof error === "object" &&
      error !== null &&
      typeof error.message === "string"
    ) {
      const code = typeof error.code === "string" ? error.code : undefined;
      return { code, message: error.message };
    }
  }
  return undefined;
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
    const parsedError = extractApiError(body);
    if (parsedError) {
      throw new ApiRequestError(
        response.status,
        parsedError.message,
        undefined,
        parsedError.code ? { code: parsedError.code } : undefined
      );
    }
    throw new ApiRequestError(
      response.status,
      `Request failed (${response.status}).`,
      requestId
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

export interface SynthesizeSpeechInput {
  format?: string;
  organizationId: string;
  projectId: string;
  speed?: number;
  text: string;
  voice?: string;
}

/**
 * Requests speech synthesis for a text string, returning an audio Blob.
 */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput
): Promise<Blob> {
  const csrf = csrfToken();
  const requestId = crypto.randomUUID();
  const path = `/v1/voice/speech?${scopeQuery(input.organizationId, input.projectId)}`;

  const diagnose = (status: number, reason: string) =>
    console.warn(
      JSON.stringify({
        event: "product.speech.failed",
        path: "/v1/voice/speech",
        reason,
        requestId,
        status,
      })
    );

  const payload: Record<string, unknown> = {
    text: input.text,
  };
  if (input.voice !== undefined) {
    payload.voice = input.voice;
  }
  if (input.format !== undefined) {
    payload.format = input.format;
  }
  if (input.speed !== undefined) {
    payload.speed = input.speed;
  }

  const response = await fetch(path, {
    body: JSON.stringify(payload),
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
    },
    method: "POST",
  }).catch((cause: unknown) => {
    diagnose(0, "network_or_timeout");
    networkManager.notifyNetworkFailure();
    throw new Error(
      "The speech synthesis service could not be reached. Retry when the connection returns.",
      { cause }
    );
  });

  networkManager.notifyNetworkSuccess();

  if (!response.ok) {
    diagnose(response.status, "speech_refusal");
    let refusalBody: unknown;
    try {
      refusalBody = await response.json();
    } catch {
      // Body not JSON
    }

    const parsedError = extractApiError(refusalBody);
    if (parsedError) {
      let errorCode = parsedError.code;
      if (!errorCode && response.status === 503) {
        errorCode = "voice_unconfigured";
      }
      throw new ApiRequestError(
        response.status,
        parsedError.message,
        requestId,
        errorCode ? { code: errorCode } : undefined
      );
    }

    throw new ApiRequestError(
      response.status,
      `Speech synthesis failed (${response.status}).`,
      requestId,
      response.status === 503 ? { code: "voice_unconfigured" } : undefined
    );
  }

  return await response.blob();
}

export interface ExportWorkspaceZipInput {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  projectName?: string | undefined;
}

/**
 * Requests an exported standard ZIP archive of the project workspace source code,
 * cleanly excluding repository metadata, dependencies, caches, and build artifacts.
 */
export async function exportWorkspaceZip(
  input: ExportWorkspaceZipInput
): Promise<Blob> {
  const csrf = csrfToken();
  const requestId = crypto.randomUUID();
  const query = new URLSearchParams({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (input.projectName) {
    query.set("projectName", input.projectName);
  }
  const path = `/v1/build-sessions/${encodeURIComponent(input.buildSessionId)}/workspace/export?${query.toString()}`;

  const diagnose = (status: number, reason: string) =>
    console.warn(
      JSON.stringify({
        event: "product.workspace_export.failed",
        path: path.split("?")[0],
        reason,
        requestId,
        status,
      })
    );

  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "x-request-id": requestId,
      ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
    },
    method: "GET",
  }).catch((cause: unknown) => {
    diagnose(0, "network_or_timeout");
    networkManager.notifyNetworkFailure();
    throw new Error(
      "The workspace export service could not be reached. Retry when the connection returns.",
      { cause }
    );
  });

  networkManager.notifyNetworkSuccess();

  if (!response.ok) {
    diagnose(response.status, "export_refusal");
    let refusalBody: unknown;
    try {
      refusalBody = await response.json();
    } catch {
      // Body not JSON
    }

    const parsedError = extractApiError(refusalBody);
    if (parsedError) {
      throw new ApiRequestError(
        response.status,
        parsedError.message,
        requestId,
        parsedError.code ? { code: parsedError.code } : undefined
      );
    }

    throw new ApiRequestError(
      response.status,
      `Workspace export failed (${response.status}).`,
      requestId
    );
  }

  return await response.blob();
}

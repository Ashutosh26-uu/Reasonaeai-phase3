import { CSRF_COOKIE, CSRF_HEADER } from "@reasonateai/contracts/auth";

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

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {}
): Promise<T> {
  const csrf = csrfToken();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(csrf && init.method && init.method !== "GET"
        ? { [CSRF_HEADER]: csrf }
        : {}),
      ...init.headers,
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error("The product API is unavailable.", { cause });
  }
  if (!response.ok) {
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

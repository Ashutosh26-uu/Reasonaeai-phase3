import { randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import { connect, type Socket } from "node:net";
import {
  PREVIEW_PUBLIC_PATH_PREFIX,
  type PreviewId,
  PreviewIdSchema,
} from "./preview-service.js";
import { apiErrorResponse } from "./principal.js";
import {
  authorizePreviewAccess,
  type PreviewAuthorizationDeps,
} from "./routes/previews.js";

const MAX_CONNECTIONS_PER_PREVIEW = 16;
const MAX_TOTAL_CONNECTIONS = 256;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
const INVALID_REQUEST_TARGET = /[\r\n]/;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface PreviewUpgradeTarget {
  readonly path: string;
  readonly previewId: PreviewId;
}

function parseTarget(
  requestTarget: string | undefined
): PreviewUpgradeTarget | undefined {
  if (
    !requestTarget?.startsWith("/") ||
    INVALID_REQUEST_TARGET.test(requestTarget)
  ) {
    return;
  }

  const [path] = requestTarget.split("?", 1);
  if (!path) {
    return;
  }
  const prefix = `${PREVIEW_PUBLIC_PATH_PREFIX}/`;
  if (!path.startsWith(prefix)) {
    return;
  }

  const pathAfterPrefix = path.slice(prefix.length);
  const slash = pathAfterPrefix.indexOf("/");
  const rawPreviewId =
    slash === -1 ? pathAfterPrefix : pathAfterPrefix.slice(0, slash);
  const rest = slash === -1 ? "" : pathAfterPrefix.slice(slash);
  const previewId = PreviewIdSchema.safeParse(rawPreviewId);
  if (!previewId.success || rest === "/status") {
    return;
  }

  return { path, previewId: previewId.data };
}

function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined
): boolean {
  if (!(origin && host) || origin.includes(",")) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isWebSocketHandshake(request: IncomingMessage): boolean {
  const {
    connection,
    upgrade,
    "sec-websocket-key": key,
    "sec-websocket-version": version,
  } = request.headers;

  if (
    request.method !== "GET" ||
    typeof key !== "string" ||
    typeof version !== "string" ||
    version !== "13" ||
    typeof connection !== "string" ||
    typeof upgrade !== "string" ||
    upgrade.toLowerCase() !== "websocket"
  ) {
    return false;
  }

  const connectionTokens = connection
    .split(",")
    .map((token) => token.trim().toLowerCase());
  const decodedKey = Buffer.from(key, "base64");
  return (
    connectionTokens.includes("upgrade") &&
    decodedKey.byteLength === 16 &&
    decodedKey.toString("base64") === key
  );
}

async function refuseUpgrade(
  socket: Socket,
  response: Response
): Promise<void> {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.delete("transfer-encoding");
  headers.set("Connection", "close");
  headers.set("Content-Length", String(body.byteLength));

  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? "Error"}`,
    ...[...headers].map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

function upgradeError(status: number, message: string): Response {
  return new Response(message, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status,
  });
}

function connectToPreview(hostPort: number): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const upstream = connect({ host: "127.0.0.1", port: hostPort });
    let settled = false;
    const finish = (socket: Socket | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      upstream.off("connect", onConnect);
      upstream.off("error", onError);
      resolve(socket);
    };
    const onConnect = () => finish(upstream);
    const onError = () => finish(undefined);
    const timer = setTimeout(() => {
      upstream.destroy();
      finish(undefined);
    }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);
    upstream.once("connect", onConnect);
    upstream.once("error", onError);
  });
}

function requestHeaders(request: IncomingMessage): string[] {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  for (const token of (request.headers.connection ?? "").split(",")) {
    if (token.trim()) {
      blocked.add(token.trim().toLowerCase());
    }
  }
  for (const name of [
    "authorization",
    "cookie",
    "content-length",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) {
    blocked.add(name);
  }

  const lines: string[] = [];
  const { rawHeaders } = request;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name && value !== undefined && !blocked.has(name.toLowerCase())) {
      lines.push(`${name}: ${value}`);
    }
  }

  return lines;
}

type UpgradeAuthorization =
  | { readonly refusal: Response }
  | { readonly hostPort: number };

async function authorizeUpgrade(input: {
  deps: PreviewAuthorizationDeps;
  request: IncomingMessage;
  previewId: PreviewId;
  requestId: string;
}): Promise<UpgradeAuthorization> {
  const { deps, previewId, request, requestId } = input;
  if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
    return {
      refusal: upgradeError(403, "This preview origin is not allowed."),
    };
  }
  if (!isWebSocketHandshake(request)) {
    return {
      refusal: upgradeError(400, "A valid WebSocket handshake is required."),
    };
  }

  const access = await authorizePreviewAccess({
    cookieHeader: request.headers.cookie,
    deps,
    previewId,
    requestId,
  });
  if ("refusal" in access) {
    return { refusal: access.refusal };
  }

  const { detail, hostPort, status } = access.target;
  if (status !== "ready" || hostPort === null) {
    return {
      refusal: apiErrorResponse({
        code: "conflict",
        message: detail ?? "This preview is not serving requests yet.",
        requestId,
      }),
    };
  }

  return { hostPort };
}

function appPathOf(path: string, previewId: PreviewId): string {
  const prefix = `${PREVIEW_PUBLIC_PATH_PREFIX}/${previewId}`;
  const suffix = path.slice(prefix.length);
  if (!suffix) {
    return "/";
  }
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

async function forwardUpgrade(input: {
  head: Buffer;
  hostPort: number;
  request: IncomingMessage;
  socket: Socket;
  target: PreviewUpgradeTarget;
}): Promise<void> {
  const { head, hostPort, request, socket, target } = input;
  const upstream = await connectToPreview(hostPort);
  if (!upstream || socket.destroyed) {
    upstream?.destroy();
    await refuseUpgrade(
      socket,
      upgradeError(502, "The preview app is not answering.")
    );
    return;
  }

  const requestTarget = request.url ?? "/";
  const queryIndex = requestTarget.indexOf("?");
  const search = queryIndex === -1 ? "" : requestTarget.slice(queryIndex);
  const requestLine = `GET ${appPathOf(target.path, target.previewId)}${search} HTTP/${request.httpVersion}`;
  const headers = requestHeaders(request);
  headers.unshift(`Host: 127.0.0.1:${hostPort}`);
  headers.push("Connection: Upgrade", "Upgrade: websocket");

  const handshakeTimer = setTimeout(() => {
    upstream.destroy();
    socket.destroy();
  }, UPSTREAM_HANDSHAKE_TIMEOUT_MS);
  upstream.once("data", () => clearTimeout(handshakeTimer));
  socket.once("close", () => {
    clearTimeout(handshakeTimer);
    upstream.destroy();
  });
  socket.once("end", () => {
    upstream.destroy();
    socket.destroy();
  });
  upstream.once("close", () => clearTimeout(handshakeTimer));
  socket.once("error", () => upstream.destroy());
  upstream.once("error", () => socket.destroy());
  upstream.once("close", () => socket.destroy());

  upstream.write(`${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n`);
  if (head.byteLength > 0) {
    upstream.write(head);
  }

  socket.pipe(upstream);
  upstream.pipe(socket);
  socket.resume();
}

async function proxyUpgrade(input: {
  deps: PreviewAuthorizationDeps;
  head: Buffer;
  request: IncomingMessage;
  requestId: string;
  socket: Socket;
  target: PreviewUpgradeTarget;
}): Promise<void> {
  const authorization = await authorizeUpgrade({
    deps: input.deps,
    previewId: input.target.previewId,
    request: input.request,
    requestId: input.requestId,
  });
  if ("refusal" in authorization) {
    await refuseUpgrade(input.socket, authorization.refusal);
    return;
  }

  await forwardUpgrade({
    head: input.head,
    hostPort: authorization.hostPort,
    request: input.request,
    socket: input.socket,
    target: input.target,
  });
}

async function rejectProxyFailure(socket: Socket, requestId: string) {
  if (socket.destroyed) {
    return;
  }
  await refuseUpgrade(
    socket,
    apiErrorResponse({
      code: "internal",
      message: "The preview connection could not be opened.",
      requestId,
    })
  );
}

/**
 * Bridges only authenticated WebSocket upgrades for a ready preview. It
 * tunnels the original RFC 6455 handshake and frames to the selected app
 * through the existing loopback relay; it does not terminate WebSockets or
 * create another sandbox.
 */
export function attachPreviewUpgradeProxy(
  server: Server,
  deps: PreviewAuthorizationDeps
): () => void {
  const sockets = new Set<Socket>();
  const previewSockets = new Map<string, Set<Socket>>();

  const onUpgrade = async (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ) => {
    const target = parseTarget(request.url);
    if (!target) {
      socket.destroy();
      return;
    }

    const activeForPreview = previewSockets.get(target.previewId);
    if (
      sockets.size >= MAX_TOTAL_CONNECTIONS ||
      (activeForPreview?.size ?? 0) >= MAX_CONNECTIONS_PER_PREVIEW
    ) {
      refuseUpgrade(
        socket,
        upgradeError(429, "Preview connection limit reached.")
      ).catch(() => socket.destroy());
      return;
    }

    sockets.add(socket);
    const currentPreviewSockets = activeForPreview ?? new Set<Socket>();
    currentPreviewSockets.add(socket);
    previewSockets.set(target.previewId, currentPreviewSockets);

    const cleanup = () => {
      sockets.delete(socket);
      currentPreviewSockets.delete(socket);
      if (currentPreviewSockets.size === 0) {
        previewSockets.delete(target.previewId);
      }
    };
    socket.once("close", cleanup);

    socket.pause();
    const requestId =
      typeof request.headers["x-request-id"] === "string"
        ? request.headers["x-request-id"]
        : randomUUID();
    try {
      await proxyUpgrade({ deps, head, request, requestId, socket, target });
    } catch {
      await rejectProxyFailure(socket, requestId).catch(() => socket.destroy());
    }
  };

  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    previewSockets.clear();
  };
}

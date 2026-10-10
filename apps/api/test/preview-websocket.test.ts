import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  OrganizationIdSchema,
  OrganizationMembershipSchema,
  ProjectIdSchema,
  ProjectMembershipSchema,
  SessionIdSchema,
  UserIdSchema,
  UserPrincipalSchema,
} from "@reasonateai/contracts/identity";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewIdSchema } from "../src/mastra/preview-service.js";
import { attachPreviewUpgradeProxy } from "../src/mastra/preview-websocket.js";
import type { PreviewAuthorizationDeps } from "../src/mastra/routes/previews.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEST_KEY = randomBytes(16).toString("base64");

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The test listener has no TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readUntil(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const value = received.toString("latin1");
      if (value.includes(marker)) {
        cleanup();
        resolve(value);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([7, 31, 59, 83]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: RFC 6455 requires XOR masking client frame payloads.
    masked[index] = (masked[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([
    Buffer.from([0x81, 128 + payload.length]),
    mask,
    masked,
  ]);
}

function unmaskTextFrame(frame: Buffer): string | undefined {
  if (frame.length < 6 || frame[0] !== 0x81 || (frame[1] ?? 0) < 128) {
    return;
  }
  const size = (frame[1] ?? 0) % 128;
  if (frame.length < size + 6) {
    return;
  }
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, size + 6));
  for (let index = 0; index < payload.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: RFC 6455 requires XOR masking client frame payloads.
    payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return payload.toString("utf8");
}

function readSocketData(
  socket: Socket,
  predicate: (data: Buffer) => boolean
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (predicate(received)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function authorizedDependencies(input: {
  hostPort: number;
  previewId: string;
}): PreviewAuthorizationDeps {
  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const userId = UserIdSchema.parse(randomUUID());
  const previewId = PreviewIdSchema.parse(input.previewId);
  const principal = UserPrincipalSchema.parse({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "user",
    revokedAt: null,
    sessionId: SessionIdSchema.parse(randomUUID()),
    userId,
  });

  return {
    previews: {
      target: async (requestedId) =>
        requestedId === previewId
          ? {
              detail: null,
              hostPort: input.hostPort,
              organizationId,
              projectId,
              status: "ready",
            }
          : undefined,
    },
    resolvePrincipal: async ({ cookieHeader }) =>
      cookieHeader === "reasonate_session=session-cookie"
        ? principal
        : undefined,
    store: () => ({
      memberships: {
        getOrganizationMembership: async () =>
          OrganizationMembershipSchema.parse({
            organizationId,
            role: "owner",
            status: "active",
            userId,
          }),
        getProjectMembership: async () =>
          ProjectMembershipSchema.parse({
            organizationId,
            projectId,
            role: "builder",
            status: "active",
            userId,
          }),
      },
    }),
  };
}

describe("preview WebSocket upgrade proxy", () => {
  const servers: Server[] = [];
  const sockets: Pick<Duplex, "destroy">[] = [];
  const detachHandlers: Array<() => void> = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const detach of detachHandlers.splice(0)) {
      detach();
    }
    await Promise.all(servers.splice(0).map(close));
  });

  it("authorizes, strips product credentials, and tunnels handshake plus frames", async () => {
    const previewId = PreviewIdSchema.parse(randomUUID());
    let receivedPath: string | undefined;
    let receivedCookie: string | undefined;
    let receivedAuthorization: string | undefined;
    let receivedProtocol: string | undefined;

    const app = createServer();
    app.on("upgrade", (request, socket, head) => {
      sockets.push(socket);
      receivedPath = request.url;
      receivedCookie = request.headers.cookie;
      receivedAuthorization = request.headers.authorization;
      receivedProtocol = request.headers["sec-websocket-protocol"];
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: app-v1\r\n\r\n`
      );
      if (head.length > 0) {
        socket.write(head);
      }
      socket.on("data", (frame) => {
        const message = unmaskTextFrame(frame);
        if (message !== undefined) {
          const payload = Buffer.from(message);
          socket.write(
            Buffer.concat([Buffer.from([0x81, payload.length]), payload])
          );
        }
      });
    });
    servers.push(app);
    const appPort = await listen(app);

    const api = createServer();
    servers.push(api);
    detachHandlers.push(
      attachPreviewUpgradeProxy(
        api,
        authorizedDependencies({ hostPort: appPort, previewId })
      )
    );
    const apiPort = await listen(api);
    const client = await connect(apiPort);
    sockets.push(client);

    client.write(
      [
        `GET /v1/previews/${previewId}/socket?view=live HTTP/1.1`,
        `Host: 127.0.0.1:${apiPort}`,
        `Origin: http://127.0.0.1:${apiPort}`,
        "Connection: keep-alive, Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${TEST_KEY}`,
        "Sec-WebSocket-Protocol: app-v1",
        "Cookie: reasonate_session=session-cookie",
        "Authorization: Bearer product-secret",
        "",
        "",
      ].join("\r\n")
    );

    const response = await readUntil(client, "\r\n\r\n");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(response).toContain("Sec-WebSocket-Protocol: app-v1");
    expect(receivedPath).toBe("/socket?view=live");
    expect(receivedCookie).toBeUndefined();
    expect(receivedAuthorization).toBeUndefined();
    expect(receivedProtocol).toBe("app-v1");

    const echoedFrame = readSocketData(client, (data) =>
      data.includes(Buffer.from("ping"))
    );
    client.write(maskedTextFrame("ping"));
    expect((await echoedFrame).toString("utf8")).toContain("ping");
  });

  it("refuses a cross-site WebSocket origin before reaching the app", async () => {
    const app = createServer();
    servers.push(app);
    const appPort = await listen(app);
    const previewId = PreviewIdSchema.parse(randomUUID());

    const api = createServer();
    servers.push(api);
    detachHandlers.push(
      attachPreviewUpgradeProxy(
        api,
        authorizedDependencies({ hostPort: appPort, previewId })
      )
    );
    const apiPort = await listen(api);
    const client = await connect(apiPort);
    sockets.push(client);
    client.write(
      [
        `GET /v1/previews/${previewId}/socket HTTP/1.1`,
        `Host: 127.0.0.1:${apiPort}`,
        "Origin: https://attacker.example",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${TEST_KEY}`,
        "",
        "",
      ].join("\r\n")
    );

    const response = await readUntil(client, "\r\n\r\n");
    expect(response).toContain("HTTP/1.1 403 Forbidden");
  });
});

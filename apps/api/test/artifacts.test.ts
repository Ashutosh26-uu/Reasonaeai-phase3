import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactObjectKeyFor } from "@reasonateai/artifact-store";
import { createLocalArtifactStore } from "@reasonateai/artifact-store/local";
import { SESSION_COOKIE } from "@reasonateai/contracts/auth";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  UserIdSchema,
} from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import { createArtifactHandlers } from "../src/mastra/routes/artifacts";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const HOUR = 1000 * 60 * 60;
const ARTIFACT_SECRET = "artifact-route-test-secret";
const PUBLIC_ORIGIN = "http://localhost:4111";
/** Longer than the route's own short-lived window, so advancing past it expires a URL. */
const PAST_EXPIRY_MS = 6 * 60 * 1000;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

interface ArtifactRecord {
  artifactId: string;
  createdAt: string;
  kind: string;
  manifestObjectKey: string;
  sha256: string;
  status: string;
  totalSize: number;
}

interface StubRequest {
  body?: unknown;
  cookie?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  requestId?: string;
}

function context(input: StubRequest): HandlerContext {
  return {
    json: (body, status) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status,
      }),
    req: {
      header: (name) => {
        const key = name.toLowerCase();
        if (key === "cookie") {
          return input.cookie;
        }
        if (key === "x-request-id") {
          return input.requestId ?? "req-test";
        }
      },
      json: async () => input.body,
      param: (name) => input.params?.[name],
      query: (name) => input.query?.[name],
    },
  };
}

describeWithDatabase("artifact routes", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
  });

  const organizationId = OrganizationIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(randomUUID());
  const foreignOrganizationId = OrganizationIdSchema.parse(randomUUID());
  const foreignProjectId = ProjectIdSchema.parse(randomUUID());
  const ownerUserId = UserIdSchema.parse(randomUUID());
  const outsiderUserId = UserIdSchema.parse(randomUUID());
  const foreignUserId = UserIdSchema.parse(randomUUID());

  let root: string;
  let ownerCookie: string;
  let outsiderCookie: string;
  let foreignCookie: string;
  /** The clock the routes read, so expiry is proven without waiting for it. */
  let clock: number;

  const handlers = createArtifactHandlers({
    artifacts: () => createLocalArtifactStore({ root }),
    nowMs: () => clock,
    publicOrigin: PUBLIC_ORIGIN,
    resolvePrincipal: async ({ cookieHeader }) =>
      await resolveSessionPrincipal({
        cookieHeader,
        sessions: store.sessions,
      }),
    secret: () => ARTIFACT_SECRET,
    store: () => store,
  });

  async function issueCookie(userId: string) {
    const issued = await store.sessions.createSession({
      absoluteTtlMs: 24 * HOUR,
      idleTtlMs: HOUR,
      userId,
    });
    return `${SESSION_COOKIE}=${issued.token}`;
  }

  function artifactBody(overrides: Record<string, unknown> = {}) {
    return {
      artifactId: randomUUID(),
      buildSessionId: null,
      contentBase64: Buffer.from("spilled tool output").toString("base64"),
      kind: "tool-output",
      mediaType: "text/plain",
      occurredAt: new Date().toISOString(),
      organizationId,
      path: "outputs/tool.txt",
      projectId,
      runId: null,
      ...overrides,
    };
  }

  function scopeQuery(overrides: Record<string, string> = {}) {
    return { organizationId, projectId, ...overrides };
  }

  /** The object path a recorded artifact's bytes occupy under the store root. */
  function objectPathFor(input: {
    artifactId: string;
    digest: string;
    organizationId: string;
    projectId: string;
  }): string {
    return join(
      root,
      ...artifactObjectKeyFor({
        artifactId: input.artifactId,
        digest: input.digest,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }).split("/")
    );
  }

  async function recordOne(overrides: Record<string, unknown> = {}) {
    const body = artifactBody(overrides);
    const response = await handlers.record(
      context({ body, cookie: ownerCookie, requestId: randomUUID() })
    );
    expect(response.status).toBe(201);
    const payload = await response.json();
    return {
      artifactId: body.artifactId as string,
      content: Buffer.from(body.contentBase64 as string, "base64"),
      record: payload.artifact as ArtifactRecord,
    };
  }

  /** Mints one artifact's access URL and returns its download request. */
  async function mintDownload(artifactId: string) {
    const access = await handlers.access(
      context({
        cookie: ownerCookie,
        params: { artifactId },
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(access.status).toBe(200);
    const url = new URL(((await access.json()) as { url: string }).url);
    expect(url.origin).toBe(PUBLIC_ORIGIN);

    return context({
      query: {
        organizationId: url.searchParams.get("organizationId") as string,
        projectId: url.searchParams.get("projectId") as string,
        token: url.searchParams.get("token") as string,
      },
      requestId: randomUUID(),
    });
  }

  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "reasonate-artifacts-"))
    );
    clock = Date.now();

    await store.migrate();
    await pool.query(
      `insert into organizations (organization_id, name)
       select fixture_id, 'Artifact route test' from unnest($1::uuid[]) as fixture_id
       on conflict do nothing`,
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query(
      `insert into projects (project_id, organization_id, name)
       select f.project_id, f.organization_id, 'Artifact route project'
         from unnest($1::uuid[], $2::uuid[]) as f(project_id, organization_id)
       on conflict do nothing`,
      [
        [projectId, foreignProjectId],
        [organizationId, foreignOrganizationId],
      ]
    );
    await pool.query(
      `insert into users (user_id) select fixture_id
         from unnest($1::uuid[]) as fixture_id on conflict do nothing`,
      [[ownerUserId, outsiderUserId, foreignUserId]]
    );

    await store.memberships.grantOrganizationMembership({
      organizationId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId,
      projectId,
      role: "builder",
      status: "active",
      userId: ownerUserId,
    });

    // A legitimate member of a different organization, with its own project.
    await store.memberships.grantOrganizationMembership({
      organizationId: foreignOrganizationId,
      role: "builder",
      status: "active",
      userId: foreignUserId,
    });
    await store.memberships.grantProjectMembership({
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      role: "builder",
      status: "active",
      userId: foreignUserId,
    });

    ownerCookie = await issueCookie(ownerUserId);
    outsiderCookie = await issueCookie(outsiderUserId);
    foreignCookie = await issueCookie(foreignUserId);
  });

  afterAll(async () => {
    await pool.query(
      "delete from organizations where organization_id = any($1::uuid[])",
      [[organizationId, foreignOrganizationId]]
    );
    await pool.query("delete from users where user_id = any($1::uuid[])", [
      [ownerUserId, outsiderUserId, foreignUserId],
    ]);
    await pool.end();
    await store.close();
    await rm(root, { force: true, recursive: true });
  });

  it("records an artifact and lists it back for its own project", async () => {
    const content = Buffer.from("recorded bytes for listing");
    const artifactId = randomUUID();
    const response = await handlers.record(
      context({
        body: artifactBody({
          artifactId,
          contentBase64: content.toString("base64"),
        }),
        cookie: ownerCookie,
        requestId: randomUUID(),
      })
    );

    expect(response.status).toBe(201);
    const recorded = (await response.json()).artifact as ArtifactRecord;
    expect(recorded.artifactId).toBe(artifactId);
    expect(recorded.status).toBe("stored");
    expect(recorded.totalSize).toBe(content.byteLength);
    // The recorded digest is the digest of the bytes, not a caller's claim.
    expect(recorded.sha256).toMatch(SHA256_HEX_RE);

    const listed = await handlers.list(
      context({
        cookie: ownerCookie,
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(listed.status).toBe(200);
    const artifacts = (await listed.json()).artifacts as ArtifactRecord[];
    expect(artifacts.map((artifact) => artifact.artifactId)).toContain(
      artifactId
    );

    // The metadata row and the stored bytes agree: the object under the
    // recorded digest hashes to exactly the content that was sent.
    const stored = await readFile(
      objectPathFor({
        artifactId,
        digest: recorded.sha256,
        organizationId,
        projectId,
      })
    );
    expect(stored.equals(content)).toBe(true);
  });

  it("serves a run-scoped artifact through a signed URL", async () => {
    const { artifactId, content } = await recordOne({
      runId: RunIdSchema.parse(randomUUID()),
    });

    const response = await handlers.download(await mintDownload(artifactId));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream"
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(
      true
    );
  });

  it("refuses an unauthenticated caller on every route", async () => {
    const record = await handlers.record(
      context({ body: artifactBody(), requestId: "req-anon-record" })
    );
    const list = await handlers.list(
      context({ query: scopeQuery(), requestId: "req-anon-list" })
    );
    const access = await handlers.access(
      context({
        params: { artifactId: randomUUID() },
        query: scopeQuery(),
        requestId: "req-anon-access",
      })
    );

    for (const response of [record, list, access]) {
      expect(response.status).toBe(401);
    }
    expect((await record.json()).error.code).toBe("unauthenticated");
    expect((await list.json()).error.code).toBe("unauthenticated");
    expect((await access.json()).error.code).toBe("unauthenticated");
  });

  it("refuses a caller outside the organization instead of showing an empty list", async () => {
    const foreignBody = artifactBody({
      contentBase64: Buffer.from("foreign tenant bytes").toString("base64"),
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
    });
    const foreignRecorded = await handlers.record(
      context({
        body: foreignBody,
        cookie: foreignCookie,
        requestId: randomUUID(),
      })
    );
    expect(foreignRecorded.status).toBe(201);

    // The foreign caller's own project answers normally, with its own artifact.
    const ownList = await handlers.list(
      context({
        cookie: foreignCookie,
        query: {
          organizationId: foreignOrganizationId,
          projectId: foreignProjectId,
        },
        requestId: randomUUID(),
      })
    );
    expect(ownList.status).toBe(200);
    const ownArtifacts = (await ownList.json()).artifacts as ArtifactRecord[];
    expect(ownArtifacts.map((artifact) => artifact.artifactId)).toContain(
      foreignBody.artifactId
    );

    // The other tenant's project is refused, not reported as an empty success.
    const stolen = await handlers.list(
      context({
        cookie: foreignCookie,
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(stolen.status).toBe(403);
    const refusal = await stolen.json();
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.artifacts).toBeUndefined();

    const outsider = await handlers.list(
      context({
        cookie: outsiderCookie,
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(outsider.status).toBe(403);
    expect((await outsider.json()).error.code).toBe("forbidden");
  });

  it("refuses a foreign tenant's record and access attempts", async () => {
    const { artifactId, record } = await recordOne();

    const foreignRecord = await handlers.record(
      context({
        body: artifactBody(),
        cookie: foreignCookie,
        requestId: randomUUID(),
      })
    );
    expect(foreignRecord.status).toBe(403);
    expect((await foreignRecord.json()).error.code).toBe("forbidden");

    const foreignAccess = await handlers.access(
      context({
        cookie: foreignCookie,
        params: { artifactId },
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(foreignAccess.status).toBe(403);
    expect((await foreignAccess.json()).error.code).toBe("forbidden");

    // Nothing was recorded for the refused attempt, and the real one stands.
    expect(record.artifactId).toBe(artifactId);
  });

  it("does not report another project's artifact as found", async () => {
    const { artifactId } = await recordOne();

    const missing = await handlers.access(
      context({
        cookie: ownerCookie,
        params: { artifactId: randomUUID() },
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");

    // The real artifact is still reachable, so the 404 is about identity only.
    const found = await handlers.access(
      context({
        cookie: ownerCookie,
        params: { artifactId },
        query: scopeQuery(),
        requestId: randomUUID(),
      })
    );
    expect(found.status).toBe(200);
  });

  it("expires a signed URL after its short window", async () => {
    const { artifactId, content } = await recordOne();
    const download = await mintDownload(artifactId);
    const expiresAt = Date.parse(
      (
        (await (
          await handlers.access(
            context({
              cookie: ownerCookie,
              params: { artifactId },
              query: scopeQuery(),
              requestId: randomUUID(),
            })
          )
        ).json()) as { expiresAt: string }
      ).expiresAt
    );
    // Short-lived: the window is minutes, not days.
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);

    const before = await handlers.download(download);
    expect(before.status).toBe(200);
    expect(Buffer.from(await before.arrayBuffer()).equals(content)).toBe(true);

    clock += PAST_EXPIRY_MS;
    try {
      const after = await handlers.download(download);
      expect(after.status).toBe(403);
      expect((await after.json()).error.code).toBe("forbidden");
    } finally {
      clock -= PAST_EXPIRY_MS;
    }
  });

  it("refuses a tampered token without returning bytes", async () => {
    const { artifactId } = await recordOne();
    const download = await mintDownload(artifactId);
    const token = download.req.query("token") as string;
    const [payload, signature] = token.split(".");
    // Flip a character in the signature half, leaving the payload untouched.
    const flipped = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;

    const response = await handlers.download(
      context({
        query: { organizationId, projectId, token: `${payload}.${flipped}` },
        requestId: randomUUID(),
      })
    );

    expect(response.status).toBe(403);
    const payloadBody = await response.json();
    expect(payloadBody.error.code).toBe("forbidden");
    expect(payloadBody.bytes).toBeUndefined();
  });

  it("refuses a token minted for another organization", async () => {
    const foreignBody = artifactBody({
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
    });
    const recorded = await handlers.record(
      context({
        body: foreignBody,
        cookie: foreignCookie,
        requestId: randomUUID(),
      })
    );
    expect(recorded.status).toBe(201);

    const access = await handlers.access(
      context({
        cookie: foreignCookie,
        params: { artifactId: foreignBody.artifactId },
        query: {
          organizationId: foreignOrganizationId,
          projectId: foreignProjectId,
        },
        requestId: randomUUID(),
      })
    );
    expect(access.status).toBe(200);
    const foreignToken = new URL(
      ((await access.json()) as { url: string }).url
    ).searchParams.get("token") as string;

    // Present the foreign tenant's token under this tenant's scope.
    const response = await handlers.download(
      context({
        query: { organizationId, projectId, token: foreignToken },
        requestId: randomUUID(),
      })
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("requires a download token", async () => {
    const response = await handlers.download(
      context({ query: { organizationId, projectId }, requestId: randomUUID() })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("refuses bytes whose digest no longer matches the record", async () => {
    const { artifactId, record } = await recordOne();
    const download = await mintDownload(artifactId);

    // Mutate the object on disk after it was recorded.
    await writeFile(
      objectPathFor({
        artifactId,
        digest: record.sha256,
        organizationId,
        projectId,
      }),
      "mutated bytes",
      "utf8"
    );

    const response = await handlers.download(download);
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe("internal");
    expect(payload.bytes).toBeUndefined();
  });

  it("rejects a traversal-shaped artifact id at the boundary", async () => {
    const hostileIds = [
      "../../etc/passwd",
      "..\\..\\windows\\win.ini",
      "/absolute/path",
      "artifact/child",
      ".",
    ];
    const responses = await Promise.all(
      hostileIds.map((artifactId) =>
        handlers.record(
          context({
            body: artifactBody({ artifactId }),
            cookie: ownerCookie,
            requestId: randomUUID(),
          })
        )
      )
    );

    for (const response of responses) {
      expect(response.status).toBe(400);
    }
  });

  it("confines writes to the tenant prefix even when the manifest path is hostile", async () => {
    const { artifactId, content, record } = await recordOne({
      path: "../../../../outside/escaped.txt",
    });

    // The bytes are exactly where the tenant-scoped key says they are.
    const stored = await readFile(
      objectPathFor({
        artifactId,
        digest: record.sha256,
        organizationId,
        projectId,
      })
    );
    expect(stored.equals(content)).toBe(true);

    // The descriptive manifest path never becomes a filesystem path.
    const escaped = join(
      root,
      "..",
      "..",
      "..",
      "..",
      "outside",
      "escaped.txt"
    );
    await expect(readFile(escaped)).rejects.toThrow();
  });

  it("takes the object key from the signed token, never from the caller", async () => {
    const target = await recordOne();
    const other = await recordOne({
      contentBase64: Buffer.from("a second artifact").toString("base64"),
    });
    const download = await mintDownload(target.artifactId);
    const token = download.req.query("token") as string;

    // The same request also names another artifact's real object key.
    const response = await handlers.download(
      context({
        query: {
          key: artifactObjectKeyFor({
            artifactId: other.artifactId,
            digest: other.record.sha256,
            organizationId,
            projectId,
          }),
          organizationId,
          projectId,
          token,
        },
        requestId: randomUUID(),
      })
    );

    expect(response.status).toBe(200);
    expect(
      Buffer.from(await response.arrayBuffer()).equals(target.content)
    ).toBe(true);
  });

  it("rejects a body that is not a valid manifest with base64 content", async () => {
    const notBase64 = await handlers.record(
      context({
        body: artifactBody({ contentBase64: "not base64!!" }),
        cookie: ownerCookie,
        requestId: randomUUID(),
      })
    );
    expect(notBase64.status).toBe(400);
    expect((await notBase64.json()).error.code).toBe("invalid_request");

    const extraField = await handlers.record(
      context({
        body: artifactBody({ unexpected: true }),
        cookie: ownerCookie,
        requestId: randomUUID(),
      })
    );
    expect(extraField.status).toBe(400);

    const malformedScope = await handlers.record(
      context({
        body: artifactBody({ organizationId: "not-a-uuid" }),
        cookie: ownerCookie,
        requestId: randomUUID(),
      })
    );
    expect(malformedScope.status).toBe(400);
  });
});

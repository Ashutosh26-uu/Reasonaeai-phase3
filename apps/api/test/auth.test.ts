import { randomUUID } from "node:crypto";
import { isStateChangingMethod } from "@reasonateai/auth/csrf";
import {
  CreateOrganizationResponseSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
  MagicLinkAcceptedSchema,
  ProjectViewSchema,
  SESSION_COOKIE,
  SessionViewSchema,
  SignedOutSchema,
} from "@reasonateai/contracts/auth";
import type { OrganizationId } from "@reasonateai/contracts/identity";
import {
  createProjectStateStore,
  type ProjectStateStore,
} from "@reasonateai/project-state/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMagicLinkSender,
  type MagicLinkSender,
  MagicLinkSenderUnconfiguredError,
} from "../src/mastra/adapters/magic-link-sender";
import {
  createCsrfMiddleware,
  type MiddlewareContext,
  type NextFunction,
} from "../src/mastra/middleware";
import { resolveSessionPrincipal } from "../src/mastra/principal";
import {
  createAuthHandlers,
  SESSION_IDLE_TTL_MS,
} from "../src/mastra/routes/auth";
import type { HandlerContext } from "../src/mastra/routes/build-sessions";
import { createOrganizationHandlers } from "../src/mastra/routes/organizations";
import { createProjectHandlers } from "../src/mastra/routes/projects";

const connectionString = process.env.DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

interface DeliveredLink {
  email: string;
  url: string;
}

interface StubRequest {
  body?: unknown;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  requestId?: string;
}

/** The acceptance deadline, which is the one field two responses cannot share. */
const ACCEPTANCE_DEADLINE = /"expiresAt":"[^"]*"/;

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * The subset of a Hono context the handlers use, so a route runs without a
 * server. Only the headers these routes actually read are wired; anything else
 * is absent, which is what a request without that header looks like.
 */
function context(input: StubRequest): HandlerContext {
  const headers = input.headers ?? {};
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
          return input.cookies ? cookieHeader(input.cookies) : undefined;
        }
        if (key === "x-request-id") {
          return input.requestId ?? `req-${randomUUID()}`;
        }
        return headers[key];
      },
      json: async () => input.body,
      param: () => undefined,
      query: (name) => input.query?.[name],
    },
  };
}

/** The cookies a response asked the browser to store, ignoring attributes. */
function cookiesFrom(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");
    cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

describe("magic-link sender", () => {
  it("announces a development delivery instead of pretending to send mail", async () => {
    // The spy runs the real write, so the awaited delivery completes as it
    // would in the process; only the recorded calls are asserted.
    const write = vi.spyOn(process.stdout, "write");
    let printed = "";
    try {
      await createMagicLinkSender({ environment: "development" }).send({
        email: "developer@example.test",
        url: "http://localhost:4111/v1/auth/callback?token=abc",
      });
    } finally {
      // Read the calls before restoring: restoring resets the mock's state.
      printed = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      write.mockRestore();
    }

    expect(printed).toContain("no email was sent");
    expect(printed).toContain("token=abc");
  });

  it("refuses to deliver outside development rather than printing a sign-in link", async () => {
    const sender = createMagicLinkSender({ environment: "production" });

    await expect(
      sender.send({
        email: "developer@example.test",
        url: "http://localhost:4111/v1/auth/callback?token=abc",
      })
    ).rejects.toBeInstanceOf(MagicLinkSenderUnconfiguredError);
  });
});

describeWithDatabase("identity routes", () => {
  const pool = new Pool({ connectionString });
  const store: ProjectStateStore = createProjectStateStore({
    connectionString: connectionString as string,
    // The same idle window the composition root wires, so the session view's
    // two deadlines are the ones a deployment would report.
    sessionIdleTtlMs: SESSION_IDLE_TTL_MS,
  });

  const csrfSecret = () => "test-csrf-secret";
  const publicOrigin = "http://api.reasonate.test";
  const delivered: DeliveredLink[] = [];
  const sender: MagicLinkSender = {
    send: (input) => {
      delivered.push(input);
      return Promise.resolve();
    },
  };

  const handlers = createAuthHandlers({
    csrfSecret,
    publicOrigin,
    secureCookies: false,
    sender,
    store: () => store,
  });

  const resolvePrincipal = async (input: {
    cookieHeader: string | undefined;
  }) =>
    await resolveSessionPrincipal({
      cookieHeader: input.cookieHeader,
      sessions: store.sessions,
    });

  const organizations = createOrganizationHandlers({
    resolvePrincipal,
    store: () => store,
  });
  const projects = createProjectHandlers({
    resolvePrincipal,
    store: () => store,
  });
  const csrf = createCsrfMiddleware({
    csrfSecret,
    origins: [],
    sessions: () => store.sessions,
  });

  /** Unique per run, so one run's addresses and counters never touch another's. */
  const suffix = randomUUID();
  const emailFor = (label: string) => `${label}-${suffix}@example.test`;

  let addressCounter = 0;

  /**
   * A client address unique to this run and request. The identity limits are
   * counted per address, so reusing one would let a repeated local test run
   * trip a window an earlier run opened.
   */
  function nextClientAddress(): string {
    addressCounter += 1;
    const [first, second] = [suffix.slice(0, 2), suffix.slice(2, 4)].map(
      (hex) => Number.parseInt(hex, 16)
    );
    return `10.${first}.${second}.${addressCounter}`;
  }

  async function requestLink(email: string): Promise<Response> {
    return await handlers.requestMagicLink(
      context({
        body: { email },
        headers: { "x-forwarded-for": nextClientAddress() },
        requestId: `link-${randomUUID()}`,
      })
    );
  }

  async function issueLink(
    email: string
  ): Promise<{ token: string; url: string }> {
    const before = delivered.length;
    const response = await requestLink(email);
    expect(response.status).toBe(202);

    const link = delivered[before];
    if (!link) {
      throw new Error("The request did not deliver a sign-in link.");
    }
    const token = new URL(link.url).searchParams.get("token");
    if (!token) {
      throw new Error("The delivered sign-in link carried no token.");
    }
    return { token, url: link.url };
  }

  /**
   * The full sign-in journey through the real handlers: request a link, follow
   * it, and keep the cookies the callback set.
   */
  async function signIn(email: string): Promise<{
    cookies: Record<string, string>;
    organizationId: OrganizationId;
    userId: string;
  }> {
    const { token } = await issueLink(email);
    const response = await handlers.callback(
      context({ query: { token }, requestId: `callback-${randomUUID()}` })
    );
    expect(response.status).toBe(303);

    const cookies = cookiesFrom(response);
    const principal = await resolveSessionPrincipal({
      cookieHeader: cookieHeader(cookies),
      sessions: store.sessions,
    });
    if (!principal) {
      throw new Error("The callback did not establish a session.");
    }

    const [organization] = await store.listOrganizationMemberships({
      userId: principal.userId,
    });
    if (!organization) {
      throw new Error("The sign-in did not establish an organization.");
    }

    return {
      cookies,
      organizationId: organization.organizationId,
      userId: principal.userId,
    };
  }

  /**
   * Runs the CSRF middleware in front of a route, exactly as the server chains
   * them, and returns whichever response the chain produced.
   */
  async function guarded(
    input: {
      cookies?: Record<string, string>;
      csrfHeader?: string;
      method: string;
      origin?: string;
    },
    route: () => Promise<Response>
  ): Promise<Response> {
    const middlewareContext: MiddlewareContext = {
      req: {
        header: (name) => {
          const key = name.toLowerCase();
          if (key === "cookie") {
            return input.cookies ? cookieHeader(input.cookies) : undefined;
          }
          if (key === CSRF_HEADER) {
            return input.csrfHeader;
          }
          if (key === "origin") {
            return input.origin;
          }
        },
        method: input.method,
      },
    };
    const next: NextFunction = () => Promise.resolve();

    const refusal = await csrf.handler(middlewareContext, next);
    return refusal ?? (await route());
  }

  beforeAll(async () => {
    await store.migrate();
  });

  afterAll(async () => {
    // Everything this run created hangs off the accounts it created: their
    // memberships name the organizations to remove, and deleting the users
    // cascades sessions, sign-in links, memberships, and audit rows with them.
    await pool.query(
      `delete from organizations
        where organization_id in (
          select m.organization_id
            from organization_memberships m
            join users u on u.user_id = m.user_id
           where u.primary_email like $1
        )`,
      [`%-${suffix}@example.test`]
    );
    await pool.query("delete from users where primary_email like $1", [
      `%-${suffix}@example.test`,
    ]);
    await pool.end();
    await store.close();
  });

  it("answers a link request identically for an address with an account and one without", async () => {
    const knownEmail = emailFor("known");
    await signIn(knownEmail);
    const unknownEmail = emailFor("unknown");

    const known = await requestLink(knownEmail);
    const unknown = await requestLink(unknownEmail);

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);

    const knownText = await known.text();
    const unknownText = await unknown.text();

    // Both answers carry exactly the acceptance deadline. That deadline is read
    // off the clock, so the two responses necessarily differ in its value;
    // masking it is what lets the comparison be exact for every other byte.
    const maskDeadline = (text: string) =>
      text.replace(ACCEPTANCE_DEADLINE, '"expiresAt":"<clock>"');
    expect(maskDeadline(unknownText)).toBe(maskDeadline(knownText));

    const accepted = MagicLinkAcceptedSchema.parse(JSON.parse(unknownText));
    const knownAccepted = MagicLinkAcceptedSchema.parse(JSON.parse(knownText));
    expect(
      Math.abs(
        Date.parse(accepted.expiresAt) - Date.parse(knownAccepted.expiresAt)
      )
    ).toBeLessThan(1000);

    // The token reached the sender and never the caller.
    const deliveredTokens = delivered
      .map(({ url }) => new URL(url).searchParams.get("token"))
      .filter((token): token is string => token !== null);
    expect(deliveredTokens.length).toBeGreaterThan(0);
    for (const token of deliveredTokens) {
      expect(unknownText).not.toContain(token);
      expect(knownText).not.toContain(token);
    }
  });

  it("builds the sign-in link from configuration rather than from the request", async () => {
    const { url } = await issueLink(emailFor("origin"));
    expect(url.startsWith(`${publicOrigin}/v1/auth/callback?token=`)).toBe(
      true
    );
  });

  it("redeems a link once and establishes a session the principal resolver accepts", async () => {
    const email = emailFor("single-use");
    const { token } = await issueLink(email);

    const first = await handlers.callback(
      context({ query: { token }, requestId: "req-first-callback" })
    );
    expect(first.status).toBe(303);

    const setCookies = first.headers.getSetCookie();
    const sessionLine = setCookies.find((line) =>
      line.startsWith(`${SESSION_COOKIE}=`)
    );
    const csrfLine = setCookies.find((line) =>
      line.startsWith(`${CSRF_COOKIE}=`)
    );
    expect(sessionLine).toContain("HttpOnly");
    expect(sessionLine).toContain("SameSite=Lax");
    expect(sessionLine).toContain("Path=/");
    expect(csrfLine).not.toContain("HttpOnly");

    const cookies = cookiesFrom(first);
    const principal = await resolveSessionPrincipal({
      cookieHeader: cookieHeader(cookies),
      sessions: store.sessions,
    });
    expect(principal?.kind).toBe("user");
    // The session the callback established is a live row the store resolves,
    // not merely a cookie the browser was handed.
    const resolved = await store.sessions.resolveSession(
      cookies[SESSION_COOKIE]
    );
    expect(resolved?.sessionId).toBe(principal?.sessionId);
    expect(cookies[CSRF_COOKIE]).not.toBe("");
    expect(cookies[CSRF_COOKIE]).not.toBe(cookies[SESSION_COOKIE]);

    // The token is spent: the same bytes are refused, and the refusal says
    // nothing about whether the link existed.
    const second = await handlers.callback(
      context({ query: { token }, requestId: "req-second-callback" })
    );
    expect(second.status).toBe(401);
    expect((await second.json()).error.code).toBe("unauthenticated");

    // The first sign-in created the caller's organization, named after the
    // address's domain, with the caller as its owner.
    const view = await handlers.readSession(
      context({ cookies, requestId: "req-view" })
    );
    expect(view.status).toBe(200);
    const session = SessionViewSchema.parse(await view.json());
    expect(session.userId).toBe(principal?.userId);
    expect(session.organizations).toHaveLength(1);
    expect(session.organizations[0]?.role).toBe("owner");
    expect(session.organizations[0]?.name).toBe("example.test");
    // Idle expiry is a real, shorter deadline: using the session pushes it
    // back, and absolute expiry is what stops that from extending forever.
    expect(Date.parse(session.idleExpiresAt)).toBeLessThan(
      Date.parse(session.absoluteExpiresAt)
    );
  });

  it("refuses a session read with no session, and audits the sign-in", async () => {
    const anonymous = await handlers.readSession(
      context({ requestId: "req-anonymous" })
    );
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.requestId).toBe("req-anonymous");

    const email = emailFor("audited");
    const { organizationId } = await signIn(email);
    const trail = await store.audit.listForOrganization({
      limit: 20,
      organizationId,
    });
    expect(trail.some(({ action }) => action === "identity.signed_in")).toBe(
      true
    );
    expect(
      trail.some(
        ({ action, metadata }) =>
          action === "identity.signed_in" && metadata.firstSignIn === true
      )
    ).toBe(true);
  });

  it("refuses a state-changing command without a CSRF token and with a wrong one", async () => {
    const { cookies, organizationId } = await signIn(emailFor("csrf"));
    const createProject = async () =>
      await projects.create(
        context({
          body: { name: "CSRF project", organizationId },
          cookies,
          requestId: "req-csrf",
        })
      );

    expect(isStateChangingMethod("POST")).toBe(true);

    const missing = await guarded({ cookies, method: "POST" }, createProject);
    expect(missing.status).toBe(403);
    expect((await missing.json()).error.code).toBe("forbidden");

    const wrong = await guarded(
      { cookies, csrfHeader: "wrong-token", method: "POST" },
      createProject
    );
    expect(wrong.status).toBe(403);

    const right = await guarded(
      { cookies, csrfHeader: cookies[CSRF_COOKIE], method: "POST" },
      createProject
    );
    expect(right.status).toBe(201);

    // A token that matches the cookie but was minted for another session is
    // still refused, because the token is bound to the session it names.
    const forged = await guarded(
      { cookies, csrfHeader: cookies[SESSION_COOKIE], method: "POST" },
      createProject
    );
    expect(forged.status).toBe(403);
  });

  it("refuses a command from an origin the API does not serve", async () => {
    const { cookies } = await signIn(emailFor("origin-check"));
    const response = await guarded(
      {
        cookies,
        csrfHeader: cookies[CSRF_COOKIE],
        method: "POST",
        origin: "https://evil.example",
      },
      async () => await handlers.readSession(context({ cookies }))
    );

    expect(response.status).toBe(403);
  });

  it("never redirects a caller to an absolute or protocol-relative target", async () => {
    const { cookies } = await signIn(emailFor("redirect"));

    const escapingTargets = [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example/steal",
      "\\\\evil.example/steal",
    ];

    // Every target needs its own link, because redeeming one spends it.
    for (const redirectTo of escapingTargets) {
      // biome-ignore lint/performance/noAwaitInLoops: one single-use link per target, by design
      const { token } = await issueLink(emailFor(`redirect-${randomUUID()}`));
      const response = await handlers.callback(
        context({
          cookies,
          query: { redirectTo, token },
          requestId: "req-redirect",
        })
      );

      expect(response.status).toBe(303);
      // A target that leaves this origin is replaced by the fallback, so the
      // Location header never carries it.
      expect(response.headers.get("Location")).toBe("/");
    }

    const { token } = await issueLink(
      emailFor(`redirect-safe-${randomUUID()}`)
    );
    const safe = await handlers.callback(
      context({
        cookies,
        query: { redirectTo: "/safe/path", token },
        requestId: "req-redirect-safe",
      })
    );
    expect(safe.headers.get("Location")).toBe("/safe/path");
  });

  it("creates an organization the caller owns, with its audit row and membership", async () => {
    const { cookies } = await signIn(emailFor("orgs"));

    const response = await organizations.create(
      context({
        body: { name: "Second organization" },
        cookies,
        requestId: "req-create-org",
      })
    );
    expect(response.status).toBe(201);

    const created = CreateOrganizationResponseSchema.parse(
      await response.json()
    );
    expect(created.membershipRole).toBe("owner");

    const trail = await store.audit.listForOrganization({
      limit: 5,
      organizationId: created.organizationId,
    });
    expect(trail.some(({ action }) => action === "organization.created")).toBe(
      true
    );

    const view = await handlers.readSession(
      context({ cookies, requestId: "req-orgs-view" })
    );
    const session = SessionViewSchema.parse(await view.json());
    expect(session.organizations.map(({ name }) => name)).toContain(
      "Second organization"
    );
  });

  it("creates a project for an authorized owner with membership and audit", async () => {
    const { cookies, organizationId, userId } = await signIn(
      emailFor("project")
    );

    const response = await projects.create(
      context({
        body: { name: "Launch slice", organizationId },
        cookies,
        requestId: "req-create-project",
      })
    );
    expect(response.status).toBe(201);

    const project = ProjectViewSchema.parse(await response.json());
    expect(project.organizationId).toBe(organizationId);
    expect(project.role).toBe("builder");

    const membership = await store.memberships.getProjectMembership({
      organizationId,
      projectId: project.projectId,
      userId,
    });
    expect(membership?.role).toBe("builder");

    const trail = await store.audit.listForOrganization({
      limit: 20,
      organizationId,
    });
    expect(
      trail.some(
        ({ action, projectId }) =>
          action === "project.created" && projectId === project.projectId
      )
    ).toBe(true);
  });

  it("refuses a project in another tenant's organization and records the denial", async () => {
    const owner = await signIn(emailFor("tenant-owner"));
    const outsider = await signIn(emailFor("tenant-outsider"));

    const response = await projects.create(
      context({
        body: { name: "Intrusion", organizationId: owner.organizationId },
        cookies: outsider.cookies,
        requestId: "req-foreign-project",
      })
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");

    const projectsInTenant = await pool.query<{ count: number }>(
      "select count(*)::int as count from projects where organization_id = $1",
      [owner.organizationId]
    );
    expect(projectsInTenant.rows[0]?.count).toBe(0);

    const trail = await store.audit.listForOrganization({
      limit: 20,
      organizationId: owner.organizationId,
    });
    expect(trail.some(({ action }) => action === "authorization.denied")).toBe(
      true
    );
  });

  it("ends a session so the next read is unauthenticated", async () => {
    const { cookies } = await signIn(emailFor("sign-out"));

    const signedOut = await guarded(
      { cookies, csrfHeader: cookies[CSRF_COOKIE], method: "DELETE" },
      async () =>
        await handlers.signOut(context({ cookies, requestId: "req-sign-out" }))
    );

    expect(signedOut.status).toBe(200);
    expect(SignedOutSchema.parse(await signedOut.json()).revoked).toBe(true);

    for (const line of signedOut.headers.getSetCookie()) {
      expect(line).toContain("Max-Age=0");
    }

    const after = await handlers.readSession(
      context({ cookies, requestId: "req-after-sign-out" })
    );
    expect(after.status).toBe(401);

    const principal = await resolveSessionPrincipal({
      cookieHeader: cookieHeader(cookies),
      sessions: store.sessions,
    });
    expect(principal).toBe(undefined);
  });

  it("refuses a session read once the session is revoked behind the cookie", async () => {
    const { cookies } = await signIn(emailFor("revoked"));
    const principal = await resolveSessionPrincipal({
      cookieHeader: cookieHeader(cookies),
      sessions: store.sessions,
    });

    if (!principal) {
      throw new Error("The sign-in did not establish a session.");
    }
    expect(await store.sessions.revokeSession(principal.sessionId)).toBe(true);

    expect(
      (
        await handlers.readSession(
          context({ cookies, requestId: "req-revoked-read" })
        )
      ).status
    ).toBe(401);
  });
});

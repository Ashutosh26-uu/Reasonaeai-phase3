import { randomBytes } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  createGoogleIdentity,
  GoogleIdentityError,
} from "../src/mastra/adapters/google-identity";
import {
  createMagicLinkSender,
  MagicLinkDeliveryError,
  MagicLinkSenderUnconfiguredError,
} from "../src/mastra/adapters/magic-link-sender";

describe("email provider boundary", () => {
  it("sends to Resend and requires a provider receipt", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "receipt" }));
    const sender = createMagicLinkSender({
      apiKey: "fixture-provider-key",
      environment: "production",
      fetch: transport,
      from: "ReasonateAI <signin@example.test>",
    });
    expect(sender.delivery).toBe("email");
    await sender.send({
      email: "person@example.test",
      url: "https://app.example.test/auth/verify#token=fixture",
    });
    const [endpoint, request] = transport.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      from: "ReasonateAI <signin@example.test>",
      to: ["person@example.test"],
    });
    transport.mockResolvedValue(new Response("{}"));
    await expect(
      sender.send({
        email: "person@example.test",
        url: "https://app.example.test",
      })
    ).rejects.toBeInstanceOf(MagicLinkDeliveryError);
    transport.mockResolvedValue(
      new Response("provider details", { status: 429 })
    );
    await expect(
      sender.send({
        email: "person@example.test",
        url: "https://app.example.test",
      })
    ).rejects.toThrow("We could not send");
  });
  it("restricts local delivery to development and loopback", async () => {
    expect(() =>
      createMagicLinkSender({
        environment: "development",
        mailpitUrl: "https://external.example.test",
      })
    ).toThrow("loopback");
    const sender = createMagicLinkSender({
      environment: "production",
      mailpitUrl: "http://127.0.0.1:8025",
    });
    expect(sender.delivery).toBe("unavailable");
    await expect(
      sender.send({
        email: "person@example.test",
        url: "https://app.example.test",
      })
    ).rejects.toBeInstanceOf(MagicLinkSenderUnconfiguredError);
  });
});

describe("Google OIDC verification", () => {
  const secret = randomBytes(48).toString("base64url");
  async function fixture(overrides: Record<string, unknown> = {}) {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    let nonce = "";
    const transport = vi.fn<typeof fetch>(async () => {
      const token = await new SignJWT({
        email: "person@gmail.com",
        email_verified: true,
        nonce,
        ...overrides,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://accounts.google.com")
        .setSubject("google-user-123")
        .setAudience("company-client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({ id_token: token });
    });
    const provider = createGoogleIdentity({
      clientId: "company-client",
      clientSecret: "fixture-client-secret",
      fetch: transport,
      keys: async () => publicKey,
      publicOrigin: "https://app.example.test",
      secret: () => secret,
    });
    const flow = await provider.begin();
    const url = new URL(flow.url);
    nonce = url.searchParams.get("nonce") ?? "";
    return { flow, provider, transport, url };
  }
  it("uses PKCE, a protected browser flow and a signed Google identity", async () => {
    const { provider, flow, url, transport } = await fixture();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.test/v1/auth/google/callback"
    );
    expect(flow.cookie).not.toContain(flow.state);
    await expect(
      provider.finish({
        code: "fixture-code",
        cookie: flow.cookie,
        state: flow.state,
      })
    ).resolves.toEqual({
      email: "person@gmail.com",
      subject: "google-user-123",
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://oauth2.googleapis.com/token"
    );
  });
  it("refuses another browser flow, tampering and untrusted or unverified email", async () => {
    const first = await fixture();
    await expect(
      first.provider.finish({
        code: "code",
        cookie: first.flow.cookie,
        state: "wrong-state",
      })
    ).rejects.toBeInstanceOf(GoogleIdentityError);
    await expect(
      first.provider.finish({
        code: "code",
        cookie: `${first.flow.cookie}tampered`,
        state: first.flow.state,
      })
    ).rejects.toBeInstanceOf(GoogleIdentityError);
    expect(first.transport).not.toHaveBeenCalled();
    const unverified = await fixture({ email_verified: false });
    await expect(
      unverified.provider.finish({ ...unverified.flow, code: "code" })
    ).rejects.toBeInstanceOf(GoogleIdentityError);
    const thirdParty = await fixture({ email: "person@example.test" });
    await expect(
      thirdParty.provider.finish({ ...thirdParty.flow, code: "code" })
    ).rejects.toBeInstanceOf(GoogleIdentityError);
    const wrongNonce = await fixture({ nonce: "wrong-nonce" });
    await expect(
      wrongNonce.provider.finish({ ...wrongNonce.flow, code: "code" })
    ).rejects.toBeInstanceOf(GoogleIdentityError);
  });
  it("accepts verified Google Workspace identities", async () => {
    const { provider, flow } = await fixture({
      email: "person@company.test",
      hd: "company.test",
    });
    await expect(
      provider.finish({ ...flow, code: "code" })
    ).resolves.toMatchObject({ email: "person@company.test" });
  });
});

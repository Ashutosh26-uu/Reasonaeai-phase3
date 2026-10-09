import { createHash, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  EncryptJWT,
  type JWTVerifyGetKey,
  jwtDecrypt,
  jwtVerify,
} from "jose";
import { z } from "zod";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000 }
);
const FlowSchema = z.object({
  nonce: z.string().min(40).max(128),
  state: z.string().min(40).max(128),
  verifier: z.string().min(43).max(128),
});
const ClaimsSchema = z.object({
  email: z.email().max(254),
  email_verified: z.literal(true),
  hd: z.string().min(1).optional(),
  nonce: z.string(),
  sub: z.string().min(1).max(255),
});
export class GoogleIdentityError extends Error {
  constructor(
    message = "Google sign-in could not be verified. Please try again or continue with email.",
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
export interface GoogleIdentity {
  begin: () => Promise<{ cookie: string; state: string; url: string }>;
  configured: boolean;
  finish: (input: {
    cookie: string;
    state: string;
    code: string;
  }) => Promise<{ email: string; subject: string }>;
}
export function createGoogleIdentity(config: {
  clientId?: string;
  clientSecret?: string;
  publicOrigin: string;
  secret: () => string;
  fetch?: typeof fetch;
  keys?: JWTVerifyGetKey;
}): GoogleIdentity {
  const key = () =>
    createHash("sha256")
      .update("reasonate:oidc:v1:")
      .update(config.secret())
      .digest();
  const callback = new URL("/v1/auth/google/callback", config.publicOrigin)
    .href;
  return {
    begin: async () => {
      if (!(config.clientId && config.clientSecret)) {
        throw new GoogleIdentityError();
      }
      const flow = {
        nonce: randomBytes(32).toString("base64url"),
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
      };
      const cookie = await new EncryptJWT(flow)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setIssuer("reasonate")
        .setAudience("google-login")
        .setIssuedAt()
        .setExpirationTime("10m")
        .encrypt(key());
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        code_challenge: createHash("sha256")
          .update(flow.verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        nonce: flow.nonce,
        prompt: "select_account",
        redirect_uri: callback,
        response_type: "code",
        scope: "openid email",
        state: flow.state,
      }).toString();
      return { cookie, state: flow.state, url: url.href };
    },
    configured: Boolean(config.clientId && config.clientSecret),
    finish: async ({ cookie, state, code }) => {
      try {
        if (!(config.clientId && config.clientSecret)) {
          throw new GoogleIdentityError();
        }
        const decrypted = await jwtDecrypt(cookie, key(), {
          audience: "google-login",
          contentEncryptionAlgorithms: ["A256GCM"],
          issuer: "reasonate",
          keyManagementAlgorithms: ["dir"],
        });
        const flow = FlowSchema.parse(decrypted.payload);
        if (flow.state !== state) {
          throw new GoogleIdentityError();
        }
        const response = await (config.fetch ?? fetch)(
          "https://oauth2.googleapis.com/token",
          {
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              code,
              code_verifier: flow.verifier,
              grant_type: "authorization_code",
              redirect_uri: callback,
            }),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!response.ok) {
          throw new GoogleIdentityError();
        }
        const tokens = z
          .object({ id_token: z.string().max(16_384) })
          .parse(await response.json());
        const verified = await jwtVerify(
          tokens.id_token,
          config.keys ?? googleKeys,
          {
            algorithms: ["RS256"],
            audience: config.clientId,
            issuer: GOOGLE_ISSUERS,
            maxTokenAge: "10m",
            requiredClaims: ["exp", "iat", "sub"],
          }
        );
        const claims = ClaimsSchema.parse(verified.payload);
        if (
          claims.nonce !== flow.nonce ||
          !(claims.email.toLowerCase().endsWith("@gmail.com") || claims.hd)
        ) {
          throw new GoogleIdentityError();
        }
        return { email: claims.email.toLowerCase(), subject: claims.sub };
      } catch (cause) {
        throw new GoogleIdentityError(undefined, { cause });
      }
    },
  };
}

# Launch authentication and workspace onboarding

Release candidate on `codex/authentication-onboarding`, October 10, 2026. This completes locally reachable launch identity behavior. Company Resend and Google credentials and an approved staging origin are still missing; production activation and live provider acceptance remain blocked.

## Behavior

`/auth/signup` and `/auth/login` use verified email rather than locally managed passwords. A requested link expires after 15 minutes, is stored only as a digest, and is bound to an HttpOnly nonce in the requesting browser. The token travels in a URL fragment; the verification page removes it from browser history, then requires an explicit confirmation. Email scanners and GET requests cannot sign a user in. Unknown, expired, consumed, and wrongly bound links share the same refusal. Requests have bounded address/email limits, actionable delivery errors, and a resend cooldown.

Sign-in establishes a fresh opaque session and revokes an existing session in that browser. Sessions have a 24-hour idle window and 14-day absolute lifetime; protected mutations require the session-bound CSRF pair and allowed origin. Security settings list active sessions with current-session identification and support individual/global revocation. No user session is passed to workers.

First verified sign-in creates the first organization and owner membership transactionally. A two-step wizard saves display name and workspace name with durable completion and an audit record in one transaction. Repeating completion does not rename an already configured workspace. Existing accounts bypass setup. Workspace creation and switching support multiple organizations; project creation uses a focused, cancellable modal with an authorized workspace selector. Organization/project selection survives URL reload and browser history. Memberships and centralized authorization govern each API operation.

Google uses authorization code, S256 PKCE, a 10-minute encrypted HttpOnly flow cookie, nonce verification, and a durable hashed state consumed once. ID tokens must have Google's signature, issuer, client audience, valid lifetime, and verified email. Automatic email linking requires Gmail or an authoritative Google Workspace hosted-domain claim. Other Google-account email domains continue through email verification. Once linked, Google's stable subject resolves the account independently of later email changes. Provider secrets and raw credentials are never logged.

## Activate company providers

Use company-managed secret configuration. The placeholders in `apps/api/.env.example` are the authoritative variable names.

1. Configure `SESSION_SECRET` with at least 32 characters of cryptographically random secret material. Configure the separate artifact signing secret, database, and Redis as required by the existing API. Production requires an explicit HTTPS `REASONATE_PUBLIC_ORIGIN`, without a path, query, or user information, listed exactly in `REASONATE_ALLOWED_ORIGINS`.
2. In the company's Resend account, verify the sending domain. Set a send-authorized `RESEND_API_KEY` and `REASONATE_EMAIL_FROM` to the approved sender. Delivery calls the fixed Resend endpoint with a 10-second timeout and requires a real delivery receipt. A vendor refusal is a failure, never a fake accepted message.
3. Create a company Google OAuth web client, configure its consent screen and authorized test users, and register the exact redirect URI `https://<approved-product-host>/v1/auth/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Product ingress must forward this callback and all `/v1` routes to the API on the configured product origin.
4. Keep authentication cookies and redirects on the approved product origin. Trusted ingress must strip caller-supplied forwarding headers before supplying the client address used for abuse limits.
5. Verify `/v1/auth/readiness` returns 200. It checks configuration plus at least one available provider; it does not prove external delivery, Google consent approval, or both launch providers. Rehearse a clean signup, received email, replay refusal, Google consent/callback, sign-out, re-login, session revocation, and two-workspace project isolation on staging. Both external providers must pass before declaring launch identity complete.

No paid model-provider call is needed for any authentication flow. Google sign-in is an identity integration, not Google hosted-model inference.

## Local verification

Mailpit is a real local mail inbox, explicitly labelled in the UI. Set `REASONATE_MAILPIT_URL` to its loopback HTTP API, run the API in development, and open Mailpit to receive links. Non-loopback URLs and embedded URL credentials are refused. A production build ignores this configuration; production cannot silently fall back to local delivery.

```powershell
docker run -d --name reasonate-mailpit -p 127.0.0.1:58027:8025 axllent/mailpit:latest
```

Use the standard [local development setup](local-development.md) for PostgreSQL and Redis. Set the public/allowed origin to the actual browser origin and `REASONATE_API_ORIGIN` in the web application's local environment to the API address. This isolated acceptance environment uses browser port 3221, API port 4113, PostgreSQL port 55434, and Redis port 56381. Configuration and transient links remain in ignored local files.

Full integration gates must use a fresh dedicated test database, separate from a concurrently running API: its outbox relay legitimately consumes pending rows, while accumulated outbox rows from prior suites can exceed bounded claim fixtures. Neither shared delivery nor stale fixture state is valid acceptance evidence. Export both `DATABASE_URL` and `REDIS_URL` before the root gates. Missing service prerequisites are skips, not passing coverage. For the full Docker acceptance gate, export `REASONATE_BUILD_SANDBOX_IMAGE` to the locally built approved image and `REASONATE_TEST_BUILD_SANDBOX_IMAGE=1`; Turborepo forwards and hashes both values. On Windows, the existing sandbox archive/export fixtures require Git for Windows `usr/bin` on `PATH` for their external `mkdir` and `unzip` commands.

## Migration and recovery

Project-state schema version 9 adds `users.onboarding_completed_at`, `magic_link_tokens.browser_hash`, durable OIDC state, and provider-subject account links. Adding the user column initially backfills existing accounts with completion, then removes the default so newly created accounts require setup. Repeated migration preserves unfinished accounts. There is no destructive rewrite of historical state. New links require browser binding; pre-migration unbound links remain redeemable until their original short expiry.

Deploy the additive migration before accepting new identity traffic and retain a database backup. Prefer a forward repair. For an application rollback, place identity endpoints in maintenance, invalidate pending magic links and OIDC requests, and revoke affected browser sessions before using an older artifact whose GET redemption semantics differ. Retain the additive columns and tables; do not drop provider links or onboarding state. Re-enable identity only after the selected artifact's security behavior is rehearsed. Never run a destructive down-migration as an automatic rollback.

## Design references

Seven public sources informed the original implementation; no third-party artwork or layouts were copied:

- [Figma login templates](https://www.figma.com/templates/login-page-design/): form hierarchy and consistent field grouping.
- [Pinterest signup study](https://in.pinterest.com/pin/saas-loginsignup-design-by-badi--929711916813290765/): calm split composition and spacious editorial panel.
- [Linear login](https://linear.app/login): one clear primary identity action.
- [Vercel signup](https://vercel.com/signup): explicit provider choices and concise continuation.
- [Notion signup](https://app.notion.com/signup): email-first entry and limited initial choices.
- [Supabase signup](https://supabase.com/dashboard/sign-up): provider/form separation and readable labels.
- [Nielsen Norman Group onboarding guidance](https://www.nngroup.com/articles/onboarding-tutorials/): brief contextual steps rather than a lengthy tutorial.

The resulting design uses the existing ReasonateAI brand, an original CSS illustration, a responsive split shell, visible progress, accessible labels/focus, and intentional loading/error/retry states.

## Verification evidence

API regressions exercise browser binding, non-consuming GETs, single-use links, uniform invalid-link responses, CSRF, tenant denial, atomic/idempotent setup, and session ownership/revocation against PostgreSQL. Provider tests exercise Resend receipts/refusals, development-only Mailpit, and cryptographically signed Google fixtures with state, nonce, email-authority, and cookie-tamper refusals. Durable identity tests cover concurrent single-use state, expiry, stable provider subjects, existing-email linking, and repeat migration.

Browser acceptance uses the built web application and real development API/PostgreSQL/Redis/Mailpit. External Resend delivery and a real Google consent round trip cannot be exercised without company credentials; injected provider fixtures do not establish those production claims.

Browser scenarios passed: first-user setup, returning-user login with setup bypass, actual project/workspace creation, organization selection after reload and browser back/forward, Escape cancellation without project creation, separate project lists, clearing an unsent draft when creation moves to another organization, active session inspection, and sign-out everywhere. Desktop and 390 × 844 mobile signup layouts were inspected. Screenshots: [desktop signup](evidence/authentication/signup-desktop.jpg), [mobile signup](evidence/authentication/signup-mobile.jpg), [project modal](evidence/authentication/project-dialog.jpg), [security sessions](evidence/authentication/security-sessions.jpg), and [workspace switching](evidence/authentication/workspaces-menu.jpg).

A separate real HTTP acceptance run passed 18 assertions across 19 requests against the running API and real PostgreSQL/Redis/Mailpit. It covered inbox receipt, wrong-browser refusal, non-consuming GET, redemption/replay, atomic setup, projects in two organizations, unknown-organization denial, and global session revocation. Observed warm local p95 response time was 95 ms for this small sample; it is not a production load or vendor-latency measurement. The final local gates below passed on October 10, 2026. The root run used the dedicated fresh database and approved sandbox image; 14 of 17 tasks reused successful keyed cache entries. Company CI and preview/staging acceptance remain prerequisites for merge and launch.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm check` | Passed; 477 files |
| `pnpm typecheck` | Passed; 10 tasks |
| `pnpm test` | Passed; 1,153 tests across nine suites, 17 tasks successful |
| `pnpm build` | Passed; 10 tasks |
| `pnpm --filter @reasonateai/api smoke:checkpoint` | Passed; `SMOKE_OK`, real Docker restoration and failure preservation |
| Production API smoke | Health 200; raw agent/controller routes 404; unconfigured identity readiness 503; local-mail fallback refused |
| Real HTTP identity smoke | 18 assertions / 19 requests passed against running API, PostgreSQL, Redis, and Mailpit |
| Browser acceptance | Desktop/mobile and critical signup/session/organization/project journeys passed |
| Gitleaks staged patch scan | Passed; no leaks |
| `pnpm audit --prod --audit-level high` | Passed; baseline two low and two moderate advisories, no high/critical findings |

Dependencies: `jose` 6.2.12 (MIT, Node 22 compatible) implements standards-based token verification/encryption; no custom JWT cryptography was introduced. The application uses patched Next.js 16.3.8. Production dependency audit blocks high/critical findings; existing lower-severity advisories remain visible in its output.

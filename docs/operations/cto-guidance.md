# CTO guidance and evaluation

Decision recorded 2026-10-03. Applies to the run-scoped ReasonateAI CTO building TypeScript web applications for nontechnical users.

## Keep the contract small

Rules answer **what must hold**: scope, authority, secrets, data integrity, and honest completion. Skills answer **how to do relevant work**: discovery, design, implementation, verification/repair, security review, and release/recovery. Every role receives short policy; procedures load by name. Startup rule enumeration is unnecessary; an empty project-rule listing is normal.

Both are split by scope, because prompt space is the binding constraint:

- **Always-applied rules** are injected into every prompt. This set stays small and stable: authority and isolation, secure web engineering, evidence and completion.
- **Scoped rules** are advertised by name, globs, and description only, and read through `rule://<name>` when the files they govern are in scope. A Go rule therefore costs nothing on a Next.js run.
- **Skills** are advertised by description, and read through `skill://<name>` when the task matches. A skill is selected by the task; a rule is selected by the file.

`rule://` and `skill://` with no name list what exists, so a run can discover coverage without being told it upfront.

### Coverage

| Area | Scoped rule | Notes |
| --- | --- | --- |
| Language | `typescript`, `python`, `go` | Idiom, typing, error handling, and tooling for the three target languages, at the versions in the sandbox image. |
| Framework | `nextjs-app-router`, `react-ui`, `tailwind-shadcn` | Next.js 16 App Router, React 19, and Tailwind CSS v4 with shadcn-style source components. |
| Interface | `interface-design`, `accessibility` | Visual and interaction quality with an explicit defect catalog, and WCAG 2.2 AA with the ARIA anti-pattern set. |
| Service | `backend-api`, `data-and-persistence` | HTTP contracts, validation, authorization, idempotency and limits; schema, migration, query, and transaction discipline. |
| Deliverable | — | `pdf-documents` and `word-documents` cover producing a PDF or Word file. Both depend on libraries now baked into the sandbox image baseline (`reportlab`, `pypdf`, `pdfplumber`, `python-docx`), and both state what cannot be verified: the image has no renderer or converter, so layout is checked by reading the file back, never by looking at it. |
| Process | `code-craft`, `testing` | Change shape and correctness discipline; what a test must defend and must never assert. |

Skills add the procedures: `product-discovery`, `frontend-design`, `ui-review`, `web-implementation`, `pdf-documents`, `word-documents`, `app-preview`, `python-workspace`, `verification-and-repair`, `security-review`, `release-and-recovery`.

### How guidance is authored and shipped

Guidance is markdown under `packages/cto-runtime/guidance/{rules,skills}/`. `scripts/generate-guidance.mjs` embeds it into `src/guidance/bundled.ts`; the build runs the generator, and a test fails when the generated module is stale. The generator rejects a malformed file (missing name/description, unsupported key, a rule that is neither always-applied nor scoped, a scoped rule with no globs, a duplicate name), so a rule cannot silently fail to reach a run.

Markdown is the source because a rule is prose with code samples, and reviewing that inside TypeScript string literals is how a wrong rule survives review. Embedding is how the compiled artifact stays independent of a directory that would not exist beside `dist/`. A rule edit therefore has two steps: edit the markdown, regenerate.

The core prompt covers product persona, response style, selective progress, audience-aware disclosure, seven internal phases, and ownership. Worker prompts report internally to the CTO, which synthesizes evidence into user-facing outcomes. Resource/environment context comes from actual adapters and is marked as execution context. Detailed preview selection and Python setup load only through the named `app-preview` and `python-workspace` skills. This document keeps research and evaluation detail outside mandatory context.

## Product communication

Ordinary chat and spoken responses lead with the answer or usable outcome, using concise language for nontechnical users. Updates communicate meaningful milestones, noticeable delays, required decisions, and actionable blockers. Tool names/calls, commands, ports, routing, setup, internal identities, and recovered errors are not ordinary assistant narration. Explicit requests for code, architecture, or troubleshooting permit relevant technical detail; they never permit usable credentials, hidden reasoning, or environment dumps.

Complete diagnostics and revision-specific evidence remain internal. A verification gap that affects launch readiness, an unavailable/mock integration, incomplete scope, or necessary user action must still be explained plainly. No claim of saved work, active retries, verification, deployment, or completion may exceed the observed state. Existing expandable tool activity remains a deliberate details surface; this change does not rewrite ledger history, remove audit evidence, or alter event schemas or permission boundaries.

The title helper names the user's goal. The internal compaction brief preserves communication preferences, scoped approvals/denials, current blockers versus recovered failures, evidence references, and the most recent user-visible status. The fallback worker directive follows the same audience boundary.

Safety follows an action's effect and verified scope. Authorized inspection, editing, formatting, builds, and tests proceed without repeated approval. Sensitive external effects use control-plane policy. Suspicious words alone neither interrupt a run nor constitute a finding. Existing authorization cannot expand tenant access or override company policy.

The reviewer focuses on changed boundaries and reachable defects. It runs applicable check-mode format/lint, types, tests, builds, and safe runtime checks, or confirms evidence tied to an unchanged revision. It reports results and gaps and routes source repairs to the CTO. Repairs trigger relevant rechecks. Shared writes remain serial unless enforced locks exist.

## Sources and adaptation

Primary sources were inspected on 2026-10-03. These informed the contract; sample policies were not copied wholesale. The adaptations below are not certification or proof that all controls are implemented.

| Source | ReasonateAI adaptation |
| --- | --- |
| [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) — stable 5.0.0 | Review authentication, sessions, access, validation, and data handling at changed boundaries; detailed requirements belong in tests/reviews rather than every prompt. |
| [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) | Scoped tools, bounded execution, auditable decisions, impact-based sensitive-action controls. Retain useful sandbox commands; avoid broad filename/keyword blocks. |
| [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | External content cannot change authority or scope. Prompt instructions supplement tool authorization, isolation, brokerage, and output validation; text filters alone are insufficient. |
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [Multi-Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html) | Central membership/per-resource decisions; scoped queries, cache keys, events, artifacts, and sandboxes. An identifier or model claim is not authority. |
| [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) | Broker short-lived access; keep usable secrets outside prompts/source/logs/evidence. Authorized test-service bindings remain usable without displaying credentials. |
| [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) and [Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html) | Validate destinations/redirects and untrusted arguments at adapters. Intentional developer commands are permitted inside the grant; generated shell text cannot expand access. |
| [OWASP Supply Chain Security](https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html) and [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | Reviewed dependencies, frozen installs, reproducible checks, review evidence, and recovery. Reuse Node/Ultracite/Biome; add no competing tooling. |
| [Mastra skills](https://mastra.ai/docs/sandbox/skills) | Progressive procedure loading through our existing immutable resource router; native skills remain optional. Installed core 1.67.0 types/runtime were checked for actual delegation/direct-tool behavior. |

Implementation lives in runtime prompts, guidance markdown, `guidance/catalog`, scoped instruction loading, and resource handlers. Product/policy decisions belong in AGENTS.md and .context/SPEC.md; delivery status belongs in .context/PHASE.md.

### Language, framework, and design coverage (2026-10-16)

The scoped rules and the language, framework, and interface skills were written for this runtime against the versions the sandbox image actually pins. Public collections were consulted for topic coverage, current API facts, and the catalog of defects agents generate by default — no third-party text was reproduced. Licenses were verified on 2026-10-16 and the full table with URLs lives in [SOURCES.md](../../packages/cto-runtime/guidance/SOURCES.md).

| Source (license) | What it contributed |
| --- | --- |
| [GitHub Awesome Copilot](https://github.com/github/awesome-copilot) — Next.js, Go, accessibility instructions (MIT) | Next.js 16 App Router facts (async request APIs, cache components, route handlers, tooling changes); the Go idiom checklist; the WCAG 2.2 AA scope and semantic/ARIA anti-pattern set. |
| [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) (MIT) | The interaction, focus, form, motion, and content checklist behind `ui-review`. |
| [Anthropic `frontend-design` skill](https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design) | The design-direction method and the "default-generated look" catalog — the recurring tells that make generated UI recognizable. |
| [Anthropic `pdf` and `docx` skills](https://github.com/anthropics/skills) (proprietary/source-available — reference only, no text reproduced) | The PDF tooling inventory and the reportlab glyph trap; the `.docx`-is-a-ZIP model and the `docx`-library footguns. Their verification step renders the output with LibreOffice, which this image does not have. |
| [Toss-style design system rule](https://github.com/PatrickJS/awesome-cursorrules/blob/main/rules/toss-style-design-system.mdc) (MIT) | Restrained product-UI discipline: grayscale hierarchy, one accent, surface and elevation rules. |
| [Next.js](https://nextjs.org/docs), [Tailwind CSS](https://tailwindcss.com/docs), [shadcn/ui](https://ui.shadcn.com/docs) documentation | Verified the version-specific claims: `use cache`, `cacheLife`, `cacheTag`, `updateTag` and `revalidateTag(tag, 'profile')`, the Tailwind v4 CSS-first theme, the selector-based dark variant, and oklch state tokens. |

Every version-specific claim was also checked against `services/build-sandbox/` (Node 22, npm 12, Python 3.11, Go 1.27) and `templates/next-shadcn/` (Next.js 16, React 19, Tailwind v4, TypeScript strict). Re-verify a claim here before repeating it for a different runtime; a rule that states a stale framework fact is worse than no rule.

The design rules deliberately carry a "not defects" list beside the anti-pattern list. An agent that treats a deliberate single accent, a wide hero, or a dense data table as a defect spends a user's money undoing correct work, and the false-positive cost of guidance is higher than its omission cost.

## Evidence and evaluation boundary

Contract tests and the real Docker guidance smoke cover empty listings, named guidance, scoped imports, tool availability, and command diagnostics. Repository tests exercise PostgreSQL/Redis/Docker when provided. Exact commands/results belong in the pull request.

### Scoped guidance revision (2026-10-16)

Verified for `@reasonateai/cto-runtime`:

- `scripts/generate-guidance.mjs` is deterministic; `--check` fails on a stale generated module, and the guidance suite asserts freshness so a markdown edit that was not regenerated cannot ship.
- `ultracite check .` and `tsc -p tsconfig.json --noEmit` pass, and the full package suite passes: 30 files, 415 tests.
- The catalogs were printed from the compiled `dist/guidance/catalog.js`: always-applied policy 2,879 characters, scoped-rule catalog 2,354, skill catalog 1,663 — about 7 KB per prompt. The 12 scoped rule bodies (43,941 characters; largest 5,792) and 9 skill bodies (14,742 characters; largest 3,293) stay out of the prompt until read.
- The real main-agent instructions were resolved through `createReasonateCtoRuntime` with a request context: every always-applied rule body is present, no scoped rule or skill body is present, and every scoped rule and skill is advertised with its name and globs or description.
- `rule://` and `skill://` listing and a named scoped read resolve through the per-run resource router and through the read tool a worker actually holds.
- The sandbox image baseline gained the document libraries this revision needs. `requirements.in` was extended with `reportlab`, `pypdf`, `pdfplumber`, and `python-docx`; `requirements.lock` was regenerated with the command recorded in its own header (`uv pip compile … --generate-hashes --python-version 3.11 --universal --no-cache`), and no existing pin moved. `apps/worker/test/sandbox-runtime.test.ts` now imports all four inside the real container, and the image was rebuilt so the lock installs under `--require-hashes`.

Not verified, and therefore not claimed:

- No live model evaluation ran for this revision. Whether the model reads a scoped rule when the files it governs are in scope is a trigger-accuracy question that only an evaluation against the approved model can answer; the October 13 communication harness does not measure it.
- Design-rule adherence — spacing-scale discipline, anti-pattern avoidance, and the false-positive rate against the "not defects" list — needs browser-observed generated output. None has been produced for these rules yet.
- The 12 scoped rules and 4 new skills are unreviewed by an independent reviewer. They are guidance text, not enforced controls.
- Document output cannot be visually verified in this image: there is no PDF renderer, no `pdftoppm`, and no converter for Word. `pdf-documents` and `word-documents` therefore require the text-level checks that are available and require the CTO to state the limitation rather than claim a visual review. Whether the model follows that instruction is unevaluated.

The original October 3 guidance revision had no approved inference credential and did not live-evaluate model-driven delegation, review, phase reporting, or false-positive behavior. October 13 communication evaluation uses the configured approved DeepSeek model with synthetic observations and the actual composed CTO prompt. This is response-only evidence, not proof of delegation, app generation, tool use, browser verification, deployment, or competitive performance.

Run `pnpm --filter @reasonateai/api eval:communication <local-report.json>` with the approved credential configured externally. The harness makes nine sequential calls with a one-minute timeout, one model step, and a bounded output per scenario. Reports contain visible responses, timing, usage, effective-prompt fingerprint/character count, and a manual-review rubric; they contain no credential, raw request, or hidden reasoning. Mechanical checks flag empty responses, excessive length, unsolicited implementation mechanics, and internal scope identifiers. Human review must additionally assess truthfulness, useful blockers, requested diagnostic depth, and tone. Synthetic observations cannot certify a real application journey.

The October 13 candidate and its remaining model adherence findings are recorded in [the communication review](../evidence/agent-communication-review.md). Mechanical results improve from 1/9 to 8/9, but unsupported assumptions and unsolicited offers remain. The candidate is a draft with real sandbox/browser acceptance pending; it is not a certified communication gate. The CLI exits nonzero for flagged mechanical responses or a provider failure. Its JSON report is written after all scenarios complete; if a request fails, completed earlier responses are not retained, so budget for a full rerun rather than assuming resumable evaluation.

Before acceptance, evaluate with the approved open-weight/local model and real browser. Cover ordinary development without needless approvals, a complete generated application, a reproduced defect and repair, denied foreign-tenant/external effects, hostile retrieved instructions, and cancellation/restart. Verify an independent reviewer actually runs, detects an introduced reachable defect, and records revision-specific checks. Count harmless-action interruptions separately from valid refusals.

Measure accepted journeys, defects remaining after review, recovery reliability, user intervention, latency, and inference cost across repeated tasks. Compare identical acceptance criteria/starting conditions with another builder only when authorized; prompt improvement alone cannot substantiate “outperforms Lovable.”

Remaining enforcement is explicit: nonforked review is prompted, not forced; commands can mutate files; this change supplies neither shared-file locks nor a durable mandatory review gate. Production promotion, governed custom agents, approvals, and deployment providers still need their existing control-plane work. Missing applicable gates remain in progress.

## Deployment and recovery

No new dependencies, migrations, credentials, or external endpoints are added. Guidance ships with the normal API/worker artifact: the generator is plain Node ESM with no dependency, and it embeds the markdown into the compiled module, so a deployed artifact reads no guidance file from disk. Deploy after company review and applicable evidence; roll back to the preceding reviewed artifact to restore prior prompts/resources. Project instructions stay in project checkpoints and reload on subsequent runs. Never widen permissions to make an evaluation pass.

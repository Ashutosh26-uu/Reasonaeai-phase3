# CTO guidance and evaluation

Decision recorded 2026-10-03. Applies to the run-scoped ReasonateAI CTO building TypeScript web applications for nontechnical users.

## Keep the contract small

Rules answer **what must hold**: scope, authority, secrets, data integrity, and honest completion. Skills answer **how to do relevant work**: discovery, implementation, verification/repair, security review, and release/recovery. Every role receives short policy; procedures load by name. Startup rule enumeration is unnecessary; an empty project-rule listing is normal.

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

Implementation lives in runtime prompts, guidance/catalog, scoped instruction loading, and resource handlers. Product/policy decisions belong in AGENTS.md and .context/SPEC.md; delivery status belongs in .context/PHASE.md.

## Evidence and evaluation boundary

Contract tests and the real Docker guidance smoke cover empty listings, named guidance, scoped imports, tool availability, and command diagnostics. Repository tests exercise PostgreSQL/Redis/Docker when provided. Exact commands/results belong in the pull request.

The original October 3 guidance revision had no approved inference credential and did not live-evaluate model-driven delegation, review, phase reporting, or false-positive behavior. October 13 communication evaluation uses the configured approved DeepSeek model with synthetic observations and the actual composed CTO prompt. This is response-only evidence, not proof of delegation, app generation, tool use, browser verification, deployment, or competitive performance.

Run `pnpm --filter @reasonateai/api eval:communication <local-report.json>` with the approved credential configured externally. The harness makes nine sequential calls with a one-minute timeout, one model step, and a bounded output per scenario. Reports contain visible responses, timing, usage, effective-prompt fingerprint/character count, and a manual-review rubric; they contain no credential, raw request, or hidden reasoning. Mechanical checks flag empty responses, excessive length, unsolicited implementation mechanics, and internal scope identifiers. Human review must additionally assess truthfulness, useful blockers, requested diagnostic depth, and tone. Synthetic observations cannot certify a real application journey.

The October 13 candidate and its remaining model adherence findings are recorded in [the communication review](../evidence/agent-communication-review.md). Mechanical results improve from 1/9 to 8/9, but unsupported assumptions and unsolicited offers remain. The candidate is a draft with real sandbox/browser acceptance pending; it is not a certified communication gate. The CLI exits nonzero for flagged mechanical responses or a provider failure. Its JSON report is written after all scenarios complete; if a request fails, completed earlier responses are not retained, so budget for a full rerun rather than assuming resumable evaluation.

Before acceptance, evaluate with the approved open-weight/local model and real browser. Cover ordinary development without needless approvals, a complete generated application, a reproduced defect and repair, denied foreign-tenant/external effects, hostile retrieved instructions, and cancellation/restart. Verify an independent reviewer actually runs, detects an introduced reachable defect, and records revision-specific checks. Count harmless-action interruptions separately from valid refusals.

Measure accepted journeys, defects remaining after review, recovery reliability, user intervention, latency, and inference cost across repeated tasks. Compare identical acceptance criteria/starting conditions with another builder only when authorized; prompt improvement alone cannot substantiate “outperforms Lovable.”

Remaining enforcement is explicit: nonforked review is prompted, not forced; commands can mutate files; this change supplies neither shared-file locks nor a durable mandatory review gate. Production promotion, governed custom agents, approvals, and deployment providers still need their existing control-plane work. Missing applicable gates remain in progress.

## Deployment and recovery

No new dependencies, migrations, credentials, or external endpoints are added. Guidance ships with the normal API/worker artifact. Deploy after company review and applicable evidence; roll back to the preceding reviewed artifact to restore prior prompts/resources. Project instructions stay in project checkpoints and reload on subsequent runs. Never widen permissions to make an evaluation pass.

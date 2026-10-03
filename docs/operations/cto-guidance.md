# CTO guidance and evaluation

Decision recorded 2026-10-03. Applies to the run-scoped ReasonateAI CTO building TypeScript web applications for nontechnical users.

## Keep the contract small

Rules answer **what must hold**: scope, authority, secrets, data integrity, and honest completion. Skills answer **how to do relevant work**: discovery, implementation, verification/repair, security review, and release/recovery. Every role receives short policy; procedures load by name. Startup rule enumeration is unnecessary; an empty project-rule listing is normal.

The core prompt covers seven phases and ownership. Worker prompts describe objectives and evidence. Resource/environment context comes from actual adapters. This document keeps research and evaluation detail outside mandatory context.

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

No approved inference credential is configured in this checkout. Revised model-driven delegation, review, phase reporting, and false-positive behavior are **not** live-evaluated. No browser generation evidence or competitive performance result is claimed.

Before acceptance, evaluate with the approved open-weight/local model and real browser. Cover ordinary development without needless approvals, a complete generated application, a reproduced defect and repair, denied foreign-tenant/external effects, hostile retrieved instructions, and cancellation/restart. Verify an independent reviewer actually runs, detects an introduced reachable defect, and records revision-specific checks. Count harmless-action interruptions separately from valid refusals.

Measure accepted journeys, defects remaining after review, recovery reliability, user intervention, latency, and inference cost across repeated tasks. Compare identical acceptance criteria/starting conditions with another builder only when authorized; prompt improvement alone cannot substantiate “outperforms Lovable.”

Remaining enforcement is explicit: nonforked review is prompted, not forced; commands can mutate files; this change supplies neither shared-file locks nor a durable mandatory review gate. Production promotion, governed custom agents, approvals, and deployment providers still need their existing control-plane work. Missing applicable gates remain in progress.

## Deployment and recovery

No new dependencies, migrations, credentials, or external endpoints are added. Guidance ships with the normal API/worker artifact. Deploy after company review and applicable evidence; roll back to the preceding reviewed artifact to restore prior prompts/resources. Project instructions stay in project checkpoints and reload on subsequent runs. Never widen permissions to make an evaluation pass.

# `@reasonateai/cto-runtime`

Owns CTO behavior, worker definitions, bundled guidance, scoped tools/resources, model compatibility, and controller composition. Applications supply adapters and verified request context.

The revised guidance is locally verified; model behavior still needs evaluation with a configured approved provider. See [guidance and evaluation](../operations/cto-guidance.md).

## Composition and workflow

`createReasonateCtoRuntime` creates the CTO, its controller, and scout/coder/debugger/reviewer descriptors. It returns `mainAgent`, `controller`, `subagents`, configured `limits`, and the optional `budget`.

The CTO follows seven scaled phases: understand, plan, build, review, verify and repair, deliver, report. Questions and small changes need less ceremony. Substantial work uses the controller task tools and reports observed outcomes and the next gate. The CTO retains integration and acceptance responsibility.

| Worker | Direct tools | Objective |
| --- | --- | --- |
| Scout | `read` | Investigation; no commands or mutation |
| Coder | `read`, `edit`, `write` | Bounded implementation and focused verification |
| Debugger | `read`, `edit`, `write` | Reproduce, repair, and recheck |
| Reviewer | `read` | Independent correctness/security review and check-mode commands |

Mastra workspace allowlists do not filter direct custom tools in the installed release. Direct tools are now separately filtered when workers are materialized. Coder/debugger inherit the permitted workspace surface; reviewer adds command execution to the scout investigation surface. Commands can mutate files, so reviewer is **not** a read-only security boundary. Its instructions route source repairs to the CTO.

Use nonforked delegation for independent review. Mastra's forked path inherits parent instructions/tools; this requirement is currently prompt guidance. Hidden title/compaction definitions are not offered as workers. Governed custom-agent execution remains pending.

## Rules, skills, and project context

Rules are constraints; skills are procedures. Neither grants permission. Every role receives three short bundled rules and an explicit catalog of five on-demand skills. Contents are company-authored constants bundled into the application artifact, without executable scripts or external downloads.

| Surface | Behavior |
| --- | --- |
| `rule://` | Optional applied-policy/project-file listing; no project files is valid |
| `rule://<name>` | Named bundled rule or loaded project instruction snapshot |
| `skill://` | Optional bundled-procedure listing |
| `skill://<name>` | Exact named immutable procedure; unknown names return choices |

Startup enumeration is unnecessary. Rules are already applied; skills load only when relevant. Runtime config `skills` remains the separate optional Mastra native-skill configuration.

Project candidates are `.reasonate/AGENTS.md`, `.reasonate/rules.md`, `AGENTS.md`, and `CLAUDE.md`, loaded through the verified workspace filesystem. Relative imports are confined and bounded by depth, file size, and total context size. The production sandbox adapter rejects symlinks. Invalid imports fail with a diagnostic.

Prompts and resources share a snapshot per request-context instance. A later run or nonforked worker's cloned context captures current project instructions; the CTO's existing prompt remains stable. This is not one globally pinned project-rule revision for all workers. Production runtime never discovers API/worker host or home instructions. Standalone exported discovery/composition utilities retain explicit local host discovery when no snapshot is supplied.

## Tools, scope, and limits

Custom `read` handles workspace files/directories and registered resource URLs through a per-run router. `write` requires a current complete-read hash anchor for replacement; `edit` applies exact or hashline edits. Workers share these scoped adapters.

`readRunScope(requestContext)` requires server-populated organization, project, build-session, and run identifiers. Missing scope fails closed. Sandbox identity includes organization/project/build session; authorized agents share that session's workspace. Resource stores also include run scope. Model arguments never choose the tenant.

Configured token/spend budgets stop each loop at a step boundary; omitted provider spend remains unknown. Optional main/worker/reviewer step caps are validated; ReasonateAI supplies no default cap. Installed Mastra 1.67.0 nevertheless defaults nonforked workers to 50 steps when neither a cap nor stop condition is provided. Aggregate delegated spending, admission, capabilities, approvals, and lifecycle records remain control-plane responsibilities.

## Public modules

| Subpath | Purpose |
| --- | --- |
| `runtime`, `prompts`, `run-scope`, `budget` | Composition, roles, identity, consumption limits |
| `agents/types`, `frontmatter`, `loader`, `catalog` | Definitions and explicit discovery utilities |
| `agents/definitions`, `tool-filter`, `delegation`, `materialize` | Builtins, tool selection, delegation decisions, Mastra descriptors |
| `context/*`, `resources/*`, `tools/*` | Prompt assembly, resource routing, scoped tools |

An omitted definition tool allowlist means all permitted tools; `[]` means none. Denylists subtract afterward. Explicit discovery replaces a same-name definition outright. Runtime builtin registration does not execute host-discovered definitions automatically.

## Verification and remaining limits

Run `pnpm --filter @reasonateai/cto-runtime test` and repository gates. `pnpm --filter @reasonateai/api smoke:guidance` starts real Docker and verifies empty rules, named skills, reviewer direct-tool access, command success/failure, and next-run project instructions without inference. `smoke:checkpoint` exercises existing tools and checkpoint recovery.

Tests cover resource resolution, import confinement, direct-tool filtering, model compatibility, edits, identity, budgets, and composition. They do not prove reasoning, automatic review completion, or superiority over another builder.

Tracked gaps include governed custom agents, repeated-action detection, durable artifact-backed oversized reads, complete sandbox format readers, and launch approval/deployment integration. Status belongs in `.context/PHASE.md`.

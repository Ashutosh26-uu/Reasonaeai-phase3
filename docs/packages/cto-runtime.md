# `@reasonateai/cto-runtime`

**Status:** ✅ implemented and verified · 🟡 not yet running against live model providers
**Owns:** `packages/cto-runtime`
**Owner role:** Agent Runtime

---

## Purpose

The single owner of agent behaviour. Applications compose this package; it composes nothing from them. No agent instructions, agent definitions, or delegation policy live in `apps/`.

The product is an autonomous CTO that owns a project's whole lifecycle. That shape comes from here.

---

## Public surface

| Subpath | Provides |
| --- | --- |
| `runtime` | `createReasonateCtoRuntime`, `ReasonateCtoRuntimeConfig`, `CtoRuntimeLimits`, `CtoSubagentModels` |
| `agents/types` | `AgentDefinition`, `AgentCatalog`, `AgentDiagnostic`, `AgentMode`, `AgentThinkingLevel` |
| `agents/frontmatter` | `parseAgentFrontmatter`, `parseModelRef`, `AgentFrontmatter` |
| `agents/loader` | `discoverAgentDirs`, `loadAgentsFromDir`, `loadDiscoveredAgents`, `agentNameFromPath` |
| `agents/catalog` | `buildCatalogFromDefinitions`, `loadAgentCatalog`, `getAgentDefinition`, `diagnoseUnknownTools`, `invalidateAgentCatalog` |
| `agents/tool-filter` | `filterToolsByDefinition`, `normalizeToolName`, `unknownToolNames`, `holdsWriteCapableTool` |
| `agents/delegation` | `resolveDelegation`, `mayDelegate`, `delegatableAgents`, `refusalMessage` |
| `agents/materialize` | `materializeSubagent`, `materializeDelegatableSubagents` |
| `agents/definitions` | `BUILTIN_AGENT_DEFINITIONS`, `OFFERED_AGENT_NAMES`, worker and hidden agents, `reasonateToolUniverse`, `writeCapableTools` |
| `prompts` | CTO and custom-agent instructions; the branded name |
| `run-scope` | `readRunScope`, `sandboxIdFor`, `runScopeKeys`, `RunScope` |

`createCustomAgentTool` is internal; the CTO reaches custom agents through the composed runtime.

---

## The agent system

**There is one agent interface.** Agents are not different kinds of thing; they are the same thing differentiated by **which tools they hold** and **what their system prompt says**. A read-only investigator is not a special type — it is an agent whose tool set contains no write or execute tool.

This mirrors the reference harnesses. Spectra distinguishes its `explore` and `build` agents only by `disallowedTools`; oh-my-pi only by a `tools` allowlist. Neither introduces a separate agent kind.

| Surface | Purpose |
| --- | --- |
| **ReasonateAI CTO** | The orchestrator. Full approved surface; performs work directly or delegates; owns completion. |
| `scout` | Read-only investigation. An allowlist with no write or execute tool. |
| `coder` | One bounded implementation or verification objective. No allowlist: inherits every permitted tool. |
| `debugger` | The same tools as `coder`. A different working contract, not a different kind of agent. |
| `title` *(hidden)* | Names a conversation. No tools. |
| `compaction` *(hidden)* | Summarises a conversation into a durable brief. No tools. |
| Custom | Ephemeral specialist with a CTO-authored role and a bounded `access` axis. |

### Hidden agents

`hidden` agents are excluded from the offered lists but remain **resolvable by name**, and they use the same interface, catalog, and resolution path as every other agent. That is what keeps title generation and context compaction inside one system instead of growing a parallel code path. `hidden` decides whether an agent is *offered*, not whether it exists.

### Definition fields

| Field | Meaning |
| --- | --- |
| `name`, `description`, `prompt` | Required. `prompt` is the system prompt; the markdown body when loaded from a file |
| `mode` | `primary`, `subagent`, or `all`. A primary agent is never a delegation target |
| `tools` | Allowlist. **Omitted means every permitted tool; `[]` means none** |
| `disallowedTools` | Subtracted after the allowlist |
| `spawns` | `"*"` or an allowlist. **Omitted means no delegation** |
| `blocking` | Inline (`true`) or background (`false`) delegation |
| `maxTurns` | Optional hard step cap. Omitted means none |
| `hidden` | Not offered, still resolvable |
| `readSummarize` | Prefer summarised reads, which is what context compaction builds on |
| `model`, `thinkingLevel`, `temperature`, `output`, `reporting`, `color`, `metadata` | Per-agent tuning; `metadata` is the extension bag for values this contract does not model |

### Authoring surface

Agents are markdown with YAML-ish frontmatter, discovered from disk:

```markdown
---
name: reviewer
description: Reviews a change for correctness and regressions
mode: subagent
tools: read, grep
max-turns: 20
---
You review changes. Report actionable findings only.
```

Kebab, snake, and camel spellings of a field all resolve to the same key. Discovery order, lowest priority first:

1. `~/.reasonate/agents`
2. `.claude/agents`, outermost directory inward
3. `.reasonate/agents`, outermost directory inward

The nearest directory wins a name collision, and this harness's own directory wins over the compatibility one at the same depth. **One merge rule applies:** a discovered definition replaces a builtin of the same name outright. There is no field-level patching, because two merge semantics in one system is how a definition ends up meaning something its author did not write.

### Tool resolution

```text
pool = tools ? allowlist : allTools
pool = pool − disallowedTools
```

Resolution is by canonical name, so an allowlist written `Read` still matches a tool registered as `read_file`.

### Delegation guardrails

| Refusal | Meaning |
| --- | --- |
| `unknown-agent` | No such agent. The orchestrator must not fall back to a default |
| `agent-disabled` | Configured off by policy |
| `not-a-subagent` | A `primary` agent is not a delegation target |
| `self-recursion` | Checked before depth, so the refusal names the real cause |
| `spawn-denied` | The parent's spawn policy excludes the target |
| `depth-exceeded` | Recursion limit reached |

---

## Loop budgets

There are **no default step caps**. A cap that fires mid-task truncates legitimate work, and a run should be stopped by a budget that steers it toward finishing, by wall clock, or by spend — not by a number chosen before the task was understood. `maxSteps` and `maxTurns` are optional everywhere; when provided they are validated, so a typo cannot silently become a cap of one step.

---

## Run scope

```ts
readRunScope(requestContext) // throws unless org, project, session, and run are present
sandboxIdFor(scope)          // "reasonate-<org>-<project>-<buildSession>", sanitized
```

The scope is read only from server-populated request context — never from model arguments or a prompt. An incomplete scope throws, so a sandbox is never resolved against a guessed identity.

The sandbox identity is a pure function of the scope, so a reconnect reuses the same workspace instead of creating a second one and losing the project. It deliberately does **not** include a role: every authorised agent in a build session shares one project workspace.

---

## Key invariants and their tests

| Invariant | Test |
| --- | --- |
| The CTO holds a full, unrestricted mode | `test/runtime.test.ts` — mode has no tool allowlist and carries the branded name and lifecycle instructions |
| Scout cannot write or execute | `test/runtime.test.ts` — allowlist excludes write and execute-command |
| Coder and debugger can edit and execute | `test/runtime.test.ts` — allowlist includes edit and execute-command |
| No step cap is applied unless configured | `test/runtime.test.ts` — the default options carry no cap, and a configured cap is applied |
| A configured cap that a runtime cannot rely on is refused | `test/runtime.test.ts` — `mainMaxSteps: 0` throws |
| An empty allowlist means no tools, not every tool | `test/agents.test.ts` — a definition with `tools: []` holds none |
| Tool names that the deployment lacks are reported | `test/agents.test.ts` — an unknown tool produces a diagnostic |
| The nearest discovered definition wins | `test/agents.test.ts` — a child definition overrides a parent one |
| A discovered agent replaces a builtin of the same name | `test/agents.test.ts` |
| Hidden agents are excluded from the offered lists but stay resolvable | `test/agents.test.ts` |
| A primary agent is not a delegation target | `test/agents.test.ts` — refuses with `not-a-subagent` |
| Delegation honours spawn policy, depth, and self-recursion | `test/agents.test.ts` |
| An incomplete scope fails closed | `test/run-scope.test.ts` — missing or malformed identifiers throw |
| Sandbox identity isolates tenant, project, and session | `test/run-scope.test.ts` — each difference changes the id |
| Sandbox identity is Docker-safe | `test/run-scope.test.ts` — matches the allowed character class |
| Main CTO has only the bound custom mutation/read tools | `test/runtime.test.ts` — `read`, `write`, and `edit` are registered |
| An existing file cannot be replaced without a current complete read | `test/write.test.ts` — a hash anchor and full seen-line provenance are required |

---

## How it works

`createReasonateCtoRuntime` builds:

1. A `createCodingAgent` CTO with the dynamically resolved verified workspace.
2. Three custom tools: `read` resolves project paths and directories; registered resource URIs need a run-specific authorized handler that is not wired in this launch slice; `write` creates a file or replaces a fully read current file using its hash anchor; and `edit` applies exact or hashline-anchored edits.
3. An `AgentController` carrying one `cto` mode, the core subagents, memory, and storage.

The workspace and tool filesystem are deliberately resolved per request rather than at construction, because the correct workspace depends on the verified run scope of the incoming request. The generic host and Mastra filesystem mutation tools are not part of this tool set.

---

## Testing

```bash
pnpm --filter @reasonateai/cto-runtime test
```

Covers composition, the agent contract, frontmatter parsing, directory discovery and precedence, tool resolution, the delegation guard, materialisation, loop-budget validation, and run-scope isolation and sanitisation. Agent reasoning itself is not unit-tested; that belongs to evaluation workstreams.

---

## Current limitations

- No live model-provider credentials wired; the runtime composes but has not executed a real run end to end.
- Budgets are enforced as optional step caps only. Token and spend ceilings are not implemented, and the steering budget that should replace a hard cap does not exist yet.
- Doom-loop detection for repeated identical behaviour is specified but not implemented.
- Skills are described by parameter but no bundled skill set exists yet.
- Ephemeral custom-agent delegation is not registered until it can run through `AgentController` under the same verified workload grant.

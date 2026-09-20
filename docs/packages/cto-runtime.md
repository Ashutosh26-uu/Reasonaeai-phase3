# `@reasonateai/cto-runtime`

**Status:** ✅ implemented and verified · 🟡 not yet running against live model providers
**Owns:** `packages/cto-runtime`
**Owner role:** Agent Runtime

---

## Purpose

The single owner of agent behaviour. Applications compose this package; it composes nothing from them. No agent instructions, capability profiles, or delegation policy live in `apps/`.

The product is an autonomous CTO that owns a project's whole lifecycle. That shape comes from here.

---

## Public surface

| Subpath | Provides |
| --- | --- |
| `runtime` | `createReasonateCtoRuntime`, `ReasonateCtoRuntimeConfig`, `CtoRuntimeLimits`, `CtoSubagentModels` |
| `subagent-contract` | `SubagentDefinition`, `validateSubagentDefinition`, `resolveDelegation`, `effectiveTools`, `mayDelegate`, `refusalMessage` |
| `subagents` | `coreSubagentDefinitions`, `coreToolSets`, `createCoreSubagents`, `scoutWorkspaceTools`, `fullWorkspaceTools` |
| `prompts` | CTO, scout, coder, debugger, and custom-agent instructions; the branded name |
| `run-scope` | `readRunScope`, `sandboxIdFor`, `runScopeKeys`, `RunScope` |

`createCustomAgentTool` is internal; the CTO reaches custom agents through the composed runtime.

---

## The subagent contract

A worker is **data, not code**. `SubagentDefinition` names the role, describes when the orchestrator should reach for it, and carries its own system prompt, capability profile, step budget, and spawn policy. The runtime validates that data and materialises execution from it, so a second way to declare an agent cannot appear beside it. This follows the contract in oh-my-pi, where an agent is frontmatter plus a prompt body.

`subagent-contract.ts` imports nothing from Mastra. Tool sets are supplied by the caller, which keeps the contract testable without a runtime.

### Capability ceilings

| Profile | Tools | Use |
| --- | --- | --- |
| `research` | read, list, stat, grep, search, language intelligence | Investigation with no writes and no commands |
| `implementation` | full workspace, sandbox, computer, search, language intelligence | Bounded implementation or verification |
| `bugfix` | same as `implementation` | Same surface, different working contract: reproduce, repair, rerun |

A profile is a **ceiling**. `declaredTools` may narrow it and can never widen it; `effectiveTools` is the single place that is applied, so a definition cannot grant itself a tool its profile forbids.

### Delegation

`resolveDelegation` returns an allow with the definition, or a typed refusal:

| Refusal | Meaning |
| --- | --- |
| `unknown-agent` | No such agent type. The orchestrator must not fall back to a default |
| `agent-disabled` | Configured off by policy |
| `self-recursion` | An agent cannot delegate to itself. Checked before depth so the refusal names the real cause |
| `spawn-denied` | The parent's spawn policy (`"*"`, an allowlist, or `[]` to deny all) excludes the target |
| `depth-exceeded` | Recursion limit reached |

An **absent** `spawns` means no delegation at all, which is the safe default. `mayDelegate` answers the same question for an already-resolved pair.

### Guardrails and their tests

| Invariant | Test |
| --- | --- |
| A definition cannot carry undeclared fields | `test/subagent-contract.test.ts` — an extra `tools` field is rejected |
| Identifiers and step budgets are usable | same file — `Scout` with a capital, `maxSteps: 0` and `257` all rejected |
| A tool outside the profile is refused | same file — `execute` under `research` reports a ceiling violation |
| Allowlists narrow and never widen | same file — a declared `execute` under `research` yields no tools |
| Unknown targets are refused, not defaulted | same file |
| Self-recursion is refused and named before depth | same file |
| An empty spawn policy denies everything | same file |
| The shipped workers are internally consistent | same file — every shipped definition validates with zero issues |

### Materialisation

`createCoreSubagents` turns the contract into Mastra subagent definitions. Step budgets and models may be overridden per deployment; everything else comes from the contract.

| Agent | Profile | Blocking | Spawns |
| --- | --- | --- | --- |
| `scout` | `research` | yes — returns inline | none |
| `coder` | `implementation` | no — background | `scout` |
| `debugger` | `bugfix` | no — background | `scout` |

A read-only investigator has nothing useful to delegate, which is why `scout` carries no `spawns`. The orchestrator's own reach is governed by the runtime, not by this list.

### Not yet ported

Deliberately out of scope, and trackable on the Agent Runtime workstream:

- Definition **discovery** from project and user directories with first-wins precedence. The contract is the loading boundary; discovery is not implemented.
- A **`yield`-style completion tool** with reminder prompts. Today a worker reports through its final text and the instruction contract.


---

## The agents

| Agent | Capability | Purpose |
| --- | --- | --- |
| **ReasonateAI CTO** | Full approved surface | Performs work directly or delegates; owns integration and completion |
| **Scout** | Read, list, stat, grep, search, language intelligence | Focused investigation. No writes, no commands. |
| **Coder** | Full workspace and execution | One bounded implementation or verification objective |
| **Debugger** | Same as coder, different contract | Reproduce, repair the owning path, rerun the exact failed scenario |
| **Custom** | CTO-chosen capability profile | Ephemeral specialist for one bounded objective |

### Why the CTO is not a delegation-only planner

An orchestrator that only delegates loses the context that makes good decisions: what the code looks like, what failed, why. The CTO holds the full surface so it can do the work itself when that preserves context or is simply faster, and delegates when specialisation or parallelism genuinely helps.

### Why workers are not a domain hierarchy

Frontend, backend, database, infrastructure, accessibility, security, and release engineering are **task objectives** handed to these workers, not permanent agent identities. Maintaining a fixed set of domain agents would mean a permanent, unbounded background service per role and a fixed vocabulary the product would outgrow.

---

## Capability profiles

The custom-agent tool accepts an enumerated profile, never raw permissions:

| Profile | Effective tools |
| --- | --- |
| `research` | Scout's read-only set |
| `implementation` | Full workspace set |
| `debugging` | Full workspace set |
| `full` | Full workspace set |

The safety preamble is prepended to every custom agent and is stated as non-overridable by task instructions, so a CTO-authored prompt cannot widen its own grant.

---

## Run scope

```ts
readRunScope(requestContext) // throws unless org, project, session, and run are present
sandboxIdFor(scope)          // "reasonate-<org>-<project>-<buildSession>", sanitized
```

The scope is read only from server-populated request context — never from model arguments or a prompt. An incomplete scope throws, so a sandbox is never resolved against a guessed identity.

The sandbox identity is a pure function of the scope, so a reconnect reuses the same workspace instead of creating a second one and losing the project. It deliberately does **not** include a role: every authorised agent in a build session shares one project workspace.

---

## Loop limits

| Limit | Default |
| --- | --- |
| `mainMaxSteps` | 64 |
| `workerMaxSteps` | 32 |
| `debuggerMaxSteps` | 32 |
| `scoutMaxSteps` | 12 |
| `customAgentMaxSteps` | 24 |

Validated at construction: a value that is not an integer between 1 and 256 throws rather than being silently clamped, so an unbounded loop cannot be introduced by a typo.

---

## Key invariants and their tests

| Invariant | Test |
| --- | --- |
| The CTO holds a full, unrestricted mode | `test/runtime.test.ts` — mode has no tool allowlist and carries the branded name and lifecycle instructions |
| Scout cannot write or execute | `test/runtime.test.ts` — allowlist excludes write and execute-command |
| Coder and debugger can edit and execute | `test/runtime.test.ts` — allowlist includes edit and execute-command |
| Unbounded loops are refused | `test/runtime.test.ts` — `mainMaxSteps: 0` throws |
| An incomplete scope fails closed | `test/run-scope.test.ts` — missing or malformed identifiers throw |
| Sandbox identity isolates tenant, project, and session | `test/run-scope.test.ts` — each difference changes the id |
| Sandbox identity is Docker-safe | `test/run-scope.test.ts` — matches the allowed character class |

---

## How it works

`createReasonateCtoRuntime` builds:

1. A `createCodingAgent` CTO with `workspace: undefined`, because the workspace is injected at the controller level per request.
2. The custom-agent tool, bound to the CTO's model, skills, and workspace resolver.
3. An `AgentController` carrying one `cto` mode, the core subagents, memory, and storage.

The workspace is deliberately resolved per request rather than at construction, because the correct workspace depends on the verified run scope of the incoming request.

---

## Testing

```bash
pnpm --filter @reasonateai/cto-runtime test
```

Covers composition, capability profiles, loop-limit validation, and run-scope isolation and sanitisation. Agent reasoning itself is not unit-tested; that belongs to evaluation workstreams.

---

## Current limitations

- No live model-provider credentials wired; the runtime composes but has not executed a real run end to end.
- Budgets are enforced as step limits only. Token and spend ceilings are not implemented.
- Doom-loop detection for repeated identical behaviour is specified but not implemented.
- Skills are described by parameter but no bundled skill set exists yet.
- The custom-agent tool creates an agent per call with no pooling or concurrency bound.

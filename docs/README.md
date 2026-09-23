# ReasonateAI Documentation

Explanatory documentation for each part of the system. **[`../.context/ARCHITECTURE.md`](../.context/ARCHITECTURE.md) holds the canonical architecture and diagrams.** These pages explain what each component does, what it guarantees, and how to work on it.

---

## Read in this order

| # | Document | Answers |
| --- | --- | --- |
| 1 | [`../.context/ARCHITECTURE.md`](../.context/ARCHITECTURE.md) | How is the whole system put together? |
| 2 | [`data-model.md`](./data-model.md) | What is stored, where, and which invariants are enforced? |
| 3 | [`packages/contracts.md`](./packages/contracts.md) | What is the shared vocabulary between components? |
| 4 | [`packages/project-state.md`](./packages/project-state.md) | How is durable state and delivery guaranteed? |
| 5 | [`packages/auth.md`](./packages/auth.md) | How is a principal established and a request authorized? |
| 6 | [`packages/cto-runtime.md`](./packages/cto-runtime.md) | How does the agent actually behave? |
| 7 | [`apps/api.md`](./apps/api.md) | What is public, what is denied, and how is a request handled? |
| 8 | [`operations/local-development.md`](./operations/local-development.md) | How do I run this locally? |
| 9 | [`operations/verification.md`](./operations/verification.md) | How do I prove my change works? |

Canonical contracts, in precedence order: [`../.context/SPEC.md`](../.context/SPEC.md), [`../.context/PHASE.md`](../.context/PHASE.md), [`../.context/FUTURE.md`](../.context/FUTURE.md), [`../AGENTS.md`](../AGENTS.md).

---

## How documentation is maintained

Documentation is part of the deliverable, not an afterthought. A pull request that changes behavior without updating the affected page is incomplete.

### Rules

1. **Docs ship in the same pull request as the change they describe.** Never in a follow-up.
2. **Update the closest page, not a summary.** Behavior belongs in the component page; a boundary or topology change belongs in `ARCHITECTURE.md`.
3. **Delete before you add.** A page describing something that no longer exists is worse than no page.
4. **Status markers must be honest.** Every page carries a status line. A component marked ✅ must be implemented and covered by tests. Planned work is ⬜ and links to `PHASE.md` rather than describing imagined internals.
5. **No duplicated status.** Progress lives in [`../.context/PHASE.md`](../.context/PHASE.md). These pages describe design and contracts, and link to `PHASE.md` for progress.
6. **Code references over prose.** Cite the file and symbol that owns a behavior instead of restating it, so a reviewer can verify.
7. **Diagrams must be structural.** A diagram earns its place only if it would catch a reviewer's mistake. Prefer Mermaid so it renders in GitHub and Notion.

### When to update what

| Change | Update |
| --- | --- |
| Product requirement, public contract, security invariant | [`../.context/SPEC.md`](../.context/SPEC.md) |
| Scope, status, exit criteria, next work | [`../.context/PHASE.md`](../.context/PHASE.md) |
| Service boundary, deployment unit, trust boundary, data flow | [`../.context/ARCHITECTURE.md`](../.context/ARCHITECTURE.md) |
| Table, column, index, or constraint | [`data-model.md`](./data-model.md) plus the owning package page |
| Package export, function, or guarantee | The owning page under [`packages/`](./packages) |
| Command, environment variable, or local setup step | [`operations/local-development.md`](./operations/local-development.md) |
| Quality gate, test type, or evidence requirement | [`operations/verification.md`](./operations/verification.md) |
| Engineering rule, workflow, or Definition of Done | [`../AGENTS.md`](../AGENTS.md) |

### Status markers

| Marker | Meaning |
| --- | --- |
| ✅ | Implemented and verified by tests |
| 🟡 | Partially implemented; the page states exactly what is missing |
| ⬜ | Designed and agreed, not built — links to `PHASE.md` |

---

## Page template

New component pages follow this shape:

```markdown
# <Component>

**Status:** ✅ / 🟡 / ⬜
**Owns:** <paths>
**Owner role:** <workstream from the team role allocation>

## Purpose
Why this exists, in two or three sentences.

## Public surface
Table of exports: name, kind, purpose.

## Key invariants
What this component guarantees, and which test defends each one.

## How it works
The mechanism, including the non-obvious parts.

## Extending it
How to add a new case safely.

## Testing
Which test files cover it and what they prove.

## Current limitations
What is deliberately not handled yet.
```

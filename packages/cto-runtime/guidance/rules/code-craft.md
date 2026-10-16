---
name: code-craft
description: "Language-agnostic engineering discipline for any implementation change."
always: false
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py", "**/*.go", "**/*.sql"]
---

# Code craft
Applies to every language in this file's scope.

## Shape of a change
- Implement the smallest coherent change that satisfies the requirement; do not add adjacent features, retries, caches, or abstractions "while here".
- Reuse the pattern the codebase already uses. A second convention beside an existing one is a defect, not a preference.
- Delete code the change makes obsolete: dead branches, unused exports, superseded helpers, stale comments. No compatibility shims or aliases unless a published contract requires them.
- Never leave `TODO`, `FIXME`, placeholder returns, empty handlers, hard-coded success, or demonstration data in a production path. If behavior cannot be finished, say what is missing instead of shipping a stub.

## Correctness
- Make invalid states unrepresentable: encode invariants in types, schemas, or database constraints rather than in comments.
- Handle the real paths: success, validation failure, empty input, unauthorized, not-found, conflict, timeout, and cancellation. Decide what each returns before writing the happy path.
- Preserve the user's existing work. Unexpected local changes are theirs; adapt around them instead of reverting them.
- Measure before optimizing. Fix the algorithm or the query before micro-tuning.

## Boundaries
- Validate untrusted input once, where it enters the system, and pass typed values inward.
- Authorize server-side at the resource, not in the view layer.
- Keep one owner per fact. Derived values are computed, not duplicated and synchronized.

## Errors
- Return typed, actionable errors. Preserve the original cause; never swallow it to make a path look clean.
- Never catch a failure only to suppress it, log-and-rethrow in a loop, or downgrade an error to an empty result that hides the problem.
- Error text names what failed and what to do next, and never contains secrets, tokens, or full request bodies.

## Resources
- Bound everything that can grow: concurrency, queue depth, response size, upload size, retries with backoff, execution time, and memory.
- Make retried operations idempotent, or give them a stable idempotency key.
- Close what you open: streams, connections, transactions, subscriptions, timers, and event listeners.
- Avoid work in loops that can be done once: repeated parsing, repeated queries, repeated allocation, and copies of large values.

## Dependencies
- Check the standard library or an existing dependency first. Add a package only with a stated reason, a current stable version, and a compatible license.
- Never disable a linter rule, type check, or test to pass a gate. Fix the code.

## Naming and comments
- Name things for what they are in the domain. Avoid `data`, `info`, `manager`, `helper`, `utils`, and `handle` when a domain noun exists.
- Comments explain why a non-obvious decision was made, not what the next line does. Never narrate a change in a comment.

---
name: testing
description: "What a test must defend, what it must never assert, and how to keep the suite trustworthy."
always: false
globs: ["**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test_*.py", "**/*_test.py", "**/tests/**", "**/vitest.config.*"]
---

# Tests
A test earns its place only if a plausible bug would make it fail.

## Assert the contract, not the implementation
- Assert what a consumer observes: returned values, persisted state, rendered text, emitted errors, HTTP status and body, database rows.
- Never assert source text, file contents, log wording, internal call order, private helpers, mock interactions, or wiring.
- Never write a test that passes regardless of behavior: no bare "does not throw", no "result is not empty", no arbitrary length or truthiness check.
- Do not pin a component's exact copy unless the wording is the contract. If a message is the contract, assert the contract, not the typography.
- Delete a test that only restates the implementation, belongs to a removed feature, or fails for a doc-comment change.

## Choose the right level
- Unit: pure rules, schema validation, state transitions, authorization decisions, error precedence, formatting.
- Integration: persistence, migrations, adapters, session lifecycle, tenant isolation, recovery.
- End-to-end: the critical user journey through the real application and a real browser.
- Regression: the exact scenario of every fixed externally observable defect — failing before the fix, passing after, for the same reason.
- One scenario per test. A test that walks five behaviors reports one failure and hides four.

## Keep it deterministic
- No `sleep` to wait for a condition; await the real event, use fake timers, or inject the clock.
- No dependency on wall-clock time, locale, timezone, random order, or filesystem iteration order. Seed or inject them.
- Each test creates and cleans up its own fixture. Never depend on another test's side effects or run order.
- Tests must pass in parallel and in isolation; no shared mutable module state.
- Never point a test at a developer's real database, mail, port, or filesystem location.

## Write it so a failure is actionable
- Name the test for the behavior and the case it covers, not for the function under test.
- Use table/parameterized cases for the same behavior across boundary values; do not pad rows that exercise the identical path.
- Cover the failure paths, not only the happy path: invalid input, empty, unauthorized, not-found, conflict, timeout, cancellation.
- Assert the specific expected error, not that "some error" happened.
- Prefer real collaborators where practical; a mock that echoes the call back asserts the mock, not the system.

## Running them
- Run the narrowest test that covers the change first, then the affected package, then the repository gates.
- Confirm the test actually executed. A skipped, filtered, or zero-test run is not evidence of passing.
- Never weaken or delete an assertion to make a run green. Fix the behavior or the test's premise.

---
name: typescript
description: "Strict TypeScript conventions: no escape hatches, modeled states, validated boundaries."
always: false
globs: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]
---

# TypeScript
Assume `strict` is on and keep it satisfied. Never loosen `tsconfig` to make code compile.

## Forbidden escape hatches
- `any` in any position — parameter, return, generic argument, or annotation. Use `unknown` for unvalidated input, a generic when the caller supplies the shape, a domain type when it is known, or a parsed value from a schema.
- `as` casts on external or untyped data. Validate instead. For a genuine library mismatch use a named const with a one-line reason.
- `@ts-ignore`. `@ts-expect-error` only with a comment naming the upstream defect.
- Non-null `!` on anything that can be absent. Narrow with a guard, or return `undefined` and handle it.
- `Object`/`Function`/`{}` as types, and stringly typed state such as `status: string`.

## Modeling
- Represent mutually exclusive states as discriminated unions and switch exhaustively; return a compile error (`never` assertion) for the unhandled case.
- Use `satisfies` for literals that must match a contract without widening.
- Prefer `readonly` fields and `as const` for fixed tables and configuration.
- Brand identifiers that share a primitive type so a project id cannot be passed as a user id.
- Return values over out-parameters; avoid boolean parameters that switch behavior (`save(true)`).
- Type-only imports: `import type { X } from "…"`; no `import()` type expressions in function signatures.

## Boundaries
- Parse untrusted input (HTTP body, form data, query, env, file, IPC, storage) with a schema at the entry point; consume the parsed type inward. Never trust a cast at a boundary.
- Give every exported function an explicit return type when inference would produce a structural literal.
- Keep `unknown` until narrowed. Narrow with `typeof`, `in`, `Array.isArray`, or a schema — never with an unchecked assertion.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` change what `undefined` means; when the project enables them, handle the `undefined` from index access and optional properties instead of asserting it away.

## Modules and code shape
- Explicit `.js` extensions on relative ESM imports; no extensionless specifiers.
- Named exports for library code; avoid `export default` except where a framework requires it.
- No barrel files whose only job is re-exporting; they defeat tree shaking and hide ownership.
- No `enum`; use a union of literal strings or an `as const` object.
- No namespaces, no decorators unless the framework requires them.
- Keep a module's public surface small: export the behavior, not the internals.

## Verification
- Type-check the whole project after a signature change: a change to an exported type is a change to every caller.
- Do not silence a diagnostic with a cast. If the type is wrong, fix the model or the boundary.

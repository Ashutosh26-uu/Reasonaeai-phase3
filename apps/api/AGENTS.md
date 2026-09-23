# `@reasonateai/api` — Mastra agents

This app hosts ReasonateAI's Mastra agent runtime. The repository operating contract in the root [`AGENTS.md`](../../AGENTS.md) applies here; this file only adds app-local mechanics.

## Rules

- Use the `dev`, `build`, `start`, `check`, `test`, and `typecheck` scripts in `package.json` instead of invoking `mastra` directly.
- Register every agent, tool, workflow, and scorer in `src/mastra/index.ts`.
- Keep each agent's prompt and tool grants role-specific. The Architect plans and integrates; workers implement, integrate, or verify one bounded task.
- Read the run scope only from server-populated request context (`src/mastra/run-scope.ts`). Never accept an organization, project, or run identifier from model output.
- Configure sandbox approval explicitly. Do not disable approval, broadened network access, or isolation hardening to make a run succeed.
- Treat Mastra as an adapter at the authorization, policy, evidence, and audit boundaries — never as the authority that replaces them.

## Resources

- [Mastra documentation index](https://mastra.ai/llms.txt)
- Repository context: [`../../.context/SPEC.md`](../../.context/SPEC.md), [`../../.context/PHASE.md`](../../.context/PHASE.md)

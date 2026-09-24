/**
 * Mastra's generated server exposes its own agent, memory, workflow, tool, and
 * observability routes. None of them enforces ReasonateAI's authorization, and
 * `GET /api/agents` returns an agent's full system prompt to any caller.
 *
 * ReasonateAI exposes only company-owned authenticated product routes. The
 * built-in groups below are made unreachable; each pattern also blocks nested
 * routes. Middleware paths must include the configured API prefix, and custom
 * product routes must live outside it so they stay reachable.
 */
export const blockedBuiltInRouteGroups = [
  "/api/agents/*",
  "/api/agent-controllers/*",
  "/api/a2a/*",
  "/api/conversations/*",
  "/api/datasets/*",
  "/api/experiments/*",
  "/api/logs/*",
  "/api/mcp/*",
  "/api/memory/*",
  "/api/observability/*",
  "/api/responses/*",
  "/api/scorers/*",
  "/api/schedules/*",
  "/api/telemetry/*",
  "/api/tools/*",
  "/api/vectors/*",
  "/api/workflows/*",
  "/api/openapi.json",
  "/swagger-ui/*",
] as const;

const notFound = async (): Promise<Response> =>
  new Response("Not Found", { status: 404 });

/**
 * Inferred as an array of `{ path, handler }` entries rather than annotated as
 * Mastra's `Middleware[]`, so tests can assert the real shape and the
 * assignability check still happens at the `new Mastra(...)` call site.
 */
export const serverMiddleware = blockedBuiltInRouteGroups.map((path) => ({
  handler: notFound,
  path,
}));

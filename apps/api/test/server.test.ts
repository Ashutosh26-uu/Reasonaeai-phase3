import { describe, expect, it } from "vitest";
import {
  blockedBuiltInRouteGroups,
  serverMiddleware,
} from "../src/mastra/server";

const requiredDenials = [
  "/api/agents/*",
  "/api/agent-controllers/*",
  "/api/memory/*",
  "/api/tools/*",
  "/api/workflows/*",
  "/api/logs/*",
  "/api/observability/*",
  "/api/openapi.json",
  "/swagger-ui/*",
];

describe("public ingress policy", () => {
  it("denies every built-in route group that could expose agent or tenant data", () => {
    for (const path of requiredDenials) {
      expect(blockedBuiltInRouteGroups).toContain(path);
    }
  });

  it("registers one denial middleware per blocked group", () => {
    expect(serverMiddleware).toHaveLength(blockedBuiltInRouteGroups.length);
    expect(serverMiddleware.map(({ path }) => path)).toEqual([
      ...blockedBuiltInRouteGroups,
    ]);
  });

  it("answers a blocked route with 404 instead of continuing the chain", async () => {
    const [entry] = serverMiddleware;
    const response = await entry?.handler();

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe("Not Found");
  });
});

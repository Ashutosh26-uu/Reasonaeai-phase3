import { Mastra } from "@mastra/core/mastra";
import { MastraCompositeStore } from "@mastra/core/storage";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";
import {
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { createReasonateCtoRuntime } from "@reasonateai/cto-runtime";
import { serverMiddleware } from "./server";
import { reasonateBuildWorkspace } from "./workspace";

export const frontierModel = "deepseek/deepseek-flash";

const storage = new MastraCompositeStore({
  default: new LibSQLStore({
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    id: "mastra-storage",
    url: process.env.TURSO_DATABASE_URL || "file:./mastra.db",
  }),
  domains: {
    observability: await new DuckDBStore().getStore("observability"),
  },
  id: "composite-storage",
});

export const reasonateCtoRuntime = createReasonateCtoRuntime({
  model: frontierModel,
  storage,
  workspace: reasonateBuildWorkspace,
});

export const mastra = new Mastra({
  agentControllers: {
    reasonateCto: reasonateCtoRuntime.controller,
  },
  agents: {
    reasonateCto: reasonateCtoRuntime.mainAgent,
  },
  bundler: {
    externals: ["@duckdb/node-bindings"],
    transpilePackages: ["@reasonateai/contracts", "@reasonateai/cto-runtime"],
  },
  observability: new Observability({
    configs: {
      default: {
        exporters: [new MastraStorageExporter()],
        serviceName: "reasonateai-api",
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  server: {
    middleware: serverMiddleware,
  },
  storage,
});

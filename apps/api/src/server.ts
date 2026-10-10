import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { MastraServer } from "@mastra/hono";
import { Hono } from "hono";
import { mastra, outboxRelay, previewRouteDeps } from "./mastra/index.js";
import { attachPreviewUpgradeProxy } from "./mastra/preview-websocket.js";

const app = new Hono();
await new MastraServer({ app, mastra }).init();
app.get("/health", (context) => context.json({ success: true }));

const port = Number(process.env.PORT ?? 4111);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const host = process.env.HOST ?? "0.0.0.0";
const httpServer = createServer(getRequestListener(app.fetch));
const closePreviewConnections = attachPreviewUpgradeProxy(
  httpServer,
  previewRouteDeps
);

httpServer.listen(port, host, () => {
  console.info(`ReasonateAI API listening on ${host}:${port}.`);
});

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    closePreviewConnections();

    const forcedClose = setTimeout(() => {
      httpServer.closeAllConnections();
    }, 15_000);
    forcedClose.unref();

    httpServer.close(async (error) => {
      clearTimeout(forcedClose);
      if (error) {
        console.error("ReasonateAI API did not close cleanly.");
        process.exitCode = 1;
      }
      const results = await Promise.allSettled([
        outboxRelay?.stop(),
        mastra.shutdown(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        console.error("ReasonateAI API shutdown did not finish cleanly.");
        process.exitCode = 1;
      }
    });
  });
}

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serviceUrl, webPort } from "./dev-environment.mjs";
import { waitUntil } from "./dev-services.mjs";

try {
  const origin = serviceUrl(
    process.env.REASONATE_API_ORIGIN ?? "http://127.0.0.1:4111",
    ["http:", "https:"],
    "REASONATE_API_ORIGIN"
  );
  await waitUntil(async () => {
    const response = await fetch(new URL("/health", origin), {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok && (await response.json()).success === true;
  }, "API");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../apps/web/node_modules/next/dist/bin/next", import.meta.url)
      ),
      "dev",
      "--port",
      String(webPort(process.env)),
    ],
    { stdio: "inherit", windowsHide: true }
  );
  process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
} catch {
  console.error(
    "The web app cannot start until its configured API is ready. Check the API's startup output and retry."
  );
  process.exitCode = 1;
}

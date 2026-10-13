import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { developmentEnvironment } from "./dev-environment.mjs";
import { startDevelopmentServices } from "./dev-services.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== "--services-only")) {
    throw new Error("Supported startup option: --services-only.");
  }
  const environment = await developmentEnvironment(root);
  await startDevelopmentServices(root, environment);
  if (!argumentsList.includes("--services-only")) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../node_modules/turbo/bin/turbo", import.meta.url)
        ),
        "run",
        "dev",
        "--filter=@reasonateai/api",
        "--filter=@reasonateai/worker",
        "--filter=@reasonateai/web",
        "--env-mode=loose",
      ],
      { cwd: root, env: environment, stdio: "inherit", windowsHide: true }
    );
    process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
  }
} catch (cause) {
  console.error(
    `Local startup failed: ${cause instanceof Error ? cause.message : "Check local configuration and retry."}`
  );
  process.exitCode = 1;
}

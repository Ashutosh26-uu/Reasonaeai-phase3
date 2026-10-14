import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { apiDevelopmentArguments } from "./dev-environment.mjs";

const directory = fileURLToPath(new URL("../apps/api/", import.meta.url));
try {
  const result = spawnSync(
    process.execPath,
    await apiDevelopmentArguments(directory),
    { cwd: directory, stdio: "inherit", windowsHide: true }
  );
  process.exitCode = result.status ?? (result.signal === "SIGINT" ? 130 : 1);
} catch {
  console.error("The API could not start. Check its local settings and retry.");
  process.exitCode = 1;
}

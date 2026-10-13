import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { developmentEnvironment } from "./dev-environment.mjs";
import { waitUntil } from "./dev-services.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const prefix = "reasonate-dev-";
assert.ok(
  process.argv.slice(2).every((argument) => argument === "--with-tests"),
  "Supported smoke option: --with-tests"
);
const existingNames = new Set(
  (
    await execute("docker", ["ps", "-a", "--format", "{{.Names}}"], {
      windowsHide: true,
    })
  ).stdout
    .trim()
    .split("\n")
);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

await mkdir(join(root, ".verification"), { recursive: true });
const directory = await mkdtemp(join(root, ".verification/dev-smoke-"));
const [pgPort, redisPort, mailPort, apiPort, browserPort] = await Promise.all(
  Array.from({ length: 5 }, freePort)
);
assert.equal(
  new Set([pgPort, redisPort, mailPort, apiPort, browserPort]).size,
  5
);
const file = join(directory, ".env");
await writeFile(
  file,
  `DATABASE_URL=postgres://reasonate:${randomBytes(24).toString("hex")}@127.0.0.1:${pgPort}/reasonate\nREDIS_URL=redis://127.0.0.1:${redisPort}\nREASONATE_MAILPIT_URL=http://127.0.0.1:${mailPort}\nREASONATE_WEB_PORT=${browserPort}\nPORT=${apiPort}\n`,
  { mode: 0o600 }
);
const inherited = {
  ...process.env,
  DEEPSEEK_API_KEY: "",
  NODE_ENV: "development",
  REASONATE_ASR_URL: "",
  REASONATE_CHECKPOINT_ROOT: join(directory, "checkpoints"),
  REASONATE_DEV_ENV_FILE: relative(root, file),
  REASONATE_TTS_URL: "",
  TTS_URL: "",
  TURSO_DATABASE_URL: `file:${join(directory, "mastra.db")}`,
};
// The smoke owns fresh endpoints; never inherit CI or user database credentials.
for (const key of [
  "DATABASE_URL",
  "REDIS_URL",
  "REASONATE_MAILPIT_URL",
  "REASONATE_PUBLIC_ORIGIN",
  "REASONATE_ALLOWED_ORIGINS",
  "REASONATE_PREVIEW_FRAME_ORIGIN",
  "REASONATE_API_ORIGIN",
  "PORT",
  "REASONATE_WEB_PORT",
]) {
  delete inherited[key];
}
const environment = await developmentEnvironment(root, inherited);
const containers = [];
let application;
let output = "";

async function services() {
  await execute(
    process.execPath,
    [join(root, "scripts/dev.mjs"), "--services-only"],
    {
      cwd: root,
      env: environment,
      maxBuffer: 1024 * 1024,
      timeout: 1_200_000,
      windowsHide: true,
    }
  );
}

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function discoverOwnedContainers() {
  const inventory = (
    await execute(
      "docker",
      [
        "ps",
        "--filter",
        "label=reasonate.dev-service=true",
        "--format",
        "{{.Names}} {{.Ports}}",
      ],
      { windowsHide: true }
    )
  ).stdout;
  for (const line of inventory.trim().split("\n")) {
    if (
      [pgPort, redisPort, mailPort].some((port) =>
        line.includes(`127.0.0.1:${port}->`)
      )
    ) {
      const [name] = line.split(" ");
      if (
        name.startsWith(prefix) &&
        !existingNames.has(name) &&
        !containers.includes(name)
      ) {
        containers.push(name);
      }
    }
  }
}

try {
  await services();
  await discoverOwnedContainers();
  assert.equal(containers.length, 3);
  const require = createRequire(join(root, "apps/worker/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: environment.DATABASE_URL });
  await client.connect();
  await client.query(
    "CREATE TABLE dev_startup_marker (value text); INSERT INTO dev_startup_marker VALUES ('preserved')"
  );
  await client.end();
  await services();
  await execute("docker", ["stop", ...containers], {
    timeout: 60_000,
    windowsHide: true,
  });
  await services();
  const restored = new Client({ connectionString: environment.DATABASE_URL });
  await restored.connect();
  assert.equal(
    (await restored.query("SELECT value FROM dev_startup_marker")).rows[0]
      .value,
    "preserved"
  );
  await restored.end();
  if (process.argv.includes("--with-tests")) {
    const startupTests = await execute(
      process.execPath,
      ["--test", join(root, "scripts/dev.test.mjs")],
      { cwd: root, env: environment, windowsHide: true }
    );
    const packageTests = await execute(
      process.execPath,
      [
        join(root, "node_modules/turbo/bin/turbo"),
        "run",
        "test",
        "--concurrency=1",
        "--force",
      ],
      {
        cwd: root,
        env: { ...environment, REASONATE_TEST_BUILD_SANDBOX_IMAGE: "1" },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 20 * 60_000,
        windowsHide: true,
      }
    );
    await writeFile(
      join(root, ".verification/dev-smoke-tests.log"),
      `${startupTests.stdout}\n${packageTests.stdout}`,
      { mode: 0o600 }
    );
    console.log(
      "Full repository tests passed against isolated PostgreSQL, Redis and Docker."
    );
  }
  application = spawn(process.execPath, [join(root, "scripts/dev.mjs")], {
    cwd: root,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  application.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-200_000);
  });
  application.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-200_000);
  });
  await waitUntil(
    async () => (await json("/health")).success === true,
    "Smoke API",
    120_000
  );
  assert.equal((await json("/v1/auth/options")).email, "local");
  assert.equal((await json("/v1/auth/readiness")).ready, true);
  const accepted = await fetch(
    `http://127.0.0.1:${apiPort}/v1/auth/magic-links`,
    {
      body: JSON.stringify({ email: "dev-smoke@example.test" }),
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${browserPort}`,
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }
  );
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).delivery, "local");
  const inbox = await fetch(`http://127.0.0.1:${mailPort}/api/v1/messages`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal((await inbox.json()).total, 1);
  await waitUntil(
    async () => {
      const response = await fetch(`http://127.0.0.1:${browserPort}/`, {
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok && (await response.text()).includes("ReasonateAI");
    },
    "Smoke web app",
    180_000
  );
  await waitUntil(
    () => output.includes("worker.started"),
    "Smoke worker",
    60_000
  );
  console.log(
    "Development smoke passed: cold services, repeated startup, stopped-service recovery, retained database data, API, worker, web, and local email availability."
  );
} finally {
  if (application?.pid) {
    if (process.platform === "win32") {
      await execute("taskkill", ["/PID", String(application.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
    } else {
      try {
        process.kill(-application.pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  }
  await discoverOwnedContainers();
  // Only generated containers and volumes selected by these fresh fixture ports are removed.
  if (containers.length) {
    await execute("docker", ["rm", "--force", ...containers], {
      windowsHide: true,
    });
    await execute(
      "docker",
      ["volume", "rm", ...containers.map((name) => `${name}-data`)],
      { windowsHide: true }
    );
  }
  assert.ok(relative(root, directory).startsWith(".verification"));
  await rm(directory, { force: true, recursive: true });
}

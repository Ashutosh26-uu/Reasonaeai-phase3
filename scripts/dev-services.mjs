import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { configuredServices, isLoopback } from "./dev-environment.mjs";
import { startSpeechServices } from "./dev-speech.mjs";

const execute = promisify(execFile);
const LOCAL_DOCKER_TCP = /^tcp:\/\/(localhost|127\.0\.0\.1|\[::1\]):/;
const WHITESPACE = /\s+/;
const LINE_BREAK = /[\r\n]/;
const INSPECT_FORMAT =
  "[{{json .Id}},{{json .Config.Image}},{{json .State.Running}},{{json .HostConfig.PortBindings}}]";

async function docker(args, timeout = 30_000, environment = process.env) {
  try {
    const selector = [];
    if (environment.DOCKER_CONTEXT) {
      selector.push("--context", environment.DOCKER_CONTEXT);
    } else if (environment.DOCKER_HOST) {
      selector.push("--host", environment.DOCKER_HOST);
    }
    const result = await execute("docker", [...selector, ...args], {
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      timeout,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (cause) {
    throw new Error(
      `Docker could not finish ${args[0]}. Check Docker Desktop, local ports, and image availability, then retry.`,
      { cause }
    );
  }
}

export async function waitUntil(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded readiness retries must be sequential
      if (await check()) {
        return;
      }
    } catch {
      // Preserve the bounded readiness attempt; never print provider errors or credentials.
    }
    await pause(500);
  } while (Date.now() < deadline);
  throw new Error(
    `${label} is not ready. Check its local settings or port availability and retry.`
  );
}

export async function httpReady(url) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  return response.ok;
}

async function startDocker(environment) {
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"], 5000, environment);
  } catch {
    console.log("Starting Docker Desktop…");
    try {
      await docker(["desktop", "start", "--detach"], 30_000, environment);
    } catch (cause) {
      throw new Error(
        "Start Docker Desktop or your local Docker engine, then run pnpm dev again.",
        { cause }
      );
    }
    await waitUntil(
      async () =>
        Boolean(
          await docker(
            ["info", "--format", "{{.ServerVersion}}"],
            5000,
            environment
          )
        ),
      "Docker",
      120_000
    );
  }
}

async function ensureDocker(environment) {
  const host =
    (!environment.DOCKER_CONTEXT && environment.DOCKER_HOST) ||
    (await docker(
      [
        "context",
        "inspect",
        ...(environment.DOCKER_CONTEXT ? [environment.DOCKER_CONTEXT] : []),
        "--format",
        '{{(index .Endpoints "docker").Host}}',
      ],
      5000,
      environment
    ));
  if (
    !(
      host.startsWith("unix://") ||
      host.startsWith("npipe://") ||
      LOCAL_DOCKER_TCP.test(host)
    )
  ) {
    throw new Error(
      "pnpm dev requires a local Docker context; it will not create services on a remote engine."
    );
  }
  await startDocker(environment);
  return host;
}

/** Select by the configured loopback binding, never by a guessed database/container name. */
export function matchingContainer(inventory, service) {
  const port = String(service.url.port || service.port);
  const addresses =
    service.url.hostname === "localhost"
      ? ["127.0.0.1", "::1"]
      : [service.url.hostname === "[::1]" ? "::1" : "127.0.0.1"];
  const candidates = inventory.filter((candidate) =>
    (candidate.bindings?.[`${service.containerPort}/tcp`] ?? []).some(
      (binding) =>
        binding.HostPort === port && addresses.includes(binding.HostIp)
    )
  );
  if (candidates.length > 1) {
    throw new Error(
      `${service.name} has ambiguous local bindings; choose one configured endpoint.`
    );
  }
  const [container] = candidates;
  const family = service.image.split(":")[0].split("/").at(-1);
  if (
    container &&
    !new RegExp(`(?:^|/)${family}(?::|@|$)`).test(container.image)
  ) {
    throw new Error(
      `${service.name}'s configured port belongs to a different container. Nothing was replaced.`
    );
  }
  return container;
}

async function containers(environment) {
  const identifiers = await docker(
    ["container", "ls", "-aq"],
    30_000,
    environment
  );
  if (!identifiers) {
    return [];
  }
  const output = await docker(
    ["inspect", "--format", INSPECT_FORMAT, ...identifiers.split(WHITESPACE)],
    30_000,
    environment
  );
  return output.split("\n").map((line) => {
    const [id, image, running, bindings] = JSON.parse(line);
    return { bindings, id, image, running };
  });
}

async function serviceReady(service, root) {
  if (service.name === "Mailpit") {
    return await httpReady(new URL("/livez", service.url));
  }
  const require = createRequire(join(root, "apps/worker/package.json"));
  if (service.name === "PostgreSQL") {
    const { Client } = require("pg");
    const client = new Client({
      connectionString: service.url.href,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  const { createClient } = require("redis");
  const client = createClient({
    socket: { connectTimeout: 3000, reconnectStrategy: false },
    url: service.url.href,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === "PONG";
  } finally {
    if (client.isOpen) {
      client.destroy();
    }
  }
}

async function startService(service, root, environment, existing) {
  if (!isLoopback(service.url)) {
    return;
  }
  const selected = matchingContainer(existing, service);
  if (selected) {
    if (!selected.running) {
      await docker(["start", selected.id], 60_000, environment);
    }
    return;
  }
  try {
    if (await serviceReady(service, root)) {
      return; // An already-working host service does not need a duplicate container.
    }
  } catch {
    // Only the configured local endpoint is considered; never switch to another service.
  }
  if (
    service.name === "Redis" &&
    (service.url.username || service.url.password)
  ) {
    throw new Error(
      "Start the configured authenticated Redis service; pnpm dev will not create a passwordless substitute."
    );
  }
  await createService(service, root, environment);
}

async function createService(service, root, environment) {
  if (
    ["rediss:", "https:"].includes(service.url.protocol) ||
    service.url.search
  ) {
    throw new Error(
      `${service.name} has custom TLS or connection options; start that configured service before pnpm dev.`
    );
  }
  const namespace = createHash("sha256")
    .update(root)
    .update(`${service.url.hostname}:${service.url.port || service.port}`)
    .digest("hex")
    .slice(0, 10);
  const name = `reasonate-dev-${service.name.toLowerCase()}-${namespace}`;
  const binding = service.url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    "reasonate.dev-service=true",
    "--publish",
    `${binding}:${service.url.port || service.port}:${service.containerPort}`,
  ];
  const directory = await mkdtemp(join(tmpdir(), "reasonate-dev-service-"));
  try {
    if (service.name === "PostgreSQL") {
      if (
        !(service.url.username && service.url.password) ||
        service.url.pathname.length <= 1
      ) {
        throw new Error(
          "A new local PostgreSQL needs a database, username, and password in DATABASE_URL."
        );
      }
      const file = join(directory, "postgres.env");
      const values = [
        decodeURIComponent(service.url.username),
        decodeURIComponent(service.url.password),
        decodeURIComponent(service.url.pathname.slice(1)),
      ];
      if (values.some((value) => LINE_BREAK.test(value))) {
        throw new Error("PostgreSQL settings cannot contain line breaks.");
      }
      await writeFile(
        file,
        `POSTGRES_USER=${values[0]}\nPOSTGRES_PASSWORD=${values[1]}\nPOSTGRES_DB=${values[2]}\n`,
        { mode: 0o600 }
      );
      args.push(
        "--env-file",
        file,
        "--volume",
        `${name}-data:/var/lib/postgresql/data`
      );
    } else if (service.name === "Redis") {
      args.push("--volume", `${name}-data:/data`);
    } else {
      args.push(
        "--volume",
        `${name}-data:/data`,
        "--env",
        "MP_DATABASE=/data/mailpit.db"
      );
    }
    args.push(service.image);
    if (service.name === "Redis") {
      args.push("redis-server", "--appendonly", "yes");
    }
    await docker(args, 180_000, environment);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function ensureBuildImage(root, environment) {
  const image = environment.REASONATE_BUILD_SANDBOX_IMAGE;
  try {
    await docker(
      ["image", "inspect", image, "--format", "{{.Id}}"],
      5000,
      environment
    );
    return;
  } catch (cause) {
    if (!image.startsWith("reasonate-build-sandbox:")) {
      throw new Error(
        "The configured custom build image is missing. Prepare it before running pnpm dev.",
        { cause }
      );
    }
  }
  console.log(
    "Preparing the build environment; the first build can take several minutes…"
  );
  await docker(
    [
      "build",
      "--file",
      join(root, "services/build-sandbox/Dockerfile"),
      "--tag",
      image,
      join(root, "services/build-sandbox"),
    ],
    15 * 60_000,
    environment
  );
}

export async function startDevelopmentServices(root, environment) {
  const services = configuredServices(environment);
  const host = await ensureDocker(environment);
  const localEnvironment = {
    ...environment,
    DOCKER_CONTEXT: "",
    DOCKER_HOST: host,
  };
  const existing = await containers(localEnvironment);
  for (const service of services) {
    console.log(`Checking ${service.name}…`);
    // biome-ignore lint/performance/noAwaitInLoops: serialize mutations and bounded readiness checks
    await startService(service, root, localEnvironment, existing);
    await waitUntil(() => serviceReady(service, root), service.name);
  }
  await ensureBuildImage(root, localEnvironment);
  await startSpeechServices(root, localEnvironment, docker, waitUntil);
  console.log("Database, Redis, mailbox, and build environment are ready.");
}

import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function apiDevelopmentArguments(directory) {
  const argumentsList = [];
  try {
    await access(resolve(directory, ".env"));
    argumentsList.push("--env-file=.env");
  } catch (cause) {
    if (cause.code !== "ENOENT") {
      throw cause;
    }
  }
  return [...argumentsList, "--import", "tsx", "--watch", "src/server.ts"];
}

export function isLoopback(url) {
  return LOOPBACK_HOSTS.has(url.hostname);
}

export function serviceUrl(value, protocols, label) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${label} needs a valid URL.`, { cause });
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${label} uses an unsupported protocol.`);
  }
  return url;
}

export function webPort(environment) {
  const port = Number(environment.REASONATE_WEB_PORT ?? "3219");
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("REASONATE_WEB_PORT must be an unprivileged TCP port.");
  }
  return port;
}

function seedSettings(environment, stored, original, defaults) {
  let contents = original;
  for (const [key, value] of Object.entries(defaults)) {
    if (environment[key]?.trim()) {
      continue;
    }
    if (stored[key]?.trim()) {
      throw new Error(
        `${key} has an empty inherited override; remove the override to use the saved setting.`
      );
    }
    environment[key] = value;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    contents = pattern.test(contents)
      ? contents.replace(pattern, `${key}=${value}`)
      : `${contents}${contents.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  return contents;
}

/** Only seed missing local settings. Existing values and external credentials stay intact. */
export async function developmentEnvironment(root, inherited = process.env) {
  const path = resolve(
    root,
    inherited.REASONATE_DEV_ENV_FILE ?? "apps/api/.env"
  );
  const localPath = relative(root, path);
  if (localPath.startsWith("..") || isAbsolute(localPath)) {
    throw new Error("REASONATE_DEV_ENV_FILE must be inside this checkout.");
  }
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (cause.code !== "ENOENT") {
      throw new Error("The local development settings could not be read.", {
        cause,
      });
    }
  }
  const stored = parseEnv(contents);
  const environment = { ...stored, ...inherited };
  if (environment.NODE_ENV && environment.NODE_ENV !== "development") {
    throw new Error(
      "pnpm dev is for development; it cannot manage production or test services."
    );
  }
  const origin = `http://localhost:${webPort(environment)}`;
  const defaults = {
    DATABASE_URL: `postgres://reasonate:${randomBytes(24).toString("hex")}@127.0.0.1:55432/reasonate`,
    NODE_ENV: "development",
    REASONATE_ALLOWED_ORIGINS: origin,
    REASONATE_API_ORIGIN: `http://127.0.0.1:${environment.PORT ?? "4111"}`,
    REASONATE_ARTIFACT_URL_SECRET: randomBytes(32).toString("hex"),
    REASONATE_BUILD_SANDBOX_IMAGE: "reasonate-build-sandbox:node22",
    REASONATE_MAILPIT_URL: "http://127.0.0.1:58027",
    REASONATE_PREVIEW_FRAME_ORIGIN: origin,
    REASONATE_PUBLIC_ORIGIN: origin,
    REDIS_URL: "redis://127.0.0.1:56379",
    SESSION_SECRET: randomBytes(32).toString("hex"),
  };
  const original = contents;
  contents = seedSettings(environment, stored, original, defaults);
  for (const key of ["SESSION_SECRET", "REASONATE_ARTIFACT_URL_SECRET"]) {
    if (environment[key].length < 32) {
      throw new Error(
        `${key} must contain at least 32 characters; existing secrets were not replaced.`
      );
    }
  }
  // A custom file is only for this invocation. Inherited values keep the API's normal .env from overriding it.
  if (contents !== original) {
    await writeFile(path, contents, { mode: 0o600 });
  }
  return environment;
}

export function configuredServices(environment) {
  const services = [
    {
      containerPort: 5432,
      image: "postgres:16-alpine",
      key: "DATABASE_URL",
      name: "PostgreSQL",
      port: 5432,
      protocols: ["postgres:", "postgresql:"],
    },
    {
      containerPort: 6379,
      image: "redis:7-alpine",
      key: "REDIS_URL",
      name: "Redis",
      port: 6379,
      protocols: ["redis:", "rediss:"],
    },
    {
      containerPort: 8025,
      image: "axllent/mailpit:v1.31.5",
      key: "REASONATE_MAILPIT_URL",
      name: "Mailpit",
      port: 80,
      protocols: ["http:", "https:"],
    },
  ].map((service) => ({
    ...service,
    url: serviceUrl(environment[service.key], service.protocols, service.key),
  }));
  const mailbox = services.find((service) => service.name === "Mailpit");
  if (
    !(mailbox && isLoopback(mailbox.url)) ||
    mailbox.url.username ||
    mailbox.url.password
  ) {
    throw new Error(
      "The development mailbox must use a loopback URL without embedded credentials."
    );
  }
  return services;
}

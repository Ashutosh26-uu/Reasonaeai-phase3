import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { isLoopback, serviceUrl } from "./dev-environment.mjs";

export function configuredSpeech(environment) {
  return [
    {
      directory: "r2t2-asr",
      health: "/healthz",
      name: "Speech recognition",
      port: 8081,
      portKey: "ASR_PORT",
      value: environment.REASONATE_ASR_URL?.trim(),
    },
    {
      directory: "kokoro-tts",
      health: "/health",
      name: "Speech playback",
      port: 8880,
      portKey: "KOKORO_TTS_PORT",
      value:
        environment.REASONATE_TTS_URL?.trim() || environment.TTS_URL?.trim(),
    },
  ]
    .filter((service) => service.value)
    .map((service) => ({
      ...service,
      url: serviceUrl(service.value, ["http:", "https:"], service.name),
    }));
}

export async function speechReady(service) {
  const response = await fetch(new URL(service.health, service.url), {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    return false;
  }
  const body = await response.json();
  return service.directory === "r2t2-asr"
    ? body.ready === true
    : body.status === "healthy";
}

const SPEECH_SETTING = /^(ASR_|R2T2_|KOKORO_TTS_|CUDA_VISIBLE_DEVICES$)/;

export async function stackEnvironment(directory, environment) {
  let stored = {};
  try {
    stored = parseEnv(await readFile(join(directory, ".env"), "utf8"));
  } catch (cause) {
    if (cause.code !== "ENOENT") {
      throw new Error("The speech service settings could not be read.", {
        cause,
      });
    }
  }
  return {
    ...Object.fromEntries(
      Object.entries(stored).filter(([key]) => SPEECH_SETTING.test(key))
    ),
    ...environment,
  };
}

export async function recognitionModels(root, environment) {
  const directory = resolve(
    root,
    environment.R2T2_GGUF_DIR ||
      join(homedir(), ".cache/models/Confucius4-R2T2-GGUF")
  );
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      "Configured speech recognition needs local GGUF model files. Set R2T2_GGUF_DIR and prepare the documented models and supported GPU.",
      { cause }
    );
  }
  const weights = files.filter(
    (file) => file.isFile() && file.name.endsWith(".gguf")
  );
  if (
    weights.filter((file) => file.name.startsWith("mmproj")).length !== 1 ||
    weights.filter((file) => !file.name.startsWith("mmproj")).length !== 1
  ) {
    throw new Error(
      "R2T2_GGUF_DIR must contain exactly one model GGUF and one mmproj GGUF file."
    );
  }
  return directory;
}

async function startSpeech(service, root, environment, docker, waitUntil) {
  try {
    if (await speechReady(service)) {
      return;
    }
  } catch {
    // A stopped configured service can be started below; health errors contain no user content.
  }
  if (isLoopback(service.url)) {
    if (
      service.url.protocol !== "http:" ||
      service.url.username ||
      service.url.password ||
      service.url.hostname === "[::1]"
    ) {
      throw new Error(
        `${service.name} needs an HTTP localhost or 127.0.0.1 endpoint for automatic startup.`
      );
    }
    const port = Number(service.url.port || "80");
    if (port < 1024 || port > 65_535) {
      throw new Error(`${service.name} needs an unprivileged local port.`);
    }
    const directory = join(root, "services", service.directory);
    const settings = await stackEnvironment(directory, environment);
    settings[service.portKey] = String(port);
    if (service.directory === "r2t2-asr") {
      settings.R2T2_GGUF_DIR = await recognitionModels(root, settings);
    }
    await docker(
      [
        "compose",
        "--project-directory",
        directory,
        "--file",
        join(directory, "compose.yaml"),
        "up",
        "--detach",
        "--no-recreate",
        "--wait",
        "--wait-timeout",
        "300",
      ],
      600_000,
      settings
    );
  }
  await waitUntil(() => speechReady(service), service.name, 300_000);
}

export async function startSpeechServices(
  root,
  environment,
  docker,
  waitUntil
) {
  for (const service of configuredSpeech(environment)) {
    console.log(`Checking ${service.name}…`);
    // biome-ignore lint/performance/noAwaitInLoops: configured service startup and readiness are serialized
    await startSpeech(service, root, environment, docker, waitUntil);
  }
}

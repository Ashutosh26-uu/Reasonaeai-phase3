import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startupDiagnostics } from "./dev-diagnostics.mjs";
import {
  apiDevelopmentArguments,
  configuredServices,
  developmentEnvironment,
  webPort,
} from "./dev-environment.mjs";
import { httpReady, matchingContainer, waitUntil } from "./dev-services.mjs";
import {
  configuredSpeech,
  recognitionModels,
  speechReady,
  stackEnvironment,
} from "./dev-speech.mjs";

const SHORT_SECRET = /at least 32/;

test("API watch startup loads an existing env file and omits an absent optional file", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await apiDevelopmentArguments(root), [
    "--import",
    "tsx",
    "--watch",
    "src/server.ts",
  ]);
  await writeFile(join(root, ".env"), "NODE_ENV=development\n");
  assert.deepEqual(await apiDevelopmentArguments(root), [
    "--env-file=.env",
    "--import",
    "tsx",
    "--watch",
    "src/server.ts",
  ]);
});

test("startup failure diagnostics redact raw and encoded configured values", () => {
  const environment = {
    DATABASE_URL: "postgres://fixture:private%2Bvalue@localhost:55432/test",
    SESSION_SECRET: "fixture-session-secret-with-32-characters",
    TURSO_AUTH_TOKEN: "abc123",
  };
  const output = `startup failed: ${environment.DATABASE_URL} ${encodeURIComponent(environment.SESSION_SECRET)} password=private+value encoded=private%2Bvalue authToken=abc123`;
  const safe = startupDiagnostics(output, environment);
  assert.ok(safe.includes("startup failed"));
  for (const value of Object.values(environment)) {
    assert.ok(!safe.includes(value));
    assert.ok(!safe.includes(encodeURIComponent(value)));
  }
  assert.ok(!safe.includes("private+value"));
  assert.ok(!safe.includes("private%2Bvalue"));
  assert.equal(
    startupDiagnostics("private%GGvalue", {
      DATABASE_URL: "postgres://fixture:private%GGvalue@localhost/test",
    }),
    "[configured value]"
  );
});
const EXPECTED_1 = /development/;
const EXPECTED_2 = /empty inherited override/;
const EXPECTED_3 = /inside this checkout/;
const EXPECTED_5 = /loopback URL/;
const EXPECTED_6 = /unprivileged/;
const EXPECTED_7 = /ambiguous/;
const EXPECTED_8 = /different container/;
const EXPECTED_9 = /unavailable is not ready/;
const EXPECTED_11 = /local GGUF model files/;
const EXPECTED_12 = /exactly one/;

test("speech stack files cannot override the validated Docker engine or unrelated application settings", async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, ".env"),
    "DOCKER_HOST=tcp://192.0.2.1:2375\nDOCKER_CONTEXT=remote\nDOCKER_CONFIG=/elsewhere\nSESSION_SECRET=override\nKOKORO_TTS_VOICE=af_heart\n"
  );
  const settings = await stackEnvironment(root, {
    DOCKER_CONTEXT: "",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    SESSION_SECRET: "saved",
  });
  assert.equal(settings.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(settings.DOCKER_CONTEXT, "");
  assert.equal(settings.DOCKER_CONFIG, undefined);
  assert.equal(settings.SESSION_SECRET, "saved");
  assert.equal(settings.KOKORO_TTS_VOICE, "af_heart");
});

async function fixture(t, contents = "") {
  const root = await mkdtemp(join(tmpdir(), "reasonate-dev-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "apps/api"), { recursive: true });
  const file = join(root, "apps/api/.env");
  await writeFile(file, contents);
  return { file, root };
}

test("first startup persists random local credentials, second startup keeps them", async (t) => {
  const { root, file } = await fixture(t);
  const first = await developmentEnvironment(root, {});
  const saved = await readFile(file, "utf8");
  const second = await developmentEnvironment(root, {});
  assert.deepEqual(second, first);
  assert.equal(await readFile(file, "utf8"), saved);
  assert.ok(first.SESSION_SECRET.length >= 32);
  assert.notEqual(first.SESSION_SECRET, first.REASONATE_ARTIFACT_URL_SECRET);
  assert.equal(first.NODE_ENV, "development");
  assert.equal(first.REASONATE_MAILPIT_URL, "http://127.0.0.1:58027");
  const other = await fixture(t);
  assert.notEqual(
    (await developmentEnvironment(other.root, {})).SESSION_SECRET,
    first.SESSION_SECRET
  );
});

test("saved custom configuration is preserved and overrides apply only to the invocation", async (t) => {
  const contents = `# keep me\nSESSION_SECRET=${"a".repeat(32)}\nDATABASE_URL=postgres://local:password@127.0.0.1:55444/custom\nREASONATE_WEB_PORT=3220\n`;
  const { root, file } = await fixture(t, contents);
  const environment = await developmentEnvironment(root, {
    REDIS_URL: "redis://127.0.0.1:56388",
  });
  assert.equal(environment.REDIS_URL, "redis://127.0.0.1:56388");
  assert.equal(environment.REASONATE_PUBLIC_ORIGIN, "http://localhost:3220");
  assert.ok((await readFile(file, "utf8")).startsWith(contents));
  assert.ok(!(await readFile(file, "utf8")).includes("56388"));
});

test("production, short secrets, empty overrides, and outside-checkout files fail without changing settings", async (t) => {
  for (const [contents, inherited, error] of [
    ["NODE_ENV=production\n", {}, EXPECTED_1],
    ["SESSION_SECRET=short\n", {}, SHORT_SECRET],
    [`SESSION_SECRET=${"a".repeat(32)}\n`, { SESSION_SECRET: "" }, EXPECTED_2],
    ["", { REASONATE_DEV_ENV_FILE: "../elsewhere.env" }, EXPECTED_3],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: independent filesystem cases retain deterministic teardown
    const { root, file } = await fixture(t, contents);
    await assert.rejects(developmentEnvironment(root, inherited), error);
    assert.equal(await readFile(file, "utf8"), contents);
  }
});

test("local mailbox rejects remote and credential-bearing URLs, configured ports are validated", async (t) => {
  const { root } = await fixture(t);
  const environment = await developmentEnvironment(root, {});
  for (const url of [
    "https://mail.example.com",
    "http://user:secret@localhost:58027",
  ]) {
    assert.throws(
      () => configuredServices({ ...environment, REASONATE_MAILPIT_URL: url }),
      EXPECTED_5
    );
  }
  for (const port of ["abc", "80", "65536", "3219.5"]) {
    assert.throws(() => webPort({ REASONATE_WEB_PORT: port }), EXPECTED_6);
  }
});

test("existing container selection honors configured port, loopback binding, and service image", async (t) => {
  const { root } = await fixture(t);
  const [postgres] = configuredServices(await developmentEnvironment(root, {}));
  const correct = {
    bindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
    id: "selected",
    image: "postgres:16-alpine",
    running: false,
  };
  const elsewhere = {
    ...correct,
    bindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55434" }] },
    id: "other",
  };
  assert.equal(matchingContainer([elsewhere, correct], postgres), correct);
  assert.equal(
    matchingContainer([{ ...correct, image: "postgres" }], postgres)?.id,
    "selected"
  );
  assert.equal(matchingContainer([elsewhere], postgres), undefined);
  const ipv6 = {
    ...postgres,
    url: new URL(postgres.url.href.replace("127.0.0.1", "[::1]")),
  };
  assert.equal(matchingContainer([correct], ipv6), undefined);
  const ipv6Container = {
    ...correct,
    bindings: { "5432/tcp": [{ HostIp: "::1", HostPort: "55432" }] },
  };
  assert.equal(matchingContainer([ipv6Container], ipv6), ipv6Container);
  assert.equal(matchingContainer([ipv6Container], postgres), undefined);
  assert.equal(
    matchingContainer(
      [
        {
          ...correct,
          bindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }] },
        },
      ],
      postgres
    ),
    undefined
  );
  assert.throws(
    () =>
      matchingContainer([correct, { ...correct, id: "duplicate" }], postgres),
    EXPECTED_7
  );
  assert.throws(
    () =>
      matchingContainer([{ ...correct, image: "another:latest" }], postgres),
    EXPECTED_8
  );
});

async function healthServer(t, respond) {
  const server = createServer(respond);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("readiness waits through real HTTP warmup and fails within a bounded timeout", async (t) => {
  let requests = 0;
  const url = await healthServer(t, (_request, response) => {
    requests += 1;
    response.writeHead(requests < 2 ? 503 : 200).end("ready");
  });
  await waitUntil(() => httpReady(url), "fixture", 2000);
  assert.ok(requests >= 2);
  await assert.rejects(
    waitUntil(() => false, "unavailable", 10),
    EXPECTED_9
  );
});

test("speech is opt-in and requires semantic readiness, not an HTTP success alone", async (t) => {
  assert.deepEqual(configuredSpeech({}), []);
  const state = { ready: false, status: "starting" };
  const url = await healthServer(t, (_request, response) =>
    response
      .setHeader("content-type", "application/json")
      .end(JSON.stringify(state))
  );
  const [asr, tts] = configuredSpeech({
    REASONATE_ASR_URL: `${url}/v1`,
    TTS_URL: `${url}/v1/audio/speech`,
  });
  assert.equal(await speechReady(asr), false);
  assert.equal(await speechReady(tts), false);
  state.ready = true;
  state.status = "healthy";
  assert.equal(await speechReady(asr), true);
  assert.equal(await speechReady(tts), true);
});

test("configured recognition refuses missing or ambiguous models", async (t) => {
  const { root } = await fixture(t);
  const environment = { R2T2_GGUF_DIR: "weights" };
  await assert.rejects(recognitionModels(root, environment), EXPECTED_11);
  await mkdir(join(root, "weights"));
  await writeFile(join(root, "weights/model.gguf"), "fixture");
  await assert.rejects(recognitionModels(root, environment), EXPECTED_12);
  await writeFile(join(root, "weights/mmproj.gguf"), "fixture");
  assert.equal(
    await recognitionModels(root, environment),
    join(root, "weights")
  );
  await writeFile(join(root, "weights/other.gguf"), "fixture");
  await assert.rejects(recognitionModels(root, environment), EXPECTED_12);
});

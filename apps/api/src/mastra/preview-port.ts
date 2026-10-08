import { randomUUID } from "node:crypto";
import type { ISandbox } from "@reasonateai/contracts/sandbox";
import { z } from "zod";

const ListeningAppSchema = z.strictObject({
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1024).max(65_535),
});
const RELAY_PATH = "/tmp/reasonate-preview-relay.cjs";
const RELAY_LOG = "/tmp/reasonate-preview-relay.log";
const RELAY_READY_PATH = "/tmp/reasonate-preview-relay.ready";
const RELAY_PID_PATH = "/tmp/reasonate-preview-relay.pid";

/** Probe only listening sockets inside the assigned preview sandbox, never host URLs. */
export async function discoverPreviewApp(
  sandbox: ISandbox,
  preferredPort?: number,
  preferredHost?: "127.0.0.1" | "::1"
) {
  const code = `
const fs = require('node:fs');
const ports = new Set();
for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
  try {
    for (const row of fs.readFileSync(path, 'utf8').trim().split('\\n').slice(1)) {
      const fields = row.trim().split(/\\s+/);
      if (fields[3] !== '0A') continue;
      const port = parseInt(fields[1].split(':')[1], 16);
      if (port >= 1024 && port <= 65535) ports.add(port);
    }
  } catch {}
}
const preferred = ${preferredPort ?? "null"};
const priority = [3000,5173,4173,4321,4200,8080,8000];
const candidates = [...ports].filter(port => preferred === null || port === preferred).sort((a,b) => {
  const rank = port => priority.includes(port) ? priority.indexOf(port) : priority.length;
  return rank(a)-rank(b) || a-b;
}).slice(0,16);
let fallback;
async function probe(index) {
  if (index >= candidates.length) { if (fallback) process.stdout.write(JSON.stringify(fallback)); return; }
  const port = candidates[index];
  for (const host of ${JSON.stringify(preferredHost ? [preferredHost] : ["127.0.0.1", "::1"])}) {
    try {
      const response = await fetch('http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/', { redirect: 'manual', signal: AbortSignal.timeout(200) });
      await response.body?.cancel();
      if (preferred !== null || (response.headers.get('content-type') || '').includes('text/html')) {
        process.stdout.write(JSON.stringify({ host, port })); return;
      }
      fallback ??= { host, port };
      break;
    } catch {}
  }
  return probe(index + 1);
}
probe(0).catch(() => process.exitCode = 1);
`;
  const result = await sandbox.runCommand({
    args: ["-e", code],
    command: "node",
    timeoutMs: 8000,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return;
  }
  const parsed = ListeningAppSchema.safeParse(JSON.parse(result.stdout));
  return parsed.success ? parsed.data : undefined;
}

/** Forward the fixed published port to the actual app; no credentials or host network are used. */
export async function connectPreviewApp(
  sandbox: ISandbox,
  input: z.infer<typeof ListeningAppSchema>,
  publishedPort: number,
  basePath = ""
) {
  const app = ListeningAppSchema.parse(input);
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const readyToken = randomUUID();
  const code = `
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const addresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
const address = addresses.find(item => item.family === 'IPv4' && !item.internal)?.address;
if (!address) throw new Error('Preview network interface unavailable');
http.createServer((request, response) => {
  const upstream = http.request({ hostname: ${JSON.stringify(app.host)}, port: ${app.port}, path: ${JSON.stringify(prefix)} + (request.url || "/"), method: request.method, headers: request.headers }, result => {
    response.writeHead(result.statusCode || 502, result.headers);
    result.pipe(response);
    result.on('error', () => response.destroy());
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'x-reasonate-preview-upstream': 'unavailable' }); response.end('The app server is unavailable.'); });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}).listen(${publishedPort}, address, () => {
  try { fs.writeFileSync(${JSON.stringify(RELAY_PID_PATH)}, String(process.pid)); } catch {}
  fs.writeFileSync(${JSON.stringify(RELAY_READY_PATH)}, ${JSON.stringify(readyToken)});
});
`;
  const written = await sandbox.runCommand({
    args: [
      "-e",
      `const fs = require('node:fs');
try {
  const oldPid = parseInt(fs.readFileSync(${JSON.stringify(RELAY_PID_PATH)}, 'utf8'), 10);
  if (oldPid && !Number.isNaN(oldPid)) process.kill(oldPid);
} catch {}
fs.rmSync(${JSON.stringify(RELAY_READY_PATH)}, { force: true });
fs.rmSync(${JSON.stringify(RELAY_PID_PATH)}, { force: true });
fs.writeFileSync(${JSON.stringify(RELAY_PATH)}, ${JSON.stringify(code)});`,
    ],
    command: "node",
    timeoutMs: 5000,
  });
  if (written.exitCode !== 0) {
    throw new Error("The preview port relay could not be prepared.");
  }
  const result = await sandbox.runCommand({
    args: ["-c", `nohup node ${RELAY_PATH} > ${RELAY_LOG} 2>&1 </dev/null &`],
    command: "sh",
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "The discovered app port could not be connected to its preview."
    );
  }
  const ready = await sandbox.runCommand({
    args: [
      "-e",
      `const fs = require('node:fs');
const deadline = Date.now() + 3000;
function poll() {
  try { if (fs.readFileSync(${JSON.stringify(RELAY_READY_PATH)}, 'utf8') === ${JSON.stringify(readyToken)}) return; } catch {}
  if (Date.now() >= deadline) { process.exitCode = 1; return; }
  setTimeout(poll, 50);
}
poll();`,
    ],
    command: "node",
    timeoutMs: 5000,
  });
  if (ready.exitCode !== 0) {
    throw new Error(
      `The app preview relay could not listen on port ${publishedPort}. Configure the app to bind to localhost or choose a different app port.`
    );
  }
}

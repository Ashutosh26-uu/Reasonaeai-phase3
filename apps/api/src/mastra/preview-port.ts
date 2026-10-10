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
const RELAY_ERROR_PATH = "/tmp/reasonate-preview-relay.error";
const RELAY_LOCK_PATH = "/tmp/reasonate-preview-relay.lock";

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
const net = require('node:net');
const os = require('node:os');
const addresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
const address = addresses.find(item => item.family === 'IPv4' && !item.internal)?.address;
if (!address) throw new Error('Preview network interface unavailable');
const server = http.createServer((request, response) => {
  const upstream = http.request({ hostname: ${JSON.stringify(app.host)}, port: ${app.port}, path: ${JSON.stringify(prefix)} + (request.url || "/"), method: request.method, headers: request.headers }, result => {
    response.writeHead(result.statusCode || 502, result.headers);
    result.pipe(response);
    result.on('error', () => response.destroy());
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'x-reasonate-preview-upstream': 'unavailable' }); response.end('The app server is unavailable.'); });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
});
server.on('upgrade', (request, socket, head) => {
  const requestPath = request.url || '/';
  const path = ${JSON.stringify(prefix)} + requestPath;
  if (!path.startsWith('/') || /[\\r\\n]/.test(path)) {
    socket.end('HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');
    return;
  }
  const upstream = net.connect({ host: ${JSON.stringify(app.host)}, port: ${app.port} });
  let closed = false;
  let responseStarted = false;
  let connectTimer;
  const fail = () => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    if (!responseStarted && !socket.destroyed && !socket.writableEnded) {
      socket.end('HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');
    } else {
      socket.destroy();
    }
    upstream.destroy();
  };
  connectTimer = setTimeout(fail, 5000);
  upstream.once('connect', () => {
    clearTimeout(connectTimer);
    if (socket.destroyed) { upstream.destroy(); return; }
    const blocked = new Set(['connection', 'host', 'upgrade', 'cookie', 'authorization', 'proxy-authorization', 'proxy-connection', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
    for (const token of (request.headers.connection || '').split(',')) {
      if (token.trim()) blocked.add(token.trim().toLowerCase());
    }
    const lines = [(request.method || 'GET') + ' ' + path + ' HTTP/' + request.httpVersion];
    const headers = new Map();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const lowerName = name.toLowerCase();
      if (blocked.has(lowerName)) continue;
      const values = headers.get(lowerName) || [];
      values.push([name, request.rawHeaders[index + 1]]);
      headers.set(lowerName, values);
    }
    const host = ${JSON.stringify(app.host)}.includes(':') ? '[' + ${JSON.stringify(app.host)} + ']' : ${JSON.stringify(app.host)};
    lines.push('Host: ' + host + ':' + ${app.port});
    lines.push('Connection: Upgrade');
    lines.push('Upgrade: websocket');
    for (const values of headers.values()) for (const [name, value] of values) lines.push(name + ': ' + value);
    upstream.write(lines.join('\\r\\n') + '\\r\\n\\r\\n');
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('data', () => { responseStarted = true; });
  upstream.once('error', fail);
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => { closed = true; clearTimeout(connectTimer); upstream.destroy(); });
  upstream.once('close', () => { if (!socket.destroyed && !socket.writableEnded) socket.end(); });
});
server.on('error', error => {
  try { fs.writeFileSync(${JSON.stringify(RELAY_ERROR_PATH)}, String(error.message).slice(0, 400)); } catch {}
});
server.listen(${publishedPort}, address, () => {
  try { fs.writeFileSync(${JSON.stringify(RELAY_PID_PATH)}, String(process.pid)); } catch {}
  fs.writeFileSync(${JSON.stringify(RELAY_READY_PATH)}, ${JSON.stringify(readyToken)});
});
`;
  const written = await sandbox.runCommand({
    args: [
      "-e",
      `(async () => {
const fs = require('node:fs');
const relayPath = ${JSON.stringify(RELAY_PATH)};
const lockPath = ${JSON.stringify(RELAY_LOCK_PATH)};
const lockDeadline = Date.now() + 8000;
let lockFd;
while (lockFd === undefined && Date.now() < lockDeadline) {
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeSync(lockFd, String(process.pid));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const lockPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      let alive = false;
      try { process.kill(lockPid, 0); alive = true; } catch (probeError) { alive = probeError.code !== 'ESRCH'; }
      const stale = !alive && Number.isSafeInteger(lockPid) && lockPid > 1;
      const abandoned = Date.now() - fs.statSync(lockPath).mtimeMs > 10000;
      if (stale || abandoned) fs.rmSync(lockPath, { force: true });
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
if (lockFd === undefined) throw new Error('Another preview relay startup is still in progress.');
try {
let oldPid;
try { oldPid = Number.parseInt(fs.readFileSync(${JSON.stringify(RELAY_PID_PATH)}, 'utf8'), 10); } catch {}
if (Number.isSafeInteger(oldPid) && oldPid > 1) {
  const commandLine = () => { try { return fs.readFileSync('/proc/' + oldPid + '/cmdline', 'utf8').split('\\0'); } catch { return []; } };
  const ownsRelay = () => commandLine().some(argument => argument === relayPath || argument.endsWith('/reasonate-preview-relay.cjs'));
  if (ownsRelay()) {
    try { process.kill(oldPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 3000;
    while (ownsRelay() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (ownsRelay()) throw new Error('The previous preview relay did not exit before restart.');
  }
}
fs.rmSync(${JSON.stringify(RELAY_READY_PATH)}, { force: true });
fs.rmSync(${JSON.stringify(RELAY_ERROR_PATH)}, { force: true });
fs.rmSync(${JSON.stringify(RELAY_PID_PATH)}, { force: true });
fs.writeFileSync(${JSON.stringify(RELAY_LOG)}, '');
fs.writeFileSync(relayPath, ${JSON.stringify(code)});
} finally {
  fs.closeSync(lockFd);
  fs.rmSync(lockPath, { force: true });
}
})().catch(error => { process.stderr.write(String(error.message || error).slice(0, 400)); process.exitCode = 1; });`,
    ],
    command: "node",
    timeoutMs: 10_000,
  });
  if (written.exitCode !== 0) {
    const detail = written.stderr.trim().slice(0, 400);
    throw new Error(
      detail
        ? `The preview port relay could not be prepared: ${detail}`
        : "The preview port relay could not be prepared."
    );
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
  try {
    const error = fs.readFileSync(${JSON.stringify(RELAY_ERROR_PATH)}, 'utf8').slice(0, 400);
    if (error) { process.stdout.write(error); process.exitCode = 1; return; }
  } catch {}
  if (Date.now() >= deadline) {
    try { process.stdout.write(fs.readFileSync(${JSON.stringify(RELAY_LOG)}, 'utf8').slice(-400)); } catch {}
    process.exitCode = 1;
    return;
  }
  setTimeout(poll, 50);
}
poll();`,
    ],
    command: "node",
    timeoutMs: 5000,
  });
  if (ready.exitCode !== 0) {
    const detail = ready.stdout.trim() || ready.stderr.trim();
    throw new Error(
      detail
        ? `The preview relay could not listen on port ${publishedPort}: ${detail}`
        : `The preview relay did not become ready on port ${publishedPort}.`
    );
  }
}

import {
  WORKSPACE_READ_EXCLUDED_SEGMENTS,
  WorkspaceFileSchema,
  WorkspaceTreeSchema,
} from "@reasonateai/contracts/execution-protocol";
import type { ISandbox } from "@reasonateai/contracts/sandbox";

// Executed inside the existing sandbox, never on the API filesystem. No shell
// interpolation, symlink traversal, dependency traversal, or unbounded reads.
export const LIVE_WORKSPACE_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync('/workspace');
const excluded = new Set(${JSON.stringify(WORKSPACE_READ_EXCLUDED_SEGMENTS)});
const exposed = relative => relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(part => part === '..' || excluded.has(part));
const within = target => target.startsWith(root + '/');
const target = process.argv[1];
if (target !== undefined) {
  if (!exposed(target)) throw new Error('Workspace path is unavailable.');
  const absolute = path.resolve(root, target);
  const real = fs.realpathSync(absolute);
  if (!within(real) || !exposed(path.relative(root, real))) throw new Error('Workspace path is unavailable.');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.realpathSync('/proc/self/fd/' + fd);
    if (!within(opened) || !exposed(path.relative(root, opened))) throw new Error('Workspace path is unavailable.');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Workspace path is unavailable.');
    const body = Buffer.alloc(Math.min(stat.size + 1, 262145));
    let length = 0;
    while (length < body.length) {
      const read = fs.readSync(fd, body, length, body.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const data = body.subarray(0, length);
    const binary = data.includes(0);
    process.stdout.write(JSON.stringify({ binary, bytes: stat.size, path: target, text: binary ? '' : data.subarray(0, 262144).toString('utf8'), truncated: length > 262144 || stat.size > 262144 }));
  } finally { fs.closeSync(fd); }
} else {
  const files = [];
  let visited = 0;
  let outputBytes = 0;
  let truncated = false;
  const deadline = Date.now() + 3000;
  function walk(relative) {
    const absolute = path.join(root, relative);
    const real = fs.realpathSync(absolute);
    if (real !== root && (!within(real) || !exposed(path.relative(root, real)))) return;
    const directoryFd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
    const directoryPath = '/proc/self/fd/' + directoryFd;
    const opened = fs.realpathSync(directoryPath);
    if (opened !== root && (!within(opened) || !exposed(path.relative(root, opened)))) return;
    const directory = fs.opendirSync(directoryPath);
    try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (++visited > 20000 || files.length >= 5000 || Date.now() > deadline) { truncated = true; return; }
      if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name.length > 1024) { truncated = true; continue; }
      try {
        const stat = fs.lstatSync(directoryPath + '/' + entry.name);
        if (stat.isSymbolicLink()) continue;
        const item = { bytes: stat.isDirectory() ? 0 : stat.size, kind: stat.isDirectory() ? 'directory' : 'file', path: name };
        outputBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (outputBytes > 600000) { truncated = true; return; }
        if (stat.isDirectory() || stat.isFile()) files.push(item);
        if (stat.isDirectory()) walk(name);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (truncated && (files.length >= 5000 || visited > 20000 || Date.now() > deadline || outputBytes > 600000)) return;
    }
    } finally { directory.closeSync(); }
    } finally { fs.closeSync(directoryFd); }
  }
  walk('');
  files.sort((a,b) => a.path.localeCompare(b.path));
  process.stdout.write(JSON.stringify({ checkpointId: '', commit: '', files, source: 'live', truncated }));
}
`;

export async function readLiveWorkspace(sandbox: ISandbox, file?: string) {
  const result = await sandbox.runCommand({
    args: [
      "-e",
      LIVE_WORKSPACE_SCRIPT,
      "--",
      ...(file === undefined ? [] : [file]),
    ],
    command: "node",
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "The live workspace could not be read. Retry after the current file operation finishes."
    );
  }
  const value: unknown = JSON.parse(result.stdout);
  return file === undefined
    ? WorkspaceTreeSchema.parse(value)
    : WorkspaceFileSchema.parse(value);
}

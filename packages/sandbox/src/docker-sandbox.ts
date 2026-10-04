import { execFile, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ISandbox,
  ISandboxProvider,
  RunCommandRequest,
  RunCommandResult,
  SandboxConfig,
  SandboxId,
  SandboxState,
} from "@reasonateai/contracts/sandbox";
import {
  RunCommandRequestSchema,
  SandboxConfigSchema,
  SandboxContainerPortSchema,
  SandboxPortBindingSchema,
} from "@reasonateai/contracts/sandbox";
import type { z } from "zod";

const execFileAsync = promisify(execFile);

/**
 * Publishes each declared container port on an ephemeral host port bound to
 * loopback. Docker chooses the host port (`:0`), and the address is written out
 * rather than left off: a `-p <port>:<port>` without an address publishes the
 * port on every interface of the host.
 */
function publishedPortFlags(ports: readonly number[]): string[] {
  const flags: string[] = [];
  for (const port of new Set(ports)) {
    flags.push("-p", `127.0.0.1:0:${SandboxContainerPortSchema.parse(port)}`);
  }
  return flags;
}

/**
 * `docker port` prints one `host:port` line for the published container port.
 * The binding is validated against the contract rather than trusted, so a
 * provider that published on a routable address fails loudly here instead of
 * handing a caller a URL that is reachable from the network.
 */
function parsePublishedHostPort(
  output: string,
  containerPort: number,
  sandboxId: SandboxId
): number {
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) {
    throw new Error(
      `Docker reported no host binding for container port ${containerPort} of sandbox ${sandboxId}.`
    );
  }

  const separator = line.lastIndexOf(":");
  const binding = SandboxPortBindingSchema.safeParse({
    containerPort,
    host: separator === -1 ? line : line.slice(0, separator),
    hostPort: separator === -1 ? Number.NaN : Number(line.slice(separator + 1)),
  });
  if (!binding.success) {
    throw new Error(
      `Docker bound container port ${containerPort} of sandbox ${sandboxId} to ${line}, which is not a host port on the loopback interface.`
    );
  }

  return binding.data.hostPort;
}

export class DockerSandbox implements ISandbox {
  readonly id: SandboxId;
  readonly config: SandboxConfig;
  readonly containerName: string;
  private readonly createdAt: string;
  readonly hostWorkspaceDir: string;
  private status: SandboxState["status"] = "pending";
  private stoppedAt: string | null = null;

  constructor(config: SandboxConfig) {
    this.config = config;
    const sanitizedId = config.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    this.containerName = `reasonate-sbx-${sanitizedId}`;
    this.createdAt = new Date().toISOString();
    this.hostWorkspaceDir = resolve(
      tmpdir(),
      `reasonate-sandbox-${sanitizedId}`
    );
    this.id = config.id;
  }

  readonly attach = async (): Promise<boolean> => {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        this.containerName,
      ]);
      if (stdout.trim() === "true") {
        this.status = "running";
        return true;
      }
      this.status = "stopped";
      return false;
    } catch {
      this.status = "stopped";
      return false;
    }
  };

  readonly init = async (): Promise<void> => {
    await mkdir(this.hostWorkspaceDir, { recursive: true });

    const dockerArgs = [
      "run",
      "-d",
      "--name",
      this.containerName,
      `--memory=${this.config.memoryLimitMb}m`,
      `--cpus=${this.config.cpuLimit}`,
      `--network=${this.config.networkMode}`,
      "--security-opt=no-new-privileges:true",
      "--pids-limit=256",
      "--label",
      `reasonate.sandbox.id=${this.config.id}`,
      // A published port exists from the moment the container is created or not
      // at all, so the declaration is honoured here, at the only point Docker
      // will accept it.
      ...publishedPortFlags(this.config.ports),
      "-w",
      this.config.workdir,
      "-v",
      `${this.hostWorkspaceDir}:${this.config.workdir}`,
    ];

    const env = {
      HOME: this.config.workdir,
      ...this.config.env,
    };

    for (const [key, value] of Object.entries(env)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(this.config.image, "sleep", "infinity");

    try {
      await execFileAsync("docker", dockerArgs);
      this.status = "running";
    } catch (error) {
      this.status = "error";
      await this.cleanup();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize Docker sandbox: ${message}`, {
        cause: error,
      });
    }
  };

  readonly getState = (): Promise<SandboxState> =>
    Promise.resolve({
      config: this.config,
      createdAt: this.createdAt,
      id: this.id,
      status: this.status,
      stoppedAt: this.stoppedAt,
    });

  /**
   * Reads back the host port Docker assigned to a declared container port. The
   * host port is Docker's to choose, so it is looked up rather than derived, and
   * the binding is validated as loopback-only before it is handed out.
   */
  readonly exposePort = async (containerPort: number): Promise<number> => {
    if (this.status !== "running") {
      throw new Error(
        `Cannot publish a port on sandbox in status: ${this.status}`
      );
    }

    const port = SandboxContainerPortSchema.parse(containerPort);
    if (!this.config.ports.includes(port)) {
      throw new Error(
        `Container port ${port} was not declared when sandbox ${this.id} was created; a port cannot be published on an existing container.`
      );
    }

    const { stdout } = await execFileAsync("docker", [
      "port",
      this.containerName,
      `${port}/tcp`,
    ]);

    return parsePublishedHostPort(stdout, port, this.id);
  };

  /** The first declared port is the sandbox's address from the host. */
  readonly baseUrl = async (): Promise<string> => {
    const [firstPort] = this.config.ports;
    if (firstPort === undefined) {
      throw new Error(
        `Sandbox ${this.id} publishes no port, so it has no host address.`
      );
    }

    const hostPort = await this.exposePort(firstPort);
    return `http://127.0.0.1:${hostPort}`;
  };

  private readonly extractExecError = (
    error: unknown,
    startTime: number
  ): RunCommandResult => {
    const durationMs = Math.round(performance.now() - startTime);

    if (typeof error === "object" && error !== null && "code" in error) {
      const execErr = error as {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stderr?: unknown;
        stdout?: unknown;
      };
      const timedOut =
        execErr.killed === true ||
        execErr.signal === "SIGKILL" ||
        execErr.code === "ETIMEDOUT";
      let exitCode = 1;
      if (typeof execErr.code === "number") {
        exitCode = execErr.code;
      } else if (timedOut) {
        exitCode = 124;
      }

      return {
        durationMs,
        exitCode,
        stderr: String(execErr.stderr ?? ""),
        stdout: String(execErr.stdout ?? ""),
        timedOut,
      };
    }

    return {
      durationMs,
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
      timedOut: false,
    };
  };

  readonly runCommand = async (
    rawRequest: RunCommandRequest
  ): Promise<RunCommandResult> => {
    if (this.status !== "running") {
      throw new Error(
        `Cannot run command on sandbox in status: ${this.status}`
      );
    }

    const request = RunCommandRequestSchema.parse(rawRequest);
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const cwd = request.cwd ?? this.config.workdir;

    const execArgs = ["exec", "-i", "-w", cwd];

    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        execArgs.push("-e", `${key}=${value}`);
      }
    }

    execArgs.push(this.containerName, request.command, ...request.args);
    const startTime = performance.now();

    try {
      const { stderr, stdout } = await execFileAsync("docker", execArgs, {
        killSignal: "SIGKILL",
        timeout: timeoutMs,
      });

      return {
        durationMs: Math.round(performance.now() - startTime),
        exitCode: 0,
        stderr: stderr.toString(),
        stdout: stdout.toString(),
        timedOut: false,
      };
    } catch (error: unknown) {
      return this.extractExecError(error, startTime);
    }
  };

  private readonly safeResolvePath = (relativePath: string): string => {
    if (isAbsolute(relativePath)) {
      throw new Error("Relative path expected, got absolute path");
    }
    const safePath = normalize(join(this.hostWorkspaceDir, relativePath));
    const isWithinWorkspace =
      safePath === this.hostWorkspaceDir ||
      safePath.startsWith(`${this.hostWorkspaceDir}${sep}`);
    if (!isWithinWorkspace) {
      throw new Error("Path traversal detected outside sandbox workspace");
    }
    return safePath;
  };

  readonly writeFile = async (
    relativePath: string,
    content: string | Uint8Array
  ): Promise<void> => {
    if (this.status !== "running") {
      throw new Error(`Cannot write file on sandbox in status: ${this.status}`);
    }
    const target = this.safeResolvePath(relativePath);
    await mkdir(resolve(target, ".."), { recursive: true });
    await fsWriteFile(target, content);
  };

  readonly readFile = async (relativePath: string): Promise<string> => {
    if (this.status !== "running") {
      throw new Error(`Cannot read file on sandbox in status: ${this.status}`);
    }
    const target = this.safeResolvePath(relativePath);
    return await fsReadFile(target, "utf-8");
  };

  private readonly cleanup = async (): Promise<void> => {
    try {
      await execFileAsync("docker", ["rm", "-f", "-v", this.containerName]);
    } catch {
      // Ignore if container already removed
    }
    try {
      await rm(this.hostWorkspaceDir, { force: true, recursive: true });
    } catch {
      // Ignore cleanup error
    }
  };

  readonly destroy = async (): Promise<void> => {
    await this.cleanup();
    this.status = "destroyed";
    this.stoppedAt = new Date().toISOString();
  };

  /**
   * The teardown a process-exit handler can finish: the container and its
   * workspace directory are removed by synchronous calls, because an exit
   * handler has no event loop left to await in and on Windows a child process
   * spawned there is killed along with its parent.
   */
  readonly destroySync = (): void => {
    try {
      spawnSync("docker", ["rm", "-f", "-v", this.containerName], {
        stdio: "ignore",
      });
    } catch {
      // Best effort: the process is going down either way.
    }
    try {
      rmSync(this.hostWorkspaceDir, { force: true, recursive: true });
    } catch {
      // Best effort, as above.
    }
    this.status = "destroyed";
    this.stoppedAt = new Date().toISOString();
  };

  static readonly cleanupOrphanedContainers = async (
    sandboxId?: string
  ): Promise<void> => {
    try {
      const filter = sandboxId
        ? `label=reasonate.sandbox.id=${sandboxId}`
        : "label=reasonate.sandbox.id";
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "-a",
        "-q",
        "--filter",
        filter,
      ]);
      const containerIds = stdout.trim().split("\n").filter(Boolean);
      if (containerIds.length > 0) {
        await execFileAsync("docker", ["rm", "-f", "-v", ...containerIds]);
      }
    } catch {
      // Best-effort cleanup
    }
  };
}

export class DockerSandboxProvider implements ISandboxProvider {
  readonly name = "docker";
  private readonly sandboxes = new Map<SandboxId, DockerSandbox>();

  readonly create = async (
    rawConfig: z.input<typeof SandboxConfigSchema>
  ): Promise<ISandbox> => {
    const config = SandboxConfigSchema.parse(rawConfig);
    const sandbox = new DockerSandbox(config);
    await sandbox.init();
    this.sandboxes.set(config.id, sandbox);
    return sandbox;
  };

  readonly attach = async (
    rawConfig: z.input<typeof SandboxConfigSchema>
  ): Promise<ISandbox | null> => {
    const config = SandboxConfigSchema.parse(rawConfig);
    const sandbox = new DockerSandbox(config);
    const alive = await sandbox.attach();
    if (!alive) {
      return null;
    }
    this.sandboxes.set(config.id, sandbox);
    return sandbox;
  };

  readonly get = (id: SandboxId): Promise<ISandbox | null> =>
    Promise.resolve(this.sandboxes.get(id) ?? null);

  readonly destroyAll = async (): Promise<void> => {
    const promises = Array.from(this.sandboxes.values()).map((s) =>
      s.destroy()
    );
    await Promise.all(promises);
    this.sandboxes.clear();
  };
}

import { execFile } from "node:child_process";
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
} from "@reasonateai/contracts/sandbox";
import type { z } from "zod";

const execFileAsync = promisify(execFile);

export class DockerSandbox implements ISandbox {
  readonly id: SandboxId;
  private readonly config: SandboxConfig;
  private readonly containerName: string;
  private readonly createdAt: string;
  private readonly hostWorkspaceDir: string;
  private status: SandboxState["status"] = "pending";
  private stoppedAt: string | null = null;

  constructor(config: SandboxConfig) {
    this.config = config;
    this.containerName = `reasonate-sbx-${config.id}`;
    this.createdAt = new Date().toISOString();
    this.hostWorkspaceDir = resolve(tmpdir(), `reasonate-sandbox-${config.id}`);
    this.id = config.id;
  }

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
      "-w",
      this.config.workdir,
      "-v",
      `${this.hostWorkspaceDir}:${this.config.workdir}`,
    ];

    for (const [key, value] of Object.entries(this.config.env)) {
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
      await execFileAsync("docker", ["rm", "-f", this.containerName]);
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

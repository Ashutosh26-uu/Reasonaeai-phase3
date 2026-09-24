import type { RequestContext } from "@mastra/core/request-context";
import type {
  CommandResult,
  ExecuteCommandOptions,
  ProviderStatus,
  SandboxFileInput,
  SandboxInfo,
  SandboxStartResult,
  WorkspaceSandbox,
  WriteFilesOptions,
} from "@mastra/core/workspace";
import type { ISandbox, SandboxConfig } from "@reasonateai/contracts/sandbox";
import { SandboxConfigSchema } from "@reasonateai/contracts/sandbox";
import type { z } from "zod";
import { DockerSandbox } from "./docker-sandbox.js";

export interface MastraWorkspaceSandboxAdapterOptions {
  /**
   * Optional sandbox config (for capacity/resource reporting).
   */
  config?: SandboxConfig | undefined;
  /**
   * Optional name for the Mastra workspace sandbox.
   * @default "ReasonateDockerSandbox"
   */
  name?: string;
  /**
   * Optional provider name.
   * @default "reasonate-docker"
   */
  provider?: string;
  /**
   * Underlying ReasonateAI ISandbox instance.
   */
  sandbox: ISandbox;
}

const LEADING_SLASHES_REGEX = /^\/+/;

/**
 * Adapter that bridges ReasonateAI's ISandbox implementation with Mastra's
 * WorkspaceSandbox interface, enabling Mastra's agent runtime to execute inside
 * hardened Docker sandboxes with enforced cgroup limits, zero volume leaks,
 * and security sandboxing.
 */
export class MastraWorkspaceSandboxAdapter implements WorkspaceSandbox {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly supportsCheckpoints = false;
  status: ProviderStatus = "pending";
  error?: string;

  private readonly sandbox: ISandbox;
  private readonly config: SandboxConfig | undefined;

  constructor(options: MastraWorkspaceSandboxAdapterOptions) {
    this.sandbox = options.sandbox;
    this.id = options.sandbox.id;
    this.name = options.name ?? "ReasonateDockerSandbox";
    this.provider = options.provider ?? "reasonate-docker";
    this.config = options.config;
  }

  readonly start = async (): Promise<SandboxStartResult> => {
    try {
      const state = await this.sandbox.getState().catch(() => null);
      if (state?.status === "running") {
        this.status = "running";
        return { outcome: "connected" };
      }

      if (
        "init" in this.sandbox &&
        typeof (this.sandbox as DockerSandbox).init === "function"
      ) {
        this.status = "starting";
        await (this.sandbox as DockerSandbox).init();
        this.status = "running";
        return { outcome: "created" };
      }

      this.status = "running";
      return { outcome: "created" };
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  readonly stop = (): Promise<void> => {
    this.status = "stopped";
    return Promise.resolve();
  };

  readonly destroy = async (): Promise<void> => {
    this.status = "destroying";
    try {
      await this.sandbox.destroy();
      this.status = "destroyed";
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  readonly snapshot = (): Promise<void> =>
    // Checkpoints are not supported until snapshots seed real sandboxes per architecture spec
    Promise.resolve();

  readonly isReady = (): Promise<boolean> =>
    Promise.resolve(this.status === "running");

  readonly getInfo = async (): Promise<SandboxInfo> => {
    const state = await this.sandbox.getState().catch(() => null);
    const config = this.config ?? state?.config;

    const info: SandboxInfo = {
      createdAt: state?.createdAt ? new Date(state.createdAt) : new Date(),
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
    };

    if (config) {
      info.resources = {
        cpuCores: config.cpuLimit,
        memoryMB: config.memoryLimitMb,
      };
    }

    return info;
  };

  readonly executeCommand = async (
    command: string,
    args: string[] = [],
    options?: ExecuteCommandOptions
  ): Promise<CommandResult> => {
    if (options?.abortSignal?.aborted) {
      const abortError = new Error("Command aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const env = options?.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;

    const runResult = await this.sandbox.runCommand({
      args,
      command,
      cwd: options?.cwd,
      env,
      timeoutMs: options?.timeout,
    });

    if (options?.onStdout && runResult.stdout) {
      options.onStdout(runResult.stdout);
    }
    if (options?.onStderr && runResult.stderr) {
      options.onStderr(runResult.stderr);
    }

    return {
      args,
      command,
      executionTimeMs: runResult.durationMs,
      exitCode: runResult.exitCode,
      killed: runResult.timedOut,
      stderr: runResult.stderr,
      stdout: runResult.stdout,
      success: runResult.exitCode === 0,
      timedOut: runResult.timedOut,
    };
  };

  readonly writeFiles = async (
    files: SandboxFileInput[],
    options?: WriteFilesOptions
  ): Promise<void> => {
    if (options?.abortSignal?.aborted) {
      const abortError = new Error("Write files aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    const workdir = this.config?.workdir ?? "/workspace";

    await Promise.all(
      files.map(async (file) => {
        if (options?.abortSignal?.aborted) {
          const abortError = new Error("Write files aborted");
          abortError.name = "AbortError";
          throw abortError;
        }

        const relPath = file.path.startsWith(workdir)
          ? file.path.slice(workdir.length).replace(LEADING_SLASHES_REGEX, "")
          : file.path.replace(LEADING_SLASHES_REGEX, "");

        await this.sandbox.writeFile(relPath, file.content);
      })
    );
  };

  readonly getInstructions = (_opts?: {
    requestContext?: RequestContext;
  }): string =>
    "ReasonateAI Docker Sandbox: Commands execute inside an isolated container with enforced cgroup CPU and memory limits and a private workspace filesystem.";
}

/**
 * Creates a Mastra-compatible WorkspaceSandbox backed by a hardened ReasonateAI DockerSandbox.
 */
export function createMastraSandbox(
  rawConfig: z.input<typeof SandboxConfigSchema>
): MastraWorkspaceSandboxAdapter {
  const config = SandboxConfigSchema.parse(rawConfig);
  const sandbox = new DockerSandbox(config);
  return new MastraWorkspaceSandboxAdapter({
    config,
    name: `ReasonateDockerSandbox-${config.id}`,
    provider: "reasonate-docker",
    sandbox,
  });
}

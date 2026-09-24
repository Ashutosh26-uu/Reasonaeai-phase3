import type {
  ISandbox,
  ISandboxProvider,
  RunCommandRequest,
  RunCommandResult,
  SandboxConfig,
  SandboxId,
  SandboxState,
} from "@reasonateai/contracts/sandbox";
import { SandboxConfigSchema } from "@reasonateai/contracts/sandbox";
import type { z } from "zod";

export interface MockCommandOptions {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly timedOut?: boolean;
}

export class MockSandbox implements ISandbox {
  readonly id: SandboxId;
  private readonly config: SandboxConfig;
  private readonly createdAt: string;
  private readonly executedCommands: RunCommandRequest[] = [];
  private readonly files = new Map<string, string>();
  private readonly plannedResponses = new Map<string, MockCommandOptions>();
  private status: SandboxState["status"] = "running";
  private stoppedAt: string | null = null;

  constructor(config: SandboxConfig) {
    this.config = config;
    this.createdAt = new Date().toISOString();
    this.id = config.id;
  }

  readonly getState = (): Promise<SandboxState> =>
    Promise.resolve({
      config: this.config,
      createdAt: this.createdAt,
      id: this.id,
      status: this.status,
      stoppedAt: this.stoppedAt,
    });

  readonly setCommandResponse = (
    commandKey: string,
    response: MockCommandOptions
  ): void => {
    this.plannedResponses.set(commandKey, response);
  };

  readonly getExecutedCommands = (): readonly RunCommandRequest[] =>
    this.executedCommands;

  readonly runCommand = (
    request: RunCommandRequest
  ): Promise<RunCommandResult> => {
    if (this.status !== "running") {
      return Promise.reject(
        new Error(`Cannot run command on sandbox in status: ${this.status}`)
      );
    }

    this.executedCommands.push(request);
    const fullCmd = [request.command, ...request.args].join(" ").trim();
    const planned =
      this.plannedResponses.get(fullCmd) ??
      this.plannedResponses.get(request.command);

    if (planned) {
      return Promise.resolve({
        durationMs: 10,
        exitCode: planned.exitCode ?? 0,
        stderr: planned.stderr ?? "",
        stdout: planned.stdout ?? "",
        timedOut: planned.timedOut ?? false,
      });
    }

    return Promise.resolve({
      durationMs: 10,
      exitCode: 0,
      stderr: "",
      stdout: `[mock] executed: ${fullCmd}`,
      timedOut: false,
    });
  };

  readonly writeFile = (
    relativePath: string,
    content: string | Uint8Array
  ): Promise<void> => {
    if (this.status !== "running") {
      return Promise.reject(
        new Error(`Cannot write file on sandbox in status: ${this.status}`)
      );
    }
    const textContent =
      typeof content === "string" ? content : new TextDecoder().decode(content);
    this.files.set(relativePath, textContent);
    return Promise.resolve();
  };

  readonly readFile = (relativePath: string): Promise<string> => {
    if (this.status !== "running") {
      return Promise.reject(
        new Error(`Cannot read file on sandbox in status: ${this.status}`)
      );
    }
    const file = this.files.get(relativePath);
    if (file === undefined) {
      return Promise.reject(
        new Error(`File not found in sandbox: ${relativePath}`)
      );
    }
    return Promise.resolve(file);
  };

  readonly destroy = (): Promise<void> => {
    this.status = "destroyed";
    this.stoppedAt = new Date().toISOString();
    return Promise.resolve();
  };
}

export class MockSandboxProvider implements ISandboxProvider {
  readonly name = "mock";
  private readonly sandboxes = new Map<SandboxId, MockSandbox>();

  readonly create = (
    rawConfig: z.input<typeof SandboxConfigSchema>
  ): Promise<ISandbox> => {
    const config = SandboxConfigSchema.parse(rawConfig);
    const sandbox = new MockSandbox(config);
    this.sandboxes.set(config.id, sandbox);
    return Promise.resolve(sandbox);
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

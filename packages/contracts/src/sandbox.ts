import { z } from "zod";
import { IsoDateTimeSchema, ProjectIdSchema, RunIdSchema } from "./identity.js";

export const SandboxIdSchema = z.uuid().brand<"SandboxId">();
export type SandboxId = z.infer<typeof SandboxIdSchema>;

export const sandboxStatuses = [
  "pending",
  "running",
  "stopped",
  "destroyed",
  "error",
] as const;
export const SandboxStatusSchema = z.enum(sandboxStatuses);
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const sandboxNetworkModes = ["none", "bridge", "host"] as const;
export const SandboxNetworkModeSchema = z.enum(sandboxNetworkModes);
export type SandboxNetworkMode = z.infer<typeof SandboxNetworkModeSchema>;

export const SandboxConfigSchema = z.strictObject({
  cpuLimit: z.number().min(0.1).max(8.0).default(1.0),
  env: z.record(z.string(), z.string()).default({}),
  id: SandboxIdSchema,
  image: z.string().min(1).max(256),
  memoryLimitMb: z.number().int().min(64).max(4096).default(512),
  networkMode: SandboxNetworkModeSchema.default("none"),
  projectId: ProjectIdSchema,
  runId: RunIdSchema.nullable(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  workdir: z.string().min(1).default("/workspace"),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const RunCommandRequestSchema = z.strictObject({
  args: z.array(z.string()).default([]),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
export type RunCommandRequest = z.infer<typeof RunCommandRequestSchema>;

export const RunCommandResultSchema = z.strictObject({
  durationMs: z.number().min(0),
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  timedOut: z.boolean(),
});
export type RunCommandResult = z.infer<typeof RunCommandResultSchema>;

export const SandboxStateSchema = z.strictObject({
  config: SandboxConfigSchema,
  createdAt: IsoDateTimeSchema,
  id: SandboxIdSchema,
  status: SandboxStatusSchema,
  stoppedAt: IsoDateTimeSchema.nullable(),
});
export type SandboxState = z.infer<typeof SandboxStateSchema>;

export interface ISandbox {
  readonly destroy: () => Promise<void>;
  readonly getState: () => Promise<SandboxState>;
  readonly id: SandboxId;
  readonly readFile: (relativePath: string) => Promise<string>;
  readonly runCommand: (
    request: RunCommandRequest
  ) => Promise<RunCommandResult>;
  readonly writeFile: (
    relativePath: string,
    content: string | Uint8Array
  ) => Promise<void>;
}

export interface ISandboxProvider {
  readonly create: (
    config: z.input<typeof SandboxConfigSchema>
  ) => Promise<ISandbox>;
  readonly destroyAll: () => Promise<void>;
  readonly get: (id: SandboxId) => Promise<ISandbox | null>;
  readonly name: string;
}

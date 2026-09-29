import { z } from "zod";
import { IsoDateTimeSchema, ProjectIdSchema, RunIdSchema } from "./identity.js";

export const SandboxIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .brand<"SandboxId">();
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

/**
 * A port inside the container. The whole unprivileged range is allowed; what
 * matters is that a provider publishes it on loopback only, never on a routable
 * interface.
 */
export const SandboxContainerPortSchema = z.number().int().min(1).max(65_535);
export type SandboxContainerPort = z.infer<typeof SandboxContainerPortSchema>;

/**
 * One container port published to the host: the container port, the host port
 * Docker assigned to it, and the interface it is bound to. `host` is a literal
 * because there is exactly one acceptable answer — a sandbox port is reachable
 * from the host's loopback interface and from nowhere else.
 */
export const SandboxPortBindingSchema = z.strictObject({
  containerPort: SandboxContainerPortSchema,
  host: z.literal("127.0.0.1"),
  hostPort: SandboxContainerPortSchema,
});
export type SandboxPortBinding = z.infer<typeof SandboxPortBindingSchema>;

export const SandboxConfigSchema = z.strictObject({
  cpuLimit: z.number().min(0.1).max(8.0).default(1.0),
  env: z.record(z.string(), z.string()).default({}),
  id: SandboxIdSchema,
  image: z.string().min(1).max(256),
  memoryLimitMb: z.number().int().min(64).max(4096).default(512),
  networkMode: SandboxNetworkModeSchema.default("none"),
  /**
   * Container ports to publish out of the sandbox. A port is published when the
   * container is created — Docker cannot add a published port to a container
   * that already exists — so the ports are declared here and read back with
   * `exposePort`.
   */
  ports: z.array(SandboxContainerPortSchema).max(8).default([]),
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

/**
 * The sandbox contract: a disposable container a caller can run commands in,
 * read and write files in, and — when its work is a server — reach over a
 * published port.
 *
 * A sandbox that serves a preview is a separate origin from the application.
 * That is what makes framing it safe to build on: the preview has its own
 * cookie store, its own storage, and no ambient authority over the product, so
 * a page it serves cannot act with the viewer's session. A provider must
 * therefore never hand a product credential to the sandbox, and the port it
 * publishes is bound to the host's loopback interface rather than to a routable
 * one.
 */
export interface ISandbox {
  /**
   * The base URL the host reaches this sandbox's published port on. Only
   * meaningful for a sandbox that declared at least one port; a sandbox with no
   * published port has no host-facing address at all.
   */
  readonly baseUrl?: () => Promise<string>;
  readonly destroy: () => Promise<void>;
  /**
   * The teardown a process-exit handler can actually finish. `exit` cannot
   * await, and a child process started there does not outlive its parent on
   * every platform, so a sandbox that has this uses it as the last resort when
   * the process is going down and there is no longer a turn of the event loop
   * to tear anything down in.
   */
  readonly destroySync?: () => void;
  /**
   * Publishes a container port and resolves to the host port that reaches it.
   * A port has to be declared when the sandbox is created ({@link SandboxConfig}
   * `ports`), so asking for one that was not declared is a programming error
   * rather than a request a provider can serve after the fact.
   */
  readonly exposePort?: (containerPort: number) => Promise<number>;
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

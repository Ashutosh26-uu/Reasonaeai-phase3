import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentController } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type { Workspace, WorkspaceFilesystem } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import type { ISandbox } from "@reasonateai/contracts/sandbox";
import type { ProjectStateStore } from "@reasonateai/project-state/postgres";
import { materializeDelegatableSubagents } from "./agents/materialize.js";
import { composeSystemPrompt } from "./context/compose.js";
import type { PlatformFacts, SandboxCapacity } from "./context/environment.js";
import { deepseekReasoningCompat } from "./model/deepseek-reasoning.js";
import { MAIN_AGENT_INSTRUCTIONS, REASONATE_CTO_NAME } from "./prompts.js";
import {
  createRunResources,
  type RunResources,
} from "./resources/handlers/index.js";
import { readRunScope, sandboxIdFor } from "./run-scope.js";
import { createCheckpointTool } from "./tools/checkpoint.js";
import { createDeploymentTool } from "./tools/deployment.js";
import { createWorkspaceEditTool } from "./tools/edit.js";
import { createEvidenceTool } from "./tools/evidence.js";
import { createPreviewTool } from "./tools/preview.js";
import { ReadSnapshotStore } from "./tools/read-snapshots.js";
import { createWorkspaceReadTool } from "./tools/workspace-read.js";
import { createWorkspaceWriteTool } from "./tools/write.js";

export type RuntimeWorkspace =
  | Workspace
  | ((input: {
      requestContext: RequestContext;
    }) => Promise<Workspace | undefined> | Workspace | undefined);

/**
 * Optional hard caps on agent loop steps.
 *
 * There are deliberately **no defaults**. A step cap that fires mid-task
 * truncates legitimate work, and a run should be stopped by a budget that steers
 * it toward finishing, by wall-clock, or by spend — not by a number chosen
 * before the task was understood. A deployment that needs a ceiling sets one.
 *
 * When a value is provided it is validated, so a typo cannot silently become an
 * accidental cap of one step.
 */
export interface CtoRuntimeLimits {
  debuggerMaxSteps?: number;
  mainMaxSteps?: number;
  scoutMaxSteps?: number;
  workerMaxSteps?: number;
}

/**
 * Session state this runtime seeds for every run it drives.
 *
 * `yolo` is the controller's session-wide approval switch: with it set, a tool
 * call resolves to allowed instead of parking on an approval gate that a
 * headless run can never answer.
 */
interface CtoControllerState {
  yolo: boolean;
}

export interface CtoSubagentModels {
  coder: string;
  debugger: string;
  scout: string;
}

export interface ReasonateCtoRuntimeConfig {
  browser?: MastraBrowser;
  /**
   * Enforced resources of the environment the agent's tools execute in. Omitted
   * means the sandbox cannot report them, and the prompt says nothing rather
   * than guessing: a plan sized to invented capacity fails later.
   */
  capacity?: SandboxCapacity | undefined;
  controllerId?: string;
  limits?: Partial<CtoRuntimeLimits>;
  memory?: Memory;
  model: string;
  /**
   * Facts about the environment the agent's tools execute in. Defaults to
   * probing the host, which is wrong for a sandboxed run: the process runs on
   * the host while every command runs inside the sandbox.
   */
  platform?: PlatformFacts | undefined;
  resolveSandbox?: (
    requestContext: RequestContext
  ) => Promise<ISandbox | undefined> | ISandbox | undefined;
  resourceId?: string;
  /**
   * Host directory under which run-scoped resource stores live: spilled read
   * output, worker output, and anything a resource URL resolves to. Defaults to
   * a process-wide temporary directory so a run never writes into the repository.
   */
  resourcesRoot?: string;
  skills?: string[];
  storage?: MastraCompositeStore;
  store?: () => ProjectStateStore;
  subagentModels?: Partial<CtoSubagentModels>;
  workspace: RuntimeWorkspace;
  workspaceRoot?: string;
}

function resolveLimits(
  overrides: Partial<CtoRuntimeLimits> | undefined
): CtoRuntimeLimits {
  const limits: CtoRuntimeLimits = { ...overrides };

  for (const [name, value] of Object.entries(limits)) {
    if (value === undefined) {
      continue;
    }
    if (!Number.isInteger(value) || value < 1 || value > 256) {
      throw new Error(
        `${name} must be an integer between 1 and 256 when provided.`
      );
    }
  }

  return limits;
}

export function createReasonateCtoRuntime(config: ReasonateCtoRuntimeConfig) {
  const limits = resolveLimits(config.limits);
  const memory = config.memory ?? new Memory();
  const snapshotsByRequest = new WeakMap<RequestContext, ReadSnapshotStore>();
  const resolveWorkspace = async (requestContext: RequestContext) => {
    const workspace =
      typeof config.workspace === "function"
        ? await config.workspace({ requestContext })
        : config.workspace;
    if (!workspace) {
      throw new Error("The verified run workspace is unavailable.");
    }
    return workspace;
  };
  const resolveFilesystem = async (
    requestContext: RequestContext
  ): Promise<WorkspaceFilesystem> => {
    const filesystem = await (
      await resolveWorkspace(requestContext)
    ).resolveFilesystem({ requestContext });
    if (!filesystem) {
      throw new Error("The verified run workspace has no filesystem provider.");
    }
    return filesystem;
  };
  const resourcesByRequest = new WeakMap<RequestContext, RunResources>();
  const resourcesRoot =
    config.resourcesRoot ?? join(tmpdir(), "reasonate-run-resources");
  /**
   * The resource layer for one run: the router a resource URL dispatches
   * through, and the stores its handlers read. Built per run and cached against
   * the request context, because a shared router would let one run answer
   * another run's read.
   */
  const resolveResources = (requestContext: RequestContext): RunResources => {
    const existing = resourcesByRequest.get(requestContext);
    if (existing !== undefined) {
      return existing;
    }
    const resources = createRunResources({
      cwd: config.workspaceRoot ?? process.cwd(),
      root: resourcesRoot,
      scope: readRunScope(requestContext),
    });
    resourcesByRequest.set(requestContext, resources);
    return resources;
  };
  const resolveSnapshots = (requestContext: RequestContext) => {
    const existing = snapshotsByRequest.get(requestContext);
    if (existing) {
      return Promise.resolve(existing);
    }
    const snapshots = new ReadSnapshotStore(undefined, async (path) => path);
    snapshotsByRequest.set(requestContext, snapshots);
    return Promise.resolve(snapshots);
  };
  const tools = {
    edit: createWorkspaceEditTool({
      resolveFilesystem,
      resolveSnapshots,
      ...(config.workspaceRoot === undefined
        ? {}
        : { root: config.workspaceRoot }),
    }),
    read: createWorkspaceReadTool({
      resolveFilesystem,
      resolveResourceContext: async (requestContext) => ({
        cwd: config.workspaceRoot ?? process.cwd(),
        scope: readRunScope(requestContext),
      }),
      resolveRouter: async (requestContext) =>
        resolveResources(requestContext).router,
      resolveSnapshots,
      ...(config.workspaceRoot === undefined
        ? {}
        : { root: config.workspaceRoot }),
    }),
    write: createWorkspaceWriteTool({
      resolveFilesystem,
      resolveSnapshots,
      ...(config.workspaceRoot === undefined
        ? {}
        : { root: config.workspaceRoot }),
    }),
    ...(config.store
      ? {
          checkpoint: createCheckpointTool({
            resolveSandbox: config.resolveSandbox,
            store: config.store,
          }),
          deployment: createDeploymentTool({
            store: config.store,
          }),
          evidence: createEvidenceTool({
            store: config.store,
          }),
          preview: createPreviewTool({
            resolveSandbox: config.resolveSandbox,
            store: config.store,
          }),
        }
      : {}),
  };

  const sessionStartedAt = new Date();
  const instructionsByRequest = new WeakMap<RequestContext, string>();
  /**
   * The prompt is assembled once per run scope from the base role, the
   * environment facts, and the project's own instruction files. It is cached
   * because every model step resolves instructions: recomposing per step would
   * re-read the instruction files and change the prompt prefix mid-run.
   */
  const resolveInstructions = ({
    requestContext,
  }: {
    requestContext: RequestContext;
  }): string => {
    const composed = instructionsByRequest.get(requestContext);
    if (composed !== undefined) {
      return composed;
    }
    const scope = readRunScope(requestContext);
    const [provider, ...modelParts] = config.model.split("/");
    const prompt = composeSystemPrompt({
      basePrompt: MAIN_AGENT_INSTRUCTIONS,
      cwd: config.workspaceRoot ?? process.cwd(),
      ...(config.capacity === undefined ? {} : { capacity: config.capacity }),
      model: modelParts.length === 0 ? config.model : modelParts.join("/"),
      ...(modelParts.length === 0 ? {} : { provider }),
      ...(config.platform === undefined ? {} : { platform: config.platform }),
      sandboxId: sandboxIdFor(scope),
      schemes: resolveResources(requestContext).router.describeSchemes(),
      scope,
      sessionStartedAt,
    }).systemPrompt;
    instructionsByRequest.set(requestContext, prompt);
    return prompt;
  };

  const mainAgent = createCodingAgent({
    defaultOptions: {
      autoResumeSuspendedTools: false,
      ...(limits.mainMaxSteps === undefined
        ? {}
        : { maxSteps: limits.mainMaxSteps }),
    },
    description:
      "ReasonateAI's autonomous CTO that owns the complete product lifecycle from intent through verified deployment.",
    id: "reasonate-cto",
    inputProcessors: [deepseekReasoningCompat()],
    instructions: resolveInstructions,
    model: config.model,
    name: REASONATE_CTO_NAME,
    ...(config.skills ? { skills: config.skills } : {}),
    tools,
    workspace: config.workspace,
  });

  const controller = new AgentController<CtoControllerState>({
    id: config.controllerId ?? "reasonate-cto-controller",
    initialState: {
      /**
       * The controller's approval gate is a shell for an interactive harness: a
       * parked tool waits for a click a headless run never receives, so the run
       * hangs instead of acting. Approval policy for this product is enforced by
       * the centralized authorization layer and the run's capability grant, which
       * is what actually bounds the tool surface — and the controller resolves a
       * tool's category policy only when a category resolver is configured, so a
       * per-category policy here would silently leave every call parked.
       */
      yolo: true,
    },
    ...(config.resourceId ? { resourceId: config.resourceId } : {}),
    agent: mainAgent,
    ...(config.browser ? { browser: config.browser } : {}),
    defaultModeId: "cto",
    memory,
    modes: [
      {
        defaultModelId: config.model,
        description:
          "Full autonomous product lifecycle authority with all approved run capabilities.",
        id: "cto",
        metadata: { default: true },
        name: REASONATE_CTO_NAME,
      },
    ],
    ...(config.storage ? { storage: config.storage } : {}),
    subagents: materializeDelegatableSubagents({
      defaultModelId: config.model,
      overrides: {
        coder: {
          ...(config.subagentModels?.coder
            ? { model: config.subagentModels.coder }
            : {}),
          ...(limits.workerMaxSteps === undefined
            ? {}
            : { maxTurns: limits.workerMaxSteps }),
        },
        debugger: {
          ...(config.subagentModels?.debugger
            ? { model: config.subagentModels.debugger }
            : {}),
          ...(limits.debuggerMaxSteps === undefined
            ? {}
            : { maxTurns: limits.debuggerMaxSteps }),
        },
        scout: {
          ...(config.subagentModels?.scout
            ? { model: config.subagentModels.scout }
            : {}),
          ...(limits.scoutMaxSteps === undefined
            ? {}
            : { maxTurns: limits.scoutMaxSteps }),
        },
      },
    }),
    workspace: config.workspace,
  });

  return {
    controller,
    limits,
    mainAgent,
  };
}

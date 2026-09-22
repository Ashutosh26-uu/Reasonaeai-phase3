import { AgentController } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type { Workspace, WorkspaceFilesystem } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { materializeDelegatableSubagents } from "./agents/materialize.js";
import { MAIN_AGENT_INSTRUCTIONS, REASONATE_CTO_NAME } from "./prompts.js";
import { createWorkspaceEditTool } from "./tools/edit.js";
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

export interface CtoSubagentModels {
  coder: string;
  debugger: string;
  scout: string;
}

export interface ReasonateCtoRuntimeConfig {
  browser?: MastraBrowser;
  controllerId?: string;
  limits?: Partial<CtoRuntimeLimits>;
  memory?: Memory;
  model: string;
  resourceId?: string;
  skills?: string[];
  storage?: MastraCompositeStore;
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
    instructions: MAIN_AGENT_INSTRUCTIONS,
    model: config.model,
    name: REASONATE_CTO_NAME,
    ...(config.skills ? { skills: config.skills } : {}),
    tools,
    workspace: config.workspace,
  });

  const controller = new AgentController({
    id: config.controllerId ?? "reasonate-cto-controller",
    ...(config.resourceId ? { resourceId: config.resourceId } : {}),
    agent: mainAgent,
    ...(config.browser ? { browser: config.browser } : {}),
    defaultModeId: "cto",
    memory,
    modes: [
      {
        description:
          "Full autonomous product lifecycle authority with all approved run capabilities.",
        id: "cto",
        metadata: { default: true },
        name: REASONATE_CTO_NAME,
      },
    ],
    ...(config.storage ? { storage: config.storage } : {}),
    subagents: materializeDelegatableSubagents({
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

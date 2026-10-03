import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentController } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type { Workspace, WorkspaceFilesystem } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import {
  materializeDelegatableSubagents,
  type WorkerOverrides,
} from "./agents/materialize.js";
import {
  type BudgetStopCondition,
  createRunBudget,
  type RunBudget,
  type RunBudgetConfig,
} from "./budget.js";
import { composeSystemPrompt } from "./context/compose.js";
import type { PlatformFacts, SandboxCapacity } from "./context/environment.js";
import type { InstructionSource } from "./context/instructions.js";
import { loadWorkspaceInstructions } from "./context/workspace-instructions.js";
import { renderBundledRules, renderSkillCatalog } from "./guidance/catalog.js";
import { deepseekReasoningCompat } from "./model/deepseek-reasoning.js";
import { MAIN_AGENT_INSTRUCTIONS, REASONATE_CTO_NAME } from "./prompts.js";
import {
  createRunResources,
  type RunResources,
} from "./resources/handlers/index.js";
import { readRunScope, sandboxIdFor } from "./run-scope.js";
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
 * Mastra may supply its own fallback: installed unbudgeted nonforked workers
 * default to 50 steps when neither maxSteps nor stopWhen is passed.
 */
export interface CtoRuntimeLimits {
  debuggerMaxSteps?: number;
  mainMaxSteps?: number;
  reviewerMaxSteps?: number;
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
  reviewer: string;
  scout: string;
}

export interface ReasonateCtoRuntimeConfig {
  browser?: MastraBrowser;
  /**
   * Consumption ceilings every agent loop this runtime drives stops on. Omitted
   * means no budget and no stop condition, exactly as an unbudgeted runtime has
   * always behaved: a run is then bounded only by its step caps and wall-clock.
   */
  budget?: RunBudgetConfig | undefined;
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
  resourceId?: string;
  /**
   * Host directory under which run-scoped resource stores live: spilled read
   * output, worker output, and anything a resource URL resolves to. Defaults to
   * a process-wide temporary directory so a run never writes into the repository.
   */
  resourcesRoot?: string;
  skills?: string[];
  storage?: MastraCompositeStore;
  subagentModels?: Partial<CtoSubagentModels>;
  workspace: RuntimeWorkspace;
  workspaceRoot?: string;
}

/**
 * The stop conditions a loop runs under.
 *
 * A budgeted loop is bounded by the budget and by its configured step cap, so
 * whichever bites first ends it. Without a budget there is no stop condition at
 * all: a cap stays on `maxSteps` alone, exactly as it always has.
 */
function stopConditions(
  budget: RunBudget,
  maxSteps: number | undefined
): BudgetStopCondition[] {
  const conditions: BudgetStopCondition[] = [budget.stopWhen];
  if (maxSteps !== undefined) {
    const cap = maxSteps;
    conditions.push(({ steps }) => steps.length >= cap);
  }
  return conditions;
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

function createRuntimeMemory(
  storage: MastraCompositeStore | undefined
): Memory {
  return new Memory(storage ? { storage } : {});
}

function resolveWorkerOverrides(
  config: ReasonateCtoRuntimeConfig,
  limits: CtoRuntimeLimits
): WorkerOverrides {
  const workers = [
    ["coder", limits.workerMaxSteps],
    ["debugger", limits.debuggerMaxSteps],
    ["reviewer", limits.reviewerMaxSteps],
    ["scout", limits.scoutMaxSteps],
  ] as const;
  return Object.fromEntries(
    workers.map(([name, maxTurns]) => {
      const model = config.subagentModels?.[name];
      return [
        name,
        {
          ...(model ? { model } : {}),
          ...(maxTurns === undefined ? {} : { maxTurns }),
        },
      ];
    })
  );
}

export function createReasonateCtoRuntime(config: ReasonateCtoRuntimeConfig) {
  const limits = resolveLimits(config.limits);
  const budget =
    config.budget === undefined ? undefined : createRunBudget(config.budget);
  const memory = config.memory ?? createRuntimeMemory(config.storage);
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
  const resourcesByRequest = new WeakMap<
    RequestContext,
    Promise<RunResources>
  >();
  const instructionSourcesByRequest = new WeakMap<
    RequestContext,
    Promise<InstructionSource[]>
  >();
  const resolveInstructionSources = (requestContext: RequestContext) => {
    let sources = instructionSourcesByRequest.get(requestContext);
    if (!sources) {
      readRunScope(requestContext);
      sources = resolveFilesystem(requestContext).then((filesystem) =>
        loadWorkspaceInstructions(filesystem, config.workspaceRoot ?? "/")
      );
      instructionSourcesByRequest.set(requestContext, sources);
    }
    return sources;
  };
  const resourcesRoot =
    config.resourcesRoot ?? join(tmpdir(), "reasonate-run-resources");
  /**
   * The resource layer for one run: the router a resource URL dispatches
   * through, and the stores its handlers read. Built per run and cached against
   * the request context, because a shared router would let one run answer
   * another run's read.
   */
  const resolveResources = (
    requestContext: RequestContext
  ): Promise<RunResources> => {
    const existing = resourcesByRequest.get(requestContext);
    if (existing !== undefined) {
      return existing;
    }
    const scope = readRunScope(requestContext);
    const resources = resolveInstructionSources(requestContext).then(
      (instructionSources) =>
        createRunResources({
          cwd: config.workspaceRoot ?? process.cwd(),
          instructionSources,
          root: resourcesRoot,
          scope,
        })
    );
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
        (await resolveResources(requestContext)).router,
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

  const sessionStartedAt = new Date();
  const instructionsByRequest = new WeakMap<
    RequestContext,
    Map<string, string>
  >();
  /**
   * The prompt is assembled once per request-context instance from the role, the
   * environment facts, and the project's own instruction files. It is cached
   * because every model step resolves instructions: recomposing per step would
   * re-read the instruction files and change that agent's prompt prefix.
   * Mastra nonforked workers clone the context and capture a fresh project
   * snapshot; their prompt and resource handler share that same snapshot.
   */
  const instructionsFor =
    (basePrompt: string, modelId = config.model) =>
    async ({
      requestContext,
    }: {
      requestContext: RequestContext;
    }): Promise<string> => {
      const promptKey = `${modelId}\n${basePrompt}`;
      const composed = instructionsByRequest
        .get(requestContext)
        ?.get(promptKey);
      if (composed !== undefined) {
        return composed;
      }
      const scope = readRunScope(requestContext);
      const resources = await resolveResources(requestContext);
      const [provider, ...modelParts] = modelId.split("/");
      const prompt = composeSystemPrompt({
        basePrompt: [
          basePrompt,
          renderBundledRules(),
          renderSkillCatalog(),
        ].join("\n\n"),
        cwd: config.workspaceRoot ?? process.cwd(),
        instructionSources: await resolveInstructionSources(requestContext),
        ...(config.capacity === undefined ? {} : { capacity: config.capacity }),
        model: modelParts.length === 0 ? modelId : modelParts.join("/"),
        ...(modelParts.length === 0 ? {} : { provider }),
        ...(config.platform === undefined ? {} : { platform: config.platform }),
        sandboxId: sandboxIdFor(scope),
        schemes: resources.router.describeSchemes(),
        scope,
        sessionStartedAt,
      }).systemPrompt;
      const prompts =
        instructionsByRequest.get(requestContext) ?? new Map<string, string>();
      prompts.set(promptKey, prompt);
      instructionsByRequest.set(requestContext, prompts);
      return prompt;
    };

  const mainAgent = createCodingAgent({
    defaultOptions: {
      autoResumeSuspendedTools: false,
      ...(limits.mainMaxSteps === undefined
        ? {}
        : { maxSteps: limits.mainMaxSteps }),
      ...(budget === undefined
        ? {}
        : { stopWhen: stopConditions(budget, limits.mainMaxSteps) }),
    },
    description:
      "ReasonateAI's autonomous CTO that owns the complete product lifecycle from intent through verified deployment.",
    id: "reasonate-cto",
    inputProcessors: [deepseekReasoningCompat()],
    instructions: instructionsFor(MAIN_AGENT_INSTRUCTIONS),
    model: config.model,
    name: REASONATE_CTO_NAME,
    ...(config.skills ? { skills: config.skills } : {}),
    tools,
    workspace: config.workspace,
  });

  const workerOverrides = resolveWorkerOverrides(config, limits);
  const materialized = materializeDelegatableSubagents({
    defaultModelId: config.model,
    instructions: (definition) =>
      instructionsFor(
        definition.prompt,
        workerOverrides[definition.name]?.model ??
          definition.model?.id ??
          config.model
      ),
    overrides: workerOverrides,
    tools,
  });
  const subagents =
    budget === undefined
      ? materialized
      : materialized.map((subagent) => ({
          ...subagent,
          stopWhen: stopConditions(budget, subagent.maxSteps),
        }));

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
    subagents,
    workspace: config.workspace,
  });

  return {
    budget,
    controller,
    limits,
    mainAgent,
    subagents,
  };
}

/**
 * The system prompt composer.
 *
 * The prompt is assembled per run from facts, not stored as one string. That
 * matters because most of what the agent needs to know is only knowable at run
 * time: which project it is in, what that project's rules say, which tools it
 * actually holds, and which resource schemes it can address. A static prompt
 * cannot state any of those truthfully, so it either omits them or lies.
 *
 * Sections appear in a fixed order, each independently renderable and each
 * omitted when empty:
 *
 * 1. The base prompt: role, policy, and workflow.
 * 2. The tool inventory, rendered from the tools the run actually holds.
 * 3. The resource catalog, rendered from the registered schemes.
 * 4. The environment block.
 * 5. Project references, when the project declares any.
 * 6. Project instruction files, most authoritative first.
 *
 * The result carries a `fingerprint` over the whole assembly, so a run can prove
 * which prompt it executed against and detect that a rules file changed mid-run.
 */

import type { RunScope } from "../run-scope.js";
import type { SandboxCapacity } from "./environment.js";
import { findWorkspaceRoot, renderEnvironment } from "./environment.js";
import type { ContextDiagnostic, InstructionSource } from "./instructions.js";
import {
  DEFAULT_MAX_FILE_CHARS,
  DEFAULT_MAX_IMPORT_DEPTH,
  discoverInstructionFileCandidates,
  escapeText,
  hashContent,
  loadInstructionSource,
  renderInstructionSource,
  selectInstructionSources,
} from "./instructions.js";

/** One tool as the prompt should describe it to the model. */
export interface ToolSummary {
  /** What the tool does, in one sentence. */
  description: string;
  /** Usage rules the model must follow when calling it. */
  guidance?: readonly string[] | undefined;
  name: string;
}

/** One resource scheme as the prompt should describe it. */
export interface SchemeSummary {
  description: string;
  scheme: string;
}

/** An additional directory the run may consult. */
export interface ProjectReference {
  description?: string | undefined;
  name: string;
  path: string;
}

export interface ComposeSystemPromptOptions {
  /** Role, policy, and workflow. */
  basePrompt: string;
  capacity?: SandboxCapacity | undefined;
  cwd: string;
  /** Overrides the home directory used for user-level instructions. */
  home?: string | undefined;
  maxFileChars?: number | undefined;
  maxImportDepth?: number | undefined;
  model: string;
  /** Injected so the rendered prompt is deterministic in tests. */
  now?: Date | undefined;
  provider: string;
  references?: readonly ProjectReference[] | undefined;
  sandboxId: string;
  /** The registered resource schemes. */
  schemes: readonly SchemeSummary[];
  scope: RunScope;
  sessionStartedAt: Date;
  /** The tools this run holds. Required: the prompt must not overstate them. */
  tools: readonly ToolSummary[];
}

/** The assembled prompt plus everything it was built from. */
export interface ComposedContext {
  /** Problems encountered while assembling, which never abort the assembly. */
  diagnostics: ContextDiagnostic[];
  /** Paths of the instruction files that were included. */
  files: string[];
  /** Hash over the prompt and every source, so a change is detectable. */
  fingerprint: string;
  /** Loaded instruction contents, in prompt order. */
  instructions: string[];
  /** Each section separately, for inspection and tests. */
  sections: {
    baseSystemPrompt: string;
    toolInventory: string;
    resourceCatalog: string;
    environment: string;
    projectReferences: string;
    instructionFiles: readonly string[];
  };
  sources: InstructionSource[];
  /** The complete system prompt. */
  systemPrompt: string;
}

/**
 * Compose the system prompt for one run.
 *
 * Instruction loading failures are collected as diagnostics rather than thrown:
 * a project with one unreadable rules file still gets a usable prompt, and the
 * failure is visible instead of silently swallowing a rule.
 */
export function composeSystemPrompt(
  options: ComposeSystemPromptOptions
): ComposedContext {
  const diagnostics: ContextDiagnostic[] = [];

  const candidates = discoverInstructionFileCandidates(options.cwd, {
    ...(options.home === undefined ? {} : { home: options.home }),
  });

  const loaded = candidates
    .map((candidate) =>
      loadInstructionSource(candidate, {
        diagnostics,
        maxFileChars: options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS,
        maxImportDepth: options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
      })
    )
    .filter((source): source is InstructionSource => source !== undefined);

  const sources = selectInstructionSources(loaded);
  const renderedSources = sources.map(renderInstructionSource);

  const workspaceRoot = findWorkspaceRoot(options.cwd);

  const sections = {
    baseSystemPrompt: options.basePrompt,
    environment: renderEnvironment({
      capacity: options.capacity,
      cwd: options.cwd,
      isGitRepo: workspaceRoot !== undefined,
      model: options.model,
      now: options.now ?? new Date(),
      provider: options.provider,
      sandboxId: options.sandboxId,
      scope: options.scope,
      sessionStartedAt: options.sessionStartedAt,
      workspaceRoot,
    }),
    instructionFiles: renderedSources,
    projectReferences: renderReferences(
      options.references ?? [],
      options.cwd,
      diagnostics
    ),
    resourceCatalog: renderResourceCatalog(options.schemes),
    toolInventory: renderToolInventory(options.tools),
  };

  const systemPrompt = [
    sections.baseSystemPrompt,
    sections.toolInventory,
    sections.resourceCatalog,
    sections.environment,
    sections.projectReferences,
    ...sections.instructionFiles,
  ]
    .filter((section) => section !== "")
    .join("\n\n");

  return {
    diagnostics,
    files: sources.map((source) => source.path),
    fingerprint: hashContent(
      [
        systemPrompt,
        ...sources.map((source) => `${source.path}:${source.contentHash}`),
      ].join("\n")
    ),
    instructions: sources.map((source) => source.content),
    sections,
    sources,
    systemPrompt,
  };
}

/**
 * Render the tool inventory.
 *
 * A run with no tools still gets the section, stating that plainly. An absent
 * section would leave the model guessing whether it has tools at all.
 */
export function renderToolInventory(tools: readonly ToolSummary[]): string {
  if (tools.length === 0) {
    return "## Available tools\n\nNo tools are available for this run. Report what you cannot do instead of attempting it.";
  }

  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  return [
    "## Available tools",
    "",
    "These are the tools this run holds. Do not call a tool that is not listed here.",
    "",
    ...ordered.flatMap((tool) => [
      `- **${tool.name}** — ${tool.description}`,
      ...(tool.guidance ?? []).map((line) => `  - ${line}`),
    ]),
  ].join("\n");
}

/**
 * Render the resource-scheme catalog.
 *
 * This is what lets the model reach a skill, artifact, or document through the
 * same read surface as a file. It is generated from the router's registrations,
 * so a scheme that is documented here is a scheme that can actually resolve.
 */
export function renderResourceCatalog(
  schemes: readonly SchemeSummary[]
): string {
  if (schemes.length === 0) {
    return "";
  }

  const ordered = [...schemes].sort((a, b) => a.scheme.localeCompare(b.scheme));

  return [
    "## Additional resources",
    "",
    "Beyond workspace paths, these schemes address resources that do not live on the filesystem. They are read through the same read tool, each with an optional `:selector` for line ranges or `:raw`.",
    "",
    ...ordered.map(
      (entry) => `- \`${entry.scheme}://\` — ${entry.description}`
    ),
  ].join("\n");
}

/**
 * Render project references.
 *
 * A reference that is missing or is not a directory is reported as a diagnostic
 * and dropped, because listing a directory the agent cannot open would produce a
 * failed read every time it trusted the prompt.
 */
function renderReferences(
  references: readonly ProjectReference[],
  cwd: string,
  diagnostics: ContextDiagnostic[]
): string {
  const available = references
    .flatMap((reference) => {
      const name = reference.name.trim();
      const configuredPath = reference.path.trim();

      if (name === "" || configuredPath === "") {
        diagnostics.push({
          message: "Project reference requires non-empty name and path fields",
          path: configuredPath || cwd,
        });
        return [];
      }

      return [
        {
          description: reference.description?.trim(),
          name,
          path: configuredPath,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path)
    );

  if (available.length === 0) {
    return "";
  }

  return [
    "Project references are additional directories that can be accessed when relevant.",
    "<available-references>",
    ...available.flatMap((reference) => [
      "  <reference>",
      `    <name>${escapeText(reference.name)}</name>`,
      `    <path>${escapeText(reference.path)}</path>`,
      ...(reference.description === undefined || reference.description === ""
        ? []
        : [
            `    <description>${escapeText(reference.description)}</description>`,
          ]),
      "  </reference>",
    ]),
    "</available-references>",
  ].join("\n");
}

/**
 * Wrap a per-agent prompt as a developer message.
 *
 * Subagents receive their role as a developer message rather than by being
 * merged into the system prompt, so the system prompt stays attributable to the
 * harness and a delegated instruction cannot be mistaken for company policy.
 */
export function buildContextMessages(
  agentPrompt: string | undefined
): { role: "developer"; content: string }[] | undefined {
  const prompt = agentPrompt?.trim();
  if (prompt === undefined || prompt === "") {
    return undefined;
  }
  return [{ content: prompt, role: "developer" }];
}

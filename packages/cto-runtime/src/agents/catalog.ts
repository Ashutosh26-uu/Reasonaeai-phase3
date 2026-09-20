import { loadDiscoveredAgents } from "./loader.js";
import { unknownToolNames } from "./tool-filter.js";
import type {
  AgentCatalog,
  AgentDefinition,
  AgentDiagnostic,
} from "./types.js";

let cached: AgentCatalog | undefined;
let cachedCwd: string | undefined;

function listPrimary(definitions: Record<string, AgentDefinition>): string[] {
  return Object.values(definitions)
    .filter(
      (entry) =>
        (entry.mode === "primary" || entry.mode === "all") && !entry.hidden
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listSubagents(definitions: Record<string, AgentDefinition>): string[] {
  return Object.values(definitions)
    .filter(
      (entry) =>
        (entry.mode === "subagent" || entry.mode === "all") && !entry.hidden
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function buildCatalogFromDefinitions(
  definitions: Record<string, AgentDefinition>,
  diagnostics: AgentDiagnostic[] = []
): AgentCatalog {
  return {
    definitions,
    diagnostics,
    primary: listPrimary(definitions),
    subagents: listSubagents(definitions),
  };
}

/** Builtins only. A synchronous fallback before discovery completes. */
export function getBuiltinCatalog(
  builtins: Record<string, AgentDefinition>
): AgentCatalog {
  return buildCatalogFromDefinitions({ ...builtins });
}

/**
 * Validates every definition against the tools the deployment actually
 * provides. Neither reference harness does this, so a typo in `tools:` silently
 * yields an agent that can do nothing. Reporting it turns a silent
 * misconfiguration into a fixable one.
 */
export function diagnoseUnknownTools(
  definitions: Record<string, AgentDefinition>,
  toolUniverse: readonly string[],
  sourcePathFor: (name: string) => string
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];

  for (const definition of Object.values(definitions)) {
    for (const tool of unknownToolNames(definition, toolUniverse)) {
      diagnostics.push({
        kind: "validation",
        message: `Agent "${definition.name}" references unknown tool "${tool}".`,
        sourcePath: definition.source ?? sourcePathFor(definition.name),
      });
    }
  }

  return diagnostics;
}

/**
 * Full catalog: builtins merged with discovered markdown agents.
 *
 * One merge rule applies here and in the loader: a discovered definition
 * replaces a builtin of the same name outright. There is no field-level patching,
 * because two merge semantics in one system is how a definition ends up meaning
 * something the author did not write.
 */
export async function loadAgentCatalog(input: {
  builtins: Record<string, AgentDefinition>;
  cwd?: string;
  toolUniverse: readonly string[];
}): Promise<AgentCatalog> {
  const cwd = input.cwd ?? process.cwd();

  if (cached && cachedCwd === cwd) {
    return cached;
  }

  const definitions: Record<string, AgentDefinition> = { ...input.builtins };
  const discovered = await loadDiscoveredAgents(cwd);

  for (const { definition } of discovered.agents) {
    definitions[definition.name] = definition;
  }

  const diagnostics = [
    ...discovered.diagnostics,
    ...diagnoseUnknownTools(definitions, input.toolUniverse, (name) => name),
  ];

  cached = buildCatalogFromDefinitions(definitions, diagnostics);
  cachedCwd = cwd;
  return cached;
}

export function getCachedCatalog(
  builtins: Record<string, AgentDefinition>
): AgentCatalog {
  return cached ?? getBuiltinCatalog(builtins);
}

export function invalidateAgentCatalog(): void {
  cached = undefined;
  cachedCwd = undefined;
}

export function getAgentDefinition(
  name: string,
  catalog: AgentCatalog
): AgentDefinition | undefined {
  return catalog.definitions[name];
}

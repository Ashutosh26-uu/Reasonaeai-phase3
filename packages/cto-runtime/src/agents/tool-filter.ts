import type { AgentDefinition } from "./types.js";

/**
 * Tool-name normalization.
 *
 * An author writes `bash`, `Bash`, or `shell`; all three name the same tool. The
 * alias table keeps the contract forgiving at the surface while the runtime only
 * ever compares one canonical spelling.
 */
const TOOL_ALIASES: Record<string, string> = {
  Bash: "execute_command",
  bash: "execute_command",
  Edit: "edit_file",
  edit: "edit_file",
  execute: "execute_command",
  execute_command: "execute_command",
  find: "list_files",
  glob: "list_files",
  grep: "grep",
  list_files: "list_files",
  Read: "read_file",
  read: "read_file",
  read_file: "read_file",
  replace: "edit_file",
  search: "search",
  shell: "execute_command",
  stat: "file_stat",
  Write: "write_file",
  write: "write_file",
  write_file: "write_file",
};

export function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return trimmed;
  }
  return (
    TOOL_ALIASES[trimmed] ?? TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed
  );
}

/**
 * Tool resolution, in one place:
 *
 *   pool = tools ? allowlist : allTools
 *   pool = pool − disallowedTools
 *
 * Resolution is by canonical name, so an allowlist written `Read` still matches
 * a tool registered as `read_file`.
 *
 * An **empty** allowlist means no tools, not every tool. Spectra treats an empty
 * list as "no restriction", which is the opposite of what an author writing
 * `tools: []` intends and is unsafe for a security-relevant field. "Inherit
 * everything" is expressed by omitting the field, so the empty list is free to
 * mean what it says.
 */
export function filterToolsByDefinition(
  allTools: readonly string[],
  definition: AgentDefinition | undefined
): string[] {
  if (!definition) {
    return [...allTools];
  }

  const allow = definition.tools?.map(normalizeToolName);
  const deny = new Set(
    (definition.disallowedTools ?? []).map(normalizeToolName)
  );

  return allTools.filter((tool) => {
    const canonical = normalizeToolName(tool);
    if (allow !== undefined && !allow.includes(canonical)) {
      return false;
    }
    return !deny.has(canonical);
  });
}

/**
 * Tool names in a definition that the deployment does not actually provide.
 *
 * Neither reference harness checks this, so a typo silently yields an agent that
 * can do nothing, or a denylist entry that protects nothing. Reporting it turns a
 * silent misconfiguration into a fixable one.
 */
export function unknownToolNames(
  definition: AgentDefinition,
  allTools: readonly string[]
): string[] {
  const known = new Set(allTools.map(normalizeToolName));
  const declared = [
    ...(definition.tools ?? []),
    ...(definition.disallowedTools ?? []),
  ];
  return declared.filter((tool) => !known.has(normalizeToolName(tool)));
}

/** Whether the resolved tool set contains any tool named as write-capable. */
export function holdsWriteCapableTool(
  resolvedTools: readonly string[],
  writeCapableTools: readonly string[]
): boolean {
  const writeCapable = new Set(writeCapableTools.map(normalizeToolName));
  return resolvedTools.some((tool) =>
    writeCapable.has(normalizeToolName(tool))
  );
}

import type { ToolEntry } from "./timeline";

const WORKSPACE_TOOL_PREFIX = /^mastra_workspace_/;
const WEB_TARGET = /^https?:\/\//;

export const normalizeToolName = (name: string): string =>
  name.toLowerCase().replace(WORKSPACE_TOOL_PREFIX, "").replaceAll("-", "_");
interface ActionLabels {
  done: string;
  ongoing: string;
  plural: string;
  singular: string;
  verb: string;
}
const actions = {
  browse: {
    done: "opened",
    ongoing: "opening",
    plural: "pages",
    singular: "a page",
    verb: "open",
  },
  command: {
    done: "ran",
    ongoing: "running",
    plural: "commands",
    singular: "a command",
    verb: "run",
  },
  delegate: {
    done: "delegated",
    ongoing: "delegating",
    plural: "tasks",
    singular: "a task",
    verb: "delegate",
  },
  delete: {
    done: "deleted",
    ongoing: "deleting",
    plural: "items",
    singular: "an item",
    verb: "delete",
  },
  edit: {
    done: "edited",
    ongoing: "editing",
    plural: "files",
    singular: "a file",
    verb: "edit",
  },
  list: {
    done: "listed",
    ongoing: "listing",
    plural: "files",
    singular: "files",
    verb: "list",
  },
  other: {
    done: "used",
    ongoing: "using",
    plural: "tools",
    singular: "a tool",
    verb: "use",
  },
  plan: {
    done: "updated",
    ongoing: "updating",
    plural: "plans",
    singular: "a plan",
    verb: "update",
  },
  question: {
    done: "asked",
    ongoing: "asking",
    plural: "questions",
    singular: "a question",
    verb: "ask",
  },
  read: {
    done: "read",
    ongoing: "reading",
    plural: "files",
    singular: "a file",
    verb: "read",
  },
  search: {
    done: "searched",
    ongoing: "searching",
    plural: "files",
    singular: "files",
    verb: "search",
  },
  web: {
    done: "searched",
    ongoing: "searching",
    plural: "the web",
    singular: "the web",
    verb: "search",
  },
  write: {
    done: "wrote",
    ongoing: "writing",
    plural: "files",
    singular: "a file",
    verb: "write",
  },
} satisfies Record<string, ActionLabels>;
type ActivityKind = keyof typeof actions;
const rules: [RegExp, ActivityKind][] = [
  [/web.*search|search.*web/, "web"],
  [/^(run_command|execute|command|bash|shell|sandbox)/, "command"],
  [/^(edit|patch|ast_edit)/, "edit"],
  [/^(write|create_file|save)/, "write"],
  [/^(read|open_file|view_file)/, "read"],
  [/^(delete|remove)/, "delete"],
  [/^(list|glob)/, "list"],
  [/^(search|find|grep|query)/, "search"],
  [/^(browser|web|fetch|http|navigate)/, "browse"],
  [/^(todo|plan)/, "plan"],
  [/^ask_user/, "question"],
  [/^(agent|delegate|spawn|subagent)/, "delegate"],
];
function category(tool: ToolEntry): ActivityKind {
  const name = normalizeToolName(tool.name);
  if (
    name === "read" &&
    typeof tool.input === "object" &&
    tool.input !== null &&
    "target" in tool.input &&
    typeof tool.input.target === "string" &&
    WEB_TARGET.test(tool.input.target)
  ) {
    return "browse";
  }
  return rules.find(([rule]) => rule.test(name))?.[1] ?? "other";
}
function activityLabel(
  kind: ActivityKind,
  state: ToolEntry["state"],
  count: number
): string {
  const action = actions[kind];
  const object = count === 1 ? action.singular : action.plural;
  switch (state) {
    case "output-error":
      return `tried to ${action.verb} ${object}`;
    case "output-denied":
      return `permission declined to ${action.verb} ${object}`;
    case "approval-requested":
      return `awaiting approval to ${action.verb} ${object}`;
    case "input-available":
      return `${action.ongoing} ${object}`;
    default:
      return `${action.done} ${object}`;
  }
}
export function toolGroupSummary(tools: ToolEntry[]): {
  label: string;
  count: number;
  iconTool: string;
} {
  const groups = new Map<
    string,
    { kind: ActivityKind; state: ToolEntry["state"]; count: number }
  >();
  const unique = new Map(tools.map((tool) => [tool.id, tool]));
  for (const tool of unique.values()) {
    const kind = category(tool);
    const key = `${kind}:${tool.state}`;
    const previous = groups.get(key);
    groups.set(key, {
      count: (previous?.count ?? 0) + 1,
      kind,
      state: tool.state,
    });
  }
  const phrases = [...groups.values()].map(({ kind, state, count }) =>
    activityLabel(kind, state, count)
  );
  const label = phrases.join(", ") || "No tool activity";
  const representative =
    [...unique.values()].find((tool) => category(tool) === "edit") ?? tools[0];
  return {
    count: unique.size,
    iconTool: representative?.name ?? "tool",
    label: label.charAt(0).toUpperCase() + label.slice(1),
  };
}

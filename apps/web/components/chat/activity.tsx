"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@reasonateai/ui/components/collapsible";
import {
  Check,
  ChevronDown,
  Circle,
  Clock3,
  FileText,
  FolderPlus,
  Globe2,
  ListChecks,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ToolEntry } from "./timeline";
import { normalizeToolName as normalizedName } from "./tool-group-summary";

type RecordValue = Record<string, unknown>;

const WORKSPACE_PREFIX = /^mastra_workspace_/;
const WORD_START = /^\w/;
const CAPITAL_BOUNDARY = /([a-z])([A-Z])/g;
const TOOL_SEPARATOR = /[_-]+/g;
const SENSITIVE_FIELD =
  /secret|token|password|credential|authorization|cookie|api.?key/i;
const DELEGATION_NAME = /^(agent|delegate|spawn|subagent)$/;
const COMMAND_NAME = /^(run_command|command|bash|shell)$/;
const SEARCH_NAME = /^(search|grep|glob|list)$/;
const TOOL_ICON_RULES = [
  [/^(read|open|view)/, FileText],
  [/^(write|edit|patch|create|save)/, Pencil],
  [/^(search|find|grep|query)/, Search],
  [/^(list|glob|todo)/, ListChecks],
  [/^(run|command|bash|shell|execute)/, Terminal],
  [/^(browser|web|fetch|http)/, Globe2],
  [/^(agent|delegate|spawn)/, FolderPlus],
] as const;

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function toolName(name: string): string {
  return name
    .replace(WORKSPACE_PREFIX, "")
    .replaceAll(TOOL_SEPARATOR, " ")
    .replace(WORD_START, (letter) => letter.toUpperCase());
}

export function actionIcon(name: string) {
  const normalized = normalizedName(name);
  for (const [pattern, Icon] of TOOL_ICON_RULES) {
    if (pattern.test(normalized)) {
      return Icon;
    }
  }
  return Wrench;
}

function labelForKey(key: string): string {
  const labels: Record<string, string> = {
    command: "Command",
    content: "New content",
    expectedHash: "Version check",
    filePath: "File",
    glob: "Pattern",
    newString: "Replacement",
    oldString: "Text to replace",
    path: "File",
    pattern: "Pattern",
    prompt: "Assignment",
    query: "Search",
    target: "Target",
    task: "Assignment",
    url: "Address",
  };
  return (
    labels[key] ??
    key
      .replaceAll(CAPITAL_BOUNDARY, "$1 $2")
      .replace(WORD_START, (s) => s.toUpperCase())
  );
}

function compact(value: unknown, limit = 260): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = `${value.length} items`;
  }
  const clean = text.replaceAll(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function isSensitive(key: string): boolean {
  return SENSITIVE_FIELD.test(key);
}

function inputRows(input: unknown): [string, string][] {
  const values = record(input);
  if (!values) {
    const value = compact(input);
    return value ? [["Details", value]] : [];
  }
  const preferred = [
    "target",
    "path",
    "filePath",
    "command",
    "query",
    "pattern",
    "url",
    "prompt",
    "task",
    "oldString",
    "newString",
    "content",
  ];
  const keys = [
    ...preferred.filter((key) => key in values),
    ...Object.keys(values).filter((key) => !preferred.includes(key)),
  ];
  return keys.flatMap((key) => {
    const value = isSensitive(key)
      ? "Hidden for security"
      : compact(values[key]);
    return value ? [[labelForKey(key), value] as [string, string]] : [];
  });
}

function Status({ tool }: { tool: ToolEntry }) {
  const stateView = {
    "approval-requested": { Icon: Clock3, label: "Needs approval" },
    "input-available": { Icon: Circle, label: "Working" },
    "output-available": { Icon: Check, label: "Done" },
    "output-denied": { Icon: X, label: "Declined" },
    "output-error": { Icon: X, label: "Failed" },
  }[tool.state];
  const { Icon, label } = stateView;
  const visibleLabel =
    tool.state === "approval-requested" && tool.name === "ask_user"
      ? "Needs your answer"
      : label;
  return (
    <span className="activity-status" data-status={tool.state}>
      <Icon aria-hidden="true" size={14} />
      {visibleLabel}
    </span>
  );
}

function Duration({ tool }: { tool: ToolEntry }) {
  if (!tool.endedAt) {
    return null;
  }
  const duration = Math.max(
    0,
    (Date.parse(tool.endedAt) - Date.parse(tool.startedAt)) / 1000
  );
  return <span className="activity-duration">{duration.toFixed(1)}s</span>;
}

function TodoOutput({ values }: { values: RecordValue }) {
  const details = record(values.details);
  const { phases: directPhases } = values;
  const { phases: nestedPhases } = details ?? {};
  let phases: unknown[] = [];
  if (Array.isArray(directPhases)) {
    phases = directPhases;
  } else if (Array.isArray(nestedPhases)) {
    phases = nestedPhases;
  }
  return phases.length > 0 ? <TodoBoard phases={phases} /> : null;
}

function CommandOutput({ values }: { values: RecordValue }) {
  const { exitCode, stdout, stderr } = values;
  return (
    <div className="activity-output-stack">
      {typeof exitCode === "number" && (
        <span className="activity-output-note">
          {exitCode === 0
            ? "Command finished successfully"
            : `Command exited with code ${exitCode}`}
        </span>
      )}
      {typeof stdout === "string" && stdout.trim() && (
        <OutputBlock label="Output" value={stdout} />
      )}
      {typeof stderr === "string" && stderr.trim() && (
        <OutputBlock label="Messages" value={stderr} />
      )}
    </div>
  );
}

function ObjectOutput({ values }: { values: RecordValue }) {
  const rows = Object.entries(values).flatMap(([key, fieldValue]) => {
    if (["patch", "diff", "stdout", "stderr"].includes(key)) {
      return [];
    }
    const rendered = isSensitive(key)
      ? "Hidden for security"
      : compact(fieldValue);
    return rendered ? [[labelForKey(key), rendered] as [string, string]] : [];
  });
  const patch = values.patch ?? values.diff;
  return (
    <div className="activity-output-stack">
      {rows.length > 0 && <DetailRows rows={rows} />}
      {typeof patch === "string" && patch.trim() && (
        <OutputBlock label="Changes" value={patch} />
      )}
    </div>
  );
}

function OutputValue({ name, output }: { name: string; output: unknown }) {
  if (output === undefined || output === null || output === "") {
    return null;
  }
  const values = record(output);
  const normalized = normalizedName(name);
  if (normalized === "todo" && values) {
    return <TodoOutput values={values} />;
  }
  if (
    values &&
    ("stdout" in values || "stderr" in values || "exitCode" in values)
  ) {
    return <CommandOutput values={values} />;
  }
  if (typeof output === "string") {
    const label = normalized === "read" ? "File contents" : "Result";
    return <OutputBlock label={label} value={output} />;
  }
  if (values) {
    return <ObjectOutput values={values} />;
  }
  const resultValue = compact(output);
  return resultValue ? (
    <OutputBlock label="Result" value={resultValue} />
  ) : null;
}

function OutputBlock({ label, value }: { label: string; value: string }) {
  return (
    <section className="activity-output-block">
      <h4>{label}</h4>
      <pre>{value}</pre>
    </section>
  );
}

function DetailRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="activity-detail-list">
      {rows.map(([label, value], index) => (
        <div className="activity-detail" key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
}
interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

function normalizeTodoPhases(raw: unknown[]): TodoPhase[] {
  return raw.flatMap((phaseValue, index) => {
    const phase = record(phaseValue);
    if (!phase) {
      return [];
    }
    let rawTasks: unknown[] = [];
    if (Array.isArray(phase.tasks)) {
      rawTasks = phase.tasks;
    } else if (Array.isArray(phase.items)) {
      rawTasks = phase.items;
    }
    const tasks = rawTasks.flatMap((taskValue): TodoTask[] => {
      if (typeof taskValue === "string") {
        return [{ content: taskValue, status: "pending" }];
      }
      const task = record(taskValue);
      if (!task) {
        return [];
      }
      const { content: taskContent, text: taskText, status } = task;
      let content = "";
      if (typeof taskContent === "string") {
        content = taskContent;
      } else if (typeof taskText === "string") {
        content = taskText;
      }
      if (!content) {
        return [];
      }
      return [
        {
          content,
          status:
            status === "completed" ||
            status === "in_progress" ||
            status === "abandoned"
              ? status
              : "pending",
        },
      ];
    });
    return [
      {
        name:
          typeof phase.name === "string" ? phase.name : `Phase ${index + 1}`,
        tasks,
      },
    ];
  });
}

function TodoBoard({ phases: raw }: { phases: unknown[] }) {
  const phases = normalizeTodoPhases(raw);
  const tasks = phases.flatMap((phase) => phase.tasks);
  const complete = tasks.filter((task) => task.status === "completed").length;
  return (
    <div className="activity-todo">
      <div className="activity-todo-heading">
        <span>Plan</span>
        <span>
          {complete} of {tasks.length} complete
        </span>
      </div>
      {phases.map((phase, phaseIndex) => (
        <section
          className="activity-todo-phase"
          key={`${phase.name}-${phaseIndex}`}
        >
          <h4>{phase.name}</h4>
          {phase.tasks.map((task, taskIndex) => (
            <TodoRow key={`${task.content}-${taskIndex}`} task={task} />
          ))}
        </section>
      ))}
    </div>
  );
}

function TodoRow({ task }: { task: TodoTask }) {
  let Icon = Circle;
  if (task.status === "completed") {
    Icon = Check;
  }
  if (task.status === "abandoned") {
    Icon = X;
  }
  return (
    <div className="activity-todo-task" data-status={task.status}>
      <Icon aria-hidden="true" size={15} />
      <span>{task.content}</span>
      {task.status === "in_progress" && (
        <span className="activity-todo-active">In progress</span>
      )}
    </div>
  );
}

function isDelegation(tool: ToolEntry): boolean {
  return (
    tool.children.length > 0 || DELEGATION_NAME.test(normalizedName(tool.name))
  );
}

function detailTitle(tool: ToolEntry): string {
  const normalized = normalizedName(tool.name);
  if (DELEGATION_NAME.test(normalized)) {
    return "Assignment";
  }
  if (COMMAND_NAME.test(normalized)) {
    return "Command";
  }
  if (normalized === "read") {
    return "Reading";
  }
  if (normalized === "write") {
    return "Writing";
  }
  if (normalized === "edit") {
    return "Editing";
  }
  if (SEARCH_NAME.test(normalized)) {
    return "Looking for";
  }
  if (normalized === "todo") {
    return "Plan update";
  }
  return toolName(tool.name);
}

function delegationTitle(name: string): string {
  const title = toolName(name);
  return title === "Agent" ? "Subagent" : title;
}

export function ActivityOutline({ tool }: { tool: ToolEntry }) {
  const delegated = isDelegation(tool);
  const Icon = delegated ? FolderPlus : actionIcon(tool.name);
  const rows = inputRows(tool.input);
  const detail = rows[0]?.[1] ?? "";
  const { children } = tool;
  const active = tool.state === "input-available";
  const title = delegated ? detail || "Subagent" : detailTitle(tool);
  const role = delegated ? delegationTitle(tool.name) : "";

  return (
    <Collapsible
      className="activity-item"
      data-delegation={delegated || undefined}
      data-status={tool.state}
      defaultOpen={tool.state === "approval-requested" || (delegated && active)}
    >
      <CollapsibleTrigger className="activity-trigger">
        <span
          className="activity-icon"
          data-delegation={delegated || undefined}
        >
          <Icon aria-hidden="true" size={16} />
        </span>
        <span className="activity-main">
          <span className="activity-title-row">
            <span className="activity-title">{title}</span>
            {!delegated && detail && (
              <span className="activity-summary">{detail}</span>
            )}
            {delegated && <span className="activity-agent-type">{role}</span>}
          </span>
        </span>
        {delegated && children.length > 0 && (
          <span className="activity-count">
            {children.length} {children.length === 1 ? "step" : "steps"}
          </span>
        )}
        <Status tool={tool} />
        <Duration tool={tool} />
        <ChevronDown
          aria-hidden="true"
          className="activity-chevron"
          size={16}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-content">
        {!delegated && rows.length > 0 && <DetailRows rows={rows} />}
        {tool.error && <div className="activity-error">{tool.error}</div>}
        <OutputValue name={tool.name} output={tool.output} />
        {tool.text && <p className="activity-worker-text">{tool.text}</p>}
        {children.length > 0 && (
          <div
            className="activity-children"
            data-active={children.some(
              (child) => child.state === "input-available"
            )}
            data-count={children.length}
          >
            <div className="activity-children-list">
              {children.map((child) => (
                <ActivityOutline key={child.id} tool={child} />
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

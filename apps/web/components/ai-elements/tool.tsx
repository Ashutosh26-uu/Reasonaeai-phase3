"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@reasonateai/ui/components/collapsible";
import { cn } from "@reasonateai/ui/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListIcon,
  type LucideIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

function ToolCode({ code }: { code: string | undefined }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3">
      <code>{code}</code>
    </pre>
  );
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

function hasPrefix(name: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => name === prefix || name.startsWith(`${prefix}-`)
  );
}

function getToolIcon(toolName: string): LucideIcon {
  const name = toolName
    .toLowerCase()
    .replace("mastra_workspace_", "")
    .replaceAll("_", "-");
  if (hasPrefix(name, ["read", "open", "view", "cat"])) {
    return FileTextIcon;
  }
  if (hasPrefix(name, ["write", "edit", "patch", "create", "save"])) {
    return PencilIcon;
  }
  if (hasPrefix(name, ["search", "find", "grep", "query"])) {
    return SearchIcon;
  }
  if (hasPrefix(name, ["list", "ls", "glob"])) {
    return ListIcon;
  }
  if (hasPrefix(name, ["execute", "run", "command", "bash", "shell"])) {
    return TerminalIcon;
  }
  if (hasPrefix(name, ["browser", "web", "fetch", "http"])) {
    return GlobeIcon;
  }
  if (hasPrefix(name, ["delete", "remove", "unlink"])) {
    return Trash2Icon;
  }
  if (hasPrefix(name, ["directory", "folder", "project"])) {
    return FolderOpenIcon;
  }
  return WrenchIcon;
}

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const Icon = getToolIcon(derivedName);

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 px-0 py-1 text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-3 pt-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <ToolCode code={JSON.stringify(input, null, 2)} />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (output === undefined && !errorText) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = <ToolCode code={JSON.stringify(output, null, 2)} />;
  } else if (
    typeof output === "string" ||
    typeof output === "boolean" ||
    typeof output === "number"
  ) {
    Output = <ToolCode code={String(output)} />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && errorText !== output && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};

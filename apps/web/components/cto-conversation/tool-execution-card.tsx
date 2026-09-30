"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { cn } from "@reasonateai/ui/lib/utils";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileSearch,
  FolderOpen,
  Loader2,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { ToolExecutionItem } from "../../lib/conversation-state";

export interface ToolExecutionCardProps {
  className?: string | undefined;
  defaultExpanded?: boolean | undefined;
  tool: ToolExecutionItem;
}

export function ToolExecutionCard({
  tool,
  className,
  defaultExpanded = false,
}: ToolExecutionCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { toolName, args, status, result, exitCode } = tool;

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const getToolIcon = () => {
    switch (toolName.toLowerCase()) {
      case "run_command":
      case "execute_command":
      case "shell":
        return Terminal;
      case "write_file":
      case "edit_file":
      case "multi_replace_file_content":
      case "replace_file_content":
        return FileCode2;
      case "read_file":
      case "view_file":
      case "grep_search":
        return FileSearch;
      case "list_directory":
      case "list_dir":
        return FolderOpen;
      default:
        return Wrench;
    }
  };

  const Icon = getToolIcon();

  const formattedArgs = (() => {
    if (Object.keys(args).length === 0) {
      return "";
    }
    if (args.CommandLine) {
      return String(args.CommandLine);
    }
    if (args.command) {
      return String(args.command);
    }
    if (args.TargetFile) {
      return String(args.TargetFile);
    }
    if (args.filePath) {
      return String(args.filePath);
    }
    if (args.Query) {
      return `"${args.Query}" in ${args.SearchPath ?? ""}`;
    }
    return JSON.stringify(args, null, 2);
  })();

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-lg border bg-card/80 text-xs shadow-2xs transition-all",
        status === "running" && "border-sky-500/40 ring-1 ring-sky-500/20",
        className
      )}
    >
      <button
        className="flex w-full cursor-pointer items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70"
        onClick={handleToggle}
        type="button"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono font-semibold text-foreground">
            {toolName}
          </span>
          {formattedArgs && (
            <span className="truncate font-mono text-muted-foreground text-xs opacity-80">
              {formattedArgs}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status === "running" && (
            <Badge
              className="flex items-center gap-1 border-sky-500/30 text-sky-500"
              variant="outline"
            >
              <Loader2 className="size-3 animate-spin" />
              <span>running</span>
            </Badge>
          )}
          {status === "completed" && (
            <Badge
              className="flex items-center gap-1 border-emerald-500/30 text-emerald-500"
              variant="outline"
            >
              <CheckCircle2 className="size-3" />
              {typeof exitCode === "number" ? `exit ${exitCode}` : "done"}
            </Badge>
          )}
          {status === "failed" && (
            <Badge
              className="flex items-center gap-1 border-rose-500/30 text-rose-500"
              variant="outline"
            >
              <XCircle className="size-3" />
              {typeof exitCode === "number" ? `exit ${exitCode}` : "error"}
            </Badge>
          )}
          {status === "denied" && (
            <Badge
              className="flex items-center gap-1 border-amber-500/30 text-amber-500"
              variant="outline"
            >
              <XCircle className="size-3" />
              <span>denied</span>
            </Badge>
          )}

          <span className="flex size-5 items-center justify-center p-0 text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="space-y-2 border-t p-3 font-mono">
          <div>
            <div className="mb-1 font-semibold text-muted-foreground">
              Arguments:
            </div>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/70 p-2 text-foreground text-xs">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>

          {result !== undefined && (
            <div>
              <div className="mb-1 font-semibold text-muted-foreground">
                Output / Result:
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border bg-background/90 p-2 text-foreground text-xs">
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

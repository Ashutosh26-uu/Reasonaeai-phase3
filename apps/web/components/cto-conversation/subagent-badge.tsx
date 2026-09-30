"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { cn } from "@reasonateai/ui/lib/utils";
import {
  Bug,
  CheckCircle2,
  Code2,
  Cpu,
  Eye,
  Loader2,
  XCircle,
} from "lucide-react";
import type { SubagentDelegationItem } from "../../lib/conversation-state";

export interface SubagentBadgeProps {
  className?: string;
  subagent: SubagentDelegationItem;
}

export function SubagentBadge({ subagent, className }: SubagentBadgeProps) {
  const { agentType, task, status, durationMs, modelId } = subagent;

  const config = (() => {
    switch (agentType.toLowerCase()) {
      case "scout":
        return {
          badgeColor:
            "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
          desc: "Read-only workspace scan & analysis",
          icon: Eye,
          label: "Scout Investigator",
        };
      case "coder":
        return {
          badgeColor:
            "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
          desc: "Writing code, updating tests & build scripts",
          icon: Code2,
          label: "Coder Implementer",
        };
      case "debugger":
        return {
          badgeColor:
            "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400",
          desc: "Failure diagnosis & surgical repair",
          icon: Bug,
          label: "Debugger Specialist",
        };
      default:
        return {
          badgeColor:
            "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          desc: "Specialized runtime delegation",
          icon: Cpu,
          label: `${agentType.charAt(0).toUpperCase() + agentType.slice(1)} Worker`,
        };
    }
  })();

  const Icon = config.icon;

  return (
    <div
      className={cn(
        "my-2 rounded-lg border bg-card/60 p-3 shadow-2xs backdrop-blur-xs transition-all",
        status === "running" && "border-primary/40 ring-1 ring-primary/20",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 font-medium text-xs",
              config.badgeColor
            )}
            variant="outline"
          >
            <Icon className="size-3.5" />
            <span>{config.label}</span>
          </Badge>
          {modelId && (
            <span className="font-mono text-muted-foreground text-xs opacity-70">
              ({modelId})
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-xs">
          {status === "running" && (
            <span className="flex items-center gap-1 font-medium text-sky-500">
              <Loader2 className="size-3 animate-spin" />
              Active
            </span>
          )}
          {status === "completed" && (
            <span className="flex items-center gap-1 font-medium text-emerald-500">
              <CheckCircle2 className="size-3" />
              {durationMs ? `${durationMs}ms` : "Done"}
            </span>
          )}
          {status === "failed" && (
            <span className="flex items-center gap-1 font-medium text-rose-500">
              <XCircle className="size-3" />
              Failed
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 text-foreground/90 text-sm">
        <span className="font-medium text-muted-foreground text-xs">
          Task Objective:{" "}
        </span>
        <span>{task}</span>
      </div>
    </div>
  );
}

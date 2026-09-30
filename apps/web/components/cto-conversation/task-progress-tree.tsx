"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { cn } from "@reasonateai/ui/lib/utils";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListTodo,
  Loader2,
  XCircle,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { TaskItem } from "../../lib/conversation-state";

export interface TaskProgressTreeProps {
  className?: string | undefined;
  defaultExpanded?: boolean | undefined;
  tasks: TaskItem[];
}

export function TaskProgressTree({
  tasks,
  className,
  defaultExpanded = true,
}: TaskProgressTreeProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  if (tasks.length === 0) {
    return null;
  }

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const progressPercent = Math.round((completedCount / tasks.length) * 100);

  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-lg border bg-card/70 text-xs shadow-2xs backdrop-blur-xs",
        className
      )}
    >
      <button
        className="flex w-full cursor-pointer items-center justify-between gap-3 bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
        onClick={handleToggle}
        type="button"
      >
        <div className="flex items-center gap-2">
          <ListTodo className="size-4 text-primary" />
          <span className="font-semibold text-foreground">
            Execution Plan Progress
          </span>
          <Badge
            className="px-1.5 py-0 font-mono text-[10px]"
            variant="outline"
          >
            {completedCount}/{tasks.length} ({progressPercent}%)
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-muted sm:flex">
            <div
              className="bg-primary transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
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
        <div className="divide-y border-t bg-background/50">
          {tasks.map((task) => {
            const isCompleted = task.status === "completed";
            const isInProgress = task.status === "in_progress";
            const isFailed = task.status === "failed";

            return (
              <div
                className={cn(
                  "flex items-center gap-2.5 px-4 py-2 transition-colors",
                  isInProgress && "bg-primary/5 font-medium"
                )}
                key={task.id}
              >
                {isCompleted && (
                  <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                )}
                {isInProgress && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-500" />
                )}
                {isFailed && (
                  <XCircle className="size-3.5 shrink-0 text-rose-500" />
                )}
                {!(isCompleted || isInProgress || isFailed) && (
                  <Circle className="size-3.5 shrink-0 text-muted-foreground/40" />
                )}

                <span
                  className={cn(
                    "flex-1 text-xs",
                    isCompleted &&
                      "text-muted-foreground line-through opacity-80",
                    isInProgress && "font-semibold text-foreground"
                  )}
                >
                  {task.title}
                </span>

                <span className="font-mono text-[10px] text-muted-foreground uppercase">
                  {task.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

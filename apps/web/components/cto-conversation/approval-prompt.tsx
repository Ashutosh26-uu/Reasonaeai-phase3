"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { Button } from "@reasonateai/ui/components/button";
import { Card } from "@reasonateai/ui/components/card";
import { cn } from "@reasonateai/ui/lib/utils";
import { Check, KeyRound, ShieldAlert, X } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import type { ApprovalGateItem } from "../../lib/conversation-state";

export interface ApprovalPromptProps {
  approval: ApprovalGateItem;
  className?: string | undefined;
  onResolve: (toolCallId: string, resolution: unknown) => void;
}

export function ApprovalPrompt({
  approval,
  onResolve,
  className,
}: ApprovalPromptProps) {
  const { toolCallId, toolName, args, suspendPayload, status } = approval;
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const suspendPrompt = (() => {
    if (suspendPayload && typeof suspendPayload === "object") {
      const p = suspendPayload as Record<string, unknown>;
      if (typeof p.prompt === "string") {
        return p.prompt;
      }
      if (typeof p.message === "string") {
        return p.message;
      }
    }
    return `The CTO is requesting approval to execute tool: ${toolName}`;
  })();

  const needsInput = Boolean(
    suspendPayload &&
      typeof suspendPayload === "object" &&
      ((suspendPayload as Record<string, unknown>).requiresInput === true ||
        (suspendPayload as Record<string, unknown>).prompt !== undefined)
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
    },
    []
  );

  const handleApprove = useCallback(() => {
    setIsSubmitting(true);
    const resPayload = needsInput
      ? { approved: true, value: inputValue }
      : { approved: true };
    onResolve(toolCallId, resPayload);
  }, [needsInput, inputValue, onResolve, toolCallId]);

  const handleDeny = useCallback(() => {
    setIsSubmitting(true);
    onResolve(toolCallId, { approved: false, reason: "Denied by user" });
  }, [onResolve, toolCallId]);

  if (status !== "pending") {
    return (
      <div
        className={cn(
          "my-3 rounded-lg border bg-muted/40 p-3 text-muted-foreground text-xs",
          className
        )}
      >
        <div className="flex items-center gap-2">
          <Badge className="border-muted-foreground/30" variant="outline">
            {status === "resolved" ? "Approved" : "Cancelled / Denied"}
          </Badge>
          <span>
            Handoff for <strong>{toolName}</strong> was {status}.
          </span>
        </div>
      </div>
    );
  }

  const hasArgs = Object.keys(args).length > 0;

  return (
    <Card
      className={cn(
        "my-3 overflow-hidden border-amber-500/40 bg-amber-500/5 p-4 shadow-sm",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-amber-500/20 p-2 text-amber-600 dark:text-amber-400">
          {needsInput ? (
            <KeyRound className="size-5" />
          ) : (
            <ShieldAlert className="size-5" />
          )}
        </div>

        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge
                className="border-amber-500/40 bg-amber-500/10 text-amber-600 text-xs dark:text-amber-400"
                variant="outline"
              >
                Smart Handoff Required
              </Badge>
              <span className="font-mono text-muted-foreground text-xs">
                {toolName}
              </span>
            </div>
          </div>

          <p className="font-medium text-foreground text-sm">{suspendPrompt}</p>

          {hasArgs && (
            <div className="rounded-md border bg-background/80 p-2 font-mono text-xs">
              <div className="mb-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                Requested Parameters:
              </div>
              <pre className="max-h-24 overflow-auto">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {needsInput && (
            <div className="pt-2">
              <input
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-500/30"
                onChange={handleInputChange}
                placeholder="Enter required credentials / response..."
                type="text"
                value={inputValue}
              />
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <Button
              className="flex h-8 items-center gap-1.5 bg-emerald-600 text-white text-xs hover:bg-emerald-700"
              disabled={isSubmitting}
              onClick={handleApprove}
              size="sm"
            >
              <Check className="size-3.5" />
              Approve & Continue
            </Button>

            <Button
              className="flex h-8 items-center gap-1.5 border-rose-500/30 text-rose-600 text-xs hover:bg-rose-500/10 hover:text-rose-700"
              disabled={isSubmitting}
              onClick={handleDeny}
              size="sm"
              variant="outline"
            >
              <X className="size-3.5" />
              Deny
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

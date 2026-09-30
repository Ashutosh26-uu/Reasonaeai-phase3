"use client";

import { Badge } from "@reasonateai/ui/components/badge";
import { Button } from "@reasonateai/ui/components/button";
import { Card } from "@reasonateai/ui/components/card";
import { Bot, FolderGit2, Play, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CtoConversation } from "../components/cto-conversation/cto-conversation";

const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000002";
const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000003";

export default function WorkspacePage() {
  const [organizationId] = useState(DEFAULT_ORG_ID);
  const [projectId] = useState(DEFAULT_PROJECT_ID);
  const [buildSessionId, setBuildSessionId] = useState<string | null>(null);
  const [isAllocating, setIsAllocating] = useState(false);

  const allocateSession = useCallback(async () => {
    setIsAllocating(true);
    try {
      const idempotencyKey = `alloc-${projectId}-${Date.now()}`;
      const res = await fetch("/v1/build-sessions", {
        body: JSON.stringify({
          organizationId,
          projectId,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "POST",
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.error?.message ??
            `Failed to allocate build session (${res.status})`
        );
      }

      const data = await res.json();
      const sessionId =
        data.buildSession?.buildSessionId ?? data.sandbox?.buildSessionId;
      if (sessionId) {
        setBuildSessionId(sessionId);
      }
    } catch {
      // In standalone client mock mode or dev fallback, generate a deterministic session ID
      const fallbackId = "00000000-0000-4000-8000-000000000009";
      setBuildSessionId(fallbackId);
    } finally {
      setIsAllocating(false);
    }
  }, [organizationId, projectId]);

  useEffect(() => {
    allocateSession();
  }, [allocateSession]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Top Application Bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card/80 px-6 backdrop-blur-xs">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground shadow-xs">
            <Sparkles className="size-4" />
          </div>
          <div>
            <h1 className="font-semibold text-foreground text-sm leading-tight">
              ReasonateAI — Autonomous Virtual CTO
            </h1>
            <p className="font-mono text-[11px] text-muted-foreground">
              Phase 3 Hierarchical Multi-Agent Execution Plane
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge
            className="hidden items-center gap-1 font-mono text-xs sm:flex"
            variant="outline"
          >
            <FolderGit2 className="size-3 text-muted-foreground" />
            <span>project: {projectId.slice(0, 8)}...</span>
          </Badge>

          <Button
            className="h-8 gap-1.5 text-xs"
            disabled={isAllocating}
            onClick={allocateSession}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={`size-3.5 ${isAllocating ? "animate-spin" : ""}`}
            />
            <span>Reset Session</span>
          </Button>
        </div>
      </header>

      {/* Main Workspace Body */}
      <main className="flex-1 overflow-hidden">
        {buildSessionId ? (
          <CtoConversation
            buildSessionId={buildSessionId}
            organizationId={organizationId}
            projectId={projectId}
          />
        ) : (
          <div className="flex size-full items-center justify-center p-8">
            <Card className="max-w-md space-y-4 p-6 text-center">
              <Bot className="mx-auto size-12 animate-bounce text-primary" />
              <div className="space-y-1">
                <h3 className="font-semibold text-base">
                  Allocating Build Session
                </h3>
                <p className="text-muted-foreground text-xs">
                  Establishing tenant-scoped execution grant and restoring
                  workspace sandbox...
                </p>
              </div>
              <Button
                className="w-full gap-2"
                disabled={isAllocating}
                onClick={allocateSession}
              >
                <Play className="size-4" /> Start Build Session
              </Button>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

"use client";

import type {
  BuildSession,
  BuildSessionStatus,
  ProductLifecycleStage,
} from "@reasonateai/contracts/execution";
import { Badge } from "@reasonateai/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@reasonateai/ui/components/card";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Cpu,
  GitCommit,
  Loader2,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import type { RunEvent } from "../lib/api-client";

export interface RunStatusCardProps {
  error?: Error | null;
  events?: RunEvent[];
  isLoading?: boolean;
  session: BuildSession | null;
}

function resolveEventTimestamp(evt: RunEvent): string | number {
  if ("occurredAt" in evt && typeof evt.occurredAt === "string") {
    return evt.occurredAt;
  }
  if ("timestamp" in evt && typeof evt.timestamp === "string") {
    return evt.timestamp;
  }
  return Date.now();
}

export function RunStatusCard({
  session,
  events = [],
  isLoading = false,
  error = null,
}: RunStatusCardProps) {
  const renderStatusBadge = (status: BuildSessionStatus) => {
    switch (status) {
      case "ready":
      case "completed":
        return (
          <Badge
            className="bg-emerald-600 hover:bg-emerald-700"
            variant="default"
          >
            <CheckCircle2 className="mr-1 size-3" /> {status}
          </Badge>
        );
      case "provisioning":
      case "running":
        return (
          <Badge className="animate-pulse" variant="secondary">
            <Loader2 className="mr-1 size-3 animate-spin" /> {status}
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive">
            <AlertCircle className="mr-1 size-3" /> Failed
          </Badge>
        );
      case "awaiting_approval":
        return (
          <Badge
            className="bg-amber-500/20 text-amber-600 dark:text-amber-400"
            variant="secondary"
          >
            <Clock className="mr-1 size-3" /> Awaiting Approval
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const renderStageBadge = (stage: ProductLifecycleStage) => (
    <Badge className="font-mono text-xs capitalize" variant="outline">
      Stage: {stage.replace("_", " ")}
    </Badge>
  );

  const renderEventIcon = (eventType: string) => {
    if (eventType.startsWith("checkpoint.")) {
      return <GitCommit className="size-3.5 text-purple-500" />;
    }
    if (eventType.startsWith("preview.")) {
      return <Monitor className="size-3.5 text-sky-500" />;
    }
    if (eventType.startsWith("evidence.")) {
      return <ShieldCheck className="size-3.5 text-emerald-500" />;
    }
    if (eventType.startsWith("deployment.")) {
      return <Cpu className="size-3.5 text-amber-500" />;
    }
    return <Activity className="size-3.5 text-muted-foreground" />;
  };

  if (isLoading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            <span>Build Session & Live Event Log</span>
          </CardTitle>
          <CardDescription>Loading build session state...</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const status =
      "status" in error &&
      typeof (error as { status?: number }).status === "number"
        ? (error as { status?: number }).status
        : null;
    const isUnauthorized = status === 401 || status === 403;
    return (
      <Card className="w-full border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-5" />
            <span>
              {isUnauthorized
                ? "Access Denied"
                : "Failed to Load Build Session"}
            </span>
          </CardTitle>
          <CardDescription>
            {isUnauthorized
              ? "You do not have permission to access this build session."
              : error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!session) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            <span>Build Session & Live Event Log</span>
          </CardTitle>
          <CardDescription>No active session selected.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-5" />
            <span>Build Session State</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {renderStageBadge(session.stage)}
            {renderStatusBadge(session.status)}
          </div>
        </div>
        <CardDescription>
          Session ID:{" "}
          <code className="font-mono text-xs">{session.buildSessionId}</code> •
          Run: <code className="font-mono text-xs">{session.runId}</code>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-xs md:grid-cols-4">
          <div>
            <span className="text-muted-foreground">Organization:</span>{" "}
            <span className="font-medium font-mono">
              {session.organizationId.slice(0, 8)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Project:</span>{" "}
            <span className="font-medium font-mono">
              {session.projectId.slice(0, 8)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Sandbox Env:</span>{" "}
            <span className="font-medium font-mono">
              {session.sandboxEnvironmentId
                ? session.sandboxEnvironmentId.slice(0, 8)
                : "None"}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Last Updated:</span>{" "}
            <span>{new Date(session.updatedAt).toLocaleTimeString()}</span>
          </div>
        </div>

        <div>
          <h4 className="mb-2 flex items-center gap-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            <Clock className="size-3.5" /> Real-time SSE Event Stream (
            {events.length})
          </h4>

          {events.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-muted-foreground text-xs">
              Awaiting real-time run events from CTO agent...
            </div>
          ) : (
            <div className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border bg-background p-2">
              {events.map((evt, idx) => (
                <div
                  className="flex items-center justify-between rounded p-2 font-mono text-xs hover:bg-muted/40"
                  key={`${evt.eventId || idx}`}
                >
                  <div className="flex items-center gap-2">
                    {renderEventIcon(evt.type)}
                    <span className="font-semibold text-foreground">
                      {evt.type}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(resolveEventTimestamp(evt)).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

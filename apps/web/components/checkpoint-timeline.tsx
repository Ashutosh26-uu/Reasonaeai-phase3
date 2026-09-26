"use client";

import type { GitCheckpoint } from "@reasonateai/contracts/execution";
import { Badge } from "@reasonateai/ui/components/badge";
import { Button } from "@reasonateai/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@reasonateai/ui/components/card";
import {
  AlertCircle,
  CheckCircle2,
  GitCommit,
  History,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useCallback, useState } from "react";

export interface CheckpointTimelineProps {
  canRestore?: boolean;
  checkpoints: GitCheckpoint[];
  error?: Error | null;
  isLoading?: boolean;
  onRefresh?: () => void;
  onRestore?: ((checkpointId: string) => Promise<void>) | undefined;
}

interface CustomError {
  status?: number;
}

function getErrorStatus(error: Error | null): number | null {
  if (!error) {
    return null;
  }
  if ("status" in error && typeof (error as CustomError).status === "number") {
    return (error as CustomError).status ?? null;
  }
  return null;
}

function CheckpointRowItem({
  cp,
  canRestore,
  onRestore,
  onSelect,
}: {
  cp: GitCheckpoint;
  canRestore: boolean;
  onRestore?: ((checkpointId: string) => Promise<void>) | undefined;
  onSelect: (checkpoint: GitCheckpoint) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(cp);
  }, [cp, onSelect]);

  return (
    <div className="group relative pb-4 last:pb-0">
      <div className="absolute top-1 -left-6 flex size-5 items-center justify-center rounded-full border bg-background text-foreground group-hover:border-primary">
        <GitCommit className="size-3 text-muted-foreground group-hover:text-primary" />
      </div>
      <div className="flex flex-col gap-1 rounded-md border bg-card p-3 shadow-2xs hover:border-accent">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sm">{cp.message}</span>
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs">
            {cp.commitHash.slice(0, 7)}
          </span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground text-xs">
          <span>
            By <span className="font-medium">{cp.author}</span> •{" "}
            {new Date(cp.occurredAt).toLocaleString()}
          </span>
          {onRestore && canRestore && (
            <Button
              onClick={handleSelect}
              size="xs"
              title="Restore workspace to this checkpoint"
              variant="ghost"
            >
              <RotateCcw className="mr-1 size-3" /> Restore
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CheckpointTimeline({
  checkpoints,
  isLoading = false,
  error = null,
  onRestore,
  canRestore = true,
}: CheckpointTimelineProps) {
  const [selectedCheckpoint, setSelectedCheckpoint] =
    useState<GitCheckpoint | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const handleConfirmRestore = useCallback(async () => {
    if (!(selectedCheckpoint && onRestore)) {
      return;
    }
    setIsRestoring(true);
    setRestoreStatus(null);
    try {
      await onRestore(selectedCheckpoint.checkpointId);
      setRestoreStatus({
        message: `Successfully restored workspace to checkpoint ${selectedCheckpoint.commitHash.slice(0, 7)}.`,
        type: "success",
      });
      setSelectedCheckpoint(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to restore checkpoint.";
      setRestoreStatus({
        message,
        type: "error",
      });
    } finally {
      setIsRestoring(false);
    }
  }, [selectedCheckpoint, onRestore]);

  const handleDismissRestoreStatus = useCallback(() => {
    setRestoreStatus(null);
  }, []);

  const handleCancelSelect = useCallback(() => {
    setSelectedCheckpoint(null);
  }, []);

  if (isLoading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-5" />
            <span>Git Checkpoints</span>
          </CardTitle>
          <CardDescription>
            Loading workspace checkpoint history...
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const status = getErrorStatus(error);
    const isUnauthorized = status === 401 || status === 403;
    return (
      <Card className="w-full border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-5" />
            <span>
              {isUnauthorized ? "Access Denied" : "Failed to Load Checkpoints"}
            </span>
          </CardTitle>
          <CardDescription>
            {isUnauthorized
              ? "You do not have permission to view checkpoints."
              : error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <History className="size-5" />
            <span>Git Checkpoints</span>
          </CardTitle>
          <Badge variant="outline">{checkpoints.length} Checkpoints</Badge>
        </div>
        <CardDescription>
          Recorded Git commits captured during CTO agent workspace execution.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {restoreStatus && (
          <div
            className={`flex items-center justify-between rounded-lg border p-3 text-sm ${
              restoreStatus.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            <div className="flex items-center gap-2">
              {restoreStatus.type === "success" ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <AlertCircle className="size-4 shrink-0" />
              )}
              <span>{restoreStatus.message}</span>
            </div>
            <Button
              onClick={handleDismissRestoreStatus}
              size="xs"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        )}

        {selectedCheckpoint && (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-semibold text-sm">
                  Confirm Checkpoint Restore
                </h4>
                <p className="text-muted-foreground text-xs">
                  Restoring will revert the workspace to commit{" "}
                  <code className="font-mono">
                    {selectedCheckpoint.commitHash.slice(0, 7)}
                  </code>
                  : "{selectedCheckpoint.message}".
                </p>
              </div>
              <Button onClick={handleCancelSelect} size="xs" variant="ghost">
                Cancel
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={handleCancelSelect} size="sm" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={isRestoring}
                onClick={handleConfirmRestore}
                size="sm"
              >
                {isRestoring ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-2 size-4" />
                    Confirm Restore
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {checkpoints.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <GitCommit className="size-8 text-muted-foreground/40" />
            <p className="text-sm">No checkpoints recorded yet.</p>
          </div>
        ) : (
          <div className="relative pl-6 before:absolute before:top-2 before:bottom-2 before:left-2.5 before:w-0.5 before:bg-border">
            {checkpoints.map((cp) => (
              <CheckpointRowItem
                canRestore={canRestore}
                cp={cp}
                key={cp.checkpointId}
                onRestore={onRestore}
                onSelect={setSelectedCheckpoint}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

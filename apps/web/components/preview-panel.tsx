"use client";

import type { PreviewSession } from "@reasonateai/contracts/execution";
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
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";

export interface PreviewPanelProps {
  buildSessionId?: string;
  error?: Error | null;
  isLoading?: boolean;
  onCreatePreview?: (port: number) => void;
  onRefresh?: () => void;
  onRetry?: () => void;
  preview: PreviewSession | null;
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

function getErrorTitle(status: number | null): string {
  if (status === 401 || status === 403) {
    return "Access Denied";
  }
  if (status === 404) {
    return "Preview Not Found";
  }
  return "Preview Error";
}

function getErrorMessage(
  status: number | null,
  fallbackMessage: string
): string {
  if (status === 401 || status === 403) {
    return "You do not have permission to view this preview.";
  }
  if (status === 404) {
    return "No preview environment was found for this build session.";
  }
  return fallbackMessage;
}

function PreviewPanelErrorState({
  error,
  onRefresh,
}: {
  error: Error;
  onRefresh?: (() => void) | undefined;
}) {
  const status = getErrorStatus(error);
  const title = getErrorTitle(status);
  const message = getErrorMessage(status, error.message);

  return (
    <Card className="w-full border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <span>{title}</span>
        </CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      {onRefresh && (
        <CardContent>
          <Button onClick={onRefresh} size="sm" variant="outline">
            <RefreshCw className="mr-2 size-4" />
            Retry
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

function PreviewPanelEmptyState({
  buildSessionId,
  isLoading,
  onCreatePreview,
}: {
  buildSessionId?: string | undefined;
  isLoading: boolean;
  onCreatePreview?: ((port: number) => void) | undefined;
}) {
  const [portInput, setPortInput] = useState<number>(3000);

  const handlePortChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPortInput(Number.parseInt(e.target.value, 10) || 3000);
  }, []);

  const handleCreate = useCallback(() => {
    if (onCreatePreview) {
      onCreatePreview(portInput);
    }
  }, [onCreatePreview, portInput]);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Monitor className="size-5" />
          <span>Application Preview</span>
        </CardTitle>
        <CardDescription>
          No active preview session for this build session.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-8 text-center">
        <Server className="size-12 text-muted-foreground/50" />
        <p className="max-w-sm text-muted-foreground text-sm">
          Launch a preview session on a port to inspect your web application
          inside the build sandbox.
        </p>
        {onCreatePreview && (
          <div className="flex items-center gap-2">
            <input
              aria-label="Preview Port"
              className="h-9 w-24 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              max={65_535}
              min={1}
              onChange={handlePortChange}
              type="number"
              value={portInput}
            />
            <Button
              disabled={!buildSessionId || isLoading}
              onClick={handleCreate}
              size="sm"
            >
              Start Preview
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RenderStatusBadge({ status }: { status: PreviewSession["status"] }) {
  switch (status) {
    case "ready":
      return (
        <Badge
          className="bg-emerald-600 hover:bg-emerald-700"
          variant="default"
        >
          <CheckCircle2 className="mr-1 size-3" /> Ready
        </Badge>
      );
    case "allocating":
      return (
        <Badge className="animate-pulse" variant="secondary">
          <Loader2 className="mr-1 size-3 animate-spin" /> Allocating
        </Badge>
      );
    case "degraded":
      return (
        <Badge
          className="bg-amber-500/20 text-amber-600 dark:text-amber-400"
          variant="secondary"
        >
          <AlertTriangle className="mr-1 size-3" /> Degraded
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <AlertCircle className="mr-1 size-3" /> Failed
        </Badge>
      );
    case "stopped":
      return <Badge variant="outline">Stopped</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function PreviewPanel({
  preview,
  isLoading = false,
  error = null,
  onRefresh,
  onRetry,
  onCreatePreview,
  buildSessionId,
}: PreviewPanelProps) {
  useEffect(() => {
    if (preview?.status === "allocating" && onRefresh) {
      const interval = setInterval(() => {
        onRefresh();
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [preview?.status, onRefresh]);

  if (isLoading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="size-5" />
            <span>Application Preview</span>
          </CardTitle>
          <CardDescription>Loading sandbox preview state...</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return <PreviewPanelErrorState error={error} onRefresh={onRefresh} />;
  }

  if (!preview) {
    return (
      <PreviewPanelEmptyState
        buildSessionId={buildSessionId}
        isLoading={isLoading}
        onCreatePreview={onCreatePreview}
      />
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Monitor className="size-5" />
            <span>Application Preview</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <RenderStatusBadge status={preview.status} />
            {onRefresh && (
              <Button
                onClick={onRefresh}
                size="icon-sm"
                title="Refresh Preview"
                variant="ghost"
              >
                <RefreshCw className="size-4" />
                <span className="sr-only">Refresh Preview</span>
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          Running on port {preview.port} inside sandbox{" "}
          <code className="font-mono text-xs">{preview.sandboxId}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.status === "allocating" && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <div className="space-y-1">
              <h4 className="font-medium text-sm">
                Allocating Preview Sandbox
              </h4>
              <p className="text-muted-foreground text-xs">
                Starting server on port {preview.port} and verifying health
                check...
              </p>
            </div>
          </div>
        )}

        {preview.status === "failed" && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive-foreground">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="flex-1 space-y-1">
                <h4 className="font-semibold text-destructive text-sm">
                  Health Check Failed{" "}
                  {preview.errorDetails?.code
                    ? `(${preview.errorDetails.code})`
                    : ""}
                </h4>
                <p className="text-sm">
                  {preview.errorDetails?.message ||
                    "Application failed to respond on configured port."}
                </p>
                {preview.errorDetails?.step && (
                  <p className="text-xs opacity-80">
                    Step: {preview.errorDetails.step}
                  </p>
                )}
                {preview.errorDetails?.occurredAt && (
                  <p className="text-xs opacity-70">
                    Failed at:{" "}
                    {new Date(preview.errorDetails.occurredAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
            {onRetry && (
              <div className="mt-4 flex justify-end">
                <Button onClick={onRetry} size="sm" variant="outline">
                  <RefreshCw className="mr-2 size-4" /> Retry Health Check
                </Button>
              </div>
            )}
          </div>
        )}

        {(preview.status === "ready" || preview.status === "degraded") &&
          (preview.proxyUrl ? (
            <div className="overflow-hidden rounded-lg border bg-background shadow-inner">
              <iframe
                className="h-[400px] w-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms"
                src={preview.proxyUrl}
                title={`Preview on port ${preview.port}`}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-8 text-center">
              <Server className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <h4 className="font-semibold text-foreground text-sm">
                  Application Running inside Build Sandbox (Port {preview.port})
                </h4>
                <p className="max-w-md text-muted-foreground text-xs">
                  The application is active and healthy on port {preview.port},
                  but no public preview proxy URL is available in this
                  environment.
                </p>
              </div>
              {preview.healthUrl && (
                <div className="mt-2 rounded border bg-background/50 px-3 py-1 font-mono text-muted-foreground text-xs">
                  Internal Health Endpoint: {preview.healthUrl}
                </div>
              )}
            </div>
          ))}

        <div className="grid grid-cols-2 gap-4 rounded-lg border p-3 text-xs">
          <div>
            <span className="text-muted-foreground">Port:</span>{" "}
            <span className="font-medium">{preview.port}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Expires:</span>{" "}
            <span className="font-medium">
              {new Date(preview.expiresAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

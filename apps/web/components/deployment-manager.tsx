"use client";

import type { Deployment } from "@reasonateai/contracts/execution";
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
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  Rocket,
  RotateCcw,
} from "lucide-react";
import type React from "react";
import { type ChangeEvent, useCallback, useState } from "react";

export interface DeploymentManagerProps {
  canDeploy?: boolean;
  canRollback?: boolean;
  deployments: Deployment[];
  error?: Error | null;
  isLoading?: boolean;
  onCreateDeployment?: (input: {
    sourceCheckpoint: string;
    exposure: "authenticated" | "unlisted" | "public";
    providerReference: string;
  }) => Promise<void>;
  onRollback?:
    | ((deploymentId: string, reason: string) => Promise<void>)
    | undefined;
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

function DeploymentRowItem({
  dep,
  canRollback,
  onRollback,
  onSelectRollback,
}: {
  dep: Deployment;
  canRollback: boolean;
  onRollback?:
    | ((deploymentId: string, reason: string) => Promise<void>)
    | undefined;
  onSelectRollback: (deployment: Deployment) => void;
}) {
  const handleRollbackClick = useCallback(() => {
    onSelectRollback(dep);
  }, [dep, onSelectRollback]);

  const renderStatusBadge = (status: Deployment["status"]) => {
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
      case "pending":
      case "building":
      case "deploying":
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
      case "rolled_back":
        return (
          <Badge
            className="bg-amber-500/20 text-amber-600 dark:text-amber-400"
            variant="secondary"
          >
            <RotateCcw className="mr-1 size-3" /> Rolled Back
          </Badge>
        );
      case "superseded":
        return <Badge variant="outline">Superseded</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-2xs hover:border-border">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-sm">
            {dep.deploymentId.slice(0, 8)}
          </span>
          <Badge className="text-[10px] capitalize" variant="outline">
            {dep.exposure}
          </Badge>
        </div>
        {renderStatusBadge(dep.status)}
      </div>

      <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs md:grid-cols-3">
        <div>
          <span>Checkpoint:</span>{" "}
          <code className="font-mono text-foreground">
            {dep.sourceCheckpoint.slice(0, 7)}
          </code>
        </div>
        <div>
          <span>Provider:</span>{" "}
          <span className="font-medium text-foreground">
            {dep.providerReference}
          </span>
        </div>
        <div>
          <span>Created:</span>{" "}
          <span>{new Date(dep.createdAt).toLocaleString()}</span>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 text-xs">
        {dep.status === "ready" && dep.url ? (
          <a
            className="inline-flex items-center font-medium text-primary hover:underline"
            href={dep.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="mr-1 size-3" /> {dep.url}
          </a>
        ) : (
          <span className="text-muted-foreground italic">
            {dep.status === "pending"
              ? "Deployment pending — no live URL generated yet"
              : "No active public URL"}
          </span>
        )}

        {onRollback &&
          canRollback &&
          dep.status !== "rolled_back" &&
          dep.status !== "superseded" && (
            <Button
              className="text-destructive hover:bg-destructive/10"
              onClick={handleRollbackClick}
              size="xs"
              variant="ghost"
            >
              <RotateCcw className="mr-1 size-3" /> Rollback
            </Button>
          )}
      </div>
    </div>
  );
}

export function DeploymentManager({
  deployments,
  isLoading = false,
  error = null,
  canRollback = true,
  canDeploy = true,
  onRollback,
  onCreateDeployment,
}: DeploymentManagerProps) {
  const [selectedRollbackDep, setSelectedRollbackDep] =
    useState<Deployment | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [checkpointHash, setCheckpointHash] = useState("");
  const [exposure, setExposure] = useState<
    "authenticated" | "unlisted" | "public"
  >("public");
  const [providerRef, setProviderRef] = useState("cloud-run");
  const [isCreating, setIsCreating] = useState(false);

  const handleConfirmRollback = useCallback(async () => {
    if (!(selectedRollbackDep && onRollback)) {
      return;
    }
    setIsRollingBack(true);
    setRollbackStatus(null);
    try {
      await onRollback(
        selectedRollbackDep.deploymentId,
        rollbackReason || "Manual user rollback"
      );
      setRollbackStatus({
        message: `Deployment ${selectedRollbackDep.deploymentId.slice(0, 8)} successfully initiated rollback.`,
        type: "success",
      });
      setSelectedRollbackDep(null);
      setRollbackReason("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to trigger rollback.";
      setRollbackStatus({
        message,
        type: "error",
      });
    } finally {
      setIsRollingBack(false);
    }
  }, [selectedRollbackDep, onRollback, rollbackReason]);

  const handleCreateDeployment = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!(onCreateDeployment && checkpointHash)) {
        return;
      }
      setIsCreating(true);
      try {
        await onCreateDeployment({
          exposure,
          providerReference: providerRef,
          sourceCheckpoint: checkpointHash,
        });
        setShowCreateModal(false);
        setCheckpointHash("");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to create deployment";
        setRollbackStatus({
          message,
          type: "error",
        });
      } finally {
        setIsCreating(false);
      }
    },
    [onCreateDeployment, checkpointHash, exposure, providerRef]
  );

  const handleOpenCreateModal = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  const handleDismissRollbackStatus = useCallback(() => {
    setRollbackStatus(null);
  }, []);

  const handleCancelRollbackSelect = useCallback(() => {
    setSelectedRollbackDep(null);
  }, []);

  const handleCheckpointHashChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setCheckpointHash(e.target.value);
    },
    []
  );

  const handleExposureChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setExposure(e.target.value as "authenticated" | "unlisted" | "public");
    },
    []
  );

  const handleProviderRefChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setProviderRef(e.target.value);
    },
    []
  );

  const handleRollbackReasonChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setRollbackReason(e.target.value);
    },
    []
  );

  if (isLoading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="size-5" />
            <span>Deployment Management</span>
          </CardTitle>
          <CardDescription>Loading deployment history...</CardDescription>
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
              {isUnauthorized ? "Access Denied" : "Failed to Load Deployments"}
            </span>
          </CardTitle>
          <CardDescription>
            {isUnauthorized
              ? "You do not have permission to view or manage deployments."
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
            <Rocket className="size-5" />
            <span>Deployment Management</span>
          </CardTitle>
          {onCreateDeployment && canDeploy && (
            <Button onClick={handleOpenCreateModal} size="sm">
              <Plus className="mr-1 size-4" /> New Deployment
            </Button>
          )}
        </div>
        <CardDescription>
          Release management, exposure policy, and deployment rollback.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {rollbackStatus && (
          <div
            className={`flex items-center justify-between rounded-lg border p-3 text-sm ${
              rollbackStatus.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            <div className="flex items-center gap-2">
              {rollbackStatus.type === "success" ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <AlertCircle className="size-4 shrink-0" />
              )}
              <span>{rollbackStatus.message}</span>
            </div>
            <Button
              onClick={handleDismissRollbackStatus}
              size="xs"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        )}

        {showCreateModal && (
          <form
            className="space-y-3 rounded-lg border bg-muted/20 p-4"
            onSubmit={handleCreateDeployment}
          >
            <h4 className="font-semibold text-sm">Request New Deployment</h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label
                  className="mb-1 block font-medium text-muted-foreground text-xs"
                  htmlFor="checkpoint-hash-input"
                >
                  Source Checkpoint Hash
                </label>
                <input
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  id="checkpoint-hash-input"
                  onChange={handleCheckpointHashChange}
                  placeholder="e.g. 40-char commit hash"
                  required
                  type="text"
                  value={checkpointHash}
                />
              </div>
              <div>
                <label
                  className="mb-1 block font-medium text-muted-foreground text-xs"
                  htmlFor="exposure-select"
                >
                  Exposure
                </label>
                <select
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  id="exposure-select"
                  onChange={handleExposureChange}
                  value={exposure}
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="authenticated">Authenticated</option>
                </select>
              </div>
              <div>
                <label
                  className="mb-1 block font-medium text-muted-foreground text-xs"
                  htmlFor="provider-ref-input"
                >
                  Provider Reference
                </label>
                <input
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  id="provider-ref-input"
                  onChange={handleProviderRefChange}
                  required
                  type="text"
                  value={providerRef}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={handleCloseCreateModal}
                size="xs"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={isCreating} size="xs" type="submit">
                {isCreating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  "Submit Deployment"
                )}
              </Button>
            </div>
          </form>
        )}

        {selectedRollbackDep && (
          <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-semibold text-destructive text-sm">
                  Confirm Deployment Rollback
                </h4>
                <p className="text-muted-foreground text-xs">
                  Roll back deployment{" "}
                  <code className="font-mono">
                    {selectedRollbackDep.deploymentId.slice(0, 8)}
                  </code>{" "}
                  (Checkpoint:{" "}
                  {selectedRollbackDep.sourceCheckpoint.slice(0, 7)}).
                </p>
              </div>
              <Button
                onClick={handleCancelRollbackSelect}
                size="xs"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>

            <div>
              <label
                className="mb-1 block font-medium text-muted-foreground text-xs"
                htmlFor="rollback-reason-input"
              >
                Rollback Reason
              </label>
              <input
                className="h-8 w-full rounded-md border border-input bg-background px-3 text-xs"
                id="rollback-reason-input"
                onChange={handleRollbackReasonChange}
                placeholder="Reason for rolling back deployment..."
                type="text"
                value={rollbackReason}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={handleCancelRollbackSelect}
                size="sm"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={isRollingBack}
                onClick={handleConfirmRollback}
                size="sm"
                variant="destructive"
              >
                {isRollingBack ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Rolling Back...
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-2 size-4" />
                    Confirm Rollback
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {deployments.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <Globe className="size-8 text-muted-foreground/40" />
            <p className="text-sm">
              No deployment records found for this project.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {deployments.map((dep) => (
              <DeploymentRowItem
                canRollback={canRollback}
                dep={dep}
                key={dep.deploymentId}
                onRollback={onRollback}
                onSelectRollback={setSelectedRollbackDep}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

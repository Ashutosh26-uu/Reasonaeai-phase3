"use client";

import type {
  BuildSession,
  Deployment,
  EvidenceRecord,
  GitCheckpoint,
  PreviewSession,
} from "@reasonateai/contracts/execution";
import { DeploymentIdSchema } from "@reasonateai/contracts/execution";
import { Button } from "@reasonateai/ui/components/button";
import {
  Activity,
  FileCheck,
  History,
  Monitor,
  RefreshCw,
  Rocket,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, subscribeToRunEvents } from "../lib/api-client";
import type { RunEvent } from "../lib/api-client.js";
import { CheckpointTimeline } from "./checkpoint-timeline";
import { DeploymentManager } from "./deployment-manager";
import { EvidenceGallery } from "./evidence-gallery";
import { PreviewPanel } from "./preview-panel";
import { RunStatusCard } from "./run-status-card";

export interface WorkspaceDashboardProps {
  initialBuildSessionId?: string;
  initialOrganizationId?: string;
  initialProjectId?: string;
}

export function WorkspaceDashboard({
  initialBuildSessionId,
  initialProjectId = "00000000-0000-4000-8000-000000000003",
  initialOrganizationId = "00000000-0000-4000-8000-000000000002",
}: WorkspaceDashboardProps) {
  const [activeTab, setActiveTab] = useState<
    "chat" | "preview" | "checkpoints" | "evidence" | "deployments" | "status"
  >("preview");

  const [buildSessionId, setBuildSessionId] = useState<string>(
    initialBuildSessionId ?? ""
  );
  const [projectId] = useState(initialProjectId);
  const [organizationId] = useState(initialOrganizationId);

  const [session, setSession] = useState<BuildSession | null>(null);
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [checkpoints, setCheckpoints] = useState<GitCheckpoint[]>([]);
  const [evidenceList, setEvidenceList] = useState<EvidenceRecord[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const bsIdRef = useRef(buildSessionId);
  bsIdRef.current = buildSessionId;

  const loadData = useCallback(
    async (isBackground = false) => {
      if (!isBackground) {
        setIsLoading(true);
      }
      setError(null);
      try {
        let activeBsId = bsIdRef.current;

        if (!activeBsId) {
          const alloc = await apiClient.allocateBuildSession(
            organizationId,
            projectId
          );
          activeBsId = alloc.buildSession.buildSessionId;
          setBuildSessionId(activeBsId);
          setSession(alloc.buildSession);
          bsIdRef.current = activeBsId;
        }

        if (activeBsId) {
          const [sess, prevs, cps, evs, deps] = await Promise.all([
            apiClient
              .getBuildSession(activeBsId, organizationId, projectId)
              .catch(() => null),
            apiClient
              .listPreviews(activeBsId, organizationId, projectId)
              .catch(() => []),
            apiClient
              .listCheckpoints(activeBsId, organizationId, projectId)
              .catch(() => []),
            apiClient
              .listEvidence(projectId, undefined, organizationId)
              .catch(() => []),
            apiClient
              .listDeployments(projectId, organizationId)
              .catch(() => []),
          ]);

          if (sess) {
            setSession(sess);
          }
          setPreviews(prevs);
          setCheckpoints(cps);
          setEvidenceList(evs);
          setDeployments(deps);
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to initialize build session";
        setError(new Error(message));
      } finally {
        setIsLoading(false);
      }
    },
    [organizationId, projectId]
  );

  useEffect(() => {
    loadData(false);
  }, [loadData]);

  // Subscribe to real-time SSE stream using real buildSessionId
  useEffect(() => {
    if (!buildSessionId) {
      return;
    }

    const unsubscribe = subscribeToRunEvents(
      buildSessionId,
      (event: RunEvent) => {
        setRunEvents((prev) => [event, ...prev]);

        // Auto-refresh lists when domain events arrive
        if (event.type.startsWith("checkpoint.")) {
          apiClient
            .listCheckpoints(buildSessionId, organizationId, projectId)
            .then(setCheckpoints)
            .catch(() => undefined);
        } else if (event.type.startsWith("preview.")) {
          apiClient
            .listPreviews(buildSessionId, organizationId, projectId)
            .then(setPreviews)
            .catch(() => undefined);
        } else if (event.type.startsWith("evidence.")) {
          apiClient
            .listEvidence(projectId, undefined, organizationId)
            .then(setEvidenceList)
            .catch(() => undefined);
        } else if (event.type.startsWith("deployment.")) {
          apiClient
            .listDeployments(projectId, organizationId)
            .then(setDeployments)
            .catch(() => undefined);
        }
      },
      undefined,
      organizationId,
      projectId
    );

    return () => {
      unsubscribe();
    };
  }, [buildSessionId, organizationId, projectId]);

  const activePreview = previews.length > 0 ? previews[0] : null;

  const handleRefreshState = useCallback(() => {
    loadData(false);
  }, [loadData]);

  const handleSelectPreviewTab = useCallback(() => {
    setActiveTab("preview");
  }, []);

  const handleSelectCheckpointsTab = useCallback(() => {
    setActiveTab("checkpoints");
  }, []);

  const handleSelectEvidenceTab = useCallback(() => {
    setActiveTab("evidence");
  }, []);

  const handleSelectDeploymentsTab = useCallback(() => {
    setActiveTab("deployments");
  }, []);

  const handleSelectStatusTab = useCallback(() => {
    setActiveTab("status");
  }, []);

  const handleCreatePreview = useCallback(
    async (port: number) => {
      try {
        const newPrev = await apiClient.createPreview(buildSessionId, {
          port,
        });
        setPreviews([newPrev]);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to start preview";
        setError(new Error(message));
      }
    },
    [buildSessionId]
  );

  const handleRefreshPreview = useCallback(() => {
    loadData(true);
  }, [loadData]);

  const handleRetryPreview = useCallback(() => {
    if (activePreview) {
      apiClient
        .getPreview(activePreview.previewId)
        .then((updated) => {
          setPreviews([updated]);
        })
        .catch(() => undefined);
    }
  }, [activePreview]);

  const handleRestoreCheckpoint = useCallback(
    async (cpId: string) => {
      await apiClient.restoreCheckpoint(cpId);
      await loadData();
    },
    [loadData]
  );

  const handleFetchArtifact = useCallback(async (artifactId: string) => {
    const res = await apiClient.getArtifact(artifactId);
    return { downloadUrl: res.downloadUrl };
  }, []);

  const handleCreateDeployment = useCallback(
    async (input: {
      sourceCheckpoint: string;
      exposure: "authenticated" | "unlisted" | "public";
      providerReference: string;
    }) => {
      if (!session) {
        return;
      }
      await apiClient.createDeployment(projectId, {
        ...input,
        organizationId: session.organizationId,
      });
      await loadData();
    },
    [session, projectId, loadData]
  );

  const handleRollbackDeployment = useCallback(
    async (depId: string, reason: string) => {
      if (!session) {
        return;
      }
      await apiClient.rollbackDeployment(depId, {
        organizationId: session.organizationId,
        projectId: session.projectId,
        reason,
        targetDeploymentId: DeploymentIdSchema.parse(depId),
      });
      await loadData();
    },
    [session, loadData]
  );

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground shadow-xs">
            <Sparkles className="size-5" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">
              ReasonateAI CTO Agent Workspace
            </h1>
            <p className="font-mono text-muted-foreground text-xs">
              Build Session:{" "}
              {buildSessionId
                ? `${buildSessionId.slice(0, 8)}...`
                : "Allocating..."}{" "}
              | Project: {projectId.slice(0, 8)}...
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            disabled={isLoading}
            onClick={handleRefreshState}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={`mr-2 size-4 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh State
          </Button>
        </div>
      </header>

      {/* Main Workspace Navigation */}
      <div className="border-b bg-muted/40 px-6">
        <nav className="-mb-px flex gap-2 overflow-x-auto">
          <button
            className={`flex items-center gap-2 border-b-2 px-4 py-3 font-medium text-sm transition-colors ${
              activeTab === "preview"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={handleSelectPreviewTab}
            type="button"
          >
            <Monitor className="size-4" /> Preview Environment
          </button>

          <button
            className={`flex items-center gap-2 border-b-2 px-4 py-3 font-medium text-sm transition-colors ${
              activeTab === "checkpoints"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={handleSelectCheckpointsTab}
            type="button"
          >
            <History className="size-4" /> Checkpoints ({checkpoints.length})
          </button>

          <button
            className={`flex items-center gap-2 border-b-2 px-4 py-3 font-medium text-sm transition-colors ${
              activeTab === "evidence"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={handleSelectEvidenceTab}
            type="button"
          >
            <FileCheck className="size-4" /> Evidence ({evidenceList.length})
          </button>

          <button
            className={`flex items-center gap-2 border-b-2 px-4 py-3 font-medium text-sm transition-colors ${
              activeTab === "deployments"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={handleSelectDeploymentsTab}
            type="button"
          >
            <Rocket className="size-4" /> Deployments ({deployments.length})
          </button>

          <button
            className={`flex items-center gap-2 border-b-2 px-4 py-3 font-medium text-sm transition-colors ${
              activeTab === "status"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={handleSelectStatusTab}
            type="button"
          >
            <Activity className="size-4" /> Session & SSE ({runEvents.length})
          </button>
        </nav>
      </div>

      {/* Main Content View */}
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-6">
        {activeTab === "preview" && (
          <PreviewPanel
            buildSessionId={buildSessionId}
            error={error}
            isLoading={isLoading}
            onCreatePreview={handleCreatePreview}
            onRefresh={handleRefreshPreview}
            onRetry={handleRetryPreview}
            preview={activePreview ?? null}
          />
        )}

        {activeTab === "checkpoints" && (
          <CheckpointTimeline
            checkpoints={checkpoints}
            error={error}
            isLoading={isLoading}
            onRefresh={handleRefreshState}
            onRestore={handleRestoreCheckpoint}
          />
        )}

        {activeTab === "evidence" && (
          <EvidenceGallery
            error={error}
            evidenceList={evidenceList}
            isLoading={isLoading}
            onFetchArtifact={handleFetchArtifact}
          />
        )}

        {activeTab === "deployments" && (
          <DeploymentManager
            deployments={deployments}
            error={error}
            isLoading={isLoading}
            onCreateDeployment={handleCreateDeployment}
            onRollback={handleRollbackDeployment}
          />
        )}

        {activeTab === "status" && (
          <RunStatusCard
            error={error}
            events={runEvents}
            isLoading={isLoading}
            session={session}
          />
        )}
      </main>
    </div>
  );
}

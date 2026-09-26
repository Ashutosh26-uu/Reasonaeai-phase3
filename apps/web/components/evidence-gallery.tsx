"use client";

import type {
  EvidenceKind,
  EvidenceRecord,
} from "@reasonateai/contracts/execution";
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
  Download,
  FileCheck,
  FileText,
  Filter,
  Info,
  Loader2,
  Shield,
  Terminal,
} from "lucide-react";
import { type ChangeEvent, useCallback, useState } from "react";

export interface EvidenceGalleryProps {
  error?: Error | null;
  evidenceList: EvidenceRecord[];
  isLoading?: boolean;
  onFetchArtifact?: (
    artifactId: string
  ) => Promise<{ downloadUrl: string | null }>;
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

function ArtifactInspectionDetails({
  activeArtifactId,
  isFetchingArtifact,
  artifactError,
  artifactDownloadUrl,
}: {
  activeArtifactId: string;
  isFetchingArtifact: boolean;
  artifactError: string | null;
  artifactDownloadUrl: string | null;
}) {
  if (isFetchingArtifact) {
    return (
      <div className="flex items-center gap-2 py-2 text-muted-foreground text-xs">
        <Loader2 className="size-4 animate-spin" /> Fetching artifact download
        manifest...
      </div>
    );
  }

  if (artifactError) {
    return <p className="text-destructive text-xs">{artifactError}</p>;
  }

  if (artifactDownloadUrl) {
    return (
      <div className="pt-2">
        <a
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs hover:bg-primary/90"
          href={artifactDownloadUrl}
          rel="noreferrer"
          target="_blank"
        >
          <Download className="size-3.5" /> Download Raw Artifact
        </a>
      </div>
    );
  }

  return (
    <div className="rounded border bg-background/80 p-2.5 text-muted-foreground text-xs">
      Artifact persistent record available (ID: {activeArtifactId}) — direct
      download URL not generated.
    </div>
  );
}

function EvidenceItemRow({
  ev,
  onInspect,
}: {
  ev: EvidenceRecord;
  onInspect: (artifactId: string) => void;
}) {
  const handleInspect = useCallback(() => {
    onInspect(ev.artifactId);
  }, [ev.artifactId, onInspect]);

  const renderKindIcon = (kind: EvidenceKind) => {
    switch (kind) {
      case "console_log":
        return <Terminal className="size-4 text-sky-500" />;
      case "security_audit":
        return <Shield className="size-4 text-purple-500" />;
      case "test_report":
        return <FileCheck className="size-4 text-emerald-500" />;
      default:
        return <FileText className="size-4 text-muted-foreground" />;
    }
  };

  const renderStatusBadge = (status: EvidenceRecord["status"]) => {
    switch (status) {
      case "passed":
        return (
          <Badge
            className="bg-emerald-600 hover:bg-emerald-700"
            variant="default"
          >
            <CheckCircle2 className="mr-1 size-3" /> Passed
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive">
            <AlertCircle className="mr-1 size-3" /> Failed
          </Badge>
        );
      case "warning":
        return (
          <Badge
            className="bg-amber-500/20 text-amber-600 dark:text-amber-400"
            variant="secondary"
          >
            <AlertTriangle className="mr-1 size-3" /> Warning
          </Badge>
        );
      case "info":
        return (
          <Badge
            className="border-blue-500/30 text-blue-600 dark:text-blue-400"
            variant="outline"
          >
            <Info className="mr-1 size-3" /> Info
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-2xs hover:border-border">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {renderKindIcon(ev.kind)}
          <span className="font-medium text-sm">{ev.summary}</span>
        </div>
        {renderStatusBadge(ev.status)}
      </div>

      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span className="capitalize">
          {ev.kind.replace("_", " ")} •{" "}
          {new Date(ev.createdAt).toLocaleString()}
        </span>
        <Button onClick={handleInspect} size="xs" variant="ghost">
          Inspect Artifact
        </Button>
      </div>

      {ev.metadata && Object.keys(ev.metadata).length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(ev.metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function EvidenceGallery({
  evidenceList,
  isLoading = false,
  error = null,
  onFetchArtifact,
}: EvidenceGalleryProps) {
  const [selectedKind, setSelectedKind] = useState<EvidenceKind | "all">("all");
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [artifactDownloadUrl, setArtifactDownloadUrl] = useState<string | null>(
    null
  );
  const [isFetchingArtifact, setIsFetchingArtifact] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const filtered =
    selectedKind === "all"
      ? evidenceList
      : evidenceList.filter((ev) => ev.kind === selectedKind);

  const handleInspectArtifact = useCallback(
    async (artifactId: string) => {
      setActiveArtifactId(artifactId);
      setArtifactDownloadUrl(null);
      setArtifactError(null);

      if (!onFetchArtifact) {
        return;
      }

      setIsFetchingArtifact(true);
      try {
        const res = await onFetchArtifact(artifactId);
        setArtifactDownloadUrl(res.downloadUrl);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to fetch artifact record.";
        setArtifactError(message);
      } finally {
        setIsFetchingArtifact(false);
      }
    },
    [onFetchArtifact]
  );

  const handleKindChange = useCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setSelectedKind(e.target.value as EvidenceKind | "all");
  }, []);

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifactId(null);
  }, []);

  if (isLoading) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCheck className="size-5" />
            <span>Verification Evidence</span>
          </CardTitle>
          <CardDescription>Loading evidence records...</CardDescription>
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
              {isUnauthorized ? "Access Denied" : "Failed to Load Evidence"}
            </span>
          </CardTitle>
          <CardDescription>
            {isUnauthorized
              ? "You do not have permission to view verification evidence."
              : error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileCheck className="size-5" />
            <span>Verification Evidence</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Filter className="size-4 text-muted-foreground" />
            <select
              aria-label="Filter evidence kind"
              className="h-8 rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={handleKindChange}
              value={selectedKind}
            >
              <option value="all">All Kinds</option>
              <option value="console_log">Console Log</option>
              <option value="test_report">Test Report</option>
              <option value="screenshot">Screenshot</option>
              <option value="network_trace">Network Trace</option>
              <option value="dom_snapshot">DOM Snapshot</option>
              <option value="security_audit">Security Audit</option>
            </select>
          </div>
        </div>
        <CardDescription>
          Runtime test execution logs, security audits, and verification
          records.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {activeArtifactId && (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm">Artifact Inspection</h4>
              <Button onClick={handleCloseArtifact} size="xs" variant="ghost">
                Close
              </Button>
            </div>
            <p className="font-mono text-muted-foreground text-xs">
              Artifact ID: {activeArtifactId}
            </p>
            <ArtifactInspectionDetails
              activeArtifactId={activeArtifactId}
              artifactDownloadUrl={artifactDownloadUrl}
              artifactError={artifactError}
              isFetchingArtifact={isFetchingArtifact}
            />
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
            <FileText className="size-8 text-muted-foreground/40" />
            <p className="text-sm">
              No evidence records matching current filter.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((ev) => (
              <EvidenceItemRow
                ev={ev}
                key={ev.evidenceId}
                onInspect={handleInspectArtifact}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

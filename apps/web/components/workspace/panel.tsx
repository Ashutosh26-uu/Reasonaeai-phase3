"use client";

import {
  Code2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderClosed,
  Globe,
  Loader2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { request } from "@/lib/product-api";

/**
 * The workspace panel: what the agent actually produced.
 *
 * Two views of one thing. Files reads the project's latest Git checkpoint, so it
 * is the real source rather than a rendering of it, and Preview runs that source
 * in its own sandbox and frames it. Without this the conversation is a claim
 * about a product nobody can look at.
 */

interface TreeEntry {
  bytes: number;
  kind: "directory" | "file";
  path: string;
}

interface TreeResponse {
  checkpointId: string;
  commit: string;
  files: TreeEntry[];
  truncated: boolean;
}

interface FileResponse {
  binary: boolean;
  bytes: number;
  path: string;
  text: string;
  truncated: boolean;
}

interface PreviewResponse {
  detail: string | null;
  previewId: string;
  status: "failed" | "ready" | "starting" | "stopped";
  url: string;
}

export interface PanelProps {
  buildSessionId: string;
  onClose: () => void;
  organizationId: string;
  projectId: string;
}

const treeUrl = (
  buildSessionId: string,
  organizationId: string,
  projectId: string
) =>
  `/v1/build-sessions/${buildSessionId}/workspace/tree?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;

const fileUrl = (
  buildSessionId: string,
  organizationId: string,
  projectId: string,
  path: string
) =>
  `/v1/build-sessions/${buildSessionId}/workspace/file?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileView({ file }: { file: FileResponse | null }) {
  if (file === null) {
    return <div className="panel-state">Choose a file.</div>;
  }
  if (file.binary) {
    return (
      <div className="panel-state">
        {file.path} is binary ({formatBytes(file.bytes)}).
      </div>
    );
  }
  return (
    <>
      <div className="files-head">
        <span>{file.path}</span>
        {file.truncated && <span className="files-truncated">truncated</span>}
      </div>
      <pre className="files-code">{file.text}</pre>
    </>
  );
}

function FilesView({
  buildSessionId,
  organizationId,
  projectId,
}: {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
}) {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [file, setFile] = useState<FileResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request(
        treeUrl(buildSessionId, organizationId, projectId),
        (value) => value as TreeResponse
      );
      setTree(result);
      setError("");
      const first = result.files.find((entry) => entry.kind === "file");
      if (first) {
        setFile(
          await request(
            fileUrl(buildSessionId, organizationId, projectId, first.path),
            (value) => value as FileResponse
          )
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not read the workspace."
      );
    } finally {
      setLoading(false);
    }
  }, [buildSessionId, organizationId, projectId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const openFile = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const path = event.currentTarget.value;
      request(
        fileUrl(buildSessionId, organizationId, projectId, path),
        (value) => value as FileResponse
      )
        .then(setFile)
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error ? cause.message : "Could not read that file."
          )
        );
    },
    [buildSessionId, organizationId, projectId]
  );

  if (loading) {
    return (
      <div className="panel-state">
        <Loader2 aria-hidden="true" className="spin" size={15} /> Reading the
        project's latest checkpoint…
      </div>
    );
  }

  if (error.length > 0) {
    return <div className="panel-state">{error}</div>;
  }

  if (tree === null || tree.files.length === 0) {
    return (
      <div className="panel-state">
        No checkpoint yet. The project's files appear here after its first run
        finishes.
      </div>
    );
  }

  const files = tree.files.filter((entry) => entry.kind === "file");

  return (
    <div className="files">
      <div className="files-tree">
        <div className="files-meta" title={tree.commit}>
          {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
          {tree.commit.slice(0, 7)}
        </div>
        {tree.files.map((entry) => (
          <button
            className="files-row"
            data-active={entry.path === file?.path || undefined}
            data-kind={entry.kind}
            disabled={entry.kind === "directory"}
            key={entry.path}
            onClick={openFile}
            type="button"
            value={entry.path}
          >
            {entry.kind === "directory" ? (
              <FolderClosed aria-hidden="true" size={13} />
            ) : (
              <FileCode2 aria-hidden="true" size={13} />
            )}
            <span className="files-name">{entry.path}</span>
            <span className="files-size">{formatBytes(entry.bytes)}</span>
          </button>
        ))}
      </div>
      <div className="files-view">
        <FileView file={file} />
      </div>
    </div>
  );
}

function PreviewView({
  buildSessionId,
  organizationId,
  projectId,
}: {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
}) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const start = useCallback(async () => {
    setStarting(true);
    setError("");
    try {
      const created = await request(
        `/v1/build-sessions/${buildSessionId}/preview?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`,
        (value) => value as PreviewResponse,
        { method: "POST" }
      );
      setPreview(created);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start a preview."
      );
    } finally {
      setStarting(false);
    }
  }, [buildSessionId, organizationId, projectId]);

  useEffect(() => {
    start().catch(() => undefined);
  }, [start]);

  // Poll while the sandbox is coming up, so the panel reports readiness rather
  // than guessing at it. A preview is process-local state: an API restart drops
  // the registry, and the honest answer to a preview this process no longer
  // knows is to start it again rather than to show a dead panel.
  useEffect(() => {
    if (preview === null || preview.status !== "starting") {
      return;
    }
    const timer = setTimeout(() => {
      const read = async () => {
        try {
          setPreview(
            await request(
              `/v1/previews/${preview.previewId}/status`,
              (value) => value as PreviewResponse
            )
          );
        } catch {
          await start();
        }
      };
      read().catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [preview, start]);

  if (error.length > 0) {
    return (
      <div className="panel-state">
        {error}
        <button
          className="panel-retry"
          disabled={starting}
          onClick={start}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  if (preview === null || preview.status === "starting") {
    return (
      <div className="panel-state">
        <Loader2 aria-hidden="true" className="spin" size={15} /> Starting the
        app from the latest checkpoint…
      </div>
    );
  }

  if (preview.status === "failed") {
    return (
      <div className="panel-state">
        {preview.detail ?? "The preview could not start."}
        <button
          className="panel-retry"
          disabled={starting}
          onClick={start}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="panel-chrome">
        <Globe aria-hidden="true" size={12} />
        <span className="panel-url">{preview.url}</span>
        <a
          aria-label="Open the preview in a new tab"
          className="panel-open"
          href={preview.url}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink aria-hidden="true" size={12} />
        </a>
      </div>
      <iframe
        className="panel-frame"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        src={preview.url}
        title="Generated app preview"
      />
    </>
  );
}

export function Panel({
  buildSessionId,
  onClose,
  organizationId,
  projectId,
}: PanelProps) {
  const [tab, setTab] = useState<"files" | "preview">("preview");
  const showFiles = useCallback(() => setTab("files"), []);
  const showPreview = useCallback(() => setTab("preview"), []);

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="panel-tabs">
          <button
            className="panel-tab"
            data-active={tab === "preview" || undefined}
            onClick={showPreview}
            type="button"
          >
            <Eye aria-hidden="true" size={14} /> Preview
          </button>
          <button
            className="panel-tab"
            data-active={tab === "files" || undefined}
            onClick={showFiles}
            type="button"
          >
            <Code2 aria-hidden="true" size={14} /> Files
          </button>
        </div>
        <button
          aria-label="Close the workspace panel"
          className="panel-close"
          onClick={onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </div>
      <div className="panel-body">
        {tab === "preview" ? (
          <PreviewView
            buildSessionId={buildSessionId}
            organizationId={organizationId}
            projectId={projectId}
          />
        ) : (
          <FilesView
            buildSessionId={buildSessionId}
            organizationId={organizationId}
            projectId={projectId}
          />
        )}
      </div>
    </aside>
  );
}

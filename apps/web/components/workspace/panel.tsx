"use client";

import {
  ArrowLeft,
  ArrowRight,
  Code2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderClosed,
  Loader2,
  Monitor,
  RotateCw,
  Smartphone,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "@/lib/product-api";
import { FileContentPreview } from "./file-content";
import styles from "./panel.module.css";
import {
  movePreviewHistory,
  observedPreviewPath,
  type PreviewHistory,
  parsePreviewPath,
  previewRoot,
  previewTransportUrl,
  recordPreviewPath,
  workspaceFilePath,
} from "./preview-path";

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
  refreshKey?: number | undefined;
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
        {workspaceFilePath(file.path)} is binary ({formatBytes(file.bytes)}).
      </div>
    );
  }
  return (
    <>
      <div className="files-head">
        <span>{workspaceFilePath(file.path)}</span>
        {file.truncated && <span className="files-truncated">truncated</span>}
      </div>
      <FileContentPreview key={file.path} path={file.path} text={file.text} />
    </>
  );
}

function FilesView({
  buildSessionId,
  organizationId,
  projectId,
  refreshKey,
}: {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  refreshKey?: number | undefined;
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
  }, [load, refreshKey]);

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
    return (
      <div className="panel-state">
        {error}
        <button className="panel-retry" onClick={load} type="button">
          Try again
        </button>
      </div>
    );
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
    <>
      <div className={styles.chrome}>
        <FolderClosed aria-hidden="true" size={14} />
        <span
          className={styles.filePath}
          title={file ? workspaceFilePath(file.path) : "/workspace"}
        >
          {file ? workspaceFilePath(file.path) : "/workspace"}
        </span>
      </div>
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
    </>
  );
}

function ReadyPreview({ root }: { root: string }) {
  const [history, setHistory] = useState<PreviewHistory>({
    index: 0,
    paths: ["/"],
  });
  const [framePath, setFramePath] = useState("/");
  const [address, setAddress] = useState("/");
  const [navigationError, setNavigationError] = useState("");
  const [locationNotice, setLocationNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [frameError, setFrameError] = useState("");
  const [revision, setRevision] = useState(0);
  const [mobile, setMobile] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingPath = useRef<string | null>("/");
  const currentPath = history.paths[history.index] ?? "/";
  const source = previewTransportUrl(root, framePath);
  const openUrl = previewTransportUrl(root, currentPath);

  useEffect(() => setAddress(currentPath), [currentPath]);

  const observeLocation = useCallback(() => {
    if (pendingPath.current !== null) {
      return;
    }
    try {
      const href = frame.current?.contentWindow?.location.href;
      if (!href || href === "about:blank") {
        return;
      }
      const path = observedPreviewPath(root, href);
      if (path === null) {
        setLocationNotice(
          "This page left the preview. Enter a project path to return."
        );
        return;
      }
      setLocationNotice("");
      setHistory((previous) => recordPreviewPath(previous, path));
    } catch {
      // A separate preview origin cannot expose its location to this toolbar.
      // Keep the entered route; generated-page messages are never trusted.
      setLocationNotice("Showing the path opened from this toolbar.");
    }
  }, [root]);

  useEffect(() => {
    const timer = setInterval(observeLocation, 500);
    return () => clearInterval(timer);
  }, [observeLocation]);

  useEffect(() => {
    const element = frame.current;
    if (element === null) {
      return;
    }
    const timer = setTimeout(() => {
      if (element.dataset.attempt !== String(revision)) {
        return;
      }
      setFrameError(
        "The preview is taking too long to load. Try refreshing it."
      );
      setLoading(false);
    }, 20_000);
    const loaded = () => {
      clearTimeout(timer);
      pendingPath.current = null;
      setLoading(false);
      setFrameError("");
      observeLocation();
    };
    const failed = () => {
      clearTimeout(timer);
      setFrameError("The preview could not load. Try refreshing it.");
      setLoading(false);
    };
    element.addEventListener("load", loaded);
    element.addEventListener("error", failed);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
    };
  }, [observeLocation, revision]);

  const loadPath = useCallback((path: string) => {
    pendingPath.current = path;
    setFrameError("");
    setNavigationError("");
    setLocationNotice("");
    setLoading(true);
    setFramePath(path);
    // Remount so re-entering the current path also performs a real reload.
    setRevision((previous) => previous + 1);
  }, []);

  const navigate = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const path = parsePreviewPath(address);
      if (path === null || previewTransportUrl(root, path) === null) {
        setNavigationError(
          "Enter a project path such as / or /settings. External addresses and parent paths are unavailable."
        );
        return;
      }
      setAddress(path);
      setHistory((previous) => recordPreviewPath(previous, path));
      loadPath(path);
    },
    [address, loadPath, root]
  );

  const move = useCallback(
    (delta: -1 | 1) => {
      const next = movePreviewHistory(history, delta);
      const path = next.paths[next.index];
      if (next === history || path === undefined) {
        return;
      }
      setHistory(next);
      loadPath(path);
    },
    [history, loadPath]
  );

  const goBack = useCallback(() => move(-1), [move]);
  const goForward = useCallback(() => move(1), [move]);
  const refresh = useCallback(
    () => loadPath(currentPath),
    [currentPath, loadPath]
  );
  const toggleDevice = useCallback(
    () => setMobile((previous) => !previous),
    []
  );
  const changeAddress = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setAddress(event.currentTarget.value),
    []
  );

  return (
    <>
      <div className={styles.chrome}>
        <button
          aria-label="Back in preview"
          className={styles.control}
          disabled={history.index === 0}
          onClick={goBack}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={14} />
        </button>
        <button
          aria-label="Forward in preview"
          className={styles.control}
          disabled={history.index >= history.paths.length - 1}
          onClick={goForward}
          type="button"
        >
          <ArrowRight aria-hidden="true" size={14} />
        </button>
        <form className={styles.addressForm} onSubmit={navigate}>
          <input
            aria-invalid={navigationError.length > 0}
            aria-label="Preview project path"
            autoComplete="off"
            className={styles.address}
            maxLength={2048}
            onChange={changeAddress}
            spellCheck={false}
            title={
              locationNotice || "Enter a path in this project and press Enter"
            }
            value={address}
          />
        </form>
        <button
          aria-label={mobile ? "Show desktop preview" : "Show mobile preview"}
          aria-pressed={mobile}
          className={styles.control}
          onClick={toggleDevice}
          type="button"
        >
          {mobile ? (
            <Smartphone aria-hidden="true" size={14} />
          ) : (
            <Monitor aria-hidden="true" size={14} />
          )}
        </button>
        {openUrl && (
          <a
            aria-label="Open the preview in a new tab"
            className={styles.control}
            href={openUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={14} />
          </a>
        )}
        <button
          aria-label="Refresh preview"
          className={styles.control}
          onClick={refresh}
          type="button"
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="spin" size={14} />
          ) : (
            <RotateCw aria-hidden="true" size={14} />
          )}
        </button>
      </div>
      {navigationError && (
        <div className={styles.notice} role="alert">
          {navigationError}
        </div>
      )}
      {locationNotice && (
        <div className={styles.notice} role="status">
          {locationNotice}
        </div>
      )}
      {frameError && (
        <div className={styles.notice} role="alert">
          {frameError}{" "}
          <button className="panel-retry" onClick={refresh} type="button">
            Try again
          </button>
        </div>
      )}
      <div
        aria-busy={loading}
        className={styles.stage}
        data-mobile={mobile || undefined}
      >
        {source && (
          <iframe
            className={styles.frame}
            data-attempt={revision}
            key={revision}
            ref={frame}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={source}
            title="Generated app preview"
          />
        )}
      </div>
    </>
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

  if (preview.status === "failed" || preview.status === "stopped") {
    return (
      <div className="panel-state">
        {preview.detail ??
          (preview.status === "stopped"
            ? "The preview has stopped."
            : "The preview could not start.")}
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

  const root = previewRoot(
    preview.url,
    preview.previewId,
    window.location.origin
  );
  if (root === null) {
    return (
      <div className="panel-state">
        The preview address is invalid.
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
  return <ReadyPreview key={root} root={root} />;
}

export function Panel({
  buildSessionId,
  onClose,
  organizationId,
  projectId,
  refreshKey,
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
            key={`${buildSessionId}:${refreshKey ?? 0}`}
            organizationId={organizationId}
            projectId={projectId}
          />
        ) : (
          <FilesView
            buildSessionId={buildSessionId}
            organizationId={organizationId}
            projectId={projectId}
            refreshKey={refreshKey}
          />
        )}
      </div>
    </aside>
  );
}

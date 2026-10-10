"use client";

import type { ConversationMessage } from "@reasonateai/contracts/execution";
import {
  WorkspaceFileSchema,
  WorkspaceTreeSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  FolderClosed,
  Loader2,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Timeline } from "@/components/chat/timeline";
import { exportWorkspaceZip, request } from "@/lib/product-api";
import type { AgentPreviewSelection } from "./agent-preview";
import { FileContentPreview } from "./file-content";
import { FileTree } from "./file-tree";
import styles from "./panel.module.css";
import {
  formatSandboxPreviewAddress,
  movePreviewHistory,
  observedPreviewPath,
  type PreviewHistory,
  parseSandboxPreviewAddress,
  previewRoot,
  previewTransportUrl,
  recordPreviewPath,
  workspaceFilePath,
} from "./preview-path";
import {
  addWorkspaceTab,
  chooseWorkspaceView,
  closeWorkspaceTab,
  INITIAL_WORKSPACE_TABS,
  MAX_WORKSPACE_TABS,
  openWorkspaceView,
  parseWorkspaceTabs,
  type WorkspaceTabs,
  type WorkspaceView,
  workspaceTabsKey,
} from "./workspace-tabs";
import {
  ChangesView,
  NewWorkspaceTab,
  RunActivityView,
  WORKSPACE_VIEWS,
} from "./workspace-views";

/**
 * The workspace panel: what the agent actually produced.
 *
 * Files observes the current mutable sandbox and falls back to saved Git
 * checkpoints. Changes remains checkpoint-backed. Preview attaches to the
 * selected app port and survives ordinary run completion without remounting.
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
  source: "checkpoint" | "live";
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
  port: number | null;
  previewId: string;
  status: "failed" | "ready" | "starting" | "stopped";
  url: string;
}

export interface PanelProps {
  buildSessionId: string;
  messages: ConversationMessage[];
  newTabRequest: number;
  onClose: () => void;
  onNewTabHandled: () => void;
  organizationId: string;
  previewSelection?: AgentPreviewSelection | undefined;
  projectId: string;
  projectName?: string | undefined;
  refreshKey?: number | undefined;
  requestedView: "new" | "preview";
  timeline: Timeline;
  visible?: boolean | undefined;
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

function workspaceReadError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Could not read the workspace.";
}

const FileView = memo(function FileViewContent({
  file,
}: {
  file: FileResponse | null;
}) {
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
});

export function sanitizeDownloadFilename(rawName: string | undefined): string {
  const clean = (rawName ?? "project")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean || "project"}-source.zip`;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof window === "undefined" || !window.URL) {
    return;
  }
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
  }, 1000);
}

export const FilesView = memo(function FilesViewContent({
  buildSessionId,
  initialTree,
  organizationId,
  projectId,
  projectName,
  refreshKey,
  visible = true,
}: {
  buildSessionId: string;
  initialTree?: TreeResponse | null;
  organizationId: string;
  projectId: string;
  projectName?: string | undefined;
  refreshKey?: number | undefined;
  visible?: boolean | undefined;
}) {
  const [tree, setTree] = useState<TreeResponse | null>(initialTree ?? null);
  const [file, setFile] = useState<FileResponse | null>(null);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");
  const [loading, setLoading] = useState(initialTree === undefined);
  const [exporting, setExporting] = useState(false);

  const selectedPath = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  const load = useCallback(() => setRetry((value) => value + 1), []);

  const readSelectedFile = useCallback(
    async (result: TreeResponse, signal: AbortSignal) => {
      const path = result.files.some(
        (entry) => entry.kind === "file" && entry.path === selectedPath.current
      )
        ? selectedPath.current
        : result.files.find((entry) => entry.kind === "file")?.path;
      if (selectedPath.current !== (path ?? null)) {
        setFile(null);
      }
      selectedPath.current = path ?? null;
      if (!path) {
        setFile(null);
        return;
      }
      const content = await request(
        fileUrl(buildSessionId, organizationId, projectId, path),
        WorkspaceFileSchema.parse,
        { signal }
      );
      if (!signal.aborted && selectedPath.current === path) {
        setFile((previous) =>
          JSON.stringify(previous) === JSON.stringify(content)
            ? previous
            : content
        );
      }
    },
    [buildSessionId, organizationId, projectId]
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await request(
          treeUrl(buildSessionId, organizationId, projectId),
          WorkspaceTreeSchema.parse,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) {
          return;
        }
        setTree((previous) =>
          JSON.stringify(previous) === JSON.stringify(result)
            ? previous
            : result
        );
        await readSelectedFile(result, controller.signal);
        if (!controller.signal.aborted) {
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(workspaceReadError(cause));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(read, 2000);
        }
      }
    };
    read().catch(() => undefined);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    buildSessionId,
    organizationId,
    projectId,
    refreshKey,
    retry,
    visible,
    readSelectedFile,
  ]);

  const openFile = useCallback(
    (path: string) => {
      selectedPath.current = path;
      setFile(null);
      load();
    },
    [load]
  );
  const handleExport = useCallback(async () => {
    if (exporting) {
      return;
    }
    setExporting(true);
    setExportError("");
    try {
      const blob = await exportWorkspaceZip({
        buildSessionId,
        organizationId,
        projectId,
        projectName,
      });
      const filename = sanitizeDownloadFilename(projectName);
      triggerBlobDownload(blob, filename);
    } catch (cause) {
      setExportError(
        cause instanceof Error
          ? cause.message
          : "Could not export the workspace."
      );
    } finally {
      setExporting(false);
    }
  }, [buildSessionId, exporting, organizationId, projectId, projectName]);

  const dismissExportError = useCallback(() => {
    setExportError("");
  }, []);

  if (loading) {
    return (
      <div className="panel-state">
        <Loader2 aria-hidden="true" className="spin" size={15} /> Reading the
        project's workspace…
      </div>
    );
  }

  if (error.length > 0 && tree === null) {
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
        No files yet. Files appear here as the agent creates them.
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
        <button
          aria-label="Export ZIP"
          className={styles.exportButton}
          disabled={exporting}
          onClick={handleExport}
          title="Download Source"
          type="button"
        >
          {exporting ? (
            <Loader2 aria-hidden="true" className="spin" size={13} />
          ) : (
            <Download aria-hidden="true" size={13} />
          )}
          <span>{exporting ? "Exporting…" : "Export ZIP"}</span>
        </button>
      </div>
      {exportError ? (
        <div className={styles.exportErrorNotice} role="alert">
          <span>{exportError}</span>
          <button
            aria-label="Dismiss export error"
            className={styles.dismissExportError}
            onClick={dismissExportError}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="files">
        <div className="files-tree">
          <div className="files-meta" title={tree.commit}>
            {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
            {tree.source === "live"
              ? "Live workspace"
              : tree.commit.slice(0, 7)}
            {tree.truncated && " · File list limit reached"}
          </div>
          <FileTree
            entries={tree.files}
            onOpen={openFile}
            selected={file?.path ?? selectedPath.current ?? undefined}
          />
        </div>
        <div className="files-view">
          {error.length > 0 && (
            <div className="panel-state" role="status">
              {error}
              <button className="panel-retry" onClick={load} type="button">
                Try again
              </button>
            </div>
          )}
          <FileView file={file} />
        </div>
      </div>
    </>
  );
});

const ReadyPreview = memo(function ReadyPreviewContent({
  root,
  port,
  initialPath,
}: {
  root: string;
  port: number;
  initialPath: string;
}) {
  const [history, setHistory] = useState<PreviewHistory>({
    index: 0,
    paths: [initialPath],
  });
  const [framePath, setFramePath] = useState(initialPath);
  const [address, setAddress] = useState(
    formatSandboxPreviewAddress(port, initialPath)
  );
  const [navigationError, setNavigationError] = useState("");
  const [locationNotice, setLocationNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [frameError, setFrameError] = useState("");
  const [revision, setRevision] = useState(0);
  const [mobile, setMobile] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingPath = useRef<string | null>(initialPath);
  const currentPath = history.paths[history.index] ?? "/";
  const source = previewTransportUrl(root, framePath);
  const openUrl = previewTransportUrl(root, currentPath);

  useEffect(
    () => setAddress(formatSandboxPreviewAddress(port, currentPath)),
    [currentPath, port]
  );

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
      const path = parseSandboxPreviewAddress(address, port);
      if (path === null || previewTransportUrl(root, path) === null) {
        setNavigationError(
          `Enter a project path or this sandbox app URL on port ${port}. Other hosts and ports are unavailable.`
        );
        return;
      }
      setAddress(formatSandboxPreviewAddress(port, path));
      setHistory((previous) => recordPreviewPath(previous, path));
      loadPath(path);
    },
    [address, loadPath, port, root]
  );

  const move = useCallback(
    (delta: -1 | 1) => {
      const next = movePreviewHistory(history, delta);
      const path = next.paths.at(next.index);
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
      <div className="workspace-preview-address">
        <a
          href={openUrl ?? root}
          rel="noopener noreferrer"
          target="_blank"
          title={`Open sandbox app at ${formatSandboxPreviewAddress(port, currentPath)}`}
        >
          {formatSandboxPreviewAddress(port, currentPath)}
        </a>
        <span>Sandbox app</span>
      </div>
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
            aria-label="Sandbox app URL"
            autoComplete="off"
            className={styles.address}
            maxLength={2048}
            onChange={changeAddress}
            spellCheck={false}
            title={locationNotice || `Sandbox app address on port ${port}`}
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
});

const PreviewView = memo(function PreviewViewContent({
  buildSessionId,
  organizationId,
  projectId,
  runId,
  selectedPort,
  initialPath,
}: {
  buildSessionId: string;
  organizationId: string;
  projectId: string;
  runId: string | undefined;
  selectedPort: number | undefined;
  initialPath: string;
}) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [heartbeat, setHeartbeat] = useState(0);

  const start = useCallback(async () => {
    setStarting(true);
    setError("");
    if (!runId) {
      setError(
        "Ask the agent to open the running app with open_preview first."
      );
      setStarting(false);
      return;
    }
    try {
      const created = await request(
        `/v1/build-sessions/${buildSessionId}/preview?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`,
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
  }, [buildSessionId, organizationId, projectId, runId]);

  useEffect(() => {
    start().catch(() => undefined);
  }, [start]);

  // Poll while the relay is connecting. The API persists a run-scoped preview
  // lease and can reattach to the same sandbox after a process restart.
  useEffect(() => {
    if (
      preview === null ||
      (preview.status !== "starting" && preview.status !== "ready")
    ) {
      return;
    }
    const timer = setTimeout(
      () => {
        const read = async () => {
          try {
            const next = await request(
              `/v1/previews/${preview.previewId}/status`,
              (value) => value as PreviewResponse
            );
            setPreview((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next
            );
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not check the preview."
            );
          } finally {
            setHeartbeat((value) => value + 1);
          }
        };
        read().catch(() => undefined);
      },
      preview.status === "starting" ? 1500 : 30_000
    );
    return () => clearTimeout(timer);
  }, [preview, heartbeat]);

  if (error.length > 0 && preview?.status !== "ready") {
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
        <Loader2 aria-hidden="true" className="spin" size={15} /> Connecting to
        port {selectedPort ?? "—"} in this run sandbox…
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
  if (preview.port === null) {
    return (
      <div className="panel-state">The sandbox app port is unavailable.</div>
    );
  }
  return (
    <ReadyPreview
      initialPath={initialPath}
      key={`${root}:${initialPath}`}
      port={preview.port}
      root={root}
    />
  );
});

function AppPreviewContent(props: PanelProps) {
  const selection = props.previewSelection;
  return (
    <PreviewView
      buildSessionId={props.buildSessionId}
      initialPath={selection?.path ?? "/"}
      key={`${props.buildSessionId}:${selection?.runId ?? ""}:${selection?.port ?? ""}`}
      organizationId={props.organizationId}
      projectId={props.projectId}
      runId={selection?.runId}
      selectedPort={selection?.port}
    />
  );
}

function AppWorkspaceView(props: PanelProps) {
  const [view, setView] = useState<"preview" | "files" | "changes">("preview");
  const chooseView = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const next = event.currentTarget.value;
      if (next === "preview" || next === "files" || next === "changes") {
        setView(next);
      }
    },
    []
  );
  return (
    <>
      <fieldset
        aria-label="App preview views"
        className="workspace-preview-views"
      >
        <button
          aria-pressed={view === "preview"}
          onClick={chooseView}
          type="button"
          value="preview"
        >
          Preview
        </button>
        <button
          aria-pressed={view === "files"}
          onClick={chooseView}
          type="button"
          value="files"
        >
          Files
        </button>
        <button
          aria-pressed={view === "changes"}
          onClick={chooseView}
          type="button"
          value="changes"
        >
          Changes
        </button>
      </fieldset>
      <div className="workspace-tab-content" hidden={view !== "preview"}>
        <AppPreviewContent {...props} />
      </div>
      {view === "files" && (
        <FilesView
          buildSessionId={props.buildSessionId}
          organizationId={props.organizationId}
          projectId={props.projectId}
          projectName={props.projectName}
          refreshKey={props.refreshKey}
          visible={props.visible}
        />
      )}
      {view === "changes" && (
        <ChangesView scope={props} timeline={props.timeline} />
      )}
    </>
  );
}

function WorkspaceTabBody({
  tab,
  onChoose,
  ...props
}: PanelProps & {
  tab: { id: string; view: WorkspaceView };
  onChoose: (id: string, view: WorkspaceView) => void;
}) {
  const choose = useCallback(
    (view: WorkspaceView) => onChoose(tab.id, view),
    [onChoose, tab.id]
  );
  return <WorkspaceViewContent {...props} onChoose={choose} view={tab.view} />;
}

function WorkspaceViewContent({
  view,
  onChoose,
  ...props
}: PanelProps & {
  view: WorkspaceView;
  onChoose: (view: WorkspaceView) => void;
}) {
  switch (view) {
    case "preview":
      return <AppWorkspaceView {...props} />;
    case "files":
      return (
        <FilesView
          buildSessionId={props.buildSessionId}
          organizationId={props.organizationId}
          projectId={props.projectId}
          projectName={props.projectName}
          refreshKey={props.refreshKey}
          visible={props.visible}
        />
      );
    case "changes":
      return <ChangesView scope={props} timeline={props.timeline} />;
    case "activity":
      return (
        <RunActivityView messages={props.messages} timeline={props.timeline} />
      );
    default:
      return <NewWorkspaceTab onChoose={onChoose} />;
  }
}

export function Panel(props: PanelProps) {
  const { buildSessionId, organizationId, projectId } = props;
  const storageKey = workspaceTabsKey(
    organizationId,
    projectId,
    buildSessionId
  );
  const [state, setState] = useState(INITIAL_WORKSPACE_TABS);
  const [loaded, setLoaded] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (loaded) {
      setVisited((current) =>
        current.includes(state.activeId)
          ? current
          : [...current, state.activeId]
      );
    }
  }, [loaded, state.activeId]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let saved: WorkspaceTabs | undefined;
    try {
      saved = parseWorkspaceTabs(
        JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null")
      );
    } catch {
      saved = undefined;
    }
    setState(saved ?? INITIAL_WORKSPACE_TABS);
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) {
      return;
    }
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* Tabs still work when browser storage is unavailable. */
    }
  }, [loaded, state, storageKey]);
  useEffect(() => {
    if (!loaded || props.newTabRequest <= 0) {
      return;
    }
    setState((current) =>
      props.requestedView === "preview"
        ? openWorkspaceView(current, "preview", crypto.randomUUID())
        : addWorkspaceTab(current, crypto.randomUUID())
    );
    props.onNewTabHandled();
  }, [loaded, props.newTabRequest, props.requestedView, props.onNewTabHandled]);
  const newTab = useCallback(
    () => setState((current) => addWorkspaceTab(current, crypto.randomUUID())),
    []
  );
  const handleTabKeys = useCallback((event: React.KeyboardEvent) => {
    if (
      !(event.target instanceof HTMLElement) ||
      event.target.getAttribute("role") !== "tab"
    ) {
      return;
    }
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    );
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    let next = index;
    if (event.key === "ArrowRight") {
      next = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (index + tabs.length - 1) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  }, []);
  const selectTab = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.value;
      setState((current) => ({ ...current, activeId: id }));
    },
    []
  );
  const chooseTabView = useCallback(
    (id: string, view: WorkspaceView) =>
      setState((current) => chooseWorkspaceView(current, id, view)),
    []
  );
  const closeTab = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.value;
    setState((current) => closeWorkspaceTab(current, id));
  }, []);
  return (
    <aside aria-label="Conversation workspace" className="panel">
      <div className="panel-head workspace-tabs-head">
        <div
          aria-label="Workspace views"
          className="workspace-tab-strip"
          onKeyDown={handleTabKeys}
          ref={listRef}
          role="tablist"
        >
          {state.tabs.map((tab) => {
            const definition = WORKSPACE_VIEWS.find(
              (item) => item.view === tab.view
            );
            const Icon = definition?.icon ?? Plus;
            const title = definition?.title ?? "New tab";
            return (
              <div
                className="workspace-tab"
                data-active={state.activeId === tab.id || undefined}
                key={tab.id}
              >
                <button
                  aria-controls={`workspace-view-${tab.id}`}
                  aria-selected={state.activeId === tab.id}
                  className="workspace-tab-select"
                  id={`workspace-tab-${tab.id}`}
                  onClick={selectTab}
                  role="tab"
                  tabIndex={state.activeId === tab.id ? 0 : -1}
                  type="button"
                  value={tab.id}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span>{title}</span>
                </button>
                <button
                  aria-label={`Close ${title} tab`}
                  className="workspace-tab-close"
                  onClick={closeTab}
                  type="button"
                  value={tab.id}
                >
                  <X aria-hidden="true" size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          aria-label="New workspace tab"
          className="panel-close"
          disabled={
            state.tabs.length >= MAX_WORKSPACE_TABS &&
            !state.tabs.some((tab) => tab.view === "new")
          }
          onClick={newTab}
          title="New workspace tab"
          type="button"
        >
          <Plus aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Close the workspace panel"
          className="panel-close"
          onClick={props.onClose}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      <div className="panel-body">
        {loaded &&
          state.tabs.map((tab) => (
            <div
              aria-labelledby={`workspace-tab-${tab.id}`}
              className="workspace-tab-content"
              hidden={state.activeId !== tab.id}
              id={`workspace-view-${tab.id}`}
              key={tab.id}
              role="tabpanel"
            >
              {(state.activeId === tab.id || visited.includes(tab.id)) && (
                <WorkspaceTabBody
                  {...props}
                  onChoose={chooseTabView}
                  tab={tab}
                  visible={state.activeId === tab.id}
                />
              )}
            </div>
          ))}
      </div>
    </aside>
  );
}

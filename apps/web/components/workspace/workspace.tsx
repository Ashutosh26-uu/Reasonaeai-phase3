"use client";

import {
  type AccountProfile,
  AccountProfileSchema,
  ProjectListSchema,
  type ProjectSummary,
  ProjectViewSchema,
  type SessionView,
} from "@reasonateai/contracts/auth";
import type { PromptAttachment } from "@reasonateai/contracts/execution";
import {
  BuildSessionAllocationSchema,
  ConversationListSchema,
  type ConversationMessage,
  type ConversationSummary,
  ConversationTurnAcceptedSchema,
} from "@reasonateai/contracts/execution";
import {
  ConversationTranscriptSchema,
  RunAnswerAcceptedSchema,
  RunCancellationAcceptedSchema,
  type RunEventEnvelope,
} from "@reasonateai/contracts/execution-protocol";
import { RunSteeringAcceptedSchema } from "@reasonateai/contracts/steering";
import { FolderClosed, PanelRight, RefreshCw } from "lucide-react";
import Image from "next/image";
import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Composer } from "@/components/chat/composer";
import { EmptyState } from "@/components/chat/empty-state";
import { QuestionCard } from "@/components/chat/question-card";
import { runProgressLabel, runStreamEnded } from "@/components/chat/run-state";
import { pendingQuestion, projectTranscript } from "@/components/chat/timeline";
import { Transcript } from "@/components/chat/transcript";
import { useRunStream } from "@/components/chat/use-run-stream";
import { VoiceMode } from "@/components/chat/voice-mode";
import { Panel } from "@/components/workspace/panel";
import { Rail } from "@/components/workspace/rail";
import { Settings } from "@/components/workspace/settings";
import { describeError, request, scopeQuery } from "@/lib/product-api";

const DRAFT_LIMIT = 20_000;
const MODEL = "deepseek-flash";
const EMPTY_EVENTS: RunEventEnvelope[] = [];
const PANEL_WIDTH_STORAGE_KEY = "reasonateai-workspace-panel-width";
const DEFAULT_PANEL_WIDTH = 40;

function conversationHeading(
  conversation: ConversationSummary | undefined,
  selected: string
) {
  return (
    conversation?.title ?? (selected ? "Conversation" : "New conversation")
  );
}

function useWorkspacePanelResize() {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const workAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedWidth = Number(
      window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)
    );
    if (Number.isFinite(savedWidth) && savedWidth >= 25 && savedWidth <= 75) {
      setPanelWidth(savedWidth);
    }
  }, []);

  const setPanelWidthFromPointer = useCallback((clientX: number) => {
    const bounds = workAreaRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return null;
    }
    const panelPixels = bounds.right - clientX;
    const minPanelPercent = (320 / bounds.width) * 100;
    const maxPanelPercent =
      (Math.max(320, bounds.width - 370) / bounds.width) * 100;
    const nextWidth = Math.min(
      maxPanelPercent,
      Math.max(minPanelPercent, (panelPixels / bounds.width) * 100)
    );
    setPanelWidth(nextWidth);
    return nextWidth;
  }, []);

  const resizePanelByKeyboard = useCallback(
    (delta: number) => {
      const bounds = workAreaRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) {
        return;
      }
      const minWidth = (320 / bounds.width) * 100;
      const maxWidth = (Math.max(320, bounds.width - 370) / bounds.width) * 100;
      const nextWidth = Math.min(
        maxWidth,
        Math.max(minWidth, panelWidth + delta)
      );
      setPanelWidth(nextWidth);
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
    },
    [panelWidth]
  );
  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizePanelByKeyboard(2);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        resizePanelByKeyboard(-2);
      }
    },
    [resizePanelByKeyboard]
  );
  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanelWidthFromPointer(event.clientX);
    },
    [setPanelWidthFromPointer]
  );
  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        setPanelWidthFromPointer(event.clientX);
      }
    },
    [setPanelWidthFromPointer]
  );
  const onResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      const nextWidth = setPanelWidthFromPointer(event.clientX);
      if (nextWidth !== null) {
        window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
      }
    },
    [setPanelWidthFromPointer]
  );

  return {
    onResizeKeyDown,
    onResizePointerDown,
    onResizePointerMove,
    onResizePointerUp,
    panelWidth,
    workAreaRef,
  };
}

function collectProjectConversationResults(
  projectIds: string[],
  results: PromiseSettledResult<{
    conversations: ConversationSummary[];
    projectId: string;
  }>[]
) {
  const conversationsByProject: Record<
    string,
    ConversationSummary[] | undefined
  > = {};
  const failedProjectIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      conversationsByProject[result.value.projectId] =
        result.value.conversations;
    } else {
      const failedProjectId = projectIds[index];
      if (failedProjectId) {
        failedProjectIds.push(failedProjectId);
      }
    }
  }
  return { conversationsByProject, failedProjectIds };
}

function useProjectConversationIndex({
  loadProjectConversations,
  projects,
  setConversationsByProject,
  setError,
  setFailedConversationProjects,
}: {
  loadProjectConversations: (
    projectId: string
  ) => Promise<ConversationSummary[]>;
  projects: ProjectSummary[];
  setConversationsByProject: Dispatch<
    SetStateAction<Record<string, ConversationSummary[] | undefined>>
  >;
  setError: Dispatch<SetStateAction<string>>;
  setFailedConversationProjects: Dispatch<SetStateAction<string[]>>;
}) {
  useEffect(() => {
    let current = true;
    if (projects.length === 0) {
      setConversationsByProject({});
      setFailedConversationProjects([]);
      return () => {
        current = false;
      };
    }

    const requestedProjectIds = projects.map(
      (itemProject) => itemProject.projectId
    );
    Promise.allSettled(
      requestedProjectIds.map(async (requestedProjectId) => ({
        conversations: await loadProjectConversations(requestedProjectId),
        projectId: requestedProjectId,
      }))
    ).then((results) => {
      if (!current) {
        return;
      }
      const { conversationsByProject: next, failedProjectIds: failedProjects } =
        collectProjectConversationResults(requestedProjectIds, results);
      setConversationsByProject((existing) => {
        const merged = { ...existing, ...next };
        for (const failedProjectId of failedProjects) {
          delete merged[failedProjectId];
        }
        return merged;
      });
      setFailedConversationProjects(failedProjects);
      if (failedProjects.length > 0) {
        setError(
          "Some project conversations could not be loaded. Reload the workspace to retry."
        );
      }
    });

    return () => {
      current = false;
    };
  }, [
    loadProjectConversations,
    projects,
    setConversationsByProject,
    setError,
    setFailedConversationProjects,
  ]);
}

function ResizableWorkspacePanel({
  buildSessionId,
  isOpen,
  onClose,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  organizationId,
  panelWidth,
  projectId,
  workAreaRef,
}: {
  buildSessionId: string;
  isOpen: boolean;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLHRElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLHRElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLHRElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLHRElement>) => void;
  organizationId: string;
  panelWidth: number;
  projectId: string;
  workAreaRef: { current: HTMLDivElement | null };
}) {
  if (!isOpen) {
    return null;
  }
  const workAreaWidth = workAreaRef.current?.clientWidth ?? 0;
  const minPanelPercent =
    workAreaWidth > 0 ? Math.ceil((320 / workAreaWidth) * 100) : 30;
  const maxPanelPercent =
    workAreaWidth > 0
      ? Math.floor((Math.max(320, workAreaWidth - 370) / workAreaWidth) * 100)
      : 75;

  return (
    <>
      <hr
        aria-label="Resize chat and workspace"
        aria-orientation="vertical"
        aria-valuemax={maxPanelPercent}
        aria-valuemin={minPanelPercent}
        aria-valuenow={Math.round(panelWidth)}
        aria-valuetext={`${Math.round(panelWidth)} percent workspace width`}
        className="workspace-resize-handle"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        tabIndex={0}
      />
      <Panel
        buildSessionId={buildSessionId}
        onClose={onClose}
        organizationId={organizationId}
        projectId={projectId}
      />
    </>
  );
}

function hasVisibleWorkspacePanel(panelOpen: boolean, conversationId: string) {
  return panelOpen && conversationId.length > 0;
}

function readRoute() {
  if (typeof window === "undefined") {
    return { conversationId: "", projectId: "" };
  }
  const query = new URLSearchParams(window.location.search);
  return {
    conversationId: query.get("conversationId") ?? "",
    projectId: query.get("projectId") ?? "",
  };
}

function hasWorkspaceScope(
  organizationId: string,
  projectId: string,
  conversationId: string
): boolean {
  return Boolean(organizationId && projectId && conversationId);
}

function useAccountProfile() {
  const [profile, setProfile] = useState<AccountProfile | null>(null);

  useEffect(() => {
    request("/v1/auth/profile", AccountProfileSchema.parse)
      .then(setProfile)
      .catch(() => setProfile(null));
  }, []);

  return [profile, setProfile] as const;
}

function useRunSettlement({
  loadConversations,
  loadHistory,
  setNotice,
}: {
  loadConversations: () => Promise<ConversationSummary[]>;
  loadHistory: () => Promise<void>;
  setNotice: Dispatch<SetStateAction<string>>;
}) {
  return useCallback(
    async (buildSessionId: string, runId: string): Promise<void> => {
      const settle = async (attempt: number): Promise<void> => {
        const items = await loadConversations();
        // Terminal status commits after the saved checkpoint event. Read history
        // after that status so a racing earlier replay cannot omit the checkpoint.
        await loadHistory();
        const stillRunning = items.some(
          (item) =>
            item.buildSessionId === buildSessionId &&
            item.pendingRunId === runId
        );
        if (!stillRunning) {
          return;
        }
        if (attempt === 59) {
          setNotice(
            "The worker has not confirmed the run's final status yet. Refresh to check it."
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await settle(attempt + 1);
      };
      await settle(0);
    },
    [loadConversations, loadHistory, setNotice]
  );
}

function writeRoute(
  projectId: string,
  conversationId: string,
  replace = false
) {
  if (typeof window === "undefined") {
    return;
  }
  const query = new URLSearchParams();
  if (projectId) {
    query.set("projectId", projectId);
  }
  if (conversationId) {
    query.set("conversationId", conversationId);
  }
  const url = query.size ? `/?${query.toString()}` : "/";
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

const promptStarters = [
  "Build a simple app for my idea",
  "Help me shape a product plan",
  "Improve an existing project",
] as const;

export interface WorkspaceProps {
  onSignedOut: () => void;
  session: SessionView;
}

function ConversationHeader({
  conversationId,
  heading,
  onOpenPanel,
  onRefresh,
  projectName,
  selectedProject,
  working,
  settling,
  progressLabel,
}: {
  conversationId: string;
  heading: string;
  onOpenPanel: () => void;
  onRefresh: () => void;
  projectName: string;
  selectedProject: boolean;
  working: boolean;
  settling: boolean;
  progressLabel: string;
}) {
  return (
    <header className="pane-head">
      <div className="pane-titles">
        <div className="pane-title">{heading}</div>
        <div className="pane-meta">
          <span>{projectName}</span>
          <span aria-hidden="true">·</span>
          <span data-state={working ? "working" : "ready"}>
            {settling ? "Saving checkpoint…" : null}
            {!settling && (working ? progressLabel : "Ready")}
          </span>
        </div>
      </div>
      <div className="pane-tools">
        {selectedProject && (
          <button
            aria-label="Refresh conversation"
            className="pane-button pane-icon-button"
            onClick={onRefresh}
            title="Refresh conversation"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={18} />
          </button>
        )}
        {selectedProject && conversationId.length > 0 && (
          <button
            aria-label="Open workspace"
            className="pane-button pane-icon-button"
            onClick={onOpenPanel}
            title="Open workspace"
            type="button"
          >
            <PanelRight aria-hidden="true" size={18} />
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * The open workspace: the rail, the conversation, and the workspace panel.
 *
 * It owns the three levels the product is organized by — organization, project,
 * conversation — and follows the conversation's run over the product's own event
 * stream. Nothing here re-reads a conversation to discover that a run advanced:
 * the stream carries the transitions, and the store is re-read only for what a
 * stream cannot express, which is the conversation's own status.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the workspace coordinates the existing project, conversation, and stream state in one component
export function Workspace({ onSignedOut, session }: WorkspaceProps) {
  const [route] = useState(readRoute);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectName, setProjectName] = useState("");
  const [organizations, setOrganizations] = useState(session.organizations);
  const [accountProfile, setAccountProfile] = useAccountProfile();
  const [organizationId, setOrganizationId] = useState(
    initialOrganizationId(session)
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState(route.projectId);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsByProject, setConversationsByProject] = useState<
    Record<string, ConversationSummary[] | undefined>
  >({});
  const [failedConversationProjects, setFailedConversationProjects] = useState<
    string[]
  >([]);
  const [conversationId, setConversationId] = useState(route.conversationId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [history, setHistory] = useState<{
    identity: string;
    events: RunEventEnvelope[];
  }>({ events: [], identity: "" });
  const historyIdentity = `${organizationId}:${projectId}:${conversationId}`;
  const selectedHistory = useRef(historyIdentity);
  selectedHistory.current = historyIdentity;
  const historyRequest = useRef(0);
  const projectIdentity = `${organizationId}:${projectId}`;
  const selectedProjectIdentity = useRef(projectIdentity);
  selectedProjectIdentity.current = projectIdentity;
  const [draft, setDraft] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const steeringAttempt = useRef<{
    runId: string;
    message: string;
    key: string;
  } | null>(null);
  const retryAttempt = useRef<{ runId: string; key: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [queuePausedConversation, setQueuePausedConversation] = useState<
    string | null
  >(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [answering, setAnswering] = useState(false);
  const [answeredToolCallId, setAnsweredToolCallId] = useState<string | null>(
    null
  );
  const [panelOpen, setPanelOpen] = useState(
    () => route.conversationId.length > 0
  );
  const {
    onResizeKeyDown,
    onResizePointerDown,
    onResizePointerMove,
    onResizePointerUp,
    panelWidth,
    workAreaRef,
  } = useWorkspacePanelResize();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const active = conversations.find(
    (item) => item.buildSessionId === conversationId
  );
  const pendingRunId = active?.pendingRunId ?? null;

  useEffect(() => {
    if (pendingRunId === null) {
      setStoppingRunId(null);
      setNotice((current) => (current === "Stopping the run…" ? "" : current));
    }
  }, [pendingRunId]);

  const loadProjects = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    const result = await request(
      `/v1/projects?organizationId=${encodeURIComponent(organizationId)}`,
      (value) => ProjectListSchema.parse(value).projects
    );
    setProjects(result);
    setProjectId((selected) =>
      result.some((item) => item.projectId === selected)
        ? selected
        : (result[0]?.projectId ?? "")
    );
  }, [organizationId]);

  /**
   * The conversation a person last looked at, or the newest one. Opening a
   * project onto a blank "new conversation" pane while its work sits in the
   * rail reads as a reset rather than as a workspace.
   */
  const loadConversations = useCallback(async () => {
    if (!(organizationId && projectId)) {
      return [];
    }
    const result = await request(
      `/v1/projects/${projectId}/conversations?organizationId=${encodeURIComponent(organizationId)}`,
      (value) => ConversationListSchema.parse(value).conversations,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (selectedProjectIdentity.current !== `${organizationId}:${projectId}`) {
      return [];
    }
    setConversations(result);
    setConversationsByProject((current) => ({
      ...current,
      [projectId]: result,
    }));
    setFailedConversationProjects((current) =>
      current.filter((failedProjectId) => failedProjectId !== projectId)
    );
    setConversationId((selected) =>
      result.some((item) => item.buildSessionId === selected) ? selected : ""
    );
    return result;
  }, [organizationId, projectId]);

  const loadProjectConversations = useCallback(
    async (targetProjectId: string) =>
      await request(
        `/v1/projects/${targetProjectId}/conversations?organizationId=${encodeURIComponent(organizationId)}`,
        (value) => ConversationListSchema.parse(value).conversations
      ),
    [organizationId]
  );

  const loadHistory = useCallback(async () => {
    if (!hasWorkspaceScope(organizationId, projectId, conversationId)) {
      setMessages([]);
      return;
    }
    historyRequest.current += 1;
    const requestId = historyRequest.current;
    const result = await readHistory(
      `/v1/build-sessions/${conversationId}/messages?${scopeQuery(organizationId, projectId)}`,
      () =>
        selectedHistory.current === historyIdentity &&
        requestId === historyRequest.current
    );
    if (!result) {
      return;
    }
    const { events, messages: nextMessages } = result;
    setMessages(nextMessages);
    setHistory({ events, identity: historyIdentity });
  }, [conversationId, historyIdentity, organizationId, projectId]);

  useEffect(() => {
    loadProjects().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load projects."))
    );
  }, [loadProjects]);

  useProjectConversationIndex({
    loadProjectConversations,
    projects,
    setConversationsByProject,
    setError,
    setFailedConversationProjects,
  });

  useEffect(() => {
    setConversations([]);
    if (!projectId) {
      return;
    }
    loadConversations().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load conversations."))
    );
  }, [loadConversations, projectId]);

  useEffect(() => {
    loadHistory().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load messages."))
    );
  }, [loadHistory]);

  useEffect(() => {
    const onPopState = () => {
      setVoiceOpen(false);
      const next = readRoute();
      setProjectId(next.projectId);
      setConversationId(next.conversationId);
      setMessages([]);
      setPanelOpen((current) => current && next.conversationId.length > 0);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    writeRoute(projectId, conversationId, true);
  }, [projectId, conversationId]);

  const onInterrupted = useCallback((reason: string) => setNotice(reason), []);

  /**
   * A reconnect clears the interruption: the browser retries on its own, and a
   * notice that outlives the outage reports a state that is no longer true.
   */
  const onOpened = useCallback(() => {
    if (!stoppingRunId) {
      setNotice("");
    }
  }, [stoppingRunId]);

  /**
   * One committed message, keyed by the ledger event that recorded it — the same
   * identifier the conversation history reports it under, so a later reload
   * replaces this copy instead of repeating it.
   */

  /**
   * The terminal ledger event is written just before the run's status commits,
   * so the authoritative status is re-read until it agrees that the run ended.
   */
  const settle = useRunSettlement({
    loadConversations,
    loadHistory,
    setNotice,
  });

  const onEnded = useCallback(() => {
    if (!(conversationId && pendingRunId)) {
      return;
    }
    settle(conversationId, pendingRunId).catch((cause: unknown) =>
      setError(describeError(cause, "Could not read the run's outcome."))
    );
  }, [conversationId, pendingRunId, settle]);

  const { following, live, timeline } = useRunStream({
    active: active
      ? { buildSessionId: active.buildSessionId, pendingRunId }
      : undefined,
    historyEvents: visibleHistory(historyIdentity, history, messages).events,
    onEnded,
    onInterrupted,
    onOpened,
    organizationId,
    projectId,
  });
  // Streaming owns live text. A bounded, sequential reconciliation also checks
  // authoritative status so a missing terminal frame cannot strand Stop.
  useEffect(() => {
    if (!pendingRunId) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const interval = following && !stoppingRunId ? 15_000 : 5000;
    const reconcile = async () => {
      try {
        await loadConversations();
        if (disposed) {
          return;
        }
        await loadHistory();
        if (!disposed) {
          setNotice((current) =>
            current === "Could not refresh progress. Retrying…" ? "" : current
          );
        }
      } catch {
        if (!disposed) {
          setNotice("Could not refresh progress. Retrying…");
          console.warn(
            JSON.stringify({
              buildSessionId: conversationId,
              event: "run.reconciliation.failed",
              organizationId,
              projectId,
              runId: pendingRunId,
            })
          );
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(reconcile, interval);
        }
      }
    };
    timer = setTimeout(reconcile, interval);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    conversationId,
    following,
    loadConversations,
    loadHistory,
    organizationId,
    pendingRunId,
    projectId,
    stoppingRunId,
  ]);
  const question = pendingRunId
    ? pendingQuestion(timeline, pendingRunId)
    : undefined;
  const answerQuestion = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (
        !(
          question &&
          pendingRunId &&
          conversationId &&
          organizationId &&
          projectId
        )
      ) {
        return;
      }
      const answer = answerDraft.trim();
      if (!answer || answer.length > DRAFT_LIMIT) {
        return;
      }
      setAnswering(true);
      setError("");
      try {
        await request(
          `/v1/build-sessions/${conversationId}/runs/${pendingRunId}/answers?${scopeQuery(organizationId, projectId)}`,
          RunAnswerAcceptedSchema.parse,
          {
            body: JSON.stringify({ answer, toolCallId: question.toolCallId }),
            method: "POST",
          }
        );
        setAnsweredToolCallId(question.toolCallId);
        setAnswerDraft("");
      } catch (cause) {
        setError(describeError(cause, "Could not send your answer."));
      } finally {
        setAnswering(false);
      }
    },
    [
      answerDraft,
      conversationId,
      organizationId,
      pendingRunId,
      projectId,
      question,
    ]
  );
  const updateAnswerDraft = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setAnswerDraft(event.currentTarget.value);
    },
    []
  );

  const updateDraft = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.currentTarget.value);
    },
    []
  );

  const promptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    []
  );

  const acceptRun = useCallback(
    (
      accepted: Pick<ConversationSummary, "buildSessionId"> & {
        runId: ConversationSummary["latestRunId"];
        createdAt?: string;
      }
    ) => {
      if (
        selectedProjectIdentity.current !== `${organizationId}:${projectId}`
      ) {
        return;
      }
      const update = (existing: ConversationSummary[]) => {
        const previous = existing.find(
          (item) => item.buildSessionId === accepted.buildSessionId
        );
        const now = new Date().toISOString();
        const summary: ConversationSummary = {
          buildSessionId: accepted.buildSessionId,
          createdAt: previous?.createdAt ?? accepted.createdAt ?? now,
          latestRunId: accepted.runId,
          pendingRunId: accepted.runId,
          status: "ready",
          title: previous?.title ?? null,
          updatedAt: now,
        };
        return [
          summary,
          ...existing.filter(
            (item) => item.buildSessionId !== summary.buildSessionId
          ),
        ];
      };
      setConversations(update);
      setConversationsByProject((current) => ({
        ...current,
        [projectId]: update(current[projectId] ?? []),
      }));
      setQueuePausedConversation(null);
    },
    [organizationId, projectId]
  );

  const refreshAcceptedTurn = useCallback(async () => {
    try {
      await loadConversations();
      await loadHistory();
    } catch {
      setNotice("Message accepted. Reconnecting to its progress…");
    }
  }, [loadConversations, loadHistory]);

  const sendTurn = useCallback(
    async (
      message: string,
      attachments: PromptAttachment[] = [],
      requestId?: string
    ) => {
      setSubmitting(true);
      setError("");
      setNotice("");
      try {
        const idempotencyKey = requestId ?? crypto.randomUUID();
        if (conversationId) {
          const accepted = await request(
            `/v1/build-sessions/${conversationId}/turns?${scopeQuery(organizationId, projectId)}`,
            ConversationTurnAcceptedSchema.parse,
            {
              body: JSON.stringify({ attachments, message }),
              headers: { "idempotency-key": idempotencyKey },
              method: "POST",
            }
          );
          acceptRun(accepted);
        } else {
          const allocated = await request(
            "/v1/build-sessions",
            BuildSessionAllocationSchema.parse,
            {
              body: JSON.stringify({
                attachments,
                message,
                organizationId,
                projectId,
              }),
              headers: { "idempotency-key": idempotencyKey },
              method: "POST",
            }
          );
          setConversationId(allocated.buildSession.buildSessionId);
          acceptRun(allocated.buildSession);
        }
        await refreshAcceptedTurn();
        return true;
      } catch (cause) {
        setError(describeError(cause, "Could not send the message."));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [acceptRun, conversationId, refreshAcceptedTurn, organizationId, projectId]
  );

  const submitMessage = useCallback(
    async (input: {
      attachments: PromptAttachment[];
      message: string;
      requestId?: string;
      preserveDraft?: boolean;
    }) => {
      if (
        !(
          (input.message.length > 0 || input.attachments.length > 0) &&
          organizationId &&
          projectId
        )
      ) {
        return false;
      }
      const sent = await sendTurn(
        input.message,
        input.attachments,
        input.requestId
      );
      if (sent && !input.preserveDraft) {
        setDraft((current) =>
          current.trim() === input.message.trim() ? "" : current
        );
      }
      return sent;
    },
    [organizationId, projectId, sendTurn]
  );

  const steerMessage = useCallback(
    async (input: {
      message: string;
      attachments: PromptAttachment[];
      requestId?: string;
      targetRunId?: string;
    }): Promise<boolean> => {
      const targetRunId = input.targetRunId ?? pendingRunId;
      if (
        !(targetRunId && conversationId && organizationId && projectId) ||
        input.attachments.length ||
        !input.message.trim()
      ) {
        setError("Steering needs a text message and an active CTO run.");
        return false;
      }
      const previous = steeringAttempt.current;
      const key =
        input.requestId ??
        (previous?.runId === targetRunId && previous.message === input.message
          ? previous.key
          : crypto.randomUUID());
      steeringAttempt.current = {
        key,
        message: input.message,
        runId: targetRunId,
      };
      try {
        const result = await request(
          `/v1/build-sessions/${conversationId}/runs/${targetRunId}/steering?${scopeQuery(organizationId, projectId)}`,
          RunSteeringAcceptedSchema.parse,
          {
            body: JSON.stringify({ message: input.message }),
            headers: { "idempotency-key": key },
            method: "POST",
          }
        );
        steeringAttempt.current = null;
        if (result.status === "failed") {
          setError(
            "This steering message could not be delivered. Check the run before retrying."
          );
          return false;
        }
        setError("");
        setNotice("Steering requested. Delivery status appears in this turn.");
        return true;
      } catch (cause) {
        setError(describeError(cause, "Could not steer this run."));
        return false;
      }
    },
    [conversationId, organizationId, pendingRunId, projectId]
  );

  const retry = useCallback(
    async (text: string, sourceRunId?: string) => {
      if (!sourceRunId) {
        await sendTurn(text);
        return;
      }
      const key =
        retryAttempt.current?.runId === sourceRunId
          ? retryAttempt.current.key
          : crypto.randomUUID();
      retryAttempt.current = { key, runId: sourceRunId };
      setSubmitting(true);
      setError("");
      try {
        const accepted = await request(
          `/v1/build-sessions/${conversationId}/runs/${sourceRunId}/retry?${scopeQuery(organizationId, projectId)}`,
          ConversationTurnAcceptedSchema.parse,
          { headers: { "idempotency-key": key }, method: "POST" }
        );
        retryAttempt.current = null;
        acceptRun(accepted);
        await refreshAcceptedTurn();
      } catch (cause) {
        setError(describeError(cause, "Could not retry this generation."));
      } finally {
        setSubmitting(false);
      }
    },
    [
      acceptRun,
      conversationId,
      refreshAcceptedTurn,
      organizationId,
      projectId,
      sendTurn,
    ]
  );

  const stopRun = useCallback(async () => {
    if (!(conversationId && projectId && organizationId && pendingRunId)) {
      return;
    }
    setStoppingRunId(pendingRunId);
    setQueuePausedConversation(conversationId);
    setError("");
    setNotice("Stopping the run…");
    try {
      await request(
        `/v1/build-sessions/${conversationId}/runs/${pendingRunId}/cancel?${scopeQuery(organizationId, projectId)}`,
        RunCancellationAcceptedSchema.parse,
        { method: "POST" }
      );
      await settle(conversationId, pendingRunId);
    } catch (cause) {
      setStoppingRunId(null);
      setNotice("");
      setError(describeError(cause, "Could not stop the run."));
    }
  }, [conversationId, organizationId, pendingRunId, projectId, settle]);

  const openSideChat = useCallback(
    async (input: {
      message: string;
      attachments: PromptAttachment[];
      requestId?: string;
    }) => {
      // Open from the click before awaiting allocation, preserving browser gesture
      // permission. The current chat and its remaining queue stay selected.
      const side = window.open("about:blank", "_blank");
      if (!side) {
        setError("Allow a new tab to open the side chat, then retry.");
        return false;
      }
      side.opener = null;
      try {
        const allocated = await request(
          "/v1/build-sessions",
          BuildSessionAllocationSchema.parse,
          {
            body: JSON.stringify({
              attachments: input.attachments,
              message: input.message,
              organizationId,
              projectId,
            }),
            headers: {
              "idempotency-key": input.requestId ?? crypto.randomUUID(),
            },
            method: "POST",
          }
        );
        side.location.href = `/?${new URLSearchParams({ conversationId: allocated.buildSession.buildSessionId, projectId }).toString()}`;
        try {
          await loadConversations();
        } catch {
          setNotice(
            "Side chat created. Its progress will reconnect in the new tab."
          );
        }
        return true;
      } catch (cause) {
        side.close();
        setError(describeError(cause, "Could not open the side chat."));
        return false;
      }
    },
    [loadConversations, organizationId, projectId]
  );

  const editMessage = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => document.getElementById("prompt")?.focus());
  }, []);

  /**
   * Speech becomes a draft in the field, never a sent turn: a transcription is
   * a guess about what someone said, and the person is the one who decides it
   * is what they meant.
   */
  const transcribe = useCallback(
    (audio: Blob): Promise<string> => {
      const body = new FormData();
      body.append("audio", audio, "message.webm");
      return request(
        `/v1/voice/transcriptions?${scopeQuery(organizationId, projectId)}`,
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("text" in value) ||
            typeof value.text !== "string"
          ) {
            throw new Error(
              "The transcription service returned an invalid response."
            );
          }
          return value.text;
        },
        { body, method: "POST" }
      );
    },
    [organizationId, projectId]
  );

  const createProjectNamed = useCallback(
    async (name: string): Promise<boolean> => {
      if (!(organizationId && name.trim())) {
        return false;
      }
      setSubmitting(true);
      setError("");
      try {
        const created = await request(
          "/v1/projects",
          (value) => ProjectViewSchema.parse(value).projectId,
          {
            body: JSON.stringify({ name: name.trim(), organizationId }),
            method: "POST",
          }
        );
        await loadProjects();
        setProjectId(created);
        setConversationId("");
        setMessages([]);
        setProjectName("");
        setPanelOpen(false);
        writeRoute(created, "");
        return true;
      } catch (cause) {
        setError(describeError(cause, "Could not create the project."));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [loadProjects, organizationId]
  );

  const createProject = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await createProjectNamed(projectName);
    },
    [createProjectNamed, projectName]
  );

  const signOut = useCallback(async () => {
    await request("/v1/auth/session", (value) => value, { method: "DELETE" });
    onSignedOut();
  }, [onSignedOut]);

  const updateProjectName = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setProjectName(event.currentTarget.value);
    },
    []
  );

  const selectOrganization = useCallback((nextOrganizationId: string) => {
    setVoiceOpen(false);
    setOrganizationId(nextOrganizationId);
    setProjectId("");
    setConversationId("");
    setConversations([]);
    setConversationsByProject({});
    setFailedConversationProjects([]);
    setMessages([]);
    setPanelOpen(false);
  }, []);

  const selectProject = useCallback((nextProjectId: string) => {
    setVoiceOpen(false);
    setProjectId(nextProjectId);
    setConversationId("");
    setMessages([]);
    setPanelOpen(false);
    writeRoute(nextProjectId, "");
  }, []);

  const selectConversation = useCallback(
    (nextProjectId: string, nextConversationId: string) => {
      setVoiceOpen(false);
      setProjectId(nextProjectId);
      setConversationId(nextConversationId);
      setMessages([]);
      writeRoute(nextProjectId, nextConversationId);
    },
    []
  );

  const newConversation = useCallback(() => {
    setVoiceOpen(false);
    setConversationId("");
    setMessages([]);
    setDraft("");
    setNotice("");
    setPanelOpen(false);
    writeRoute(projectId, "");
    document.getElementById("prompt")?.focus();
  }, [projectId]);

  const newConversationForProject = useCallback((nextProjectId: string) => {
    setVoiceOpen(false);
    setProjectId(nextProjectId);
    setConversationId("");
    setMessages([]);
    setDraft("");
    setNotice("");
    setPanelOpen(false);
    writeRoute(nextProjectId, "");
    document.getElementById("prompt")?.focus();
  }, []);

  const refreshConversation = useCallback(() => {
    loadConversations().catch((cause: unknown) =>
      setError(describeError(cause, "Could not refresh the conversation."))
    );
    loadHistory().catch((cause: unknown) =>
      setError(describeError(cause, "Could not refresh the messages."))
    );
  }, [loadConversations, loadHistory]);

  const dismissError = useCallback(() => setError(""), []);
  const dismissNotice = useCallback(() => setNotice(""), []);
  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openVoice = useCallback(() => setVoiceOpen(true), []);
  const closeVoice = useCallback(() => setVoiceOpen(false), []);
  const renameOrganization = useCallback(
    (name: string) => {
      setOrganizations((current) =>
        current.map((item) =>
          item.organizationId === organizationId ? { ...item, name } : item
        )
      );
      loadProjects().catch(() => undefined);
    },
    [loadProjects, organizationId]
  );

  const selectStarter = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      setDraft(event.currentTarget.value);
      document.getElementById("prompt")?.focus();
    },
    []
  );

  /**
   * The files a mention can point at: the project's latest checkpoint, read
   * through the same route the workspace panel uses. A mention is the path of a
   * real file, so the agent reads what the person pointed at rather than a name
   * they guessed at.
   */
  const listFiles = useCallback(async (): Promise<string[]> => {
    if (!hasWorkspaceScope(organizationId, projectId, conversationId)) {
      return [];
    }
    const tree = await request(
      `/v1/build-sessions/${conversationId}/workspace/tree?${scopeQuery(organizationId, projectId)}`,
      (value) => value as { files: { kind: string; path: string }[] }
    );
    return tree.files
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path);
  }, [conversationId, organizationId, projectId]);

  const selectedProject = projects.some((item) => item.projectId === projectId);
  const activeRunEvents = Object.values(
    timeline.runs[pendingRunId ?? active?.latestRunId ?? ""]?.events ?? {}
  );
  const streamEnded = runStreamEnded(
    activeRunEvents,
    stoppingRunId === pendingRunId
  );
  const working = pendingRunId !== null && !streamEnded;
  const savingStoppedRun = pendingRunId !== null && streamEnded;
  let progressLabel = runProgressLabel(activeRunEvents);
  if (question) {
    progressLabel = "Waiting for your answer";
  }
  if (stoppingRunId === pendingRunId && pendingRunId !== null) {
    progressLabel = "Stopping…";
  }
  const composer = (
    <Composer
      busy={submitting || savingStoppedRun}
      count={draft.length}
      draft={draft}
      hasConversation={conversationId.length > 0}
      key={`${organizationId}:${projectId}:${conversationId}`}
      limit={DRAFT_LIMIT}
      listFiles={listFiles}
      model={MODEL}
      onChange={updateDraft}
      onCreateProject={createProjectNamed}
      onKeyDown={promptKeyDown}
      onOpenSideChat={openSideChat}
      onProjectSelect={selectProject}
      onSteer={steerMessage}
      onStop={stopRun}
      onSubmit={submitMessage}
      onTranscribe={transcribe}
      onVoiceMode={openVoice}
      pending={working || !selectedProject}
      pendingRunId={pendingRunId}
      placeholder={
        selectedProject
          ? "Describe the product, or the change you want next…"
          : "Choose a project first…"
      }
      preventAutoQueueDispatch={
        queuePausedConversation === conversationId ||
        active?.status === "failed" ||
        active?.status === "cancelled" ||
        activeRunEvents.some(
          (event) =>
            (event.type === "run.failed" || event.type === "run.cancelled") &&
            typeof event.payload.outcome === "string"
        )
      }
      projectId={projectId}
      projectPickerDisabled={working || submitting}
      projects={projects}
      queueScopeKey={historyIdentity}
      stopping={pendingRunId !== null && stoppingRunId === pendingRunId}
    />
  );
  const questionForm =
    question &&
    !streamEnded &&
    stoppingRunId !== pendingRunId &&
    answeredToolCallId !== question.toolCallId ? (
      <QuestionCard
        busy={answering}
        key={question.toolCallId}
        limit={DRAFT_LIMIT}
        onChange={updateAnswerDraft}
        onSubmit={answerQuestion}
        question={question.question}
        value={answerDraft}
      />
    ) : null;
  const emptyConversation =
    messages.length === 0 && Object.keys(timeline.runs).length === 0;
  const heading = conversationHeading(active, conversationId);
  const project = projects.find((item) => item.projectId === projectId);
  const renderedMessages = visibleHistory(
    historyIdentity,
    history,
    messages
  ).messages;
  const completedVoiceTurn = projectTranscript(timeline, renderedMessages)
    .filter((turn) =>
      Object.values(timeline.runs[turn.id]?.events ?? {}).some(
        (event) =>
          event.type === "run.completed" &&
          event.payload.outcome === "succeeded"
      )
    )
    .at(-1);
  const voiceResponseText =
    completedVoiceTurn?.entries
      .filter((entry) => entry.kind === "text" && !entry.streaming)
      .map((entry) => (entry.kind === "text" ? entry.text : ""))
      .join("\n\n") ?? "";
  const voiceResponse =
    completedVoiceTurn && voiceResponseText
      ? { id: completedVoiceTurn.id, text: voiceResponseText }
      : null;
  const organizationName =
    organizations.find((item) => item.organizationId === organizationId)
      ?.name ?? "This workspace";
  const organizationRole =
    organizations.find((item) => item.organizationId === organizationId)
      ?.role ?? "viewer";
  const showWorkspacePanel = hasVisibleWorkspacePanel(
    panelOpen,
    conversationId
  );

  return (
    <div className="app" data-stopping-run={stoppingRunId || undefined}>
      <Rail
        accountEmail={accountProfile?.email ?? ""}
        accountName={accountProfile?.displayName ?? ""}
        conversationId={conversationId}
        conversationsByProject={conversationsByProject}
        draftProjectName={projectName}
        errorMessage={error}
        failedConversationProjects={failedConversationProjects}
        onConversationSelect={selectConversation}
        onNewConversation={newConversation}
        onNewConversationForProject={newConversationForProject}
        onOrganizationSelect={selectOrganization}
        onProjectNameChange={updateProjectName}
        onProjectSelect={selectProject}
        onProjectSubmit={createProject}
        onSettings={openSettings}
        onSignOut={signOut}
        organizationId={organizationId}
        organizations={organizations}
        projectId={projectId}
        projects={projects}
        submitting={submitting}
      />

      <div
        className="work-area"
        data-panel={showWorkspacePanel || undefined}
        ref={workAreaRef}
        style={{ "--workspace-panel-width": `${panelWidth}%` } as CSSProperties}
      >
        <main className="pane">
          <ConversationHeader
            conversationId={conversationId}
            heading={heading}
            onOpenPanel={openPanel}
            onRefresh={refreshConversation}
            progressLabel={progressLabel}
            projectName={project?.name ?? "No project selected"}
            selectedProject={selectedProject}
            settling={savingStoppedRun}
            working={working}
          />

          {error.length > 0 && (
            <div className="banner is-error" role="alert">
              <span>{error}</span>
              <button onClick={dismissError} type="button">
                Dismiss
              </button>
            </div>
          )}
          {notice.length > 0 && (
            <div className="banner" role="status">
              <span>{notice}</span>
              <button onClick={dismissNotice} type="button">
                Dismiss
              </button>
            </div>
          )}

          <div className="pane-body">
            {selectedProject && voiceOpen ? (
              <VoiceMode
                busy={working || submitting}
                disabled={questionForm !== null}
                key={`${organizationId}:${projectId}`}
                onClose={closeVoice}
                onStop={stopRun}
                onSubmit={sendTurn}
                onTranscribe={transcribe}
                projectName={project?.name ?? "Your project"}
                question={questionForm}
                response={voiceResponse}
              />
            ) : null}
            {selectedProject && !voiceOpen && (
              <ConversationPane
                checkpointScope={{
                  buildSessionId: conversationId,
                  organizationId,
                  projectId,
                }}
                composer={composer}
                empty={emptyConversation}
                live={live}
                messages={
                  visibleHistory(historyIdentity, history, messages).messages
                }
                onEdit={editMessage}
                onRetry={retry}
                onStarter={selectStarter}
                pending={working}
                questionForm={questionForm}
                starters={promptStarters}
                timeline={timeline}
              />
            )}
            {!selectedProject && (
              <EmptyState
                mark={<FolderClosed aria-hidden="true" size={26} />}
                onStarter={selectStarter}
                pending={false}
                starters={[]}
              >
                <p className="empty-note">
                  Create or select a project in the rail to open its CTO
                  workspace.
                </p>
              </EmptyState>
            )}
          </div>
        </main>

        <ResizableWorkspacePanel
          buildSessionId={conversationId}
          isOpen={showWorkspacePanel}
          onClose={closePanel}
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          organizationId={organizationId}
          panelWidth={panelWidth}
          projectId={projectId}
          workAreaRef={workAreaRef}
        />
      </div>

      {settingsOpen && (
        <Settings
          onClose={closeSettings}
          onProfileUpdated={setAccountProfile}
          onRenamed={renameOrganization}
          onSignOut={signOut}
          organizationId={organizationId}
          organizationName={organizationName}
          organizationRole={organizationRole}
          projectCount={projects.length}
          session={session}
        />
      )}
    </div>
  );
}

/**
 * A conversation with a project behind it: the prompt alone when nothing has
 * happened yet, and the transcript with the composer docked under it otherwise.
 */
function ConversationPane({
  checkpointScope,
  composer,
  questionForm,
  empty,
  live,
  messages,
  onEdit,
  onRetry,
  onStarter,
  pending,
  starters,
  timeline,
}: {
  checkpointScope: {
    buildSessionId: string;
    organizationId: string;
    projectId: string;
  };
  composer: React.ReactNode;
  questionForm: React.ReactNode;
  empty: boolean;
  live: boolean;
  messages: ConversationMessage[];
  onEdit: (text: string) => void;
  onRetry: (text: string, sourceRunId?: string) => void;
  onStarter: (event: React.MouseEvent<HTMLButtonElement>) => void;
  pending: boolean;
  starters: readonly string[];
  timeline: Parameters<typeof Transcript>[0]["timeline"];
}) {
  if (empty) {
    return (
      <EmptyState
        mark={
          <Image
            alt=""
            height={40}
            src="/brand/reasonateai-icon.png"
            width={40}
          />
        }
        onStarter={onStarter}
        pending={pending}
        starters={starters}
      >
        {questionForm}
        {composer}
      </EmptyState>
    );
  }

  return (
    <>
      <Transcript
        checkpointScope={checkpointScope}
        live={live}
        messages={messages}
        onEdit={onEdit}
        onRetry={onRetry}
        pending={pending}
        timeline={timeline}
      />
      <div className="composer-dock">
        {questionForm}
        {composer}
      </div>
    </>
  );
}

async function readHistory(
  url: string,
  isCurrent: () => boolean
): Promise<
  { events: RunEventEnvelope[]; messages: ConversationMessage[] } | undefined
> {
  const events: RunEventEnvelope[] = [];
  let after: number | null = 0;
  let messages: ConversationMessage[] = [];
  while (after !== null) {
    const result: ReturnType<typeof ConversationTranscriptSchema.parse> =
      // biome-ignore lint/performance/noAwaitInLoops: each page depends on the previous cursor
      await request(
        `${url}&after=${after}`,
        ConversationTranscriptSchema.parse,
        { signal: AbortSignal.timeout(10_000) }
      );
    if (!isCurrent()) {
      return;
    }
    events.push(...result.events);
    ({ messages } = result);
    after = result.nextAfter;
  }
  return { events, messages };
}

function initialOrganizationId(session: SessionView): string {
  return session.organizations[0]?.organizationId ?? "";
}
function visibleHistory(
  identity: string,
  history: { identity: string; events: RunEventEnvelope[] },
  messages: ConversationMessage[]
) {
  return identity === history.identity
    ? { events: history.events, messages }
    : { events: EMPTY_EVENTS, messages: [] };
}

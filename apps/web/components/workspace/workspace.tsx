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
import { FolderClosed, PanelRight, RefreshCw } from "lucide-react";
import Image from "next/image";
import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Composer } from "@/components/chat/composer";
import { EmptyState } from "@/components/chat/empty-state";
import { pendingQuestion } from "@/components/chat/timeline";
import { Transcript } from "@/components/chat/transcript";
import { useRunStream } from "@/components/chat/use-run-stream";
import { Panel } from "@/components/workspace/panel";
import { Rail } from "@/components/workspace/rail";
import { Settings } from "@/components/workspace/settings";
import { describeError, request, scopeQuery } from "@/lib/product-api";

const DRAFT_LIMIT = 20_000;
const MODEL = "deepseek-flash";
const EMPTY_EVENTS: RunEventEnvelope[] = [];
const PANEL_WIDTH_STORAGE_KEY = "reasonateai-workspace-panel-width";
const DEFAULT_PANEL_WIDTH = 40;

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
        const [items] = await Promise.all([loadConversations(), loadHistory()]);
        const stillRunning = items.some(
          (item) =>
            item.buildSessionId === buildSessionId &&
            item.pendingRunId === runId
        );
        if (!stillRunning) {
          return;
        }
        if (attempt === 9) {
          setNotice(
            "The run finished, but its status has not settled yet. Refresh to read it."
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
}: {
  conversationId: string;
  heading: string;
  onOpenPanel: () => void;
  onRefresh: () => void;
  projectName: string;
  selectedProject: boolean;
  working: boolean;
}) {
  return (
    <header className="pane-head">
      <div className="pane-titles">
        <div className="pane-title">{heading}</div>
        <div className="pane-meta">
          <span>{projectName}</span>
          <span aria-hidden="true">·</span>
          <span data-state={working ? "working" : "ready"}>
            {working ? "Working" : "Ready"}
          </span>
        </div>
      </div>
      <div className="pane-tools">
        {selectedProject && (
          <button className="pane-button" onClick={onRefresh} type="button">
            <RefreshCw size={14} /> Refresh
          </button>
        )}
        {selectedProject && conversationId.length > 0 && (
          <button className="pane-button" onClick={onOpenPanel} type="button">
            <PanelRight size={14} /> Workspace
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
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
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
      (value) => ConversationListSchema.parse(value).conversations
    );
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
  const onOpened = useCallback(() => setNotice(""), []);

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

  const { live, timeline } = useRunStream({
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
  const submitDecision = useCallback(
    async (decision: "APPROVED" | "REJECTED") => {
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
      setAnswering(true);
      setError("");
      try {
        await request(
          `/v1/build-sessions/${conversationId}/runs/${pendingRunId}/answers?${scopeQuery(organizationId, projectId)}`,
          RunAnswerAcceptedSchema.parse,
          {
            body: JSON.stringify({
              answer: JSON.stringify({ decision }),
              toolCallId: question.toolCallId,
            }),
            method: "POST",
          }
        );
        setAnsweredToolCallId(question.toolCallId);
      } catch (cause) {
        setError(describeError(cause, "Could not send your decision."));
      } finally {
        setAnswering(false);
      }
    },
    [conversationId, organizationId, pendingRunId, projectId, question]
  );
  const submitDecisionApprove = useCallback(() => {
    submitDecision("APPROVED").catch(() => undefined);
  }, [submitDecision]);
  const submitDecisionReject = useCallback(() => {
    submitDecision("REJECTED").catch(() => undefined);
  }, [submitDecision]);

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

  const sendTurn = useCallback(
    async (message: string, attachments: PromptAttachment[] = []) => {
      setSubmitting(true);
      setError("");
      setNotice("");
      try {
        const idempotencyKey = crypto.randomUUID();
        if (conversationId) {
          await request(
            `/v1/build-sessions/${conversationId}/turns?${scopeQuery(organizationId, projectId)}`,
            ConversationTurnAcceptedSchema.parse,
            {
              body: JSON.stringify({ attachments, message }),
              headers: { "idempotency-key": idempotencyKey },
              method: "POST",
            }
          );
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
        }
        await loadConversations();
        await loadHistory();
        return true;
      } catch (cause) {
        setError(describeError(cause, "Could not send the message."));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [conversationId, loadConversations, loadHistory, organizationId, projectId]
  );

  const submitMessage = useCallback(
    async (input: { attachments: PromptAttachment[]; message: string }) => {
      if (
        !(
          (input.message.length > 0 || input.attachments.length > 0) &&
          organizationId &&
          projectId
        )
      ) {
        return false;
      }
      const sent = await sendTurn(input.message, input.attachments);
      if (sent) {
        setDraft("");
      }
      return sent;
    },
    [organizationId, projectId, sendTurn]
  );

  const retry = useCallback(
    async (text: string) => {
      await sendTurn(text);
    },
    [sendTurn]
  );

  const stopRun = useCallback(async () => {
    if (!(conversationId && projectId && organizationId && pendingRunId)) {
      return;
    }
    setStoppingRunId(pendingRunId);
    setError("");
    setNotice("Stopping the run…");
    try {
      await request(
        `/v1/build-sessions/${conversationId}/runs/${pendingRunId}/cancel?${scopeQuery(organizationId, projectId)}`,
        RunCancellationAcceptedSchema.parse,
        { method: "POST" }
      );
    } catch (cause) {
      setStoppingRunId(null);
      setNotice("");
      setError(describeError(cause, "Could not stop the run."));
    }
  }, [conversationId, organizationId, pendingRunId, projectId]);

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
    async (audio: Blob): Promise<string> => {
      const body = new FormData();
      body.append("audio", audio, "message.webm");
      const response = await fetch(
        `/v1/voice/transcriptions?${scopeQuery(organizationId, projectId)}`,
        { body, credentials: "same-origin", method: "POST" }
      );
      const payload = (await response.json()) as {
        error?: { message?: string };
        text?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error?.message ?? "Could not transcribe that recording."
        );
      }
      return payload.text ?? "";
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
    setProjectId(nextProjectId);
    setConversationId("");
    setMessages([]);
    setPanelOpen(false);
    writeRoute(nextProjectId, "");
  }, []);

  const selectConversation = useCallback(
    (nextProjectId: string, nextConversationId: string) => {
      setProjectId(nextProjectId);
      setConversationId(nextConversationId);
      setMessages([]);
      writeRoute(nextProjectId, nextConversationId);
    },
    []
  );

  const newConversation = useCallback(() => {
    setConversationId("");
    setMessages([]);
    setDraft("");
    setNotice("");
    setPanelOpen(false);
    writeRoute(projectId, "");
    document.getElementById("prompt")?.focus();
  }, [projectId]);

  const newConversationForProject = useCallback((nextProjectId: string) => {
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
  const working = pendingRunId !== null;
  const composer = (
    <Composer
      busy={submitting}
      count={draft.length}
      draft={draft}
      limit={DRAFT_LIMIT}
      listFiles={listFiles}
      model={MODEL}
      onChange={updateDraft}
      onCreateProject={createProjectNamed}
      onKeyDown={promptKeyDown}
      onProjectSelect={selectProject}
      onStop={stopRun}
      onSubmit={submitMessage}
      onTranscribe={transcribe}
      pending={working || !selectedProject}
      placeholder={
        selectedProject
          ? "Describe the product, or the change you want next…"
          : "Choose a project first…"
      }
      projectId={projectId}
      projectPickerDisabled={working || submitting}
      projects={projects}
      stopping={stoppingRunId === pendingRunId}
    />
  );
  let questionForm: ReactNode = null;
  if (question && answeredToolCallId !== question.toolCallId) {
    if (question.toolName === "request_access") {
      const payload = question.suspendPayload as {
        resource?: string;
        reason?: string;
      };
      questionForm = (
        <div className="question-form approval-card">
          <h4>Access Request</h4>
          <p>
            <strong>Resource:</strong> {payload.resource}
          </p>
          <p>
            <strong>Reason:</strong> {payload.reason}
          </p>
          <div className="approval-actions">
            <button
              disabled={answering}
              onClick={submitDecisionApprove}
              type="button"
            >
              {answering ? "Sending…" : "Approve"}
            </button>
            <button
              disabled={answering}
              onClick={submitDecisionReject}
              type="button"
            >
              {answering ? "Sending…" : "Reject"}
            </button>
          </div>
        </div>
      );
    } else if (question.toolName === "submit_plan") {
      const payload = question.suspendPayload as {
        title?: string;
        summary?: string;
        steps?: string[];
      };
      questionForm = (
        <div className="question-form approval-card">
          <h4>Plan Review: {payload.title}</h4>
          <p>
            <strong>Summary:</strong> {payload.summary}
          </p>
          {payload.steps && (
            <ul>
              {payload.steps.map((step, idx) => (
                <li key={idx}>{step}</li>
              ))}
            </ul>
          )}
          <div className="approval-actions">
            <button
              disabled={answering}
              onClick={submitDecisionApprove}
              type="button"
            >
              {answering ? "Sending…" : "Approve Plan"}
            </button>
            <button
              disabled={answering}
              onClick={submitDecisionReject}
              type="button"
            >
              {answering ? "Sending…" : "Reject Plan"}
            </button>
          </div>
        </div>
      );
    } else {
      questionForm = (
        <form className="question-form" onSubmit={answerQuestion}>
          <label htmlFor="question-answer">{question.question}</label>
          <textarea
            id="question-answer"
            maxLength={DRAFT_LIMIT}
            onChange={updateAnswerDraft}
            value={answerDraft}
          />
          <button
            disabled={answering || answerDraft.trim().length === 0}
            type="submit"
          >
            {answering ? "Sending…" : "Send answer"}
          </button>
        </form>
      );
    }
  }
  const emptyConversation =
    messages.length === 0 && Object.keys(timeline.runs).length === 0;
  const heading =
    active?.title ?? (conversationId ? "Conversation" : "New conversation");
  const project = projects.find((item) => item.projectId === projectId);
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
    <div className="app">
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
            projectName={project?.name ?? "No project selected"}
            selectedProject={selectedProject}
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
            {selectedProject ? (
              <ConversationPane
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
            ) : (
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
  composer: React.ReactNode;
  questionForm: React.ReactNode;
  empty: boolean;
  live: boolean;
  messages: ConversationMessage[];
  onEdit: (text: string) => void;
  onRetry: (text: string) => void;
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
        ConversationTranscriptSchema.parse
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

"use client";

import {
  CreateOrganizationResponseSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
  ProjectListSchema,
  ProjectViewSchema,
  SessionViewSchema,
} from "@reasonateai/contracts/auth";
import {
  BuildSessionAllocationSchema,
  ConversationHistorySchema,
  ConversationListSchema,
  ConversationTurnAcceptedSchema,
} from "@reasonateai/contracts/execution";
import { Button } from "@reasonateai/ui/components/button";
import {
  ArrowUp,
  CirclePlus,
  FolderClosed,
  LogOut,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import "./product.css";

type Session = ReturnType<typeof SessionViewSchema.parse>;
type Project = ReturnType<typeof ProjectListSchema.parse>["projects"][number];
type ConversationItem = ReturnType<
  typeof ConversationListSchema.parse
>["conversations"][number];
type ChatMessage = ReturnType<
  typeof ConversationHistorySchema.parse
>["messages"][number];

function csrfToken(): string | undefined {
  const cookie = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return cookie
    ? decodeURIComponent(cookie.slice(CSRF_COOKIE.length + 1))
    : undefined;
}

async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {}
): Promise<T> {
  const csrf = csrfToken();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(csrf && init.method && init.method !== "GET"
        ? { [CSRF_HEADER]: csrf }
        : {}),
      ...init.headers,
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new Error("The product API is unavailable.", { cause });
  }
  if (!response.ok) {
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        throw new ApiRequestError(response.status, error.message);
      }
    }
    throw new ApiRequestError(
      response.status,
      `Request failed (${response.status}).`
    );
  }
  return parse(body);
}

class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

const scopeQuery = (organizationId: string, projectId: string) =>
  `organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const promptStarters = [
  "Build a simple app for my idea",
  "Help me shape a product plan",
  "Improve an existing project",
] as const;

const asciiField = Array.from({ length: 25 }, (_rowCell, row) =>
  Array.from({ length: 97 }, (_columnCell, column) => {
    const x = (column - 48) / 48;
    const y = (row - 12) / 12;
    const distance = Math.sqrt(x * x * 0.73 + y * y);
    const contour = Math.sin(distance * 24 - x * 7 + Math.sin(y * 9) * 1.5);
    const light = Math.cos(x * 16 + y * 9) * Math.sin(y * 12 - x * 4);
    if (distance > 1.03 || contour + light * 0.36 < 0.13) {
      return " ";
    }
    if (contour > 0.78) {
      return "+";
    }
    if (contour > 0.44) {
      return ":";
    }
    return ".";
  }).join("")
).join("\n");

function AsciiField() {
  return (
    <pre aria-hidden="true" className="ascii-field">
      {asciiField}
    </pre>
  );
}

function EmptyWorkspace({
  conversationId,
  onStarter,
  pending,
}: {
  conversationId: string;
  onStarter: (event: React.MouseEvent<HTMLButtonElement>) => void;
  pending: boolean;
}) {
  return (
    <div className="chat-conversation empty-conversation">
      <div className="chat-empty">
        <AsciiField />
        <div className="empty-index">REASONATE / 001</div>
        <h2>
          {conversationId
            ? "The conversation is ready."
            : "Let’s make it real."}
        </h2>
        <p>
          Tell your CTO what you want to build. Start with a rough idea or a
          specific change; the work stays with this project.
        </p>
        <div className="prompt-starters">
          {promptStarters.map((starter) => (
            <button
              key={starter}
              onClick={onStarter}
              type="button"
              value={starter}
            >
              <Sparkles aria-hidden="true" size={13} />
              {starter}
              <ArrowUp aria-hidden="true" size={13} />
            </button>
          ))}
        </div>
        {pending && (
          <div className="run-status" role="status">
            <span className="pulse-dot" /> CTO is working in the sandbox…
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectButton({
  item,
  selected,
  onSelect,
}: {
  item: Project;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const choose = useCallback(
    () => onSelect(item.projectId),
    [item.projectId, onSelect]
  );
  return (
    <button
      className={`sidebar-item ${selected ? "selected" : ""}`}
      onClick={choose}
      type="button"
    >
      <FolderClosed size={15} />
      {item.name}
    </button>
  );
}

function ConversationButton({
  item,
  selected,
  onSelect,
}: {
  item: ConversationItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const choose = useCallback(
    () => onSelect(item.buildSessionId),
    [item.buildSessionId, onSelect]
  );
  return (
    <button
      className={`sidebar-item conversation-item ${selected ? "selected" : ""}`}
      onClick={choose}
      type="button"
    >
      <span className="conversation-name">
        {item.title || "Untitled conversation"}
      </span>
      {item.pendingRunId && (
        <span className="live-dot" title="Run in progress" />
      )}
    </button>
  );
}

function useRunStream(input: {
  active: ConversationItem | undefined;
  organizationId: string;
  projectId: string;
  loadHistory: () => Promise<void>;
  loadConversations: () => Promise<ConversationItem[]>;
  onDisconnect: () => void;
}) {
  const {
    active,
    organizationId,
    projectId,
    loadHistory,
    loadConversations,
    onDisconnect,
  } = input;
  useEffect(() => {
    if (!(active?.pendingRunId && organizationId && projectId)) {
      return;
    }
    const stream = new EventSource(
      `/v1/build-sessions/${active.buildSessionId}/events?${scopeQuery(organizationId, projectId)}`
    );
    const refresh = () => {
      loadHistory().catch(onDisconnect);
      loadConversations().catch(onDisconnect);
    };
    const finish = () => {
      stream.close();
      // The terminal ledger event is written just before the run status
      // transaction commits. Re-read until the authoritative status catches up.
      const settle = async (attempt = 0): Promise<void> => {
        const [items] = await Promise.all([loadConversations(), loadHistory()]);
        if (
          !items.some(
            (item) =>
              item.buildSessionId === active.buildSessionId &&
              item.pendingRunId === active.pendingRunId
          )
        ) {
          return;
        }
        if (attempt === 9) {
          onDisconnect();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await settle(attempt + 1);
      };
      settle().catch(onDisconnect);
    };
    stream.addEventListener("agent.progress", refresh);
    stream.addEventListener("run.completed", finish);
    stream.addEventListener("run.failed", finish);
    stream.addEventListener("run.cancelled", finish);
    stream.onopen = () => {
      refresh();
    };
    stream.onerror = onDisconnect;
    return () => stream.close();
  }, [
    active?.buildSessionId,
    active?.pendingRunId,
    organizationId,
    projectId,
    loadHistory,
    loadConversations,
    onDisconnect,
  ]);
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const current = await request(
        "/v1/auth/session",
        SessionViewSchema.parse
      );
      setSession(current);
      setOrganizationId(
        (selected) => selected || current.organizations[0]?.organizationId || ""
      );
      setError("");
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        setSession(null);
      } else {
        setError(describeError(cause, "Could not reach ReasonateAI."));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    const result = await request(
      `/v1/projects?organizationId=${encodeURIComponent(organizationId)}`,
      ProjectListSchema.parse
    );
    setProjects(result.projects);
    setProjectId((selected) =>
      result.projects.some((item) => item.projectId === selected)
        ? selected
        : (result.projects[0]?.projectId ?? "")
    );
  }, [organizationId]);

  const loadConversations = useCallback(async () => {
    if (!(organizationId && projectId)) {
      return [];
    }
    const result = await request(
      `/v1/projects/${projectId}/conversations?organizationId=${encodeURIComponent(organizationId)}`,
      ConversationListSchema.parse
    );
    setConversations(result.conversations);
    return result.conversations;
  }, [organizationId, projectId]);

  const loadHistory = useCallback(async () => {
    if (!(organizationId && projectId && conversationId)) {
      setMessages([]);
      return;
    }
    const result = await request(
      `/v1/build-sessions/${conversationId}/messages?${scopeQuery(organizationId, projectId)}`,
      ConversationHistorySchema.parse
    );
    setMessages(result.messages);
  }, [organizationId, projectId, conversationId]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);
  useEffect(() => {
    if (!organizationId) {
      return;
    }
    loadProjects().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load projects."))
    );
  }, [organizationId, loadProjects]);
  useEffect(() => {
    setConversations([]);
    setConversationId("");
    if (!projectId) {
      return;
    }
    loadConversations().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load conversations."))
    );
  }, [projectId, loadConversations]);
  useEffect(() => {
    loadHistory().catch((cause: unknown) =>
      setError(describeError(cause, "Could not load messages."))
    );
  }, [loadHistory]);

  const active = conversations.find(
    (item) => item.buildSessionId === conversationId
  );
  const onDisconnect = useCallback(
    () => setNotice("Connection interrupted. Reconnecting to the run…"),
    []
  );
  useRunStream({
    active,
    loadConversations,
    loadHistory,
    onDisconnect,
    organizationId,
    projectId,
  });

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!(message && organizationId && projectId) || submitting) {
      return;
    }
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
            body: JSON.stringify({ message }),
            headers: { "idempotency-key": idempotencyKey },
            method: "POST",
          }
        );
      } else {
        const allocated = await request(
          "/v1/build-sessions",
          BuildSessionAllocationSchema.parse,
          {
            body: JSON.stringify({ message, organizationId, projectId }),
            headers: { "idempotency-key": idempotencyKey },
            method: "POST",
          }
        );
        setConversationId(allocated.buildSession.buildSessionId);
      }
      setDraft("");
      await loadConversations();
      if (conversationId) {
        await loadHistory();
      }
    } catch (cause) {
      setError(describeError(cause, "Could not send the message."));
    } finally {
      setSubmitting(false);
    }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await request("/v1/auth/magic-links", (value) => value, {
        body: JSON.stringify({ email }),
        method: "POST",
      });
      setNotice(
        process.env.NODE_ENV === "development"
          ? "No email was sent. Open the one-use sign-in link in the API terminal."
          : "Check your email for a sign-in link."
      );
    } catch (cause) {
      setError(describeError(cause, "Could not request a link."));
    } finally {
      setSubmitting(false);
    }
  }

  async function createOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const created = await request(
        "/v1/organizations",
        CreateOrganizationResponseSchema.parse,
        {
          body: JSON.stringify({ name: organizationName.trim() }),
          method: "POST",
        }
      );
      await loadSession();
      setOrganizationId(created.organizationId);
      setOrganizationName("");
    } catch (cause) {
      setError(describeError(cause, "Could not create organization."));
    } finally {
      setSubmitting(false);
    }
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const created = await request("/v1/projects", ProjectViewSchema.parse, {
        body: JSON.stringify({ name: projectName.trim(), organizationId }),
        method: "POST",
      });
      await loadProjects();
      setProjectId(created.projectId);
      setProjectName("");
    } catch (cause) {
      setError(describeError(cause, "Could not create project."));
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    try {
      await request("/v1/auth/session", (value) => value, { method: "DELETE" });
    } finally {
      setSession(null);
      setOrganizationId("");
      setProjectId("");
      setConversationId("");
    }
  }

  function dismissError() {
    setError("");
  }
  function updateOrganization(event: React.ChangeEvent<HTMLSelectElement>) {
    setOrganizationId(event.currentTarget.value);
  }
  function updateOrganizationName(event: React.ChangeEvent<HTMLInputElement>) {
    setOrganizationName(event.currentTarget.value);
  }
  function updateProjectName(event: React.ChangeEvent<HTMLInputElement>) {
    setProjectName(event.currentTarget.value);
  }
  function updateEmail(event: React.ChangeEvent<HTMLInputElement>) {
    setEmail(event.currentTarget.value);
  }
  function updateDraft(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(event.currentTarget.value);
  }
  function newConversation() {
    setConversationId("");
    setMessages([]);
    setDraft("");
  }
  function selectStarter(event: React.MouseEvent<HTMLButtonElement>) {
    setDraft(event.currentTarget.value);
    document.getElementById("prompt")?.focus();
  }
  function refreshChat() {
    loadConversations().catch(onDisconnect);
    loadHistory().catch(onDisconnect);
  }
  function promptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const selectedProject = projects.find((item) => item.projectId === projectId);

  return (
    <div className="product-shell">
      <header className="product-header">
        <div className="brand">
          <Image
            alt="ReasonateAI"
            height={34}
            src="/brand/reasonateai-icon.png"
            width={34}
          />
          <span>
            reasonate<span className="brand-ai">AI</span>
          </span>
        </div>
        <span className="product-label">
          AN IDEA, A PLAN, A WORKING PRODUCT.
        </span>
        {session && (
          <Button onClick={signOut} size="sm" variant="ghost">
            <LogOut size={15} /> Sign out
          </Button>
        )}
      </header>
      {error && (
        <div className="product-alert" role="alert">
          {error}
          <button onClick={dismissError} type="button">
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="product-notice" role="status">
          {notice}
        </div>
      )}
      {loading && (
        <main className="center-panel">
          <p>Opening your workspace…</p>
        </main>
      )}
      {!loading && session && (
        <div className="workspace-grid">
          <aside aria-label="Project navigation" className="workspace-sidebar">
            <div className="sidebar-section">
              <div className="sidebar-heading">ORGANIZATION</div>
              <select
                aria-label="Organization"
                onChange={updateOrganization}
                value={organizationId}
              >
                {session.organizations.map((item) => (
                  <option key={item.organizationId} value={item.organizationId}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            {session.organizations.length === 0 && (
              <form className="sidebar-form" onSubmit={createOrganization}>
                <label htmlFor="organization-name">
                  Create an organization
                </label>
                <input
                  id="organization-name"
                  maxLength={120}
                  onChange={updateOrganizationName}
                  placeholder="Organization name"
                  required
                  value={organizationName}
                />
                <Button disabled={submitting} size="sm" type="submit">
                  Create
                </Button>
              </form>
            )}
            {organizationId && (
              <>
                <div className="sidebar-section">
                  <div className="sidebar-heading">PROJECTS</div>
                  {projects.map((item) => (
                    <ProjectButton
                      item={item}
                      key={item.projectId}
                      onSelect={setProjectId}
                      selected={projectId === item.projectId}
                    />
                  ))}
                </div>
                <form className="sidebar-form" onSubmit={createProject}>
                  <label htmlFor="project-name">New project</label>
                  <div className="sidebar-input-row">
                    <input
                      id="project-name"
                      maxLength={120}
                      onChange={updateProjectName}
                      placeholder="Project name"
                      required
                      value={projectName}
                    />
                    <Button
                      aria-label="Create project"
                      disabled={submitting}
                      size="icon-sm"
                      type="submit"
                    >
                      <CirclePlus size={16} />
                    </Button>
                  </div>
                </form>
              </>
            )}
            {projectId && (
              <div className="sidebar-section conversations-section">
                <div className="sidebar-heading">
                  CONVERSATIONS{" "}
                  <button
                    aria-label="New conversation"
                    onClick={newConversation}
                    type="button"
                  >
                    <CirclePlus size={16} />
                  </button>
                </div>
                {conversations.map((item) => (
                  <ConversationButton
                    item={item}
                    key={item.buildSessionId}
                    onSelect={setConversationId}
                    selected={conversationId === item.buildSessionId}
                  />
                ))}
              </div>
            )}
          </aside>
          <main className="chat-main">
            {selectedProject ? (
              <>
                <div className="chat-topline">
                  <div>
                    <div className="eyebrow">
                      WORKSPACE <span aria-hidden="true">/</span>{" "}
                      {selectedProject.name.toUpperCase()}
                    </div>
                    <h1>
                      {active?.title ||
                        (conversationId
                          ? "Conversation"
                          : "What are we building?")}
                    </h1>
                  </div>
                  <div className="chat-top-actions">
                    <span className="workspace-presence">
                      <span className="presence-mark" /> PROJECT WORKSPACE
                    </span>
                    <Button onClick={refreshChat} size="sm" variant="outline">
                      <RefreshCw size={14} /> Refresh
                    </Button>
                  </div>
                </div>
                {messages.length === 0 ? (
                  <EmptyWorkspace
                    conversationId={conversationId}
                    onStarter={selectStarter}
                    pending={Boolean(active?.pendingRunId)}
                  />
                ) : (
                  <Conversation className="chat-conversation">
                    <ConversationContent className="chat-messages">
                      {messages.map((message) => (
                        <Message
                          from={message.role === "user" ? "user" : "assistant"}
                          key={message.id}
                        >
                          <MessageContent>
                            {message.role === "user" ? (
                              message.text
                            ) : (
                              <MessageResponse>{message.text}</MessageResponse>
                            )}
                          </MessageContent>
                        </Message>
                      ))}
                      {active?.pendingRunId && (
                        <div className="run-status" role="status">
                          <span className="pulse-dot" /> CTO is working in the
                          sandbox…
                        </div>
                      )}
                    </ConversationContent>
                  </Conversation>
                )}
                <div className="composer-wrap">
                  <form className="composer" onSubmit={submitMessage}>
                    <div className="composer-heading">
                      <span>
                        <span className="composer-indicator" /> MESSAGE YOUR CTO
                      </span>
                      <span>{draft.length.toLocaleString()} / 20,000</span>
                    </div>
                    <label className="sr-only" htmlFor="prompt">
                      Message your CTO
                    </label>
                    <textarea
                      disabled={submitting || Boolean(active?.pendingRunId)}
                      id="prompt"
                      maxLength={20_000}
                      onChange={updateDraft}
                      onKeyDown={promptKeyDown}
                      placeholder="Describe the product or your next change…"
                      rows={3}
                      value={draft}
                    />
                    <div className="composer-bottom">
                      <span>
                        ENTER TO SEND <span aria-hidden="true">/</span> SHIFT +
                        ENTER FOR A NEW LINE
                      </span>
                      <Button
                        aria-label="Send message"
                        disabled={
                          !draft.trim() ||
                          submitting ||
                          Boolean(active?.pendingRunId)
                        }
                        size="icon"
                        type="submit"
                      >
                        <ArrowUp size={18} />
                      </Button>
                    </div>
                  </form>
                  <p className="composer-note">
                    Work is saved to this project. Review important changes
                    before deployment.
                  </p>
                </div>
              </>
            ) : (
              <div className="chat-empty project-empty">
                <FolderClosed size={26} />
                <h2>Choose a project</h2>
                <p>Create or select a project to open its CTO workspace.</p>
              </div>
            )}
          </main>
        </div>
      )}
      {!(loading || session) && (
        <main className="center-panel">
          <div className="entry-mark">01 / ACCESS</div>
          <h1>
            Build with a CTO
            <br />
            who remembers the work.
          </h1>
          <p>Sign in to your project workspace.</p>
          <form className="entry-form" onSubmit={signIn}>
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              onChange={updateEmail}
              placeholder="you@company.com"
              required
              type="email"
              value={email}
            />
            <Button disabled={submitting} type="submit">
              Send sign-in link <ArrowUp size={15} />
            </Button>
          </form>
        </main>
      )}
    </div>
  );
}

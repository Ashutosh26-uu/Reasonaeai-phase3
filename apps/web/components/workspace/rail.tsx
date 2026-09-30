"use client";

import type { ProjectSummary } from "@reasonateai/contracts/auth";
import type { ConversationSummary } from "@reasonateai/contracts/execution";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@reasonateai/ui/components/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@reasonateai/ui/components/hover-card";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CirclePlus,
  FolderClosed,
  FolderOpen,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  UserRound,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface RailProps {
  accountEmail: string;
  accountName: string;
  conversationId: string;
  conversationsByProject: Record<string, ConversationSummary[] | undefined>;
  draftProjectName: string;
  errorMessage: string;
  failedConversationProjects: string[];
  onConversationSelect: (projectId: string, buildSessionId: string) => void;
  onNewConversation: () => void;
  onNewConversationForProject: (projectId: string) => void;
  onOrganizationSelect: (organizationId: string) => void;
  onProjectNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onProjectSelect: (projectId: string) => void;
  onProjectSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSettings: () => void;
  onSignOut: () => void;
  organizationId: string;
  organizations: { name: string; organizationId: string }[];
  projectId: string;
  projects: ProjectSummary[];
  submitting: boolean;
}

const COLLAPSED_KEY = "reasonate.rail.collapsed";
const PINNED_CONVERSATIONS_KEY = "reasonate.rail.pinned-conversations";

function readCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(COLLAPSED_KEY) === "true";
}

interface NavigationConversation {
  conversation: ConversationSummary;
  projectId: string;
  projectName: string;
}

interface ChatPickerProps {
  conversations: NavigationConversation[];
  onConversationSelect: (projectId: string, buildSessionId: string) => void;
  onNewConversation: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

function ChatPicker({
  conversations,
  onConversationSelect,
  onNewConversation,
  onOpenChange,
  open,
}: ChatPickerProps) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const filteredConversations = conversations.filter(
    ({ conversation, projectName }) =>
      `${conversation.title ?? "Untitled conversation"} ${projectName}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
  );
  const updateSearch = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setQuery(event.currentTarget.value),
    []
  );
  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      setQuery("");
      element.showModal();
      searchInput.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const cancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      close();
    },
    [close]
  );
  const createChat = useCallback(() => {
    close();
    onNewConversation();
  }, [close, onNewConversation]);
  const openConversationFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const targetProjectId = event.currentTarget.dataset.projectId;
      const targetConversationId = event.currentTarget.value;
      if (!(targetProjectId && targetConversationId)) {
        return;
      }
      onConversationSelect(targetProjectId, targetConversationId);
      close();
    },
    [close, onConversationSelect]
  );

  return (
    <dialog
      aria-label="Search conversations"
      className="rail-chat-dialog"
      onCancel={cancel}
      onClose={close}
      ref={dialog}
    >
      <header className="rail-chat-dialog-head">
        <Search aria-hidden="true" size={20} />
        <input
          aria-label="Search conversations"
          className="rail-chat-search"
          onChange={updateSearch}
          placeholder="Search conversations and projects…"
          ref={searchInput}
          type="search"
          value={query}
        />
        <button
          aria-label="Close search"
          className="rail-chat-close"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>
      <section
        aria-label="Conversation results"
        className="rail-chat-list-pane"
      >
        <div className="rail-chat-section-head">
          <span>Conversations</span>
        </div>
        <button className="rail-chat-create" onClick={createChat} type="button">
          <SquarePen aria-hidden="true" size={18} />
          New conversation
        </button>
        <div className="rail-chat-results">
          {filteredConversations.length === 0 ? (
            <p className="rail-chat-empty">
              {query ? "No matching conversations." : "No conversations yet."}
            </p>
          ) : (
            filteredConversations.map(
              ({ conversation, projectId, projectName }) => (
                <button
                  className="rail-chat-result"
                  data-project-id={projectId}
                  key={conversation.buildSessionId}
                  onClick={openConversationFromButton}
                  title={conversation.title ?? "Untitled conversation"}
                  type="button"
                  value={conversation.buildSessionId}
                >
                  <span className="rail-chat-result-copy">
                    <span>{conversation.title ?? "Untitled conversation"}</span>
                    <span className="rail-chat-result-project">
                      {projectName}
                    </span>
                  </span>
                  <time dateTime={conversation.updatedAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      day: "numeric",
                      month: "short",
                    }).format(new Date(conversation.updatedAt))}
                  </time>
                </button>
              )
            )
          )}
        </div>
      </section>
    </dialog>
  );
}

interface ProjectPickerProps {
  draftProjectName: string;
  errorMessage: string;
  onOpenChange: (open: boolean) => void;
  onProjectNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onProjectSelect: (projectId: string) => void;
  onProjectSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  open: boolean;
  projectId: string;
  projects: ProjectSummary[];
  submitting: boolean;
}

function ProjectPicker({
  draftProjectName,
  errorMessage,
  onOpenChange,
  onProjectNameChange,
  onProjectSelect,
  onProjectSubmit,
  open,
  projectId,
  projects,
  submitting,
}: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousProjectIds = useRef(
    projects.map((project) => project.projectId)
  );
  const filteredProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(query.trim().toLowerCase())
  );
  const updateSearch = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setQuery(event.currentTarget.value),
    []
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      setQuery("");
      element.showModal();
      searchInput.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    const createdProject = projects.some(
      (project) => !previousProjectIds.current.includes(project.projectId)
    );
    previousProjectIds.current = projects.map((project) => project.projectId);
    if (open && createdProject) {
      onOpenChange(false);
    }
  }, [onOpenChange, open, projects]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const cancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      close();
    },
    [close]
  );
  const chooseProject = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onProjectSelect(event.currentTarget.value);
      close();
    },
    [close, onProjectSelect]
  );
  return (
    <dialog
      aria-label="Choose a project"
      className="rail-project-dialog"
      onCancel={cancel}
      onClose={close}
      ref={dialog}
    >
      <header className="rail-project-dialog-head">
        <div>
          <h2>Projects</h2>
          <p>Choose a project to open its workspace.</p>
        </div>
        <button
          aria-label="Close project picker"
          className="rail-chat-close"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>
      <label className="sr-only" htmlFor="project-picker-search">
        Search projects
      </label>
      <div className="rail-project-search-wrap">
        <Search aria-hidden="true" size={17} />
        <input
          className="rail-project-search"
          id="project-picker-search"
          onChange={updateSearch}
          placeholder="Search projects…"
          ref={searchInput}
          type="search"
          value={query}
        />
      </div>
      {errorMessage.length > 0 && (
        <p className="rail-project-error" role="alert">
          {errorMessage}
        </p>
      )}
      <section aria-label="Projects" className="rail-project-picker-list">
        {filteredProjects.length === 0 ? (
          <p className="rail-chat-empty">
            {query ? "No matching projects." : "No projects yet."}
          </p>
        ) : (
          filteredProjects.map((project) => (
            <button
              aria-current={
                project.projectId === projectId ? "page" : undefined
              }
              className="rail-project-choice"
              key={project.projectId}
              onClick={chooseProject}
              type="button"
              value={project.projectId}
            >
              <FolderClosed aria-hidden="true" size={17} />
              <span>{project.name}</span>
              {project.projectId === projectId && (
                <Check aria-hidden="true" size={16} />
              )}
            </button>
          ))
        )}
      </section>
      <form className="rail-project-create" onSubmit={onProjectSubmit}>
        <label className="sr-only" htmlFor="project-picker-new-name">
          New project name
        </label>
        <input
          id="project-picker-new-name"
          maxLength={120}
          onChange={onProjectNameChange}
          placeholder="New project name"
          required
          value={draftProjectName}
        />
        <button aria-label="Create project" disabled={submitting} type="submit">
          <CirclePlus aria-hidden="true" size={17} />
          Create
        </button>
      </form>
    </dialog>
  );
}

interface ProjectTreeItemProps {
  conversationId: string;
  conversations: ConversationSummary[] | undefined;
  expanded: boolean;
  failed: boolean;
  onConversationMenuAction: (event: Event) => void;
  onConversationPin: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onConversationSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCreateConversation: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onProjectMenuAction: (event: Event) => void;
  onProjectSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onToggleProject: (event: React.MouseEvent<HTMLButtonElement>) => void;
  pinnedConversationIds: string[];
  project: ProjectSummary;
  selectedProjectId: string;
}

function ConversationTreeItem({
  conversation,
  conversationId,
  isPinned,
  onMenuAction,
  onPin,
  onSelect,
  projectId,
  projectName,
  selectedProjectId,
}: {
  conversation: ConversationSummary;
  conversationId: string;
  isPinned: boolean;
  onMenuAction: (event: Event) => void;
  onPin: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
  projectId: string;
  projectName: string;
  selectedProjectId: string;
}) {
  const active =
    conversation.buildSessionId === conversationId &&
    projectId === selectedProjectId;
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(conversation.updatedAt));

  return (
    <li className="rail-tree-conversation-item">
      <div
        className="rail-tree-conversation-wrap"
        data-pinned={isPinned || undefined}
      >
        <HoverCard closeDelay={120} openDelay={450}>
          <HoverCardTrigger asChild>
            <button
              aria-current={active ? "page" : undefined}
              className="rail-tree-conversation"
              data-active={active ? "true" : undefined}
              data-project-id={projectId}
              onClick={onSelect}
              title={conversation.title ?? "Untitled conversation"}
              type="button"
              value={conversation.buildSessionId}
            >
              <span aria-hidden="true" className="rail-tree-leaf" />
              <span className="rail-tree-conversation-title">
                {conversation.title ?? "Untitled conversation"}
              </span>
              {conversation.pendingRunId !== null && (
                <LoaderCircle
                  aria-label="Conversation running"
                  className="rail-tree-running"
                  role="img"
                  size={14}
                />
              )}
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            className="rail-conversation-preview"
            side="right"
            sideOffset={8}
          >
            <strong className="rail-conversation-preview-title">
              {conversation.title ?? "Untitled conversation"}
            </strong>
            <span className="rail-conversation-preview-detail">
              <FolderClosed aria-hidden="true" size={14} />
              {projectName}
            </span>
            <span className="rail-conversation-preview-detail">
              {conversation.pendingRunId === null ? (
                <Check aria-hidden="true" size={14} />
              ) : (
                <LoaderCircle
                  aria-hidden="true"
                  className="rail-tree-running"
                  size={14}
                />
              )}
              {conversation.pendingRunId === null ? "Last active" : "Running"}
              <time dateTime={conversation.updatedAt}>{updatedAt}</time>
            </span>
          </HoverCardContent>
        </HoverCard>
        <div className="rail-tree-conversation-actions">
          <button
            aria-label={`${isPinned ? "Unpin" : "Pin"} ${conversation.title ?? "conversation"}`}
            aria-pressed={isPinned}
            className="rail-tree-action"
            data-conversation-id={conversation.buildSessionId}
            onClick={onPin}
            title={isPinned ? "Unpin conversation" : "Pin conversation"}
            type="button"
          >
            <Pin aria-hidden="true" size={14} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`More options for ${conversation.title ?? "conversation"}`}
                className="rail-tree-action"
                title="Conversation options"
                type="button"
              >
                <MoreHorizontal aria-hidden="true" size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="rail-project-menu rail-conversation-menu"
              side="right"
              sideOffset={6}
            >
              <DropdownMenuItem
                data-conversation-id={conversation.buildSessionId}
                data-project-action="open-conversation"
                data-project-id={projectId}
                onSelect={onMenuAction}
              >
                <FolderOpen aria-hidden="true" />
                Open conversation
              </DropdownMenuItem>
              <DropdownMenuItem
                data-project-action="new-conversation"
                data-project-id={projectId}
                onSelect={onMenuAction}
              >
                <SquarePen aria-hidden="true" />
                New conversation in project
              </DropdownMenuItem>
              <DropdownMenuItem
                data-conversation-id={conversation.buildSessionId}
                data-project-action="toggle-pin"
                onSelect={onMenuAction}
              >
                <Pin aria-hidden="true" />
                {isPinned ? "Unpin conversation" : "Pin conversation"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

function ProjectTreeItem({
  conversationId,
  conversations,
  expanded,
  failed,
  onConversationSelect,
  onConversationMenuAction,
  onConversationPin,
  onCreateConversation,
  onProjectMenuAction,
  onProjectSelect,
  onToggleProject,
  pinnedConversationIds,
  project,
  selectedProjectId,
}: ProjectTreeItemProps) {
  const unpinnedConversations = conversations?.filter(
    (conversation) =>
      !pinnedConversationIds.includes(conversation.buildSessionId)
  );
  const conversationItems: React.ReactNode[] = [];
  if (expanded) {
    if (failed) {
      conversationItems.push(
        <li className="rail-tree-message" key="load-error">
          Could not load conversations
        </li>
      );
    } else if (conversations === undefined) {
      conversationItems.push(
        <li className="rail-tree-message" key="loading">
          Loading conversations…
        </li>
      );
    } else if ((unpinnedConversations?.length ?? 0) === 0) {
      conversationItems.push(
        <li className="rail-tree-message" key="empty">
          {conversations.length === 0
            ? "No conversations yet"
            : "All conversations pinned"}
        </li>
      );
    } else {
      conversationItems.push(
        ...[...(unpinnedConversations ?? [])]
          .sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
          )
          .map((conversation) => (
            <ConversationTreeItem
              conversation={conversation}
              conversationId={conversationId}
              isPinned={pinnedConversationIds.includes(
                conversation.buildSessionId
              )}
              key={conversation.buildSessionId}
              onMenuAction={onConversationMenuAction}
              onPin={onConversationPin}
              onSelect={onConversationSelect}
              projectId={project.projectId}
              projectName={project.name}
              selectedProjectId={selectedProjectId}
            />
          ))
      );
    }
  }
  const projectChildren = expanded ? (
    <ul className="rail-tree-children">{conversationItems}</ul>
  ) : null;

  return (
    <li className="rail-tree-project">
      <div
        className="rail-tree-project-row"
        data-active={project.projectId === selectedProjectId || undefined}
      >
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
          className="rail-tree-chevron"
          onClick={onToggleProject}
          type="button"
          value={project.projectId}
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
        </button>
        <button
          aria-current={
            project.projectId === selectedProjectId ? "page" : undefined
          }
          className="rail-tree-project-select"
          onClick={onProjectSelect}
          title={project.name}
          type="button"
          value={project.projectId}
        >
          <FolderClosed aria-hidden="true" size={16} />
          <span>{project.name}</span>
        </button>
        <div className="rail-tree-actions">
          <button
            aria-label={`New conversation in ${project.name}`}
            className="rail-tree-action"
            onClick={onCreateConversation}
            title={`New conversation in ${project.name}`}
            type="button"
            value={project.projectId}
          >
            <SquarePen aria-hidden="true" size={15} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`More options for ${project.name}`}
                className="rail-tree-action"
                title={`More options for ${project.name}`}
                type="button"
              >
                <MoreHorizontal aria-hidden="true" size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="rail-project-menu"
              side="right"
              sideOffset={6}
            >
              <DropdownMenuItem
                data-project-action="new-conversation"
                data-project-id={project.projectId}
                onSelect={onProjectMenuAction}
              >
                <SquarePen aria-hidden="true" />
                New conversation
              </DropdownMenuItem>
              <DropdownMenuItem
                data-project-action="open-project"
                data-project-id={project.projectId}
                onSelect={onProjectMenuAction}
              >
                <FolderOpen aria-hidden="true" />
                Open project
              </DropdownMenuItem>
              <DropdownMenuItem
                data-project-action="toggle-conversations"
                data-project-id={project.projectId}
                onSelect={onProjectMenuAction}
              >
                {expanded ? (
                  <ChevronRight aria-hidden="true" />
                ) : (
                  <ChevronDown aria-hidden="true" />
                )}
                {expanded ? "Collapse conversations" : "Expand conversations"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {projectChildren}
    </li>
  );
}

export function Rail({
  accountEmail,
  accountName,
  conversationId,
  conversationsByProject,
  failedConversationProjects,
  draftProjectName,
  errorMessage,
  onConversationSelect,
  onNewConversation,
  onNewConversationForProject,
  onOrganizationSelect,
  onProjectNameChange,
  onProjectSelect,
  onProjectSubmit,
  onSettings,
  onSignOut,
  organizationId,
  organizations,
  projectId,
  projects,
  submitting,
}: RailProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>(
    []
  );
  const [loadedPinnedOrganizationId, setLoadedPinnedOrganizationId] =
    useState("");

  useEffect(() => {
    let storedIds: string[] = [];
    try {
      const value: unknown = JSON.parse(
        window.localStorage.getItem(
          `${PINNED_CONVERSATIONS_KEY}:${organizationId}`
        ) ?? "[]"
      );
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        storedIds = value;
      }
    } catch {
      storedIds = [];
    }
    setPinnedConversationIds(storedIds);
    setLoadedPinnedOrganizationId(organizationId);
  }, [organizationId]);

  useEffect(() => {
    if (loadedPinnedOrganizationId !== organizationId) {
      return;
    }
    window.localStorage.setItem(
      `${PINNED_CONVERSATIONS_KEY}:${organizationId}`,
      JSON.stringify(pinnedConversationIds)
    );
  }, [loadedPinnedOrganizationId, organizationId, pinnedConversationIds]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      const saved = window.localStorage.getItem(COLLAPSED_KEY);
      setCollapsed(media.matches || saved === "true");
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (projectId) {
      setExpandedProjects((current) =>
        current.includes(projectId) ? current : [...current, projectId]
      );
    }
  }, [projectId]);

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      if (!window.matchMedia("(max-width: 900px)").matches) {
        window.localStorage.setItem(COLLAPSED_KEY, String(next));
      }
      return next;
    });
  }, []);

  const closeNavigation = useCallback(() => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    if (collapsed) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        window.matchMedia("(max-width: 900px)").matches
      ) {
        closeNavigation();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeNavigation, collapsed]);

  const orderedConversations = useMemo(
    () =>
      Object.entries(conversationsByProject).flatMap(
        ([targetProjectId, items]) => {
          const projectName = projects.find(
            (item) => item.projectId === targetProjectId
          )?.name;
          if (!(items && projectName)) {
            return [];
          }
          return items.map((conversation) => ({
            conversation,
            projectId: targetProjectId,
            projectName,
          }));
        }
      ),
    [conversationsByProject, projects]
  );
  const sortedConversations = useMemo(
    () =>
      [...orderedConversations].sort(
        (left, right) =>
          Date.parse(right.conversation.updatedAt) -
          Date.parse(left.conversation.updatedAt)
      ),
    [orderedConversations]
  );
  const pinnedConversations = useMemo(
    () =>
      sortedConversations.filter(({ conversation }) =>
        pinnedConversationIds.includes(conversation.buildSessionId)
      ),
    [pinnedConversationIds, sortedConversations]
  );
  const organizationName =
    organizations.find((item) => item.organizationId === organizationId)
      ?.name ?? "No organization";

  const toggleProject = useCallback((targetProjectId: string) => {
    setExpandedProjects((current) =>
      current.includes(targetProjectId)
        ? current.filter((item) => item !== targetProjectId)
        : [...current, targetProjectId]
    );
  }, []);

  const startProjectConversation = useCallback(
    (targetProjectId: string) => {
      onNewConversationForProject(targetProjectId);
      setExpandedProjects((current) =>
        current.includes(targetProjectId)
          ? current
          : [...current, targetProjectId]
      );
      closeNavigation();
    },
    [closeNavigation, onNewConversationForProject]
  );

  const chooseConversation = useCallback(
    (targetProjectId: string, targetConversationId: string) => {
      onConversationSelect(targetProjectId, targetConversationId);
      closeNavigation();
    },
    [closeNavigation, onConversationSelect]
  );
  const toggleProjectFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      toggleProject(event.currentTarget.value),
    [toggleProject]
  );
  const selectProjectFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onProjectSelect(event.currentTarget.value);
      closeNavigation();
    },
    [closeNavigation, onProjectSelect]
  );
  const createConversationFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      startProjectConversation(event.currentTarget.value),
    [startProjectConversation]
  );
  const selectConversationFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const targetProjectId = event.currentTarget.dataset.projectId;
      if (targetProjectId) {
        chooseConversation(targetProjectId, event.currentTarget.value);
      }
    },
    [chooseConversation]
  );
  const selectProjectMenuAction = useCallback(
    (event: Event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const targetProjectId = target.dataset.projectId;
      const action = target.dataset.projectAction;
      if (!(targetProjectId && action)) {
        return;
      }
      if (action === "new-conversation") {
        startProjectConversation(targetProjectId);
      } else if (action === "open-project") {
        onProjectSelect(targetProjectId);
        closeNavigation();
      } else if (action === "toggle-conversations") {
        toggleProject(targetProjectId);
      }
    },
    [closeNavigation, onProjectSelect, startProjectConversation, toggleProject]
  );
  const togglePinnedConversation = useCallback((buildSessionId: string) => {
    setPinnedConversationIds((current) =>
      current.includes(buildSessionId)
        ? current.filter((item) => item !== buildSessionId)
        : [buildSessionId, ...current]
    );
  }, []);
  const pinConversationFromButton = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const buildSessionId = event.currentTarget.dataset.conversationId;
      if (buildSessionId) {
        togglePinnedConversation(buildSessionId);
      }
    },
    [togglePinnedConversation]
  );
  const selectConversationMenuAction = useCallback(
    (event: Event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const action = target.dataset.projectAction;
      const buildSessionId = target.dataset.conversationId;
      const targetProjectId = target.dataset.projectId;
      if (action === "open-conversation" && buildSessionId && targetProjectId) {
        chooseConversation(targetProjectId, buildSessionId);
      } else if (action === "new-conversation" && targetProjectId) {
        startProjectConversation(targetProjectId);
      } else if (action === "toggle-pin" && buildSessionId) {
        togglePinnedConversation(buildSessionId);
      }
    },
    [chooseConversation, startProjectConversation, togglePinnedConversation]
  );
  const selectOrganizationFromMenu = useCallback(
    (event: Event) => {
      const target = event.currentTarget;
      if (target instanceof HTMLElement && target.dataset.organizationId) {
        onOrganizationSelect(target.dataset.organizationId);
      }
    },
    [onOrganizationSelect]
  );
  const openChatPicker = useCallback(() => setChatPickerOpen(true), []);
  const openProjectPicker = useCallback(() => setProjectPickerOpen(true), []);
  const toggleProjectCreation = useCallback(
    () => setCreateProjectOpen((current) => !current),
    []
  );
  const startNewConversation = useCallback(() => {
    onNewConversation();
    closeNavigation();
  }, [closeNavigation, onNewConversation]);
  const selectProjectFromPicker = useCallback(
    (nextProjectId: string) => {
      onProjectSelect(nextProjectId);
      closeNavigation();
    },
    [closeNavigation, onProjectSelect]
  );

  return (
    <aside className="rail" data-collapsed={collapsed || undefined}>
      {!collapsed && (
        <button
          aria-label="Close navigation"
          className="rail-backdrop"
          onClick={closeNavigation}
          tabIndex={-1}
          type="button"
        />
      )}

      <div className="rail-head">
        <Image
          alt=""
          height={22}
          priority
          src="/brand/reasonateai-icon.png"
          width={22}
        />
        <span className="rail-brand">
          reasonate<span className="rail-ai">AI</span>
        </span>
        <div className="rail-head-actions">
          <button
            aria-label="Search conversations"
            className="rail-icon-button"
            onClick={openChatPicker}
            title="Search conversations"
            type="button"
          >
            <Search aria-hidden="true" size={19} />
          </button>
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rail-icon-button rail-desktop-toggle"
            onClick={toggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            type="button"
          >
            {collapsed ? (
              <ChevronsRight aria-hidden="true" size={18} />
            ) : (
              <ChevronsLeft aria-hidden="true" size={18} />
            )}
          </button>
        </div>
      </div>

      <button
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Open navigation" : "Close navigation"}
        className="rail-mobile-toggle"
        onClick={toggle}
        type="button"
      >
        {collapsed ? (
          <Menu aria-hidden="true" size={20} />
        ) : (
          <X aria-hidden="true" size={20} />
        )}
      </button>

      <div className="rail-body">
        <button
          className="rail-new"
          disabled={!projectId}
          onClick={startNewConversation}
          title={collapsed ? "New conversation" : undefined}
          type="button"
        >
          <SquarePen aria-hidden="true" size={17} />
          <span className="rail-text">New conversation</span>
        </button>

        {pinnedConversations.length > 0 && (
          <div className="rail-block rail-pinned-block">
            <div className="rail-label rail-pinned-label">Pinned</div>
            <ul aria-label="Pinned conversations" className="rail-pinned-list">
              {pinnedConversations.map(
                ({ conversation, projectId: targetProjectId, projectName }) => (
                  <ConversationTreeItem
                    conversation={conversation}
                    conversationId={conversationId}
                    isPinned
                    key={conversation.buildSessionId}
                    onMenuAction={selectConversationMenuAction}
                    onPin={pinConversationFromButton}
                    onSelect={selectConversationFromButton}
                    projectId={targetProjectId}
                    projectName={projectName}
                    selectedProjectId={projectId}
                  />
                )
              )}
            </ul>
          </div>
        )}

        <div className="rail-block rail-project-block">
          <div className="rail-label rail-project-label">
            <span>Projects</span>
            <button
              aria-label="Create a project"
              className="rail-label-action"
              onClick={toggleProjectCreation}
              title="Create a project"
              type="button"
            >
              <Plus aria-hidden="true" size={16} />
            </button>
          </div>
          <button
            aria-label="Browse projects"
            className="rail-collapsed-projects"
            onClick={openProjectPicker}
            title="Browse projects"
            type="button"
          >
            <FolderClosed aria-hidden="true" size={19} />
          </button>

          <ul aria-label="Projects and conversations" className="rail-tree">
            {projects.map((project) => (
              <ProjectTreeItem
                conversationId={conversationId}
                conversations={conversationsByProject[project.projectId]}
                expanded={expandedProjects.includes(project.projectId)}
                failed={failedConversationProjects.includes(project.projectId)}
                key={project.projectId}
                onConversationMenuAction={selectConversationMenuAction}
                onConversationPin={pinConversationFromButton}
                onConversationSelect={selectConversationFromButton}
                onCreateConversation={createConversationFromButton}
                onProjectMenuAction={selectProjectMenuAction}
                onProjectSelect={selectProjectFromButton}
                onToggleProject={toggleProjectFromButton}
                pinnedConversationIds={pinnedConversationIds}
                project={project}
                selectedProjectId={projectId}
              />
            ))}
          </ul>

          {createProjectOpen && (
            <form className="rail-form" onSubmit={onProjectSubmit}>
              <label className="sr-only" htmlFor="project-name">
                New project
              </label>
              <input
                autoFocus
                className="rail-input"
                id="project-name"
                maxLength={120}
                onChange={onProjectNameChange}
                placeholder="New project"
                required
                value={draftProjectName}
              />
              <button
                aria-label="Create project"
                className="rail-submit"
                disabled={submitting}
                type="submit"
              >
                <CirclePlus aria-hidden="true" size={16} />
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="rail-foot">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Open account menu${accountName ? ` for ${accountName}` : ""}`}
              className="rail-profile"
              title="Profile menu"
              type="button"
            >
              <span className="rail-profile-mark">
                <UserRound aria-hidden="true" size={18} />
              </span>
              <span className="rail-text">{accountName || "Profile"}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="rail-profile-menu"
            side="top"
            sideOffset={8}
          >
            <DropdownMenuLabel>
              <span className="rail-menu-org-name">
                {accountName || "Your account"}
              </span>
              {accountEmail && (
                <span className="rail-menu-eyebrow">{accountEmail}</span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              <span className="rail-menu-eyebrow">Workspace</span>
              <span className="rail-menu-org-name">{organizationName}</span>
            </DropdownMenuLabel>
            {organizations.length > 1 && (
              <>
                <DropdownMenuSeparator />
                {organizations.map((organization) => (
                  <DropdownMenuItem
                    data-organization-id={organization.organizationId}
                    key={organization.organizationId}
                    onSelect={selectOrganizationFromMenu}
                  >
                    <span className="rail-menu-org-mark">
                      {organization.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="rail-menu-org-label">
                      {organization.name}
                    </span>
                    {organization.organizationId === organizationId && (
                      <Check
                        aria-hidden="true"
                        className="rail-menu-check"
                        size={15}
                      />
                    )}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSettings}>
              <SettingsIcon aria-hidden="true" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSignOut} variant="destructive">
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ChatPicker
        conversations={sortedConversations}
        onConversationSelect={onConversationSelect}
        onNewConversation={onNewConversation}
        onOpenChange={setChatPickerOpen}
        open={chatPickerOpen}
      />
      <ProjectPicker
        draftProjectName={draftProjectName}
        errorMessage={errorMessage}
        onOpenChange={setProjectPickerOpen}
        onProjectNameChange={onProjectNameChange}
        onProjectSelect={selectProjectFromPicker}
        onProjectSubmit={onProjectSubmit}
        open={projectPickerOpen}
        projectId={projectId}
        projects={projects}
        submitting={submitting}
      />
    </aside>
  );
}

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
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CirclePlus,
  FolderClosed,
  LogOut,
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
  selectedConversationId: string;
}

function ChatPicker({
  conversations,
  onConversationSelect,
  onNewConversation,
  onOpenChange,
  open,
  selectedConversationId,
}: ChatPickerProps) {
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState("");
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
  const preview = conversations.find(
    (item) => item.conversation.buildSessionId === previewId
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      setQuery("");
      setPreviewId(selectedConversationId);
      element.showModal();
      searchInput.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, selectedConversationId]);

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
  const selectPreview = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      setPreviewId(event.currentTarget.value),
    []
  );
  const openPreview = useCallback(() => {
    if (!preview) {
      return;
    }
    onConversationSelect(
      preview.projectId,
      preview.conversation.buildSessionId
    );
    close();
  }, [close, onConversationSelect, preview]);

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
      <div className="rail-chat-dialog-body">
        <section
          aria-label="Conversation results"
          className="rail-chat-list-pane"
        >
          <div className="rail-chat-section-head">
            <span>Conversations</span>
          </div>
          <button
            className="rail-chat-create"
            onClick={createChat}
            type="button"
          >
            <SquarePen aria-hidden="true" size={18} />
            New conversation
          </button>
          <div className="rail-chat-results">
            {filteredConversations.length === 0 ? (
              <p className="rail-chat-empty">
                {query ? "No matching conversations." : "No conversations yet."}
              </p>
            ) : (
              filteredConversations.map(({ conversation, projectName }) => (
                <button
                  aria-pressed={conversation.buildSessionId === previewId}
                  className="rail-chat-result"
                  key={conversation.buildSessionId}
                  onClick={selectPreview}
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
              ))
            )}
          </div>
        </section>
        <section
          aria-label="Conversation preview"
          className="rail-chat-preview-pane"
        >
          {preview ? (
            <>
              <div className="rail-chat-preview-content">
                <FolderClosed aria-hidden="true" size={22} />
                <span className="rail-chat-preview-project">
                  {preview.projectName}
                </span>
                <h2>{preview.conversation.title ?? "Untitled conversation"}</h2>
              </div>
              <button
                className="rail-chat-open"
                onClick={openPreview}
                type="button"
              >
                Open conversation
              </button>
            </>
          ) : (
            <p>Select a conversation to preview</p>
          )}
        </section>
      </div>
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

export function Rail({
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
        <span>{collapsed ? "Menu" : "Close"}</span>
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
            {projects.map((project) => {
              const expanded = expandedProjects.includes(project.projectId);
              const projectConversations =
                conversationsByProject[project.projectId];
              let projectChildren: React.ReactNode = null;
              if (
                expanded &&
                failedConversationProjects.includes(project.projectId)
              ) {
                projectChildren = (
                  <ul className="rail-tree-children">
                    <li className="rail-tree-message">
                      Could not load conversations
                    </li>
                  </ul>
                );
              } else if (expanded && projectConversations === undefined) {
                projectChildren = (
                  <ul className="rail-tree-children">
                    <li className="rail-tree-message">
                      Loading conversations…
                    </li>
                  </ul>
                );
              } else if (expanded && projectConversations?.length === 0) {
                projectChildren = (
                  <ul className="rail-tree-children">
                    <li className="rail-tree-message">No conversations yet</li>
                  </ul>
                );
              } else if (expanded && projectConversations) {
                projectChildren = (
                  <ul className="rail-tree-children">
                    {[...projectConversations]
                      .sort(
                        (left, right) =>
                          Date.parse(right.updatedAt) -
                          Date.parse(left.updatedAt)
                      )
                      .map((conversation) => (
                        <li key={conversation.buildSessionId}>
                          <button
                            aria-current={
                              conversation.buildSessionId === conversationId &&
                              project.projectId === projectId
                                ? "page"
                                : undefined
                            }
                            className="rail-tree-conversation"
                            data-active={
                              conversation.buildSessionId === conversationId &&
                              project.projectId === projectId
                                ? "true"
                                : undefined
                            }
                            data-project-id={project.projectId}
                            onClick={selectConversationFromButton}
                            title={
                              conversation.title ?? "Untitled conversation"
                            }
                            type="button"
                            value={conversation.buildSessionId}
                          >
                            <span
                              aria-hidden="true"
                              className="rail-tree-leaf"
                            />
                            <span className="rail-tree-conversation-title">
                              {conversation.title ?? "Untitled conversation"}
                            </span>
                            {conversation.pendingRunId !== null && (
                              <span aria-hidden="true" className="live-dot" />
                            )}
                          </button>
                        </li>
                      ))}
                  </ul>
                );
              }
              return (
                <li className="rail-tree-project" key={project.projectId}>
                  <div
                    className="rail-tree-project-row"
                    data-active={project.projectId === projectId || undefined}
                  >
                    <button
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                      className="rail-tree-chevron"
                      onClick={toggleProjectFromButton}
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
                        project.projectId === projectId ? "page" : undefined
                      }
                      className="rail-tree-project-select"
                      onClick={selectProjectFromButton}
                      title={project.name}
                      type="button"
                      value={project.projectId}
                    >
                      <FolderClosed aria-hidden="true" size={16} />
                      <span>{project.name}</span>
                    </button>
                    <button
                      aria-label={`New conversation in ${project.name}`}
                      className="rail-tree-add"
                      onClick={createConversationFromButton}
                      title={`New conversation in ${project.name}`}
                      type="button"
                      value={project.projectId}
                    >
                      <Plus aria-hidden="true" size={15} />
                    </button>
                  </div>
                  {projectChildren}
                </li>
              );
            })}
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
              aria-label="Open profile menu"
              className="rail-profile"
              title="Profile menu"
              type="button"
            >
              <span className="rail-profile-mark">
                <UserRound aria-hidden="true" size={18} />
              </span>
              <span className="rail-text">Profile</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="rail-profile-menu"
            side="top"
            sideOffset={8}
          >
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
        selectedConversationId={conversationId}
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

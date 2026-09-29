"use client";

import type { ProjectSummary } from "@reasonateai/contracts/auth";
import type { ConversationSummary } from "@reasonateai/contracts/execution";
import {
  ChevronsLeft,
  ChevronsRight,
  CirclePlus,
  CircleUserRound,
  FolderClosed,
  Menu,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface RailProps {
  conversationId: string;
  conversations: ConversationSummary[];
  draftProjectName: string;
  onConversationSelect: (buildSessionId: string) => void;
  onNewConversation: () => void;
  onOrganizationSelect: (organizationId: string) => void;
  onProjectNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onProjectSelect: (projectId: string) => void;
  onProjectSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSettings: () => void;
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
  const saved = window.localStorage.getItem(COLLAPSED_KEY);
  return saved === "true";
}

interface ChatPickerProps {
  conversationId: string;
  conversations: ConversationSummary[];
  onConversationSelect: (buildSessionId: string) => void;
  onNewConversation: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

function ChatPicker({
  conversationId,
  conversations,
  onConversationSelect,
  onNewConversation,
  onOpenChange,
  open,
}: ChatPickerProps) {
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const filteredConversations = conversations.filter((item) =>
    (item.title ?? "Untitled conversation")
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
  const previewConversation = conversations.find(
    (item) => item.buildSessionId === previewId
  );

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      setQuery("");
      setPreviewId(conversationId);
      element.showModal();
      searchInput.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [conversationId, open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const cancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      onOpenChange(false);
    },
    [onOpenChange]
  );
  const updateSearch = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setQuery(event.currentTarget.value),
    []
  );
  const createChat = useCallback(() => {
    onOpenChange(false);
    onNewConversation();
  }, [onNewConversation, onOpenChange]);
  const selectPreview = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      setPreviewId(event.currentTarget.value),
    []
  );
  const openPreview = useCallback(() => {
    if (!previewConversation) {
      return;
    }
    onConversationSelect(previewConversation.buildSessionId);
    onOpenChange(false);
  }, [onConversationSelect, onOpenChange, previewConversation]);

  return (
    <dialog
      aria-label="Chats"
      className="rail-chat-dialog"
      onCancel={cancel}
      onClose={close}
      ref={dialog}
    >
      <header className="rail-chat-dialog-head">
        <Search aria-hidden="true" size={20} />
        <input
          aria-label="Search chats"
          className="rail-chat-search"
          onChange={updateSearch}
          placeholder="Search chats..."
          ref={searchInput}
          type="search"
          value={query}
        />
        <span aria-current="page" className="rail-chat-tab">
          Chats
        </span>
        <button
          aria-label="Close chat search"
          className="rail-chat-close"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>
      <div className="rail-chat-dialog-body">
        <section aria-label="Chat list" className="rail-chat-list-pane">
          <div className="rail-chat-section-head">
            <span>Actions</span>
          </div>
          <button
            className="rail-chat-create"
            onClick={createChat}
            type="button"
          >
            <SquarePen aria-hidden="true" size={18} />
            Create New Chat
          </button>
          <div className="rail-chat-section-head rail-chat-older-head">
            <span>{query ? "Results" : "Chats"}</span>
          </div>
          <div className="rail-chat-results">
            {filteredConversations.length === 0 ? (
              <p className="rail-chat-empty">
                {query ? "No matching chats." : "No chats yet."}
              </p>
            ) : (
              filteredConversations.map((item) => (
                <button
                  aria-pressed={item.buildSessionId === previewId}
                  className="rail-chat-result"
                  key={item.buildSessionId}
                  onClick={selectPreview}
                  type="button"
                  value={item.buildSessionId}
                >
                  <span>{item.title ?? "Untitled conversation"}</span>
                  <time dateTime={item.updatedAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    }).format(new Date(item.updatedAt))}
                  </time>
                </button>
              ))
            )}
          </div>
        </section>
        <section aria-label="Chat preview" className="rail-chat-preview-pane">
          {previewConversation ? (
            <>
              <div className="rail-chat-preview-content">
                <MessageSquare aria-hidden="true" size={24} />
                <h2>{previewConversation.title ?? "Untitled conversation"}</h2>
              </div>
              <button
                className="rail-chat-open"
                onClick={openPreview}
                type="button"
              >
                Open chat
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

/**
 * The rail: which organization, which project, which conversation.
 *
 * It collapses to an icon strip and remembers that, because a person who works
 * in one project all day does not need the list of projects in the way. Chats
 * stay reachable from one shortcut and a searchable picker, with account
 * controls anchored at the bottom.
 */
export function Rail({
  conversations,
  conversationId,
  draftProjectName,
  onConversationSelect,
  onNewConversation,
  onOrganizationSelect,
  onProjectNameChange,
  onProjectSelect,
  onProjectSubmit,
  onSettings,
  organizationId,
  organizations,
  projectId,
  projects,
  submitting,
}: RailProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);

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
      if (event.key === "Escape") {
        if (!window.matchMedia("(max-width: 900px)").matches) {
          window.localStorage.setItem(COLLAPSED_KEY, "true");
        }
        setCollapsed(true);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeNavigation, collapsed]);

  const chooseOrganization = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onOrganizationSelect(event.currentTarget.value);
      closeNavigation();
    },
    [closeNavigation, onOrganizationSelect]
  );

  const chooseConversation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onConversationSelect(event.currentTarget.value);
      closeNavigation();
    },
    [closeNavigation, onConversationSelect]
  );

  const chooseProject = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onProjectSelect(event.currentTarget.value);
      closeNavigation();
    },
    [closeNavigation, onProjectSelect]
  );

  const startConversation = useCallback(() => {
    onNewConversation();
    closeNavigation();
  }, [closeNavigation, onNewConversation]);

  const openChatMenu = useCallback(() => setChatMenuOpen(true), []);

  const orderedConversations = useMemo(
    () =>
      [...conversations].sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      ),
    [conversations]
  );

  const selectedProject = projects.some((item) => item.projectId === projectId);
  const organizationName =
    organizations.find((item) => item.organizationId === organizationId)
      ?.name ?? "No organization";

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
          className="rail-org"
          onClick={onSettings}
          title={organizationName}
          type="button"
        >
          <span className="rail-org-mark">
            {organizationName.slice(0, 1).toUpperCase()}
          </span>
          <span className="rail-org-name">{organizationName}</span>
          <SettingsIcon aria-hidden="true" size={13} />
        </button>

        {organizations.length > 1 && (
          <select
            aria-label="Organization"
            className="rail-select"
            onChange={chooseOrganization}
            value={organizationId}
          >
            {organizations.map((item) => (
              <option key={item.organizationId} value={item.organizationId}>
                {item.name}
              </option>
            ))}
          </select>
        )}

        {selectedProject && (
          <button
            aria-expanded={collapsed ? chatMenuOpen : undefined}
            aria-haspopup="dialog"
            aria-label={collapsed ? "Browse chats" : "Start a new chat"}
            className="rail-new"
            data-active={selectedProject || undefined}
            onClick={collapsed ? openChatMenu : startConversation}
            title={collapsed ? "Browse chats" : "New chat"}
            type="button"
          >
            <SquarePen size={16} />
            <span className="rail-text">Chat</span>
          </button>
        )}

        {organizationId.length > 0 && (
          <div className="rail-block">
            <div className="rail-label">Projects</div>
            <div className="rail-list">
              {projects.map((item) => (
                <button
                  className="rail-row"
                  data-active={item.projectId === projectId || undefined}
                  key={item.projectId}
                  onClick={chooseProject}
                  title={item.name}
                  type="button"
                  value={item.projectId}
                >
                  <FolderClosed size={15} />
                  <span className="rail-text">{item.name}</span>
                </button>
              ))}
            </div>
            <form className="rail-form" onSubmit={onProjectSubmit}>
              <label className="sr-only" htmlFor="project-name">
                New project
              </label>
              <input
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
                <CirclePlus size={15} />
              </button>
            </form>
          </div>
        )}

        {selectedProject && (
          <div className="rail-block rail-chat-block">
            <div className="rail-label">Chats</div>
            {orderedConversations.length === 0 ? (
              <p className="rail-note">No chats yet.</p>
            ) : (
              <>
                <div className="rail-list rail-conversations">
                  {orderedConversations.slice(0, 1).map((item) => (
                    <button
                      aria-label={item.title ?? "Untitled conversation"}
                      className="rail-row rail-conversation"
                      data-active={
                        item.buildSessionId === conversationId || undefined
                      }
                      key={item.buildSessionId}
                      onClick={chooseConversation}
                      title={item.title ?? "Untitled conversation"}
                      type="button"
                      value={item.buildSessionId}
                    >
                      <span className="rail-text">
                        {item.title ?? "Untitled conversation"}
                      </span>
                      {item.pendingRunId !== null && (
                        <span className="live-dot" />
                      )}
                    </button>
                  ))}
                </div>
                <button
                  className="rail-see-all"
                  onClick={openChatMenu}
                  type="button"
                >
                  See all
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="rail-foot">
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rail-toggle"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          type="button"
        >
          {collapsed ? (
            <ChevronsRight aria-hidden="true" size={17} />
          ) : (
            <ChevronsLeft aria-hidden="true" size={17} />
          )}
        </button>
        <button
          aria-label="Open profile and settings"
          className="rail-profile"
          onClick={onSettings}
          title="Profile and settings"
          type="button"
        >
          <span className="rail-profile-mark">
            <CircleUserRound aria-hidden="true" size={18} />
          </span>
          <span className="rail-text">Profile</span>
        </button>
      </div>

      <ChatPicker
        conversationId={conversationId}
        conversations={orderedConversations}
        onConversationSelect={onConversationSelect}
        onNewConversation={startConversation}
        onOpenChange={setChatMenuOpen}
        open={chatMenuOpen}
      />
    </aside>
  );
}

"use client";

import { BorderBeam } from "border-beam";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Code2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderClosed,
  FolderOpen,
  Globe,
  Loader2,
  MessageSquare,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useCallback, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import "./skeleton.css";

/**
 * A layout skeleton, not a product surface.
 *
 * Every element here is markup and spacing: nothing is wired to a route, a run,
 * or a stream. It exists so the structure of the workspace can be judged and
 * corrected before the real surfaces are built against it.
 */

type Mock = "empty" | "running" | "panel";

const MOCKS: { id: Mock; label: string }[] = [
  { id: "empty", label: "Empty state" },
  { id: "running", label: "Run in progress" },
  { id: "panel", label: "Workspace panel" },
];

function ActivityGroup({
  children,
  meta,
  title,
  tone = "plain",
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
  title: string;
  tone?: "plain" | "thinking";
}) {
  return (
    <div className="sk-group" data-tone={tone}>
      <div className="sk-group-head">
        <ChevronRight aria-hidden="true" className="sk-chevron" size={13} />
        <span className="sk-group-title">{title}</span>
        {meta}
      </div>
      <div className="sk-group-body">{children}</div>
    </div>
  );
}

function ToolRow({
  detail,
  glyph,
  state,
  title,
}: {
  detail?: string;
  glyph: React.ReactNode;
  state?: "done" | "running" | "failed";
  title: string;
}) {
  return (
    <div className="sk-row" data-state={state ?? "done"}>
      <span className="sk-row-glyph">{glyph}</span>
      <span className="sk-row-title">{title}</span>
      {detail !== undefined && <span className="sk-row-detail">{detail}</span>}
      <span className="sk-row-state">
        {state === "running" ? (
          <Loader2 aria-hidden="true" size={12} />
        ) : (
          <Check aria-hidden="true" size={12} />
        )}
      </span>
    </div>
  );
}

function DiffStat({ added, removed }: { added: string; removed: string }) {
  return (
    <span className="sk-diff">
      <span className="sk-diff-add">+{added}</span>
      <span className="sk-diff-remove">-{removed}</span>
    </span>
  );
}

function Transcript() {
  return (
    <div className="sk-transcript">
      <div className="sk-user">
        <p>Build a small todo html app single file</p>
      </div>

      <ActivityGroup
        meta={<DiffStat added="9,877" removed="22" />}
        title="Worked for 12s"
      >
        <ToolRow
          detail="."
          glyph={<FolderOpen aria-hidden="true" size={13} />}
          title="Listed workspace"
        />
        <ToolRow
          detail="index.html"
          glyph={<Wrench aria-hidden="true" size={13} />}
          state="failed"
          title="Edit"
        />
        <ToolRow
          detail="index.html · 431 lines"
          glyph={<FileCode2 aria-hidden="true" size={13} />}
          title="Wrote file"
        />
        <ActivityGroup
          meta={<span className="sk-count">12</span>}
          title="Commands"
        >
          <ToolRow
            detail="node verify-todo.mjs · 20/20"
            glyph={<SquareTerminal aria-hidden="true" size={13} />}
            title="Ran verification"
          />
        </ActivityGroup>
      </ActivityGroup>

      <ActivityGroup title="Thought for 4s" tone="thinking">
        <div className="sk-thinking-head">
          <ThinkingOrb size={20} state="connecting" />
          <span>Reasoning</span>
        </div>
        <p className="sk-thinking">
          No browser and no network in the sandbox, so I cannot drive a real
          browser here. I will verify the app's own script against a DOM harness
          built from its markup.
        </p>
      </ActivityGroup>

      <div className="sk-prose">
        <p>
          Built and verified. One file: <code>index.html</code>, no
          dependencies, no build step, no network requests.
        </p>
        <ul>
          <li>Add, complete, edit, and delete todos with keyboard paths.</li>
          <li>Filters, live count, and a distinct empty state per filter.</li>
          <li>
            XSS-safe by construction: no innerHTML, eval, or document.write.
          </li>
        </ul>
      </div>

      <div className="sk-message-foot">
        <button className="sk-ghost" type="button">
          <Check aria-hidden="true" size={12} /> Copy
        </button>
        <button className="sk-ghost" type="button">
          <RotateCcw aria-hidden="true" size={12} /> Retry
        </button>
        <span className="sk-foot-meta">deepseek-flash · 41s</span>
      </div>
    </div>
  );
}

function FilesPanel() {
  return (
    <div className="sk-files">
      <div className="sk-tree">
        <div className="sk-tree-row" data-active="true">
          <FileCode2 aria-hidden="true" size={13} /> index.html
        </div>
        <div className="sk-tree-row">
          <FileCode2 aria-hidden="true" size={13} /> verify-todo.mjs
        </div>
        <div className="sk-tree-row" data-muted="true">
          <FolderClosed aria-hidden="true" size={13} /> .npm
        </div>
      </div>
      <pre className="sk-code">
        <span className="sk-ln">1</span>
        {"<!doctype html>\n"}
        <span className="sk-ln">2</span>
        {'<html lang="en">\n'}
        <span className="sk-ln">3</span>
        {"  <head>\n"}
        <span className="sk-ln">4</span>
        {'    <meta charset="utf-8" />\n'}
        <span className="sk-ln">5</span>
        {"    <title>Todos</title>\n"}
        <span className="sk-ln">6</span>
        {"  </head>\n"}
        <span className="sk-ln">7</span>
        {"  <body>\n"}
        <span className="sk-ln">8</span>
        {'    <main id="app"></main>\n'}
        <span className="sk-ln">9</span>
        {"  </body>\n"}
        <span className="sk-ln">10</span>
        {"</html>"}
      </pre>
    </div>
  );
}

function WorkspacePanel() {
  const [tab, setTab] = useState<"files" | "preview">("preview");

  const showFiles = useCallback(() => setTab("files"), []);
  const showPreview = useCallback(() => setTab("preview"), []);

  return (
    <aside className="sk-panel">
      <div className="sk-panel-head">
        <div className="sk-tabs">
          <button
            className="sk-tab"
            data-active={tab === "preview" || undefined}
            onClick={showPreview}
            type="button"
          >
            <Eye aria-hidden="true" size={13} /> Preview
          </button>
          <button
            className="sk-tab"
            data-active={tab === "files" || undefined}
            onClick={showFiles}
            type="button"
          >
            <Code2 aria-hidden="true" size={13} /> Files
          </button>
        </div>
        <div className="sk-panel-tools">
          <button className="sk-ghost" type="button">
            <RefreshCw aria-hidden="true" size={12} /> Refresh
          </button>
        </div>
      </div>
      {tab === "files" ? (
        <FilesPanel />
      ) : (
        <>
          <div className="sk-chrome">
            <Globe aria-hidden="true" size={12} />
            <span className="sk-url">preview.reasonate.ai/todo-8f2c</span>
            <ExternalLink aria-hidden="true" size={12} />
          </div>
          <div className="sk-preview">
            <div className="sk-preview-card">
              <h3>Todos</h3>
              <p className="sk-preview-note">
                The generated app runs here in its own sandbox origin.
              </p>
              <div className="sk-preview-row">
                <span className="sk-preview-box" /> Buy milk
              </div>
              <div className="sk-preview-row">
                <span className="sk-preview-box" data-done="true" /> Ship the
                todo app
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function Composer() {
  return (
    <div className="sk-composer">
      <BorderBeam colorVariant="mono" size="line" strength={0.7}>
        <div className="sk-composer-box">
          <textarea
            className="sk-composer-input"
            placeholder="Describe the product, or the change you want next…"
            readOnly
            rows={1}
          />
          <button aria-label="Send" className="sk-send" type="button">
            <ArrowUp size={15} />
          </button>
        </div>
      </BorderBeam>
      <div className="sk-composer-foot">
        <span>Enter to send, Shift + Enter for a new line.</span>
        <span className="sk-model">deepseek-flash</span>
      </div>
    </div>
  );
}

export default function Skeleton() {
  const [mock, setMock] = useState<Mock>("running");
  const [rail, setRail] = useState<"icons" | "wide">("icons");

  const toggleRail = useCallback(
    () => setRail((current) => (current === "icons" ? "wide" : "icons")),
    []
  );

  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      setMock(event.currentTarget.value as Mock),
    []
  );

  return (
    <div className="sk-app" data-rail={rail}>
      <aside className="sk-rail">
        <div className="sk-rail-top">
          <span className="sk-mark" />
          <span className="sk-wordmark">
            reasonate<span>AI</span>
          </span>
        </div>
        <button
          aria-label={
            rail === "icons" ? "Expand the sidebar" : "Collapse the sidebar"
          }
          className="sk-rail-toggle"
          onClick={toggleRail}
          type="button"
        >
          {rail === "icons" ? (
            <ChevronRight size={14} />
          ) : (
            <ChevronLeft size={14} />
          )}
        </button>
        <nav className="sk-rail-nav">
          <button className="sk-rail-item" data-active="true" type="button">
            <MessageSquare aria-hidden="true" size={16} />
            <span className="sk-rail-label">Chat</span>
          </button>
          <button className="sk-rail-item" type="button">
            <FolderClosed aria-hidden="true" size={16} />
            <span className="sk-rail-label">Projects</span>
          </button>
          <button className="sk-rail-item" type="button">
            <Sparkles aria-hidden="true" size={16} />
            <span className="sk-rail-label">Runs</span>
          </button>
        </nav>
        <div className="sk-rail-foot">
          <button className="sk-rail-item" type="button">
            <Settings aria-hidden="true" size={16} />
            <span className="sk-rail-label">Settings</span>
          </button>
        </div>
      </aside>

      <section className="sk-side">
        <div className="sk-side-head">
          <select className="sk-org" defaultValue="workspace">
            <option value="workspace">Mohan&apos;s workspace</option>
          </select>
        </div>
        <button className="sk-new" type="button">
          <CirclePlus aria-hidden="true" size={15} /> New conversation
        </button>
        <div className="sk-side-block">
          <div className="sk-side-label">Projects</div>
          <div className="sk-side-row" data-active="true">
            <FolderClosed aria-hidden="true" size={13} /> A small app
          </div>
        </div>
        <div className="sk-side-block">
          <div className="sk-side-label">Conversations</div>
          <div className="sk-side-row" data-active="true">
            Build a small todo html app…
          </div>
          <div className="sk-side-row">Landing page for launch</div>
        </div>
      </section>

      <main className="sk-main">
        <header className="sk-head">
          <div>
            <div className="sk-title">
              Build a small todo html app single file
            </div>
            <div className="sk-sub">
              A small app · <span data-state="ready">Ready</span>
            </div>
          </div>
          <div className="sk-head-tools">
            <button className="sk-ghost" type="button">
              <PanelRight aria-hidden="true" size={13} /> Panel
            </button>
          </div>
        </header>

        {mock === "empty" ? (
          <div className="sk-empty">
            <span className="sk-mark sk-mark-lg" />
            <h1>What are we building?</h1>
            <p>
              Describe the product, the change, or the problem. Everything stays
              with this project.
            </p>
            <Composer />
            <div className="sk-starters">
              <span className="sk-starter">
                <Sparkles aria-hidden="true" size={12} /> Build a simple app for
                my idea
              </span>
              <span className="sk-starter">
                <Sparkles aria-hidden="true" size={12} /> Improve an existing
                project
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="sk-scroll">
              <Transcript />
              <button
                aria-label="Scroll to the newest message"
                className="sk-scroll-bottom"
                type="button"
              >
                <ArrowDown size={15} />
              </button>
            </div>
            <Composer />
          </>
        )}
      </main>

      {mock === "panel" ? <WorkspacePanel /> : null}

      <div className="sk-switch">
        {MOCKS.map((item) => (
          <button
            className="sk-switch-item"
            data-active={item.id === mock || undefined}
            key={item.id}
            onClick={choose}
            type="button"
            value={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

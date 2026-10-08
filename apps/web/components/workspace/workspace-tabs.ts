export type WorkspaceView =
  | "new"
  | "preview"
  | "files"
  | "changes"
  | "activity";
export interface WorkspaceTab {
  id: string;
  view: WorkspaceView;
}
export interface WorkspaceTabs {
  activeId: string;
  tabs: WorkspaceTab[];
}
export const MAX_WORKSPACE_TABS = 8;
export const INITIAL_WORKSPACE_TABS: WorkspaceTabs = {
  activeId: "preview",
  tabs: [
    { id: "preview", view: "preview" },
    { id: "files", view: "files" },
  ],
};

function isView(value: unknown): value is WorkspaceView {
  return (
    value === "new" ||
    value === "preview" ||
    value === "files" ||
    value === "changes" ||
    value === "activity"
  );
}

/** Only view identifiers are saved; content and credentials never enter storage. */
export function parseWorkspaceTabs(value: unknown): WorkspaceTabs | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("activeId" in value) ||
    !("tabs" in value) ||
    typeof value.activeId !== "string" ||
    !Array.isArray(value.tabs) ||
    value.tabs.length === 0 ||
    value.tabs.length > MAX_WORKSPACE_TABS
  ) {
    return;
  }
  const tabs: WorkspaceTab[] = [];
  for (const item of value.tabs) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      !("view" in item) ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 128 ||
      !isView(item.view) ||
      tabs.some((tab) => tab.id === item.id)
    ) {
      return;
    }
    tabs.push({ id: item.id, view: item.view });
  }
  if (!tabs.some((tab) => tab.id === value.activeId)) {
    return;
  }
  return { activeId: value.activeId, tabs };
}

export function addWorkspaceTab(
  state: WorkspaceTabs,
  id: string
): WorkspaceTabs {
  const existing = state.tabs.find((tab) => tab.view === "new");
  if (existing) {
    return { ...state, activeId: existing.id };
  }
  if (state.tabs.length >= MAX_WORKSPACE_TABS) {
    return state;
  }
  return { activeId: id, tabs: [...state.tabs, { id, view: "new" }] };
}

export function chooseWorkspaceView(
  state: WorkspaceTabs,
  id: string,
  view: WorkspaceView
): WorkspaceTabs {
  if (!state.tabs.some((tab) => tab.id === id)) {
    return state;
  }
  const existing = state.tabs.find((tab) => tab.view === view && tab.id !== id);
  if (existing && view !== "new") {
    return {
      activeId: existing.id,
      tabs: state.tabs.filter((tab) => tab.id !== id || tab.view !== "new"),
    };
  }
  return {
    activeId: id,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, view } : tab)),
  };
}

export function closeWorkspaceTab(
  state: WorkspaceTabs,
  id: string
): WorkspaceTabs {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) {
    return { activeId: "new", tabs: [{ id: "new", view: "new" }] };
  }
  return {
    activeId:
      state.activeId === id
        ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "new")
        : state.activeId,
    tabs,
  };
}

export function openWorkspaceView(
  state: WorkspaceTabs,
  view: WorkspaceView,
  id: string
): WorkspaceTabs {
  const existing = state.tabs.find((tab) => tab.view === view);
  if (existing) {
    return { ...state, activeId: existing.id };
  }
  const opened = addWorkspaceTab(state, id);
  return chooseWorkspaceView(opened, opened.activeId, view);
}

export const workspaceTabsKey = (
  organizationId: string,
  projectId: string,
  buildSessionId: string
) =>
  `reasonate.workspace.tabs:${organizationId}:${projectId}:${buildSessionId}`;

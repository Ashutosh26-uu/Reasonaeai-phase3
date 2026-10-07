import { describe, expect, it } from "vitest";
import {
  addWorkspaceTab,
  chooseWorkspaceView,
  closeWorkspaceTab,
  INITIAL_WORKSPACE_TABS,
  openWorkspaceView,
  parseWorkspaceTabs,
  workspaceTabsKey,
} from "./workspace-tabs";

describe("conversation workspace tabs", () => {
  it("opens the running app without replacing files or duplicating preview tabs", () => {
    const files = { ...INITIAL_WORKSPACE_TABS, activeId: "files" };
    expect(openWorkspaceView(files, "preview", "app")).toEqual(
      INITIAL_WORKSPACE_TABS
    );
    const closed = closeWorkspaceTab(files, "preview");
    const reopened = openWorkspaceView(closed, "preview", "app");
    expect(reopened.tabs.map((tab) => tab.view)).toEqual(["files", "preview"]);
    expect(reopened.activeId).toBe("app");
  });
  it("opens a generic view chooser, selects a tool, and keeps existing preview/file tabs", () => {
    const opened = addWorkspaceTab(INITIAL_WORKSPACE_TABS, "chooser");
    const changes = chooseWorkspaceView(opened, "chooser", "changes");
    expect(changes.tabs.map((tab) => tab.view)).toEqual([
      "preview",
      "files",
      "changes",
    ]);
    expect(changes.activeId).toBe("chooser");
    expect(
      chooseWorkspaceView(
        addWorkspaceTab(changes, "another"),
        "another",
        "files"
      )
    ).toEqual({ activeId: "files", tabs: changes.tabs });
  });
  it("closes the selected tab to a neighbor and retains a chooser when the final view closes", () => {
    const next = closeWorkspaceTab(INITIAL_WORKSPACE_TABS, "preview");
    expect(next.activeId).toBe("files");
    expect(closeWorkspaceTab(next, "files")).toEqual({
      activeId: "new",
      tabs: [{ id: "new", view: "new" }],
    });
  });
  it("bounds restored state, rejects corrupt selection and duplicate identities", () => {
    expect(parseWorkspaceTabs(INITIAL_WORKSPACE_TABS)).toEqual(
      INITIAL_WORKSPACE_TABS
    );
    expect(
      parseWorkspaceTabs({ ...INITIAL_WORKSPACE_TABS, activeId: "missing" })
    ).toBeUndefined();
    expect(
      parseWorkspaceTabs({
        activeId: "x",
        tabs: [{ id: "x", view: "browser" }],
      })
    ).toBeUndefined();
    expect(
      parseWorkspaceTabs({
        activeId: "x",
        tabs: Array.from({ length: 9 }, (_, id) => ({
          id: String(id),
          view: "new",
        })),
      })
    ).toBeUndefined();
    expect(
      parseWorkspaceTabs({
        activeId: "preview",
        tabs: [INITIAL_WORKSPACE_TABS.tabs[0], INITIAL_WORKSPACE_TABS.tabs[0]],
      })
    ).toBeUndefined();
  });
  it("isolates stored layout across organizations, projects, and conversations", () => {
    const key = workspaceTabsKey("org-a", "project-a", "conversation-a");
    expect(workspaceTabsKey("org-b", "project-a", "conversation-a")).not.toBe(
      key
    );
    expect(workspaceTabsKey("org-a", "project-b", "conversation-a")).not.toBe(
      key
    );
    expect(workspaceTabsKey("org-a", "project-a", "conversation-b")).not.toBe(
      key
    );
  });
});

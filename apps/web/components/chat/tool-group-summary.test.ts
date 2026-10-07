import { describe, expect, it } from "vitest";
import type { ToolEntry } from "./timeline";
import { toolGroupSummary } from "./tool-group-summary";

function tool(
  name: string,
  id = name,
  state: ToolEntry["state"] = "output-available",
  input: unknown = {}
): ToolEntry {
  return {
    children: [],
    endedAt: null,
    id,
    input,
    name,
    output: null,
    startedAt: "2026-10-04T00:00:00.000Z",
    state,
    text: "",
  };
}
describe("tool group summaries", () => {
  it("uses distinct action categories and singular/plural counts", () => {
    expect(
      toolGroupSummary([
        tool("edit", "1"),
        tool("edit", "2"),
        tool("run_command", "3"),
      ])
    ).toMatchObject({
      count: 3,
      iconTool: "edit",
      label: "Edited files, ran a command",
    });
    expect(
      toolGroupSummary([
        tool("read"),
        tool("run_command", "1"),
        tool("run_command", "2"),
      ]).label
    ).toBe("Ran commands, read a file");
    expect(
      toolGroupSummary([tool("edit"), tool("run_command"), tool("web_search")])
        .label
    ).toBe("Edited a file, ran a command, searched the web");
  });
  it("alphabetizes summary phrases independently of chronological tool order", () => {
    const tools = [
      tool("web_search"),
      tool("run_command", "first-command"),
      tool("edit", "first-edit"),
      tool("run_command", "second-command"),
      tool("edit", "second-edit"),
    ];
    expect(toolGroupSummary(tools).label).toBe(
      "Edited files, ran commands, searched the web"
    );
    expect(tools.map((entry) => entry.id)).toEqual([
      "web_search",
      "first-command",
      "first-edit",
      "second-command",
      "second-edit",
    ]);
  });
  it("recognizes workspace-prefixed tools and resource reads", () => {
    expect(
      toolGroupSummary([
        tool("mastra_workspace_edit_file"),
        tool("mastra_workspace_execute_command"),
      ]).label
    ).toBe("Edited a file, ran a command");
    expect(
      toolGroupSummary([
        tool("read", "read-web", "output-available", {
          target: "https://example.test",
        }),
      ]).label
    ).toBe("Opened a page");
  });
  it("counts each identity once and preserves unknown tools", () => {
    expect(
      toolGroupSummary([tool("read", "same"), tool("read", "same")])
    ).toMatchObject({ count: 1, label: "Read a file" });
    expect(toolGroupSummary([tool("custom-action")]).label).toBe("Used a tool");
  });
  it("does not describe active, failed, denied, or approval-gated calls as successful", () => {
    expect(toolGroupSummary([tool("edit", "1", "input-available")]).label).toBe(
      "Editing a file"
    );
    expect(toolGroupSummary([tool("edit", "1", "output-error")]).label).toBe(
      "Tried to edit a file"
    );
    expect(
      toolGroupSummary([tool("run_command", "1", "output-denied")]).label
    ).toBe("Permission declined to run a command");
    expect(
      toolGroupSummary([tool("write", "1", "approval-requested")]).label
    ).toBe("Awaiting approval to write a file");
  });
});

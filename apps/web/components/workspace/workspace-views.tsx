"use client";

import type { ConversationMessage } from "@reasonateai/contracts/execution";
import { FileDiff, FolderClosed, Globe2, ListChecks } from "lucide-react";
import { useCallback } from "react";
import { ActivityOutline } from "@/components/chat/activity";
import { CheckpointCard } from "@/components/chat/checkpoint-card";
import {
  type CheckpointScope,
  turnCheckpoint,
} from "@/components/chat/checkpoint-state";
import {
  projectTranscript,
  type Timeline,
  type ToolEntry,
  type TranscriptEntry,
} from "@/components/chat/timeline";
import type { WorkspaceView } from "./workspace-tabs";

export const WORKSPACE_VIEWS = [
  {
    detail: "Run and inspect the generated app",
    icon: Globe2,
    title: "App preview",
    view: "preview",
  },
  {
    detail: "Browse source files in the saved workspace",
    icon: FolderClosed,
    title: "Files",
    view: "files",
  },
  {
    detail: "Review saved file changes and diffs",
    icon: FileDiff,
    title: "Changes",
    view: "changes",
  },
  {
    detail: "Follow tools, commands, and their results",
    icon: ListChecks,
    title: "Run activity",
    view: "activity",
  },
] as const;

export function NewWorkspaceTab({
  onChoose,
}: {
  onChoose: (view: WorkspaceView) => void;
}) {
  const choose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const option = WORKSPACE_VIEWS.find(
        (item) => item.view === event.currentTarget.value
      );
      if (option) {
        onChoose(option.view);
      }
    },
    [onChoose]
  );
  return (
    <div className="workspace-new-tab">
      <h2>Open a workspace view</h2>
      <p>These views belong to the current conversation.</p>
      <div className="workspace-view-choices">
        {WORKSPACE_VIEWS.map(({ view, icon: Icon, title, detail }) => (
          <button key={view} onClick={choose} type="button" value={view}>
            <Icon aria-hidden="true" size={22} />
            <span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChangesView({
  scope,
  timeline,
}: {
  scope: CheckpointScope;
  timeline: Timeline;
}) {
  const checkpoints = Object.values(timeline.runs)
    .map((run) => turnCheckpoint(Object.values(run.events)))
    .filter((turn) => turn !== undefined);
  return (
    <div className="workspace-detail-view">
      <h2>Saved changes</h2>
      {checkpoints.length === 0 ? (
        <p>No saved changes yet. Checkpoints appear after a run finishes.</p>
      ) : (
        checkpoints.map((turn) => (
          <CheckpointCard
            key={`${turn.runId}:${turn.sequence}`}
            scope={scope}
            turn={turn}
          />
        ))
      )}
    </div>
  );
}

function entryTools(entry: TranscriptEntry): ToolEntry[] {
  if (entry.kind === "tool") {
    return [entry.tool];
  }
  return [];
}

export function RunActivityView({
  messages,
  timeline,
}: {
  messages: ConversationMessage[];
  timeline: Timeline;
}) {
  const turns = projectTranscript(timeline, messages)
    .map((turn) => ({ ...turn, tools: turn.entries.flatMap(entryTools) }))
    .filter((turn) => turn.tools.length > 0);
  return (
    <div className="workspace-detail-view">
      <h2>Run activity</h2>
      <p>
        Recorded tool calls and command output. This view updates with the
        conversation’s event stream.
      </p>
      {turns.length === 0 ? (
        <p>No tool activity recorded in this conversation yet.</p>
      ) : (
        turns.map((turn) => (
          <section key={turn.id}>
            <h3>{turn.user?.text || "Run"}</h3>
            {turn.tools.map((tool) => (
              <ActivityOutline key={tool.id} tool={tool} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

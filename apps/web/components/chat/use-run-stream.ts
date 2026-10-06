"use client";

import {
  RUN_LIVE_EVENT_KINDS,
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  RunEventTypeSchema,
  RunLiveEventSchema,
} from "@reasonateai/contracts/execution-protocol";
import { useEffect, useRef, useState } from "react";
import { runStreamEnded } from "./run-state";
import {
  EMPTY_TIMELINE,
  foldDurable,
  foldLive,
  type Timeline,
} from "./timeline";

export interface RunStreamInput {
  active: { buildSessionId: string; pendingRunId: string | null } | undefined;
  historyEvents: RunEventEnvelope[];
  onEnded: () => void;
  onInterrupted: (reason: string) => void;
  onOpened: () => void;
  organizationId: string;
  projectId: string;
}

export function useRunStream(input: RunStreamInput) {
  const { active, organizationId, projectId, historyEvents } = input;
  const identity = `${organizationId}:${projectId}:${active?.buildSessionId ?? ""}`;
  const [state, setState] = useState<{ identity: string; timeline: Timeline }>({
    identity,
    timeline: EMPTY_TIMELINE,
  });
  const [following, setFollowing] = useState(false);
  const handlers = useRef(input);
  handlers.current = input;
  const selected = useRef(identity);
  selected.current = identity;
  const currentRuns = useRef(new Set<string>());
  currentRuns.current = new Set(
    historyEvents.map((event) => String(event.runId))
  );
  if (active?.pendingRunId) {
    currentRuns.current.add(active.pendingRunId);
  }

  useEffect(() => {
    const retainedRuns = new Set<string>(
      historyEvents.map((event) => event.runId)
    );
    if (active?.pendingRunId) {
      retainedRuns.add(active.pendingRunId);
    }
    setState((current) => ({
      identity,
      timeline: historyEvents.reduce(
        foldDurable,
        current.identity === identity
          ? {
              ...current.timeline,
              runs: Object.fromEntries(
                Object.entries(current.timeline.runs).filter(([runId]) =>
                  retainedRuns.has(runId)
                )
              ),
            }
          : EMPTY_TIMELINE
      ),
    }));
  }, [identity, historyEvents, active?.pendingRunId]);

  const buildSessionId = active?.buildSessionId;
  const pendingRunId = active?.pendingRunId;
  useEffect(() => {
    if (!buildSessionId) {
      setFollowing(false);
      return;
    }
    let closed = false;
    const requestId = crypto.randomUUID();
    let lastSequence = 0;
    const diagnostic = (event: string) =>
      JSON.stringify({
        buildSessionId,
        event,
        lastSequence,
        organizationId,
        projectId,
        requestId,
        runId: pendingRunId,
      });
    const source = new EventSource(
      `/v1/build-sessions/${buildSessionId}/events?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}&requestId=${requestId}`
    );
    const durable = (frame: MessageEvent<string>) => {
      if (closed || selected.current !== identity) {
        return;
      }
      const parsed = RunEventEnvelopeSchema.safeParse(parseJson(frame.data));
      if (
        !parsed.success ||
        parsed.data.organizationId !== organizationId ||
        parsed.data.projectId !== projectId ||
        !currentRuns.current.has(parsed.data.runId)
      ) {
        return;
      }
      const event = parsed.data;
      lastSequence = event.sequence;
      setState((current) => ({
        identity,
        timeline: foldDurable(
          current.identity === identity ? current.timeline : EMPTY_TIMELINE,
          event
        ),
      }));
      if (runStreamEnded([event], false) && pendingRunId === event.runId) {
        handlers.current.onEnded();
      }
    };
    const live = (frame: MessageEvent<string>) => {
      if (closed || selected.current !== identity) {
        return;
      }
      const parsed = RunLiveEventSchema.safeParse(parseJson(frame.data));
      if (
        !parsed.success ||
        parsed.data.organizationId !== organizationId ||
        parsed.data.projectId !== projectId ||
        !currentRuns.current.has(parsed.data.runId)
      ) {
        return;
      }
      setState((current) => ({
        identity,
        timeline: foldLive(
          current.identity === identity ? current.timeline : EMPTY_TIMELINE,
          parsed.data
        ),
      }));
    };
    for (const type of RunEventTypeSchema.options) {
      source.addEventListener(type, durable as EventListener);
    }
    for (const type of RUN_LIVE_EVENT_KINDS) {
      source.addEventListener(type, live as EventListener);
    }
    source.onopen = () => {
      if (!closed) {
        setFollowing(true);
        console.info(diagnostic("run.stream.connected"));
        handlers.current.onOpened();
      }
    };
    source.onerror = () => {
      if (closed) {
        return;
      }
      setFollowing(false);
      console.warn(diagnostic("run.stream.interrupted"));
      if (pendingRunId) {
        handlers.current.onInterrupted("Connection interrupted. Reconnecting…");
      }
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [buildSessionId, identity, organizationId, pendingRunId, projectId]);
  const timeline =
    state.identity === identity ? state.timeline : EMPTY_TIMELINE;
  return { following, live: timeline.sawLiveText, timeline };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

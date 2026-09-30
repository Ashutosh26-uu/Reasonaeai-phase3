"use client";

import {
  type RunEventEnvelope,
  RunEventEnvelopeSchema,
  RunEventIdSchema,
} from "@reasonateai/contracts/execution-protocol";
import {
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "@reasonateai/contracts/identity";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConversationState,
  initialConversationState,
  reduceConversationEvent,
} from "../lib/conversation-state";
import {
  RunEventStream,
  type StreamConnectionState,
  type StreamStateDetail,
} from "../lib/run-event-stream";

export interface UseRunEventsOptions {
  /** Whether to connect automatically on mount (default true) */
  autoConnect?: boolean | undefined;
  /** Optional API base URL */
  baseUrl?: string | undefined;
  /** Target BuildSession ID (UUID) */
  buildSessionId: string;
  /** Organization ID (UUID) */
  organizationId: string;
  /** Project ID (UUID) */
  projectId: string;
}

export interface UseRunEventsReturn {
  addUserMessage: (text: string) => void;
  connectionDetail?: StreamStateDetail | undefined;
  connectionState: StreamConnectionState;
  conversation: ConversationState;
  reconnect: () => void;
  resolveApprovalLocally: (toolCallId: string, resolution: unknown) => void;
}

export function useRunEvents(options: UseRunEventsOptions): UseRunEventsReturn {
  const {
    buildSessionId,
    organizationId,
    projectId,
    baseUrl,
    autoConnect = true,
  } = options;

  const [conversation, setConversation] = useState<ConversationState>(() =>
    initialConversationState()
  );
  const [connectionState, setConnectionState] =
    useState<StreamConnectionState>("idle");
  const [connectionDetail, setConnectionDetail] = useState<
    StreamStateDetail | undefined
  >(undefined);

  const streamRef = useRef<RunEventStream | null>(null);

  const handleEvent = useCallback((event: RunEventEnvelope) => {
    setConversation((prev) => reduceConversationEvent(prev, event));
  }, []);

  const handleConnectionChange = useCallback(
    (state: StreamConnectionState, detail?: StreamStateDetail | undefined) => {
      setConnectionState(state);
      setConnectionDetail(detail);
    },
    []
  );

  useEffect(() => {
    if (!(buildSessionId && organizationId && projectId && autoConnect)) {
      return;
    }

    const stream = new RunEventStream({
      baseUrl,
      buildSessionId,
      onConnectionStateChange: handleConnectionChange,
      onEvent: handleEvent,
      organizationId,
      projectId,
    });

    streamRef.current = stream;
    stream.connect();

    return () => {
      stream.close();
      streamRef.current = null;
    };
  }, [
    buildSessionId,
    organizationId,
    projectId,
    baseUrl,
    autoConnect,
    handleEvent,
    handleConnectionChange,
  ]);

  const reconnect = useCallback(() => {
    streamRef.current?.reconnectNow();
  }, []);

  const addUserMessage = useCallback(
    (text: string) => {
      const optimisticEvent = RunEventEnvelopeSchema.parse({
        eventId: RunEventIdSchema.parse(crypto.randomUUID()),
        occurredAt: new Date().toISOString(),
        organizationId: OrganizationIdSchema.parse(organizationId),
        payload: {
          kind: "message_end",
          messageId: crypto.randomUUID(),
          role: "user",
          text,
        },
        projectId: ProjectIdSchema.parse(projectId),
        runId: RunIdSchema.parse(crypto.randomUUID()),
        schemaVersion: 1,
        sequence: 0,
        type: "agent.progress",
      });
      setConversation((prev) => reduceConversationEvent(prev, optimisticEvent));
    },
    [organizationId, projectId]
  );

  const resolveApprovalLocally = useCallback(
    (toolCallId: string, resolution: unknown) => {
      const optimisticResolved = RunEventEnvelopeSchema.parse({
        eventId: RunEventIdSchema.parse(crypto.randomUUID()),
        occurredAt: new Date().toISOString(),
        organizationId: OrganizationIdSchema.parse(organizationId),
        payload: {
          kind: "tool_approval_resolved",
          resolution,
          toolCallId,
        },
        projectId: ProjectIdSchema.parse(projectId),
        runId: RunIdSchema.parse(crypto.randomUUID()),
        schemaVersion: 1,
        sequence: 0,
        type: "approval.resolved",
      });
      setConversation((prev) =>
        reduceConversationEvent(prev, optimisticResolved)
      );
    },
    [organizationId, projectId]
  );

  return {
    addUserMessage,
    connectionDetail,
    connectionState,
    conversation,
    reconnect,
    resolveApprovalLocally,
  };
}

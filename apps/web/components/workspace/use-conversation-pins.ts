"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "reasonate.rail.pinned-conversations";

export function useConversationPins(organizationId: string) {
  const [state, setState] = useState<{ organizationId: string; ids: string[] }>(
    { ids: [], organizationId: "" }
  );
  useEffect(() => {
    let ids: string[] = [];
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem(`${KEY}:${organizationId}`) ?? "[]"
      );
      if (
        Array.isArray(stored) &&
        stored.every((item) => typeof item === "string")
      ) {
        ids = stored;
      }
    } catch {
      ids = [];
    }
    setState({ ids, organizationId });
  }, [organizationId]);
  useEffect(() => {
    if (state.organizationId === organizationId) {
      window.localStorage.setItem(
        `${KEY}:${organizationId}`,
        JSON.stringify(state.ids)
      );
    }
  }, [organizationId, state]);
  const togglePin = useCallback(
    (id: string) => {
      setState((current) =>
        current.organizationId === organizationId
          ? {
              ...current,
              ids: current.ids.includes(id)
                ? current.ids.filter((value) => value !== id)
                : [id, ...current.ids],
            }
          : current
      );
    },
    [organizationId]
  );
  return {
    pinnedConversationIds:
      state.organizationId === organizationId ? state.ids : [],
    togglePin,
  };
}

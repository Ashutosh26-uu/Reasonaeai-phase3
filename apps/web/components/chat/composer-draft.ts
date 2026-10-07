import type { SetStateAction } from "react";

/** Mounted-workspace memory, subscribed to by the composer alone. */
export function createComposerDraft() {
  let value = "";
  const listeners = new Set<() => void>();
  return {
    getServerSnapshot: () => "",
    getSnapshot: () => value,
    setValue: (update: SetStateAction<string>) => {
      const next = typeof update === "function" ? update(value) : update;
      if (next === value) {
        return;
      }
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ComposerDraft = ReturnType<typeof createComposerDraft>;

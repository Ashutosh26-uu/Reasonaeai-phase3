"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Composer, type ComposerProps } from "./composer";
import type { ComposerDraft } from "./composer-draft";

/** Keystrokes update this boundary without rerendering the workspace history. */
export function DraftComposer({
  draftStore,
  ...props
}: Omit<ComposerProps, "count" | "draft" | "onChange"> & {
  draftStore: ComposerDraft;
}) {
  const draft = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.getSnapshot,
    draftStore.getServerSnapshot
  );
  const change = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      draftStore.setValue(event.currentTarget.value);
    },
    [draftStore]
  );
  return (
    <Composer {...props} count={draft.length} draft={draft} onChange={change} />
  );
}

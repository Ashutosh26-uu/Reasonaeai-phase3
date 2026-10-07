import { describe, expect, it, vi } from "vitest";
import { createComposerDraft } from "./composer-draft";

describe("composer draft updates", () => {
  it("notifies mounted subscribers immediately and stops after unsubscribe", () => {
    const draft = createComposerDraft();
    const seen: string[] = [];
    const unsubscribe = draft.subscribe(() => seen.push(draft.getSnapshot()));
    draft.setValue("a");
    draft.setValue("ab");
    draft.setValue("ab");
    unsubscribe();
    draft.setValue("abc");
    expect(seen).toEqual(["a", "ab"]);
    expect(draft.getSnapshot()).toBe("abc");
  });

  it("retains edits made while a sent message is awaiting acknowledgement", () => {
    const draft = createComposerDraft();
    draft.setValue("First message");
    const sent = draft.getSnapshot();
    draft.setValue("New follow-up");
    draft.setValue((current) =>
      current.trim() === sent.trim() ? "" : current
    );
    expect(draft.getSnapshot()).toBe("New follow-up");
    draft.setValue((current) =>
      current.trim() === "New follow-up" ? "" : current
    );
    expect(draft.getSnapshot()).toBe("");
  });

  it("preserves a draft across composer remounts and keeps workspace instances independent", () => {
    const draft = createComposerDraft();
    const unsubscribe = draft.subscribe(vi.fn());
    draft.setValue("Follow-up while the first conversation is allocated");
    unsubscribe();
    const nextSubscriber = vi.fn();
    draft.subscribe(nextSubscriber);
    expect(draft.getSnapshot()).toBe(
      "Follow-up while the first conversation is allocated"
    );
    const otherWorkspace = createComposerDraft();
    expect(otherWorkspace.getSnapshot()).toBe("");
    expect(draft.getServerSnapshot()).toBe("");
    draft.setValue("");
    expect(nextSubscriber).toHaveBeenCalledOnce();
  });
});

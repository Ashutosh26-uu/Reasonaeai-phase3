import { randomUUID } from "node:crypto";
import { ConversationMessageSchema } from "@reasonateai/contracts/execution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messageAnchor, messageNavigationItems } from "./message-navigation";
import { EMPTY_TIMELINE, type TranscriptTurn } from "./timeline";
import { Transcript } from "./transcript";

const message = (text: string) =>
  ConversationMessageSchema.parse({
    createdAt: "2026-10-06T00:00:00.000Z",
    id: randomUUID(),
    reasoning: "",
    role: "user",
    runId: randomUUID(),
    sourceId: randomUUID(),
    text,
  });

describe("message navigation", () => {
  it("lists user and steering messages in their transcript order with distinct anchors", () => {
    const first = message("Use a dark canvas");
    const second = message("Use a dark canvas");
    const turns: TranscriptTurn[] = [
      {
        entries: [
          { id: "answer", kind: "text", streaming: false, text: "Done" },
          {
            active: false,
            id: "first:steering:1",
            kind: "steering",
            status: "delivered",
            text: "Make it blue",
          },
        ],
        id: "first",
        user: first,
      },
      { entries: [], id: "second", user: second },
    ];
    const items = messageNavigationItems(turns);
    expect(items.map((item) => item.title)).toEqual([
      "Use a dark canvas",
      "Make it blue",
      "Use a dark canvas",
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
  });

  it("renders message targets and a named minimap without including assistant text", () => {
    const user = message("Jump to this request");
    const html = renderToStaticMarkup(
      <Transcript
        live={false}
        messages={[user]}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        timeline={EMPTY_TIMELINE}
      />
    );
    expect(html).toContain(`id="${messageAnchor(user.id)}"`);
    expect(html).toContain('aria-label="Your messages"');
    expect(html).toContain("Jump to message 1: Jump to this request");
    expect(html).toContain('tabindex="-1"');
  });

  it("does not render navigation for an empty chat", () => {
    const html = renderToStaticMarkup(
      <Transcript
        live={false}
        messages={[]}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        timeline={EMPTY_TIMELINE}
      />
    );
    expect(html).not.toContain('aria-label="Your messages"');
  });
});

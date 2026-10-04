import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "./message-queue";
import { QueuedMessageRow } from "./queued-messages";

function row(id: string): QueuedMessage {
  return {
    attachments: [],
    id,
    message: `Queued ${id}`,
    projectId: "project",
    scopeKey: "conversation",
  };
}

function renderRow(queued: QueuedMessage, error?: string) {
  return (
    <QueuedMessageRow
      error={error}
      limit={20_000}
      onEdit={vi.fn()}
      onOpenSideChat={vi.fn()}
      onRemove={vi.fn()}
      onSend={vi.fn()}
      onToggleQueueing={vi.fn()}
      pending
      queued={queued}
      queueing
      sending={false}
      steerDisabled={queued.attachments.length > 0}
    />
  );
}

describe("queued message cards", () => {
  it("renders ordered compact rows with steering, deletion, and menu controls", () => {
    const html = renderToStaticMarkup(
      <ul>
        {renderRow(row("first"))}
        {renderRow(row("second"))}
      </ul>
    );
    expect(html.indexOf("Queued first")).toBeLessThan(
      html.indexOf("Queued second")
    );
    expect(html.match(/aria-label="Delete queued message"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Queued message actions"/g)).toHaveLength(2);
    expect(html.match(/lucide-corner-down-right/g)).toHaveLength(2);
    expect(html.match(/lucide-list-end/g)).toHaveLength(2);
  });

  it("renders retained attachment thumbnails and an actionable failed-delivery message", () => {
    const queued = {
      ...row("wireframe"),
      attachments: [
        {
          data: "data:image/png;base64,YQ==",
          filename: "wireframe.png",
          mediaType: "image/png",
        },
      ],
    };
    const html = renderToStaticMarkup(
      renderRow(queued, "Delivery failed; this message is still queued.")
    );
    expect(html).toContain('alt="wireframe.png"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("this message is still queued");
    expect(html).toContain("Attachments will send as a follow-up");
  });
});

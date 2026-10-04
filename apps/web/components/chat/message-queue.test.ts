import { describe, expect, it } from "vitest";
import {
  appendQueuedMessage,
  bindQueuedDelivery,
  mayAutomaticallyDeliver,
  type QueuedMessage,
  queuedSubmission,
  removeQueuedMessage,
} from "./message-queue";

function message(id: string, text = id): QueuedMessage {
  return {
    attachments: [],
    id,
    message: text,
    projectId: "project",
    scopeKey: "conversation",
  };
}

describe("queued follow-ups", () => {
  it("keeps an ambiguous steering attempt bound to its original run after completion", () => {
    const bound = bindQueuedDelivery(
      message("steering-request", "Change the navigation"),
      "run-before-disconnect"
    );
    const before = queuedSubmission(bound);
    const afterRunEnds = bindQueuedDelivery(bound, null);
    const afterAnotherRunStarts = bindQueuedDelivery(bound, "different-run");
    expect(mayAutomaticallyDeliver(afterRunEnds)).toBe(false);
    expect(queuedSubmission(afterRunEnds)).toEqual(before);
    expect(queuedSubmission(afterAnotherRunStarts)).toEqual(before);
    expect(before.targetRunId).toBe("run-before-disconnect");
    expect(before.requestId).toBe("steering-request");
    expect(() => bindQueuedDelivery(bound, null, true)).toThrow(
      "original delivery"
    );
  });

  it("retains side-chat allocation intent and never automatically converts it into a follow-up", () => {
    const bound = bindQueuedDelivery(
      message("allocation-request"),
      "active-run",
      true
    );
    const retry = bindQueuedDelivery(bound, null);
    expect(retry.delivery?.kind).toBe("side-chat");
    expect(mayAutomaticallyDeliver(retry)).toBe(false);
    expect(queuedSubmission(retry).requestId).toBe("allocation-request");
  });

  it("retries admitted follow-ups through the turn endpoint even when a new run is active", () => {
    const bound = bindQueuedDelivery(message("turn-request"), null);
    const retry = bindQueuedDelivery(bound, "new-run");
    expect(retry.delivery?.kind).toBe("turn");
    expect(queuedSubmission(retry)).toEqual(queuedSubmission(bound));
    expect(mayAutomaticallyDeliver(retry)).toBe(true);
  });
  it("retains submission order and files while one row is acknowledged", () => {
    const first = {
      ...message("first"),
      attachments: [
        {
          data: "data:image/png;base64,YQ==",
          filename: "wireframe.png",
          mediaType: "image/png",
        },
      ],
    };
    let queue = appendQueuedMessage([], first);
    queue = appendQueuedMessage(queue, message("second"));
    queue = appendQueuedMessage(queue, message("third"));
    expect(queue.map((item) => item.id)).toEqual(["first", "second", "third"]);
    const request = queuedSubmission(first);
    expect(request.attachments[0]?.filename).toBe("wireframe.png");
    expect(request.preserveDraft).toBe(true);
    queue = removeQueuedMessage(queue, "second");
    expect(queue.map((item) => item.id)).toEqual(["first", "third"]);
    expect(queue[0]?.attachments).toEqual(first.attachments);
  });

  it("retries the same queued intent with its original delivery key", () => {
    const queued = message("stable-id", "Change the navigation");
    const attempt = queuedSubmission(queued);
    const retry = queuedSubmission(queued);
    expect(retry).toEqual(attempt);
    expect(retry.requestId).toBe("stable-id");
  });

  it("rejects excess messages without losing the ten existing drafts", () => {
    let queue: QueuedMessage[] = [];
    for (let index = 0; index < 10; index += 1) {
      queue = appendQueuedMessage(queue, message(String(index)));
    }
    expect(() => appendQueuedMessage(queue, message("overflow"))).toThrow(
      "Queue up to 10"
    );
    expect(queue).toHaveLength(10);
  });

  it("bounds attachment memory and rejects missing project or empty submissions", () => {
    expect(() =>
      appendQueuedMessage([], { ...message("missing"), projectId: "" })
    ).toThrow("Choose a project");
    expect(() => appendQueuedMessage([], message("empty", "  "))).toThrow(
      "Write a message"
    );
    expect(() =>
      appendQueuedMessage([], {
        ...message("huge"),
        attachments: [
          {
            data: "a".repeat(13 * 1024 * 1024),
            filename: "huge.png",
            mediaType: "image/png",
          },
        ],
      })
    ).toThrow("Queued files are too large");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { readPastedText } from "./read-pasted-text";

afterEach(() => vi.unstubAllGlobals());
describe("pasted text viewer", () => {
  it("preserves Unicode and CRLF across streamed chunks", async () => {
    const text = "First\r\n終わり😀";
    const bytes = new TextEncoder().encode(text);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 9));
              controller.enqueue(bytes.slice(9));
              controller.close();
            },
          })
        )
      )
    );
    expect(
      await readPastedText("/original", new AbortController().signal)
    ).toBe(text);
  });
  it("fails on authorization denial and oversized streams", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Denied", { status: 403 }))
    );
    await expect(
      readPastedText("/original", new AbortController().signal)
    ).rejects.toThrow("Could not load");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(new Uint8Array(4 * 1024 * 1024 + 1)))
    );
    await expect(
      readPastedText("/original", new AbortController().signal)
    ).rejects.toThrow("4 MB");
  });
});

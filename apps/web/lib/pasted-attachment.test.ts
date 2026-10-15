import { describe, expect, it } from "vitest";
import { pastedTextAttachment } from "./pasted-attachment";

describe("large pasted text", () => {
  it("preserves exact multiline Unicode and line endings as a text file", async () => {
    const text = `${"Line\r\n".repeat(100)}終わり\n`;
    const file = pastedTextAttachment(text);
    expect(file?.type).toBe("text/plain");
    expect(await file?.text()).toBe(text);
  });
  it("catches a large single line by UTF-8 byte size", () => {
    expect(pastedTextAttachment("字".repeat(3000))?.size).toBe(9000);
    expect(pastedTextAttachment("hello\nworld")).toBeUndefined();
  });
  it("leaves text above the file limit available for normal paste and validation", () => {
    expect(
      pastedTextAttachment("x".repeat(4 * 1024 * 1024 + 1))
    ).toBeUndefined();
  });
});

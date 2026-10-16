import { describe, expect, it } from "vitest";
import {
  filePastePresentation,
  isLegacyPaste,
  pastedTextAttachment,
  pastePresentation,
} from "./pasted-attachment";

describe("large pasted text", () => {
  it("preserves exact multiline Unicode and line endings as a text file", async () => {
    const text = `${"Line\r\n".repeat(100)}終わり\n`;
    const file = pastedTextAttachment(text);
    expect(file?.type).toBe("text/plain");
    expect(await file?.text()).toBe(text);
    expect(file && filePastePresentation(file)).toMatchObject({
      charCount: text.length,
      lineCount: 102,
      preview: "Line\nLine\nLine\nLine",
    });
  });
  it("distinguishes real uploads and bounds long single-line previews without splitting Unicode", () => {
    expect(
      filePastePresentation(
        new File(["notes"], "notes.txt", { type: "text/plain" })
      )
    ).toBeUndefined();
    expect(pastePresentation(`${"a".repeat(511)}😀tail`).preview).toBe(
      "a".repeat(511)
    );
    expect(pastePresentation("a\rb\r\nc\nd").lineCount).toBe(4);
    expect(
      isLegacyPaste({
        filename: "pasted-text-1234abcd.txt",
        mediaType: "text/plain",
      })
    ).toBe(true);
    expect(
      isLegacyPaste({ filename: "notes.txt", mediaType: "text/plain" })
    ).toBe(false);
    expect(
      isLegacyPaste({
        filename: "pasted-text-1234abcd.txt",
        mediaType: "text/plain",
        origin: "upload",
      })
    ).toBe(false);
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

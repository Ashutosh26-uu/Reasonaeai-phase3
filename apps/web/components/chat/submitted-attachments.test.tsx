import type { ConversationAttachment } from "@reasonateai/contracts/execution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubmittedAttachments } from "./submitted-attachments";

function file(
  filename: string,
  mediaType = "application/octet-stream"
): ConversationAttachment {
  return {
    filename,
    mediaType,
    sizeBytes: 2048,
    url: `/files/${encodeURIComponent(filename)}?original=1`,
  };
}

describe("submitted attachments", () => {
  it("shows a paste as its own readable text preview beside images and PDFs", () => {
    const pasted = {
      ...file("pasted-text-1234abcd.txt", "text/plain"),
      paste: {
        charCount: 9000,
        lineCount: 120,
        preview: "First line\n<script>reference only</script>\nThird line",
      },
    };
    const html = renderToStaticMarkup(
      <SubmittedAttachments
        files={[
          file("reference.png", "image/png"),
          pasted,
          file("brief.pdf", "application/pdf"),
        ]}
      />
    );
    expect(html).toContain("Pasted text");
    expect(html).toContain("120 lines");
    expect(html).toContain("First line");
    expect(html).toContain("&lt;script&gt;reference only&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("pasted-text-1234abcd.txt");
    expect(html).not.toContain("TXT ·");
    expect(html).toContain("brief.pdf");
  });
  it("recognizes pre-metadata generated pastes without relabeling ordinary text uploads", () => {
    const html = renderToStaticMarkup(
      <SubmittedAttachments
        files={[
          file("pasted-text-1234abcd.txt", "text/plain"),
          file("notes.txt", "text/plain"),
        ]}
      />
    );
    expect(html).toContain('aria-label="Read pasted text"');
    expect(html).toContain("Open to preview pasted content");
    expect(html).toContain("notes.txt");
    expect(html).toContain("TXT · 2 KB");
    const uploaded = renderToStaticMarkup(
      <SubmittedAttachments
        files={[
          {
            ...file("pasted-text-1234abcd.txt", "text/plain"),
            origin: "upload",
          },
        ]}
      />
    );
    expect(uploaded).not.toContain("Read pasted text");
    expect(uploaded).toContain("pasted-text-1234abcd.txt");
  });
  it("keeps mixed files in submission order with accessible image and file actions", () => {
    const files = [
      file("reference.png", "image/png"),
      file("brief.pdf", "application/pdf"),
      file("pasted-text.txt", "text/plain"),
      file("budget.xlsx"),
      file("source.zip"),
    ];
    const html = renderToStaticMarkup(<SubmittedAttachments files={files} />);
    expect(html).toContain('aria-label="Attached files"');
    expect(html).toContain('aria-label="View reference.png"');
    expect(html).toContain('alt="reference.png"');
    expect(html).toContain('href="/files/brief.pdf?original=1"');
    expect(html).toContain("PDF · 2 KB");
    expect(html).toContain("TXT · 2 KB");
    expect(html).toContain("XLSX · 2 KB");
    expect(html).toContain("ZIP · 2 KB");
    for (const [index, value] of files.entries()) {
      if (index > 0) {
        expect(html.indexOf(value.filename)).toBeGreaterThan(
          html.indexOf(files[index - 1]?.filename ?? "")
        );
      }
    }
  });

  it("retains the full filename for truncated cards and handles missing or unusual extensions", () => {
    const filename = `pasted-${"notes-".repeat(15)}.txt`;
    const html = renderToStaticMarkup(
      <SubmittedAttachments
        files={[
          file(filename),
          file("README"),
          file(`notes.${"x".repeat(100)}`),
        ]}
      />
    );
    expect(html).toContain(`title="${filename}"`);
    expect(html).toContain(`href="/files/${filename}?original=1"`);
    expect(html.match(/FILE · 2 KB/g)).toHaveLength(2);
  });

  it("omits the attachment list for an empty message", () => {
    expect(renderToStaticMarkup(<SubmittedAttachments files={[]} />)).toBe("");
  });
});

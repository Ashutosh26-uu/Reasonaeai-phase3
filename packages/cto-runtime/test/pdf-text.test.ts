import { describe, expect, it } from "vitest";
import { pdfDocumentText } from "../src/tools/readers/pdf-text.js";

function document() {
  const content = "BT /F1 16 Tf 72 720 Td (Durable attachment) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const start = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text);
}

describe("bounded PDF extraction", () => {
  it("reads real PDF text without requiring PDF support from the language model", async () => {
    expect(await pdfDocumentText(document())).toContain("Durable attachment");
  }, 30_000);
  it("rejects corrupt files and supports cancellation", async () => {
    await expect(
      pdfDocumentText(Buffer.from("%PDF-invalid"))
    ).rejects.toThrow();
    const controller = new AbortController();
    const reading = pdfDocumentText(document(), controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow("cancelled");
  }, 30_000);
});

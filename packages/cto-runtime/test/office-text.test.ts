import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { officeDocumentText } from "../src/tools/readers/office-text.js";

describe("read Office attachments", () => {
  it("extracts document paragraphs with Unicode and escaped text", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        "<w:document><w:body><w:p><w:r><w:t>001 &amp; 世界</w:t></w:r></w:p></w:body></w:document>"
      ),
    });
    expect(officeDocumentText("spec.docx", bytes)).toContain("001 & 世界");
  });
  it("resolves shared strings and distinguishes cached worksheet values", () => {
    const bytes = zipSync({
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Revenue</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>123</v></c></row></sheetData></worksheet>'
      ),
    });
    const result = officeDocumentText("finance.xlsx", bytes);
    expect(result).toContain("A1: Revenue | B1: 123");
    expect(result).toContain("formulas are not recalculated");
  });
  it("rejects document entity declarations and oversized extraction", () => {
    const unsafe = zipSync({
      "word/document.xml": strToU8(
        '<!DOCTYPE x [<!ENTITY x "oops">]><w:document>&x;</w:document>'
      ),
    });
    expect(() => officeDocumentText("unsafe.docx", unsafe)).toThrow(
      "declarations"
    );
    const large = zipSync({
      "word/document.xml": new Uint8Array(16 * 1024 * 1024 + 1),
    });
    expect(() => officeDocumentText("large.docx", large)).toThrow(
      "extraction limit"
    );
  });
});

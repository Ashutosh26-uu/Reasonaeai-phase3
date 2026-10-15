import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

const MEMBER =
  /^(?:word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml)$/;
const BOUND = 16 * 1024 * 1024;
const DECLARATION = /<!DOCTYPE|<!ENTITY/i;
const OFFICE_EXTENSION = /\.(?:docx|pptx|xlsx)$/i;
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: true,
});

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean).join("\n");
  }
  return Object.entries(record(value))
    .filter(([key]) => !key.startsWith("@_"))
    .map(([key, child]) =>
      key === "w:p" || key === "a:p" ? `${text(child)}\n` : text(child)
    )
    .filter(Boolean)
    .join(" ");
}
function parse(bytes: Uint8Array): unknown {
  const xml = new TextDecoder().decode(bytes);
  if (DECLARATION.test(xml)) {
    throw new Error("Document XML declarations are not supported.");
  }
  const result: unknown = parser.parse(xml);
  return result;
}

/** Extract paragraphs, slides and cached worksheet values with bounded inflation. */
export function officeDocumentText(
  path: string,
  bytes: Uint8Array
): string | undefined {
  if (!OFFICE_EXTENSION.test(path)) {
    return undefined;
  }
  let expanded = 0;
  const members = unzipSync(bytes, {
    filter: (entry) => {
      if (!MEMBER.test(entry.name)) {
        return false;
      }
      expanded += entry.originalSize;
      if (expanded > BOUND) {
        throw new Error("Document expands beyond the 16 MiB extraction limit.");
      }
      return true;
    },
  });
  const entries = Object.entries(members).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  if (entries.length === 0) {
    throw new Error("This document has no supported content parts.");
  }
  const sharedBytes = members["xl/sharedStrings.xml"];
  const shared = sharedBytes
    ? list(record(record(parse(sharedBytes)).sst).si).map(text)
    : [];
  const output: string[] = [];
  for (const [name, data] of entries) {
    if (name === "xl/sharedStrings.xml") {
      continue;
    }
    const document = parse(data);
    if (name.startsWith("xl/")) {
      const rows = list(record(record(document).worksheet).sheetData).flatMap(
        (sheetData) => list(record(sheetData).row)
      );
      output.push(`## ${name} (stored values; formulas are not recalculated)`);
      for (const row of rows) {
        output.push(
          list(record(row).c)
            .map((value) => {
              const cell = record(value);
              const raw = text(cell.v ?? cell.is);
              return `${String(cell["@_r"] ?? "cell")}: ${cell["@_t"] === "s" ? (shared[Number(raw)] ?? "(missing shared string)") : raw}`;
            })
            .join(" | ")
        );
      }
    } else {
      output.push(`## ${name}\n${text(document)}`);
    }
  }
  return output.join("\n");
}

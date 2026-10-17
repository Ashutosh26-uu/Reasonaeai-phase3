import type { PastePresentation } from "@reasonateai/contracts/execution";

const LINE_BREAK = /\r\n|\r|\n/;
const LEGACY_PASTE = /^pasted-text-[0-9a-f]{8}\.txt$/;
const metadata = new WeakMap<File, PastePresentation>();

export function pastePresentation(text: string): PastePresentation {
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      lineCount += 1;
      if (text[index + 1] === "\n") {
        index += 1;
      }
    } else if (text[index] === "\n") {
      lineCount += 1;
    }
  }
  let preview = text.slice(0, 512).split(LINE_BREAK, 4).join("\n");
  const last = preview.charCodeAt(preview.length - 1);
  if (last >= 0xd8_00 && last <= 0xdb_ff) {
    preview = preview.slice(0, -1);
  }
  return { charCount: text.length, lineCount, preview };
}

export function filePastePresentation(
  file: File
): PastePresentation | undefined {
  return metadata.get(file);
}

/** Compatibility for pastes created before explicit presentation metadata existed. */
export function isLegacyPaste(file: {
  filename: string;
  mediaType: string;
  origin?: "upload" | "paste" | undefined;
}): boolean {
  return (
    file.origin === undefined &&
    file.mediaType === "text/plain" &&
    LEGACY_PASTE.test(file.filename)
  );
}
/** Keep a large paste out of the prompt while preserving its exact UTF-8 bytes. */
export function pastedTextAttachment(text: string): File | undefined {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 8192 && text.split(LINE_BREAK).length < 100) {
    return undefined;
  }
  if (bytes.length > 4 * 1024 * 1024) {
    return undefined;
  }
  const file = new File(
    [bytes],
    `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
    { type: "text/plain" }
  );
  metadata.set(file, pastePresentation(text));
  return file;
}

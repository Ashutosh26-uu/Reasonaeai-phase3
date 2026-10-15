const LINE_BREAK = /\r\n|\r|\n/;
/** Keep a large paste out of the prompt while preserving its exact UTF-8 bytes. */
export function pastedTextAttachment(text: string): File | undefined {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 8192 && text.split(LINE_BREAK).length < 100) {
    return undefined;
  }
  if (bytes.length > 4 * 1024 * 1024) {
    return undefined;
  }
  return new File(
    [bytes],
    `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
    { type: "text/plain" }
  );
}

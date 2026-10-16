const MAX_PASTE_BYTES = 4 * 1024 * 1024;

/** Read only on demand; bound even an unexpected response from the file endpoint. */
export async function readPastedText(
  url: string,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error("Could not load pasted text. Try again.");
  }
  if (Number(response.headers.get("content-length")) > MAX_PASTE_BYTES) {
    await response.body?.cancel();
    throw new Error("Pasted text exceeds the 4 MB viewing limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Bound each ordered stream chunk before reading the next.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_PASTE_BYTES) {
        await reader.cancel();
        throw new Error("Pasted text exceeds the 4 MB viewing limit.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

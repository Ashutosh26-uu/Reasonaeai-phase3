// SPDX-License-Identifier: MIT
// Ported from spectra (MIT, the project owner's own codebase) —
// packages/code/src/tools/hashline/stream.ts.

/**
 * Lazily format a stream of UTF-8 bytes into hashline-numbered lines, yielded
 * as bounded text chunks. Used to send `read`-style file content to consumers
 * without materializing the full file at once.
 *
 * Each yielded chunk is at most {@link StreamOptions.maxChunkLines} lines and
 * at most {@link StreamOptions.maxChunkBytes} UTF-8 bytes (whichever fires
 * first).
 */
import { formatNumberedLine } from "./format.js";
import type { StreamOptions } from "./types.js";

interface ResolvedStreamOptions {
  maxChunkBytes: number;
  maxChunkLines: number;
  startLine: number;
}

function resolveStreamOptions(options: StreamOptions): ResolvedStreamOptions {
  return {
    maxChunkBytes: options.maxChunkBytes ?? 64 * 1024,
    maxChunkLines: options.maxChunkLines ?? 200,
    startLine: options.startLine ?? 1,
  };
}

interface ChunkEmitter {
  flush: () => string | undefined;
  pushLine: (line: string) => string[];
}

function createChunkEmitter(options: ResolvedStreamOptions): ChunkEmitter {
  let lineNumber = options.startLine;
  let outLines: string[] = [];
  let outBytes = 0;

  const flush = (): string | undefined => {
    if (outLines.length === 0) {
      return undefined;
    }
    const chunk = outLines.join("\n");
    outLines = [];
    outBytes = 0;
    return chunk;
  };

  const pushLine = (line: string): string[] => {
    const formatted = formatNumberedLine(lineNumber, line);
    lineNumber += 1;

    const chunks: string[] = [];
    const sepBytes = outLines.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(formatted, "utf-8");
    const wouldOverflow =
      outLines.length >= options.maxChunkLines ||
      outBytes + sepBytes + lineBytes > options.maxChunkBytes;

    if (outLines.length > 0 && wouldOverflow) {
      const flushed = flush();
      if (flushed) {
        chunks.push(flushed);
      }
    }

    outLines.push(formatted);
    outBytes += (outLines.length === 1 ? 0 : 1) + lineBytes;

    if (
      outLines.length >= options.maxChunkLines ||
      outBytes >= options.maxChunkBytes
    ) {
      const flushed = flush();
      if (flushed) {
        chunks.push(flushed);
      }
    }
    return chunks;
  };

  return { flush, pushLine };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

/**
 * One `read()` result per `next()`. Spectra drove the reader with
 * `while (true) { await reader.read() }`; this adapter keeps the same
 * sequencing — one read in flight, the reader released (never cancelled) at
 * the end — without an `await` inside a loop, which this repo forbids.
 */
function readerChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<Uint8Array | undefined> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array | undefined> => ({
      next: async (): Promise<IteratorResult<Uint8Array | undefined>> => {
        const result = await reader.read();
        if (result.done === true) {
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
    }),
  };
}

async function* bytesFromReadableStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for await (const value of readerChunks(reader)) {
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamHashLines(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: StreamOptions = {}
): AsyncGenerator<string> {
  const resolved = resolveStreamOptions(options);
  const decoder = new TextDecoder("utf-8");
  const chunks = isReadableStream(source)
    ? bytesFromReadableStream(source)
    : source;
  const emitter = createChunkEmitter(resolved);

  let pending = "";
  let sawAnyLine = false;

  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const raw = pending.slice(0, nl);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      sawAnyLine = true;
      for (const out of emitter.pushLine(line)) {
        yield out;
      }
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }

  pending += decoder.decode();
  if (pending.length > 0) {
    sawAnyLine = true;
    const tail = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
    for (const out of emitter.pushLine(tail)) {
      yield out;
    }
  }
  if (!sawAnyLine) {
    for (const out of emitter.pushLine("")) {
      yield out;
    }
  }

  const last = emitter.flush();
  if (last) {
    yield last;
  }
}

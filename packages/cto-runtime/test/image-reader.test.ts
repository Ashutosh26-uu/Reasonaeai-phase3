import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { imageReader, parseImageHeader } from "../src/tools/readers/image.js";
import {
  DEFAULT_READER_LIMITS,
  ReaderLimitError,
  type ReaderRequest,
  UnsupportedFormatError,
} from "../src/tools/readers/types.js";

/** A PNG chunk: length, type, data, and the CRC over type and data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(strToU8(type), 4);
  chunk.set(data, 8);
  // PNG checksums are CRC-32/ISO-HDLC over the type and data bytes, which is what
  // zlib's crc32 computes.
  view.setUint32(
    8 + data.byteLength,
    crc32(chunk.subarray(4, 8 + data.byteLength))
  );
  return chunk;
}

/**
 * A PNG header: signature, IHDR, and IEND. The scan data is left out because the
 * reader never decodes pixels, it reads the header.
 */
function pngBytes(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  // Bit depth, colour type, compression, filter, interlace.
  ihdr.set([8, 6, 0, 0, 0], 8);

  const chunks = [pngChunk("IHDR", ihdr), pngChunk("IEND", new Uint8Array(0))];
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const bytes = new Uint8Array(
    signature.byteLength +
      chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );

  bytes.set(signature, 0);
  let offset = signature.byteLength;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/** A GIF header plus the logical screen descriptor that holds the dimensions. */
function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(strToU8("GIF89a"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** A JPEG header: start-of-image followed straight by a start-of-frame segment. */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(15);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xc0], 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 11);
  bytes.set([8], 6);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

/** A WebP header whose extended-format chunk carries the canvas dimensions. */
function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(strToU8("RIFF"), 0);
  bytes.set(strToU8("WEBP"), 8);
  bytes.set(strToU8("VP8X"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  view.setUint32(16, 10, true);
  // The canvas stores each dimension as a 24-bit little-endian value minus one.
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  view.setUint8(24, widthMinusOne % 256);
  view.setUint8(25, Math.floor(widthMinusOne / 256) % 256);
  view.setUint8(26, Math.floor(widthMinusOne / 65_536));
  view.setUint8(27, heightMinusOne % 256);
  view.setUint8(28, Math.floor(heightMinusOne / 256) % 256);
  view.setUint8(29, Math.floor(heightMinusOne / 65_536));
  return bytes;
}

/** Write image bytes into a temp file and return its path. */
async function writeImage(name: string, bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasonate-image-"));
  const target = join(root, name);
  await writeFile(target, bytes);
  return target;
}

/** Read through the reader and hand back the error it threw. */
async function readError(request: ReaderRequest): Promise<Error> {
  try {
    await imageReader.read(request);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`expected an Error, got ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error("expected the read to fail");
}

describe("image headers", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(parseImageHeader(pngBytes(3, 2))).toEqual({
      format: "PNG",
      height: 2,
      mimeType: "image/png",
      width: 3,
    });
  });

  it("reads GIF dimensions from the screen descriptor", () => {
    expect(parseImageHeader(gifBytes(640, 480))).toEqual({
      format: "GIF",
      height: 480,
      mimeType: "image/gif",
      width: 640,
    });
  });

  it("reads JPEG dimensions from the first frame marker", () => {
    expect(parseImageHeader(jpegBytes(1920, 1080))).toEqual({
      format: "JPEG",
      height: 1080,
      mimeType: "image/jpeg",
      width: 1920,
    });
  });

  it("reads WebP dimensions from the extended chunk", () => {
    expect(parseImageHeader(webpBytes(300, 200))).toEqual({
      format: "WebP",
      height: 200,
      mimeType: "image/webp",
      width: 300,
    });
  });

  it("reports nothing for bytes that are not an image", () => {
    expect(parseImageHeader(strToU8("this is plain text"))).toBeUndefined();
  });
});

describe("reading an image", () => {
  it("reports the format, dimensions, and size", async () => {
    const bytes = pngBytes(7, 5);
    const imagePath = await writeImage("photo.png", bytes);

    const result = await imageReader.read({
      limits: DEFAULT_READER_LIMITS,
      path: imagePath,
      selector: undefined,
    });

    expect(result.text).toContain("Read image file [image/png]");
    expect(result.text).toContain(`(${bytes.byteLength} bytes)`);
    expect(result.text).toContain("Format: PNG");
    expect(result.text).toContain("Dimensions: 7x5");
    expect(result.notes).toContain("dimensions: 7x5");
    expect(result.immutable).toBe(true);
    expect(result.contentType).toBe("text/plain");
  });

  it("refuses a .png whose bytes are not an image", async () => {
    const imagePath = await writeImage("fake.png", strToU8("not a png"));

    const failure = await readError({
      limits: DEFAULT_READER_LIMITS,
      path: imagePath,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(UnsupportedFormatError);
    expect(failure.message).toContain("fake.png");
  });

  it("refuses an image over maxResourceBytes", async () => {
    const imagePath = await writeImage("photo.png", pngBytes(1, 1));

    const failure = await readError({
      limits: { ...DEFAULT_READER_LIMITS, maxResourceBytes: 8 },
      path: imagePath,
      selector: undefined,
    });

    expect(failure).toBeInstanceOf(ReaderLimitError);
    if (!(failure instanceof ReaderLimitError)) {
      throw new Error(failure.message);
    }
    expect(failure.limit).toBe("maxResourceBytes");
  });
});

describe("dispatch", () => {
  it("claims the four formats it can describe", () => {
    expect(
      imageReader.matches({ path: "/tmp/photo.png", selector: undefined })
    ).toBe(true);
    expect(
      imageReader.matches({ path: "/tmp/photo.JPEG", selector: undefined })
    ).toBe(true);
    expect(
      imageReader.matches({ path: "/tmp/icon.webp", selector: undefined })
    ).toBe(true);
  });

  it("leaves other targets to other readers", () => {
    expect(
      imageReader.matches({ path: "/tmp/notes.txt", selector: undefined })
    ).toBe(false);
    expect(
      imageReader.matches({ path: "/tmp/report.pdf", selector: undefined })
    ).toBe(false);
    expect(
      imageReader.matches({
        path: "https://example.com/photo.png",
        selector: undefined,
      })
    ).toBe(false);
  });

  it("does not claim a query target, because ?q= is not ported", () => {
    expect(
      imageReader.matches({
        path: "/tmp/photo.png?q=describe",
        selector: undefined,
      })
    ).toBe(false);
  });
});

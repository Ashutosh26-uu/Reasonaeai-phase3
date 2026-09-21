/**
 * The image reader: what an image file is, since the pixels cannot be text.
 *
 * Ported from spectra's `image-reader.ts`. Spectra returned the decoded image as
 * an `ImageContent` part beside a note; this runtime's reader contract returns
 * text only, so the reader reports what the image is — format, pixel dimensions,
 * and byte size — read from the file header. The pixels are not returned and the
 * result says so, rather than dressing a binary dump up as content.
 *
 * The magic bytes and dimension fields are parsed here rather than through a
 * dependency, because the four formats in play each expose their dimensions a few
 * bytes into the file and nothing about decoding is needed.
 *
 * `?q=` queries are not ported: spectra had no such form, and the reader contract
 * has no way to answer a question about an image.
 */

import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import {
  assertWithinLimit,
  type FormatReader,
  type ReaderRequest,
  type ReaderResult,
  UnsupportedFormatError,
} from "./types.js";

/** MIME types by lowercase extension: the formats whose headers this reader reads. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** The extensions this reader claims. */
const IMAGE_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION);

/** PNG signature `\x89PNG`, as the first big-endian word of the file. */
const PNG_MAGIC_HIGH = 0x89_50_4e_47;

/** PNG signature `\r\n\x1a\n`, as the second big-endian word of the file. */
const PNG_MAGIC_LOW = 0x0d_0a_1a_0a;

/** JPEG start-of-image `FFD8`. */
const JPEG_MAGIC = 0xff_d8;

/** The two GIF version headers. */
const GIF_MAGIC: readonly string[] = ["GIF87a", "GIF89a"];

/**
 * JPEG start-of-frame markers: the only segments that carry pixel dimensions.
 *
 * `C4` (Huffman tables), `C8` (reserved), and `CC` (arithmetic coding) sit in the
 * same numeric range and are not frames, so they are left out.
 */
const JPEG_FRAME_MARKERS: readonly number[] = [
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
];

/** Magic strings are single-byte ASCII, which latin1 decodes one character per byte. */
const ASCII_DECODER = new TextDecoder("latin1");

/** An image's format and pixel dimensions, as its header declares them. */
export interface ImageHeader {
  format: "GIF" | "JPEG" | "PNG" | "WebP";
  height: number;
  mimeType: string;
  width: number;
}

/** A view over exactly the bytes given, which `Buffer` subarrays need. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * PNG dimensions.
 *
 * The IHDR chunk is required to be the first chunk, so its width and height are
 * always 8 bytes of chunk header after the 8-byte signature.
 */
function pngHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.byteLength < 24) {
    return undefined;
  }

  const view = viewOf(bytes);

  if (
    view.getUint32(0) !== PNG_MAGIC_HIGH ||
    view.getUint32(4) !== PNG_MAGIC_LOW
  ) {
    return undefined;
  }

  return {
    format: "PNG",
    height: view.getUint32(20),
    mimeType: "image/png",
    width: view.getUint32(16),
  };
}

/**
 * JPEG dimensions, from the first start-of-frame segment.
 *
 * Segments are length-prefixed, so the walk is a hop from marker to marker until a
 * frame segment appears; that is the point where the dimensions are known.
 */
function jpegHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.byteLength < 4) {
    return undefined;
  }

  const view = viewOf(bytes);

  if (view.getUint16(0) !== JPEG_MAGIC) {
    return undefined;
  }

  let offset = 2;

  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      // Padding between segments is legal, and cheap to step over.
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];

    if (marker !== undefined && JPEG_FRAME_MARKERS.includes(marker)) {
      return {
        format: "JPEG",
        height: view.getUint16(offset + 5),
        mimeType: "image/jpeg",
        width: view.getUint16(offset + 7),
      };
    }

    const length = view.getUint16(offset + 2);

    if (length < 2) {
      return undefined;
    }

    offset += 2 + length;
  }

  return undefined;
}

/** GIF dimensions, from the logical screen descriptor that follows the header. */
function gifHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.byteLength < 10) {
    return undefined;
  }

  if (!GIF_MAGIC.includes(ASCII_DECODER.decode(bytes.subarray(0, 6)))) {
    return undefined;
  }

  const view = viewOf(bytes);

  return {
    format: "GIF",
    height: view.getUint16(8, true),
    mimeType: "image/gif",
    width: view.getUint16(6, true),
  };
}

/**
 * WebP dimensions.
 *
 * The RIFF container says which of the three WebP encodings follows, and each
 * stores its canvas differently: `VP8X` as 24-bit little-endian values minus one,
 * `VP8 ` as 14-bit values after the frame header, and `VP8L` as two 14-bit values
 * packed into one 32-bit word. Each is read arithmetically, because the fields are
 * not byte-aligned and no read is wider than the field.
 */
function webpHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.byteLength < 30) {
    return undefined;
  }

  if (
    ASCII_DECODER.decode(bytes.subarray(0, 4)) !== "RIFF" ||
    ASCII_DECODER.decode(bytes.subarray(8, 12)) !== "WEBP"
  ) {
    return undefined;
  }

  const view = viewOf(bytes);
  const chunk = ASCII_DECODER.decode(bytes.subarray(12, 16));

  if (chunk === "VP8X") {
    const width =
      view.getUint8(24) + view.getUint8(25) * 256 + view.getUint8(26) * 65_536;
    const height =
      view.getUint8(27) + view.getUint8(28) * 256 + view.getUint8(29) * 65_536;

    return {
      format: "WebP",
      height: height + 1,
      mimeType: "image/webp",
      width: width + 1,
    };
  }

  if (chunk === "VP8 ") {
    return {
      format: "WebP",
      height: view.getUint16(28, true) % 16_384,
      mimeType: "image/webp",
      width: view.getUint16(26, true) % 16_384,
    };
  }

  if (chunk === "VP8L") {
    const packed = view.getUint32(21, true);

    return {
      format: "WebP",
      height: (Math.floor(packed / 16_384) % 16_384) + 1,
      mimeType: "image/webp",
      width: (packed % 16_384) + 1,
    };
  }

  return undefined;
}

/**
 * Read the format and pixel dimensions out of an image's header.
 *
 * Only the header is inspected, so a file whose header is not one of the four
 * formats this reader knows is not an image it can describe: `undefined` says
 * that, rather than a guess from the extension.
 */
export function parseImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  return (
    pngHeader(bytes) ??
    jpegHeader(bytes) ??
    gifHeader(bytes) ??
    webpHeader(bytes)
  );
}

/** Stat an image, reporting a missing path and a non-file as such. */
async function statImage(filePath: string): Promise<Stats> {
  let info: Stats;

  try {
    info = await stat(filePath);
  } catch (error) {
    throw new Error(`File not found: ${filePath}`, { cause: error });
  }

  if (!info.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  return info;
}

/** Describe one image target: its format, dimensions, and size. */
async function readImage(request: ReaderRequest): Promise<ReaderResult> {
  const { limits, path: filePath } = request;
  const extension = extname(filePath).toLowerCase();

  if (MIME_BY_EXTENSION[extension] === undefined) {
    throw new UnsupportedFormatError(
      `Unsupported image format: ${extension || "(none)"}`
    );
  }

  const info = await statImage(filePath);
  assertWithinLimit("maxResourceBytes", info.size, limits.maxResourceBytes);

  const bytes = await readFile(filePath);
  const header = parseImageHeader(bytes);

  if (header === undefined) {
    throw new UnsupportedFormatError(
      `${filePath} is named ${extension} but its header is not PNG, JPEG, GIF, or WebP (${bytes.byteLength} bytes)`
    );
  }

  const size = bytes.byteLength;

  return {
    contentType: "text/plain",
    immutable: true,
    notes: [
      `format: ${header.format}`,
      `dimensions: ${header.width}x${header.height}`,
      `mime: ${header.mimeType}`,
      `bytes: ${size}`,
    ],
    text: [
      `Read image file [${header.mimeType}] (${size} bytes)`,
      `Format: ${header.format}`,
      `Dimensions: ${header.width}x${header.height}`,
      "The pixels are not returned as text; this reports the image's header only.",
    ].join("\n"),
  };
}

/**
 * The image reader as the read tool consumes it.
 *
 * An image is immutable here in the strongest sense: there is no editable text in
 * one, so no edit anchor can be minted for it.
 */
export const imageReader: FormatReader = {
  extensions: IMAGE_EXTENSIONS,
  matches: ({ path }) => {
    const target = path.trim();

    // A URL is the URL reader's target, whatever its suffix looks like.
    if (target.includes("://")) {
      return false;
    }

    return MIME_BY_EXTENSION[extname(target).toLowerCase()] !== undefined;
  },
  name: "image",
  read: readImage,
};

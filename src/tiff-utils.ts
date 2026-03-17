import { Compression, Predictor, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import { decompress } from "@developmentseed/lzw-tiff-decoder";
import type { AbsolutePath } from '@zarrita/storage';

/**
 * Error thrown when an assertion fails.
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Make an assertion. An error is thrown if `expr` does not have truthy value.
 */
export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

export function encodeJson(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj, null, 2));
}

export function parseKey(key: AbsolutePath):
  | {
      kind: "meta";
      value: { kind: "root" } | { kind: "resolution"; value: number };
    }
  | {
      kind: "chunk";
      resolution: number;
      chunkCoords: number[];
    }
  | {
      kind: "unknown";
    } {
  if (key === "/zarr.json") {
    return { kind: "meta", value: { kind: "root" } };
  }
  let match = key.match(/^\/(\d+)\/zarr\.json$/);
  if (match) {
    return {
      kind: "meta",
      value: { kind: "resolution", value: +match[1] },
    };
  }
  match = key.match(/^\/(\d+)\/c\/([\d/]+)$/);
  if (match) {
    const resolution = +match[1];
    const chunkCoords = match[2].split('/').map((d) => +d);
    return { kind: "chunk", resolution, chunkCoords };
  }
  return { kind: "unknown" };
}

/**
 * Undo TIFF horizontal differencing (Predictor=2).
 */
function undoHorizontalDifferencing(data: Uint8Array, options: { tileSize: number; bytesPerPixel: number }) {
  const { tileSize, bytesPerPixel } = options;
  const rowBytes = tileSize * bytesPerPixel;
  for (let row = 0; row < tileSize; row++) {
    const rowStart = row * rowBytes;
    for (let i = rowStart + bytesPerPixel; i < rowStart + rowBytes; i++) {
      data[i] = (data[i] + data[i - bytesPerPixel]) & 0xff;
    }
  }
}

/** Swap bytes in-place from big-endian to little-endian for multi-byte samples. */
function swapEndianness(data: Uint8Array, bytesPerPixel: number) {
  const half = bytesPerPixel >>> 1;
  for (let i = 0; i < data.length; i += bytesPerPixel) {
    for (let j = 0; j < half; j++) {
      const lo = i + j;
      const hi = i + bytesPerPixel - 1 - j;
      const tmp = data[lo];
      data[lo] = data[hi];
      data[hi] = tmp;
    }
  }
}

/**
 * Decompress a raw TIFF tile/strip, undo predictor differencing, and normalize
 * to little-endian so the zarr codec can always declare `endian: "little"`.
 *
 * The `bytesPerPixel` parameter should include all samples for chunky (interleaved)
 * images — e.g. for 8-bit RGB pass 3, for 16-bit RGB pass 6.
 */
export async function decompressTile(
  tile: { bytes: ArrayBuffer; compression: Compression },
  options: { tileWidth: number; tileHeight: number; bytesPerPixel: number; predictor: Predictor; isLittleEndian: boolean },
): Promise<Uint8Array> {
  const { tileWidth, tileHeight, bytesPerPixel, predictor, isLittleEndian } = options;
  const maxUncompressedSize = tileWidth * tileHeight * bytesPerPixel;
  let data: Uint8Array;
  switch (tile.compression) {
    case Compression.None:
      data = new Uint8Array(tile.bytes);
      break;
    case Compression.Lzw: {
      data = await decompress(new Uint8Array(tile.bytes), maxUncompressedSize);
      break;
    }
    case Compression.Deflate:
    case Compression.DeflateOther: {
      const ds = new DecompressionStream("deflate");
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(tile.bytes));
      writer.close();
      data = new Uint8Array(await new Response(ds.readable).arrayBuffer());
      break;
    }
    default:
      throw new Error(`Unsupported compression: ${tile.compression}`);
  }
  if (predictor === Predictor.Horizontal) {
    undoHorizontalDifferencing(data, { tileSize: tileWidth, bytesPerPixel });
  }
  if (!isLittleEndian && bytesPerPixel > 1) {
    swapEndianness(data, bytesPerPixel);
  }
  return data;
}

/**
 * cogeotiff only reads the top-level IFD chain during init(). Sub-IFDs
 * (used by bioformats for multi-resolution pyramids) must be parsed
 * separately. The `readIfd` method exists at runtime but is private in
 * the type declarations, so we use a runtime check to access it safely.
 */
function getReadIfd(tiff: Tiff): (offset: number, view: DataView & { sourceOffset: number }) => number {
  // @ts-expect-error - readIfd is private but we need it to parse sub-IFDs
  const fn: unknown = tiff.readIfd;
  assert(typeof fn === "function", "Expected Tiff instance to have readIfd method");
  return fn.bind(tiff);
}

export async function loadSubIfd(tiff: Tiff, offset: number): Promise<TiffImage> {
  const readIfd = getReadIfd(tiff);
  const bytes = await tiff.source.fetch(offset, tiff.defaultReadSize);
  const view = Object.assign(new DataView(bytes), { sourceOffset: offset });
  readIfd(offset, view);
  const subImage = tiff.images[tiff.images.length - 1];
  await subImage.init();
  return subImage;
}

export function getTileSize(image: TiffImage): number {
  const { width, height } = image.tileSize;
  const size = Math.min(width, height);
  // deck.gl requirement for power-of-two tile size.
  return 2 ** Math.floor(Math.log2(size));
}

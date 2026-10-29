import { Compression, Predictor, SampleFormat, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import { decompress } from "@developmentseed/lzw-tiff-decoder";
import { decompress as zstdDecompress } from "fzstd";
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

/** Map TIFF SampleFormat + BitsPerSample to a Zarr v3 data type. */
export function sampleFormatToZarrType(bitsPerSample: number, fmt: SampleFormat): string {
  switch (fmt) {
    case SampleFormat.Int:   return `int${bitsPerSample}`;
    case SampleFormat.Float: return `float${bitsPerSample}`;
    default:                 return `uint${bitsPerSample}`;
  }
}

/**
 * Default `omero` channel window for a Zarr data type: the full range of
 * integer types, and [0, 1] for floats (which have no meaningful range).
 */
export function defaultWindow(dataType: string): { min: number; max: number; start: number; end: number } {
  const match = dataType.match(/^(u?)int(\d+)$/);
  if (!match) return { min: 0, max: 1, start: 0, end: 1 };
  const bits = Number(match[2]);
  const [min, max] = match[1] === 'u'
    ? [0, 2 ** bits - 1]
    : [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1];
  return { min, max, start: min, end: max };
}

/**
 * Downsampling factor of a pyramid level along one axis. Levels whose size is
 * the floor or ceil of `size0 / 2^r` are treated as exact power-of-two levels;
 * anything else falls back to the size ratio.
 */
export function levelScaleFactor(size0: number, sizeR: number, resolution: number): number {
  const factor = 2 ** resolution;
  if (sizeR === Math.floor(size0 / factor) || sizeR === Math.ceil(size0 / factor)) {
    return factor;
  }
  return size0 / sizeR;
}

/**
 * How the pixel data of one IFD is split into segments (tiles or strips).
 * Each segment maps to exactly one Zarr chunk.
 */
export type SegmentLayout = {
  kind: 'tiled' | 'stripped';
  width: number;
  height: number;
  segmentWidth: number;
  segmentHeight: number;
  segmentsAcross: number;
  segmentsDown: number;
};

export function getSegmentLayout(image: TiffImage): SegmentLayout {
  const { width, height } = image.size;
  if (image.isTiled()) {
    const { width: segmentWidth, height: segmentHeight } = image.tileSize;
    return {
      kind: 'tiled',
      width,
      height,
      segmentWidth,
      segmentHeight,
      segmentsAcross: Math.ceil(width / segmentWidth),
      segmentsDown: Math.ceil(height / segmentHeight),
    };
  }
  const rowsPerStrip = Number(image.value(TiffTag.RowsPerStrip) ?? height);
  const segmentHeight = Math.min(rowsPerStrip, height);
  return {
    kind: 'stripped',
    width,
    height,
    segmentWidth: width,
    segmentHeight,
    segmentsAcross: 1,
    segmentsDown: Math.ceil(height / segmentHeight),
  };
}

/**
 * Read the raw (still compressed) bytes of segment `index` of an IFD.
 * Returns null for sparse segments (zero offset or byte count).
 */
export async function readSegment(
  image: TiffImage,
  index: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ bytes: ArrayBuffer; compression: Compression } | null> {
  let offset: number;
  let byteCount: number;
  if (image.isTiled()) {
    ({ offset, imageSize: byteCount } = await image.getTileSize(index));
  } else {
    const offsets = (await image.fetch(TiffTag.StripOffsets)) as number[] | null;
    const byteCounts = (await image.fetch(TiffTag.StripByteCounts)) as number[] | null;
    assert(offsets && byteCounts, "Stripped TIFF is missing StripOffsets/StripByteCounts");
    offset = offsets[index] ?? 0;
    byteCount = byteCounts[index] ?? 0;
  }
  if (offset === 0 || byteCount === 0) return null;
  const segment = await image.getBytes(offset, byteCount, options.signal ? { signal: options.signal } : undefined);
  if (!segment) return null;
  return { bytes: segment.bytes, compression: segment.compression };
}

async function decompressBytes(bytes: ArrayBuffer, compression: Compression, maxUncompressedSize: number): Promise<Uint8Array> {
  switch (compression) {
    case Compression.None:
      return new Uint8Array(bytes);
    case Compression.Lzw:
      return decompress(new Uint8Array(bytes), maxUncompressedSize);
    case Compression.Deflate:
    case Compression.DeflateOther: {
      const ds = new DecompressionStream("deflate");
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(bytes));
      writer.close();
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }
    case Compression.Zstd:
      return zstdDecompress(new Uint8Array(bytes));
    default:
      throw new Error(`Unsupported compression: ${compression}`);
  }
}

/**
 * Undo TIFF horizontal differencing (Predictor=2) in place. Each sample is
 * accumulated with the sample `samplesPerPixel` positions before it, using the
 * sample's native width and the file's byte order.
 */
function undoHorizontalPredictor(
  data: Uint8Array,
  options: { rowLength: number; samplesPerPixel: number; bytesPerSample: number; isLittleEndian: boolean },
) {
  const { rowLength, samplesPerPixel, bytesPerSample, isLittleEndian } = options;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rowBytes = rowLength * samplesPerPixel * bytesPerSample;
  const stride = samplesPerPixel * bytesPerSample;
  const rows = Math.floor(data.length / rowBytes);
  for (let row = 0; row < rows; row++) {
    const rowEnd = (row + 1) * rowBytes;
    for (let i = row * rowBytes + stride; i < rowEnd; i += bytesPerSample) {
      const j = i - stride;
      switch (bytesPerSample) {
        case 1:
          data[i] = (data[i] + data[j]) & 0xff;
          break;
        case 2:
          view.setUint16(i, view.getUint16(i, isLittleEndian) + view.getUint16(j, isLittleEndian), isLittleEndian);
          break;
        case 4:
          view.setUint32(i, view.getUint32(i, isLittleEndian) + view.getUint32(j, isLittleEndian), isLittleEndian);
          break;
        case 8:
          view.setBigUint64(i, BigInt.asUintN(64, view.getBigUint64(i, isLittleEndian) + view.getBigUint64(j, isLittleEndian)), isLittleEndian);
          break;
        default:
          throw new Error(`Unsupported sample size for horizontal predictor: ${bytesPerSample} bytes`);
      }
    }
  }
}

/**
 * Undo the TIFF floating-point predictor (Predictor=3). Each row stores the
 * bytes of all samples split into planes (most significant byte first), then
 * byte-wise differenced. The output is little-endian regardless of the file's
 * byte order.
 */
function undoFloatingPointPredictor(
  data: Uint8Array,
  options: { rowLength: number; samplesPerPixel: number; bytesPerSample: number },
): Uint8Array {
  const { rowLength, samplesPerPixel, bytesPerSample } = options;
  const samplesPerRow = rowLength * samplesPerPixel;
  const rowBytes = samplesPerRow * bytesPerSample;
  const rows = Math.floor(data.length / rowBytes);
  const out = new Uint8Array(rows * rowBytes);
  for (let row = 0; row < rows; row++) {
    const start = row * rowBytes;
    for (let i = start + samplesPerPixel; i < start + rowBytes; i++) {
      data[i] = (data[i] + data[i - samplesPerPixel]) & 0xff;
    }
    for (let s = 0; s < samplesPerRow; s++) {
      for (let b = 0; b < bytesPerSample; b++) {
        out[start + s * bytesPerSample + b] = data[start + (bytesPerSample - 1 - b) * samplesPerRow + s];
      }
    }
  }
  return out;
}

/** Swap bytes in-place from big-endian to little-endian for multi-byte samples. */
function swapEndianness(data: Uint8Array, bytesPerSample: number) {
  const half = bytesPerSample >>> 1;
  for (let i = 0; i + bytesPerSample <= data.length; i += bytesPerSample) {
    for (let j = 0; j < half; j++) {
      const lo = i + j;
      const hi = i + bytesPerSample - 1 - j;
      const tmp = data[lo];
      data[lo] = data[hi];
      data[hi] = tmp;
    }
  }
}

/**
 * Decode a raw TIFF tile/strip into a little-endian buffer of exactly
 * `segmentWidth * segmentHeight * samplesPerPixel * bytesPerSample` bytes:
 * decompress, undo the predictor, normalize byte order, and zero-pad short
 * segments (e.g. the last strip of an image).
 *
 * `samplesPerPixel` is the number of interleaved samples per pixel in the
 * segment (1 for grayscale or planar-separate data).
 */
export async function decodeSegment(
  segment: { bytes: ArrayBuffer; compression: Compression },
  options: {
    segmentWidth: number;
    segmentHeight: number;
    samplesPerPixel: number;
    bytesPerSample: number;
    predictor: Predictor;
    isLittleEndian: boolean;
  },
): Promise<Uint8Array> {
  const { segmentWidth, segmentHeight, samplesPerPixel, bytesPerSample, predictor, isLittleEndian } = options;
  const size = segmentWidth * segmentHeight * samplesPerPixel * bytesPerSample;
  let data = await decompressBytes(segment.bytes, segment.compression, size);
  const predictorOptions = { rowLength: segmentWidth, samplesPerPixel, bytesPerSample };
  if (predictor === Predictor.FloatingPoint) {
    data = undoFloatingPointPredictor(data, predictorOptions);
  } else {
    if (predictor === Predictor.Horizontal) {
      undoHorizontalPredictor(data, { ...predictorOptions, isLittleEndian });
    } else if (predictor !== Predictor.None) {
      throw new Error(`Unsupported predictor: ${predictor}`);
    }
    if (!isLittleEndian && bytesPerSample > 1) {
      swapEndianness(data, bytesPerSample);
    }
  }
  if (data.length === size) return data;
  const padded = new Uint8Array(size);
  padded.set(data.subarray(0, size));
  return padded;
}

/**
 * Convert a chunky (YXS) buffer to planar (SYX) order.
 */
export function deinterleave(data: Uint8Array, options: { pixels: number; samplesPerPixel: number; bytesPerSample: number }): Uint8Array {
  const { pixels, samplesPerPixel, bytesPerSample } = options;
  const out = new Uint8Array(data.length);
  for (let p = 0; p < pixels; p++) {
    for (let s = 0; s < samplesPerPixel; s++) {
      const src = (p * samplesPerPixel + s) * bytesPerSample;
      const dst = (s * pixels + p) * bytesPerSample;
      for (let b = 0; b < bytesPerSample; b++) {
        out[dst + b] = data[src + b];
      }
    }
  }
  return out;
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

/**
 * Returns a function that resolves the IFD for pyramid level `resolution` of
 * a base (level 0) IFD in the main chain, loading and caching SubIFDs lazily.
 */
export function createSubIfdResolver(tiff: Tiff) {
  const cache = new Map<number, Promise<TiffImage>>();
  return async (baseImage: TiffImage, resolution: number): Promise<TiffImage> => {
    if (resolution === 0) return baseImage;
    const subIfdOffsets = (await baseImage.fetch(TiffTag.SubIFDs)) as number[] | null;
    const offset = subIfdOffsets?.[resolution - 1];
    assert(offset !== undefined, `IFD ${baseImage.id} has no SubIFD for level ${resolution}`);
    let subImage = cache.get(offset);
    if (!subImage) {
      subImage = loadSubIfd(tiff, offset);
      cache.set(offset, subImage);
    }
    return subImage;
  };
}

/** Zarr v3 array metadata for a virtual array. */
export function arrayZarrJson(options: { shape: number[]; chunkShape: number[]; dataType: string }): Uint8Array {
  return encodeJson({
    zarr_format: 3,
    node_type: "array",
    shape: options.shape,
    data_type: options.dataType,
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: options.chunkShape },
    },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0,
    attributes: {},
  });
}

/** Root `zarr.json` augmented with inline consolidated metadata. */
export function consolidateMetadata(root: Uint8Array, arrays: Uint8Array[]): Record<string, unknown> {
  const decoder = new TextDecoder();
  const rootMeta = JSON.parse(decoder.decode(root)) as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  arrays.forEach((zarrJson, i) => {
    metadata[i.toString()] = JSON.parse(decoder.decode(zarrJson));
  });
  return {
    ...rootMeta,
    consolidated_metadata: { metadata, kind: "inline", must_understand: false },
  };
}

/** Slice a value returned by `get` according to a zarrita RangeQuery. */
export function sliceRange(data: Uint8Array, range: { offset: number; length: number } | { suffixLength: number }): Uint8Array {
  if ('suffixLength' in range) {
    return data.slice(Math.max(0, data.length - range.suffixLength));
  }
  return data.slice(range.offset, range.offset + range.length);
}

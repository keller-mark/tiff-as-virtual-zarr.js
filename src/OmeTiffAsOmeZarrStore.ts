// Reference: https://github.com/hms-dbmi/vizarr/blob/deee311fc71fd06694096f147e8ad51090d1d421/src/ome-tiff-store.ts
/*
MIT License

Copyright (c) 2020 Trevor Manz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { Compression, Predictor, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import { decompress } from "@developmentseed/lzw-tiff-decoder";
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
//import type { ImageSchema } from 'zod-ome-ngff/0.5';
//import type { z } from 'zod';
//import { type Pixels, type Channel, type DimensionOrder } from './ome-tiff-types.js';
//import { createOffsetsProxy } from './proxies.js';
import { SourceFromAsyncReadable } from "./SourceFromAsyncReadable.js";
import type { Ome } from './types.js';

export const COLORS = {
  cyan: "#00FFFF",
  yellow: "#FFFF00",
  magenta: "#FF00FF",
  red: "#FF0000",
  green: "#00FF00",
  blue: "#0000FF",
  white: "#FFFFFF",
};
export const MAGENTA_GREEN = [COLORS.magenta, COLORS.green];
export const RGB = [COLORS.red, COLORS.green, COLORS.blue];
export const CYMRGB = Object.values(COLORS).slice(0, 6);

/**
 * Error thrown when an assertion fails.
 */
export class AssertionError extends Error {
  /** @param message The error message. */
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Make an assertion. An error is thrown if `expr` does not have truthy value.
 *
 * @param expr The expression to test.
 * @param msg The message to display if the assertion fails.
 */
export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

// ── Main store class ──────────────────────────────────────────────────────────
//export class OmeTiffAsOmeZarrStore implements AsyncReadable {

  /**
   * Create a store from an AsyncReadable that serves the raw TIFF bytes at
   * key '/'.  The full TIFF is buffered in memory on first access; for
   * large remote TIFFs prefer `fromUrl` so geotiff can issue true HTTP Range
   * requests instead.
   */
  /*static async fromStore(
    store: AsyncReadable,
    offsets?: number[],
  ): Promise<OmeTiffAsOmeZarrStore> {
    const client = new StoreTiffClient(store);
    const tiff = await fromCustomClient(client);
    return new OmeTiffAsOmeZarrStore(offsets ? createOffsetsProxy(tiff, offsets) : tiff);
  }*/

  
//}

/**
 * Returns the relative IFD index given the selection and the size of the image.
 *
 * This is is necessary because the IFD ordering is implicitly defined by the
 * dimension order.
 *
 * @param selection - The desired plane selection.
 * @param options.size - The size of each (z, t, c) dimension from the OME-XML.
 * @param options.dimensionOrder - The dimension order of the image from the OME-XML.
 */
function getRelativeOmeIfdIndex(
  selection: { z: number; t: number; c: number },
  options: {
    sizes: { z: number; t: number; c: number };
    dimensionOrder: string;
  },
) {
  const { z, t, c } = selection;
  const { sizes, dimensionOrder } = options;
  switch (dimensionOrder) {
    case "XYZCT":
      return z + sizes.z * c + sizes.z * sizes.c * t;
    case "XYZTC":
      return z + sizes.z * t + sizes.z * sizes.t * c;
    case "XYCTZ":
      return c + sizes.c * t + sizes.c * sizes.t * z;
    case "XYCZT":
      return c + sizes.c * z + sizes.c * sizes.z * t;
    case "XYTCZ":
      return t + sizes.t * c + sizes.t * sizes.c * z;
    case "XYTZC":
      return t + sizes.t * z + sizes.t * sizes.z * c;
    default:
      throw new Error(`Invalid dimension order: ${dimensionOrder}`);
  }
}

function encodeJson(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj, null, 2));
}

type AxisName = 't' | 'c' | 'z' | 'y' | 'x';

function getActiveAxes(sizes: { t: number; c: number; z: number }): AxisName[] {
  const axes: AxisName[] = [];
  if (sizes.t > 1) axes.push('t');
  if (sizes.c > 1) axes.push('c');
  if (sizes.z > 1) axes.push('z');
  axes.push('y', 'x');
  return axes;
}

function omeTiffTypeToZarrType(omeType: string): string {
  const typeMap: Record<string, string> = {
    uint8: 'uint8',
    uint16: 'uint16',
    uint32: 'uint32',
    uint64: 'uint64',
    int8: 'int8',
    int16: 'int16',
    int32: 'int32',
    int64: 'int64',
    float: 'float32',
    double: 'float64',
  };
  return typeMap[omeType.toLowerCase()] ?? omeType;
}

function parseKey(key: AbsolutePath):
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

type Context = {
  tileSize: number;
  bytesPerPixel: number;
  predictor: Predictor;
  activeAxes: AxisName[];
  indexer(
    coords: {
      z: number;
      t: number;
      c: number;
    },
    resolution: number,
  ): Promise<TiffImage>;
  root: {
    zarrJson: Uint8Array;
  };
  resolutions: Array<{
    sizes: { t: number; c: number; z: number; y: number; x: number };
    zarrJson: Uint8Array;
  }>;
};

async function resolveMetadata(tiff: Tiff) {
  const image = tiff.images[0];
  const subIfds = (await image.fetch(TiffTag.SubIFDs)) as number[] | null;
  assert(subIfds, "Only support bioformats >6");
  const raw = String(await image.fetch(TiffTag.ImageDescription));
  // biome-ignore lint/suspicious/noExplicitAny: proper validation later
  const xml = parseXml(raw) as Record<string, any>;

  const name = xml?.Image?.attr?.Name ?? "unknown";
  assert(typeof name === "string");

  const physicalSizeX = Number(xml.Image?.Pixels?.attr?.PhysicalSizeX);
  const physicalSizeXUnit = xml.Image?.Pixels?.attr?.PhysicalSizeXUnit as string | undefined;
  const physicalSizeY = Number(xml.Image?.Pixels?.attr?.PhysicalSizeY);
  const physicalSizeYUnit = xml.Image?.Pixels?.attr?.PhysicalSizeYUnit as string | undefined;

  const sizeT = Number(xml.Image?.Pixels?.attr?.SizeT);
  const sizeC = Number(xml.Image?.Pixels?.attr?.SizeC);
  const sizeZ = Number(xml.Image?.Pixels?.attr?.SizeZ);
  const sizeY = Number(xml.Image?.Pixels?.attr?.SizeY);
  const sizeX = Number(xml.Image?.Pixels?.attr?.SizeX);
  assert(
    !Number.isNaN(sizeT) &&
      !Number.isNaN(sizeC) &&
      !Number.isNaN(sizeZ) &&
      !Number.isNaN(sizeY) &&
      !Number.isNaN(sizeX),
  );

  let omero: Ome.Omero | undefined = undefined;
  if (Array.isArray(xml?.Image?.Pixels?.Channel) && xml.Image.Pixels.Channel.length === sizeC) {
    omero = {
      id: 1,
      version: "0.1",
      name: name,
      channels: xml.Image.Pixels.Channel.map(
        (entry: { attr: { Name: string; Color?: string } }, i: number) =>
          ({
            active: i < 6,
            label: entry.attr.Name,
            color: entry.attr.Color ? intToHexColor(Number(entry.attr.Color)) : CYMRGB[i % CYMRGB.length],
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: {
              min: 0,
              max: 65535,
              start: 0,
              end: 65535,
            },
          }) satisfies Ome.Channel,
      ),
      rdefs: {
        model: "greyscale",
      },
    };
  }

  const dimensionOrder = xml.Image?.Pixels?.attr?.DimensionOrder;
  assert(typeof dimensionOrder === "string");

  const interleaved = xml.Image?.Pixels?.attr?.Interleaved;
  assert(interleaved === "false" || interleaved === undefined);

  const dataType = xml.Image?.Pixels?.attr?.Type;
  // Zarr will tell us if we have a supported dtype or not
  assert(typeof dataType === "string");

  const bitsPerSample = image.value(TiffTag.BitsPerSample);
  const bytesPerPixel = bitsPerSample ? bitsPerSample[0] / 8 : 1;
  const predictor = image.value(TiffTag.Predictor) ?? Predictor.None;

  const sizes = { t: sizeT, c: sizeC, z: sizeZ, y: sizeY, x: sizeX };
  return {
    raw,
    dimensionOrder,
    dataType: omeTiffTypeToZarrType(dataType),
    name,
    sizes,
    omero,
    resolutions: subIfds.length - 1,
    tileSize: getTileSize(image),
    bytesPerPixel,
    predictor,
    activeAxes: getActiveAxes(sizes),
    physicalSizeX,
    physicalSizeY,
    physicalSizeXUnit,
    physicalSizeYUnit,
  };
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

async function loadSubIfd(tiff: Tiff, offset: number): Promise<TiffImage> {
  const readIfd = getReadIfd(tiff);
  const bytes = await tiff.source.fetch(offset, tiff.defaultReadSize);
  const view = Object.assign(new DataView(bytes), { sourceOffset: offset });
  readIfd(offset, view);
  const subImage = tiff.images[tiff.images.length - 1];
  await subImage.init();
  return subImage;
}

async function createVirtualZarrMetadata(tiff: Tiff): Promise<Context> {
  const meta = await resolveMetadata(tiff);
  const { activeAxes } = meta;

  // Spatial scale at base resolution (from physical size, defaulting to 1.0)
  const baseScaleY = !Number.isNaN(meta.physicalSizeY) && meta.physicalSizeY > 0 ? meta.physicalSizeY : 1.0;
  const baseScaleX = !Number.isNaN(meta.physicalSizeX) && meta.physicalSizeX > 0 ? meta.physicalSizeX : 1.0;

  const ome = {
    version: '0.5',
    omero: meta.omero,
    multiscales: [
      {
        datasets: Array.from({ length: meta.resolutions }, (_, i) => {
          const scaleFactor = Math.pow(2, i);
          const scale = activeAxes.map((axis) => {
            if (axis === 'y') return baseScaleY * scaleFactor;
            if (axis === 'x') return baseScaleX * scaleFactor;
            return 1.0;
          });
          return {
            path: i.toString(),
            coordinateTransformations: [{ type: 'scale', scale }],
          };
        }),
        axes: activeAxes.map((name) => {
          if (name === 'c') return { name: 'c', type: 'channel' };
          if (name === 't') return { name: 't', type: 'time' };
          if (name === 'z') return { name: 'z', type: 'space' };
          if (name === 'y') return {
            name: 'y',
            type: 'space',
            ...(meta.physicalSizeYUnit ? { unit: meta.physicalSizeYUnit } : {}),
          };
          // 'x'
          return {
            name: 'x',
            type: 'space',
            ...(meta.physicalSizeXUnit ? { unit: meta.physicalSizeXUnit } : {}),
          };
        }),
      },
    ],
  };

  const subIfdCache = new Map<number, TiffImage>();
  return {
    tileSize: meta.tileSize,
    bytesPerPixel: meta.bytesPerPixel,
    predictor: meta.predictor,
    activeAxes,
    async indexer(coords: { z: number; c: number; t: number }, resolution: number) {
      const baseImage = tiff.images[getRelativeOmeIfdIndex(coords, meta)];

      // It's the highest resolution, no need to look up SubIFDs.
      if (resolution === 0) {
        return baseImage;
      }

      const subIfdOffsets = (await baseImage.fetch(TiffTag.SubIFDs)) as number[];
      const offset = subIfdOffsets[resolution - 1];
      const cached = subIfdCache.get(offset);
      if (cached) return cached;

      const subImage = await loadSubIfd(tiff, offset);
      subIfdCache.set(offset, subImage);
      return subImage;
    },
    root: {
      zarrJson: encodeJson({
        zarr_format: 3,
        node_type: "group",
        attributes: { ome },
      }),
    },
    resolutions: Array.from({ length: meta.resolutions }, (_, resolution) => {
      const shape = activeAxes.map((axis) => {
        switch (axis) {
          case 't': return meta.sizes.t;
          case 'c': return meta.sizes.c;
          case 'z': return meta.sizes.z;
          case 'y': return meta.sizes.y >> resolution;
          case 'x': return meta.sizes.x >> resolution;
        }
      });
      const chunkShape = activeAxes.map((axis) =>
        (axis === 'y' || axis === 'x') ? meta.tileSize : 1
      );
      return {
        sizes: {
          ...meta.sizes,
          y: meta.sizes.y >> resolution,
          x: meta.sizes.x >> resolution,
        },
        zarrJson: encodeJson({
          zarr_format: 3,
          node_type: "array",
          shape,
          data_type: meta.dataType,
          chunk_grid: {
            name: "regular",
            configuration: { chunk_shape: chunkShape },
          },
          chunk_key_encoding: {
            name: "default",
            configuration: { separator: "/" },
          },
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          fill_value: 0,
          attributes: {},
        }),
      };
    }),
  };
}

/**
 * Undo TIFF horizontal differencing (Predictor=2).
 *
 * To improve compression ratios, TIFF encoders can store each pixel as the
 * difference from its left neighbor instead of the absolute value. Adjacent
 * pixels in an image are usually similar, so these differences cluster near
 * zero and compress much better.
 *
 * This function reverses that transform by accumulating the differences back
 * into absolute values. The operation is per-row and per-byte — for multi-byte
 * samples (e.g. uint16), each byte lane is accumulated independently.
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
 * Decompress a raw TIFF tile, undo predictor differencing, and normalize
 * to little-endian so the zarr codec can always declare `endian: "little"`.
 */
async function decompressTile(
  tile: { bytes: ArrayBuffer; compression: Compression },
  options: { tileSize: number; bytesPerPixel: number; predictor: Predictor; isLittleEndian: boolean },
): Promise<Uint8Array> {
  const { tileSize, bytesPerPixel, predictor, isLittleEndian } = options;
  const maxUncompressedSize = tileSize * tileSize * bytesPerPixel;
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
    undoHorizontalDifferencing(data, { tileSize, bytesPerPixel });
  }
  if (!isLittleEndian && bytesPerPixel > 1) {
    swapEndianness(data, bytesPerPixel);
  }
  return data;
}

export class OmeTiffAsOmeZarrStore implements AsyncReadable<{ signal: AbortSignal }> {
  #tiff: Tiff;
  #context: Context | undefined = undefined;

  constructor(tiff: Tiff) {
    this.#tiff = tiff;
  }

  static async fromStore(internal_store: AsyncReadable): Promise<OmeTiffAsOmeZarrStore> {
    return new OmeTiffAsOmeZarrStore(await Tiff.create(new SourceFromAsyncReadable(internal_store)));
  }

  async get(key: AbsolutePath, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const keyResult = parseKey(key);
    if (keyResult.kind === "unknown") {
      return undefined;
    }
    if (!this.#context) {
      this.#context = await createVirtualZarrMetadata(this.#tiff);
    }
    if (keyResult.kind === "meta") {
      if (keyResult.value.kind === "root") {
        return this.#context.root.zarrJson;
      }
      const resolution = keyResult.value.value;
      return this.#context.resolutions[resolution]?.zarrJson;
    }
    const { tileSize, bytesPerPixel, predictor, activeAxes } = this.#context;
    const { resolution, chunkCoords } = keyResult;
    const sizes = this.#context.resolutions[resolution]?.sizes;
    if (!sizes) {
      return undefined;
    }
    // Map chunk coords (in collapsed-axis order) to TIFF t/c/z/y/x
    const t = activeAxes.includes('t') ? chunkCoords[activeAxes.indexOf('t')] : 0;
    const c = activeAxes.includes('c') ? chunkCoords[activeAxes.indexOf('c')] : 0;
    const z = activeAxes.includes('z') ? chunkCoords[activeAxes.indexOf('z')] : 0;
    const y = chunkCoords[activeAxes.indexOf('y')];
    const x = chunkCoords[activeAxes.indexOf('x')];
    const image = await this.#context.indexer({ t, c, z }, resolution);
    const tile = await image.getTile(x, y, { signal: options.signal });
    if (!tile) {
      // Sparse / empty tile — return zeros
      return new Uint8Array(tileSize * tileSize * bytesPerPixel);
    }
    return decompressTile(tile, { tileSize, bytesPerPixel, predictor, isLittleEndian: this.#tiff.isLittleEndian });
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const data = await this.get(key, options);
    if (data === undefined) return undefined;
    if ('suffixLength' in range) {
      return data.slice(Math.max(0, data.length - range.suffixLength));
    }
    return data.slice(range.offset, range.offset + range.length);
  }
}

type XmlNode = string | { [x: string]: XmlNode } | Array<XmlNode>;

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1;
}

function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

function xmlToJson(xmlNode: HTMLElement, options: { attrtibutesKey: string }): XmlNode {
  if (isText(xmlNode)) {
    // If the node is a text node
    return xmlNode.nodeValue?.trim() ?? "";
  }

  // If the node has no attributes and no children, return an empty string
  if (xmlNode.childNodes.length === 0 && (!xmlNode.attributes || xmlNode.attributes.length === 0)) {
    return "";
  }

  const xmlObj: XmlNode = {};

  if (xmlNode.attributes && xmlNode.attributes.length > 0) {
    const attrsObj: Record<string, string> = {};
    for (let i = 0; i < xmlNode.attributes.length; i++) {
      const attr = xmlNode.attributes[i];
      attrsObj[attr.name] = attr.value;
    }
    xmlObj[options.attrtibutesKey] = attrsObj;
  }

  for (let i = 0; i < xmlNode.childNodes.length; i++) {
    const childNode = xmlNode.childNodes[i];
    if (!isElement(childNode)) {
      continue;
    }
    const childXmlObj = xmlToJson(childNode, options);
    if (childXmlObj !== undefined && childXmlObj !== "") {
      if (childNode.nodeName === "#text" && xmlNode.childNodes.length === 1) {
        return childXmlObj;
      }
      if (xmlObj[childNode.nodeName]) {
        if (!Array.isArray(xmlObj[childNode.nodeName])) {
          xmlObj[childNode.nodeName] = [xmlObj[childNode.nodeName]];
        }
        (xmlObj[childNode.nodeName] as XmlNode[]).push(childXmlObj);
      } else {
        xmlObj[childNode.nodeName] = childXmlObj;
      }
    }
  }

  return xmlObj;
}

function parseXml(xmlString: string) {
  const parser = new DOMParser();
  // Remove trailing null character, which can break XML parsing in Firefox
  const doc = parser.parseFromString(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Necessary for parsing XML
    xmlString.replace(/\u0000$/, ""),
    "application/xml",
  );
  return xmlToJson(doc.documentElement, { attrtibutesKey: "attr" });
}

function getTileSize(image: TiffImage) {
  const { width, height } = image.tileSize;
  const size = Math.min(width, height);
  // deck.gl requirement for power-of-two tile size.
  return 2 ** Math.floor(Math.log2(size));
}

/**
 * Converts 32-bit integer color representation to a 6-character hexadecimal RGB string.
 *
 * > console.log(intToHexColor(100100));
 * > // "018704"
 */
function intToHexColor(int: number): string {
  if (!Number.isInteger(int)) {
    throw Error("Not an integer.");
  }

  // Write number to int32 representation (4 bytes).
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setInt32(0, int, false); // offset === 0, littleEndian === false

  // Take u8 view and extract number for each byte (1 byte for R/G/B/A).
  const bytes = new Uint8Array(buffer);

  return [bytes[0], bytes[1], bytes[2]].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

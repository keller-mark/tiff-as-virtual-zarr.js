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
import { Predictor, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import { SourceFromAsyncReadable } from "./SourceFromAsyncReadable.js";
import { assert, AssertionError, encodeJson, parseKey, decompressTile, loadSubIfd, getTileSize } from "./tiff-utils.js";
import type { Ome } from './types.js';

export { assert, AssertionError };

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
  // cogeotiff decodes ASCII tags with String.fromCharCode (Latin-1), but OME-XML is UTF-8.
  // Re-encode as bytes and decode as UTF-8 so multibyte characters like µ are correct.
  const rawLatin1 = String(await image.fetch(TiffTag.ImageDescription));
  const raw = new TextDecoder("utf-8").decode(Uint8Array.from(rawLatin1, (c) => c.charCodeAt(0)));
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
  let resolutions: number;
  if (subIfds) {
    // Modern bioformats 6+: sub-IFDs on each base image hold the pyramid levels.
    resolutions = subIfds.length - 1;
  } else {
    // Legacy bioformats (<6): pyramid levels are stored as sequential IFDs after
    // the base-resolution IFDs.  The main IFD chain has ifdPerLevel * numLevels
    // entries where ifdPerLevel = T * C * Z.
    const ifdPerLevel = sizeT * sizeC * sizeZ;
    resolutions = Math.max(1, Math.floor(tiff.images.length / ifdPerLevel));
  }
  return {
    raw,
    dimensionOrder,
    dataType: omeTiffTypeToZarrType(dataType),
    name,
    sizes,
    omero,
    resolutions,
    isLegacy: !subIfds,
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
  const ifdPerLevel = meta.sizes.t * meta.sizes.c * meta.sizes.z;
  return {
    tileSize: meta.tileSize,
    bytesPerPixel: meta.bytesPerPixel,
    predictor: meta.predictor,
    activeAxes,
    async indexer(coords: { z: number; c: number; t: number }, resolution: number) {
      const baseIfdIndex = getRelativeOmeIfdIndex(coords, meta);
      const baseImage = tiff.images[baseIfdIndex];

      // It's the highest resolution, no need to look up SubIFDs.
      if (resolution === 0) {
        return baseImage;
      }

      if (meta.isLegacy) {
        // Legacy bioformats (<6): pyramid levels are sequential IFDs after the
        // base-resolution block.
        return tiff.images[baseIfdIndex + resolution * ifdPerLevel];
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

export class OmeTiffAsOmeZarrStore implements AsyncReadable {
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
    return decompressTile(tile, { tileWidth: tileSize, tileHeight: tileSize, bytesPerPixel, predictor, isLittleEndian: this.#tiff.isLittleEndian });
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const data = await this.get(key, options);
    if (data === undefined) return undefined;
    if ('suffixLength' in range) {
      return data.slice(Math.max(0, data.length - range.suffixLength));
    }
    return data.slice(range.offset, range.offset + range.length);
  }

  /**
   * Generate Zarr v3 consolidated metadata for this store.
   *
   * Returns the root `zarr.json` object with a `consolidated_metadata` field
   * that embeds the array metadata for every resolution level.
   */
  async getConsolidatedMetadata(): Promise<Record<string, unknown>> {
    if (!this.#context) {
      this.#context = await createVirtualZarrMetadata(this.#tiff);
    }
    const rootMeta = JSON.parse(new TextDecoder().decode(this.#context.root.zarrJson)) as Record<string, unknown>;
    const childMeta: Record<string, unknown> = {};
    for (let i = 0; i < this.#context.resolutions.length; i++) {
      childMeta[i.toString()] = JSON.parse(new TextDecoder().decode(this.#context.resolutions[i].zarrJson));
    }
    return {
      ...rootMeta,
      consolidated_metadata: {
        metadata: childMeta,
        kind: "inline",
        must_understand: false,
      },
    };
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

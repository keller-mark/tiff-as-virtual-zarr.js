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
import { Predictor, SampleFormat, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import { SourceFromAsyncReadable } from "./SourceFromAsyncReadable.js";
import {
  assert,
  AssertionError,
  arrayZarrJson,
  consolidateMetadata,
  createSubIfdResolver,
  decodeSegment,
  defaultWindow,
  encodeJson,
  getSegmentLayout,
  levelScaleFactor,
  parseKey,
  readSegment,
  sampleFormatToZarrType,
  sliceRange,
  type SegmentLayout,
} from "./tiff-utils.js";
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
  const zarrType = typeMap[omeType.toLowerCase()];
  assert(zarrType, `Unsupported OME-XML pixel type: ${omeType}`);
  return zarrType;
}

/**
 * OME-XML UnitsLength symbols → OME-NGFF unit names. Units without an
 * OME-NGFF equivalent (pixel, reference frame, thou, li, ua, ly, pt) are
 * absent and therefore omitted from the axes.
 */
const OME_TO_NGFF_LENGTH_UNITS: Record<string, string> = {
  Ym: 'yottameter',
  Zm: 'zettameter',
  Em: 'exameter',
  Pm: 'petameter',
  Tm: 'terameter',
  Gm: 'gigameter',
  Mm: 'megameter',
  km: 'kilometer',
  hm: 'hectometer',
  dam: 'decameter',
  m: 'meter',
  dm: 'decimeter',
  cm: 'centimeter',
  mm: 'millimeter',
  'µm': 'micrometer', // U+00B5 MICRO SIGN
  'μm': 'micrometer', // U+03BC GREEK SMALL LETTER MU
  um: 'micrometer',
  nm: 'nanometer',
  pm: 'picometer',
  fm: 'femtometer',
  am: 'attometer',
  zm: 'zeptometer',
  ym: 'yoctometer',
  'Å': 'angstrom',
  in: 'inch',
  ft: 'foot',
  yd: 'yard',
  mi: 'mile',
  pc: 'parsec',
};

/**
 * Physical pixel size and OME-NGFF unit for one spatial axis. OME-XML defaults
 * the unit to µm when a physical size is given without one.
 */
function physicalSize(pixelsAttrs: Record<string, string> | undefined, axis: 'X' | 'Y' | 'Z') {
  const size = Number(pixelsAttrs?.[`PhysicalSize${axis}`]);
  const valid = !Number.isNaN(size) && size > 0;
  const omeUnit = pixelsAttrs?.[`PhysicalSize${axis}Unit`] ?? 'µm';
  return {
    scale: valid ? size : 1.0,
    unit: valid ? OME_TO_NGFF_LENGTH_UNITS[omeUnit] : undefined,
  };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type Level = {
  layout: SegmentLayout;
  shape: number[];
  chunkShape: number[];
  zarrJson: Uint8Array;
};

type Context = {
  bytesPerSample: number;
  activeAxes: AxisName[];
  sizes: { t: number; c: number; z: number };
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
  resolutions: Level[];
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

  // Only the first image (series) of multi-image OME-TIFFs is exposed.
  const omeImage = asArray(xml?.Image)[0];
  const pixelsAttrs = omeImage?.Pixels?.attr as Record<string, string> | undefined;

  const name = omeImage?.attr?.Name ?? "unknown";
  assert(typeof name === "string");

  const sizeT = Number(pixelsAttrs?.SizeT);
  const sizeC = Number(pixelsAttrs?.SizeC);
  const sizeZ = Number(pixelsAttrs?.SizeZ);
  assert(
    [sizeT, sizeC, sizeZ].every((size) => Number.isInteger(size) && size >= 1),
    "OME-XML SizeT/SizeC/SizeZ must be positive integers",
  );

  const dimensionOrder = pixelsAttrs?.DimensionOrder;
  assert(typeof dimensionOrder === "string");

  const interleaved = pixelsAttrs?.Interleaved;
  assert(interleaved === "false" || interleaved === undefined, "Interleaved OME-TIFFs are not supported");
  assert((image.value(TiffTag.SamplesPerPixel) ?? 1) === 1, "OME-TIFFs with SamplesPerPixel > 1 are not supported");

  const dataTypeAttr = pixelsAttrs?.Type;
  assert(typeof dataTypeAttr === "string");
  const dataType = omeTiffTypeToZarrType(dataTypeAttr);

  const bitsPerSampleArr = image.value(TiffTag.BitsPerSample);
  const bitsPerSample = bitsPerSampleArr ? bitsPerSampleArr[0] : 8;
  const sampleFormatArr = image.value(TiffTag.SampleFormat);
  const sampleFormat = sampleFormatArr ? sampleFormatArr[0] : SampleFormat.Uint;
  assert(
    sampleFormatToZarrType(bitsPerSample, sampleFormat) === dataType,
    `OME-XML pixel type ${dataTypeAttr} does not match TIFF BitsPerSample/SampleFormat`,
  );

  let omero: Ome.Omero | undefined = undefined;
  const channels = asArray(omeImage?.Pixels?.Channel) as Array<{ attr?: { Name?: string; Color?: string } }>;
  if (channels.length === sizeC) {
    const window = defaultWindow(dataType);
    omero = {
      id: 1,
      version: "0.1",
      name: name,
      channels: channels.map(
        (entry, i) =>
          ({
            active: i < 6,
            label: entry.attr?.Name,
            color: entry.attr?.Color ? intToHexColor(Number(entry.attr.Color)) : CYMRGB[i % CYMRGB.length].slice(1),
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { ...window },
          }) satisfies Ome.Channel,
      ),
      rdefs: {
        model: "greyscale",
      },
    };
  }

  const sizes = { t: sizeT, c: sizeC, z: sizeZ };
  let resolutions: number;
  if (subIfds) {
    // Modern bioformats 6+: sub-IFDs on each base image hold the pyramid levels.
    resolutions = subIfds.length + 1;
  } else {
    // Legacy bioformats (<6): pyramid levels are stored as sequential IFDs after
    // the base-resolution IFDs.  The main IFD chain has ifdPerLevel * numLevels
    // entries where ifdPerLevel = T * C * Z.
    const ifdPerLevel = sizeT * sizeC * sizeZ;
    resolutions = Math.max(1, Math.floor(tiff.images.length / ifdPerLevel));
  }
  return {
    dimensionOrder,
    dataType,
    sizes,
    omero,
    resolutions,
    isLegacy: !subIfds,
    bytesPerSample: bitsPerSample / 8,
    activeAxes: getActiveAxes(sizes),
    physicalSizes: {
      x: physicalSize(pixelsAttrs, 'X'),
      y: physicalSize(pixelsAttrs, 'Y'),
      z: physicalSize(pixelsAttrs, 'Z'),
    },
  };
}

async function createVirtualZarrMetadata(tiff: Tiff): Promise<Context> {
  const meta = await resolveMetadata(tiff);
  const { activeAxes, physicalSizes } = meta;

  const ifdPerLevel = meta.sizes.t * meta.sizes.c * meta.sizes.z;
  const resolveSubIfd = createSubIfdResolver(tiff);
  const indexer = async (coords: { z: number; c: number; t: number }, resolution: number) => {
    const baseIfdIndex = getRelativeOmeIfdIndex(coords, meta);
    if (meta.isLegacy) {
      // Legacy bioformats (<6): pyramid levels are sequential IFDs after the
      // base-resolution block.
      return tiff.images[baseIfdIndex + resolution * ifdPerLevel];
    }
    return resolveSubIfd(tiff.images[baseIfdIndex], resolution);
  };

  // Level geometry comes from the IFDs of the first plane.
  const layouts = await Promise.all(
    Array.from({ length: meta.resolutions }, async (_, r) => getSegmentLayout(await indexer({ t: 0, c: 0, z: 0 }, r))),
  );
  const resolutions: Level[] = layouts.map((layout) => {
    const shape = activeAxes.map((axis) => {
      switch (axis) {
        case 't': return meta.sizes.t;
        case 'c': return meta.sizes.c;
        case 'z': return meta.sizes.z;
        case 'y': return layout.height;
        case 'x': return layout.width;
      }
    });
    const chunkShape = activeAxes.map((axis) => {
      if (axis === 'y') return layout.segmentHeight;
      if (axis === 'x') return layout.segmentWidth;
      return 1;
    });
    return {
      layout,
      shape,
      chunkShape,
      zarrJson: arrayZarrJson({ shape, chunkShape, dataType: meta.dataType }),
    };
  });

  const base = layouts[0];
  const ome = {
    version: '0.5',
    omero: meta.omero,
    multiscales: [
      {
        datasets: layouts.map((layout, i) => {
          const scale = activeAxes.map((axis) => {
            if (axis === 'y') return physicalSizes.y.scale * levelScaleFactor(base.height, layout.height, i);
            if (axis === 'x') return physicalSizes.x.scale * levelScaleFactor(base.width, layout.width, i);
            if (axis === 'z') return physicalSizes.z.scale;
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
          const { unit } = physicalSizes[name];
          return { name, type: 'space', ...(unit ? { unit } : {}) };
        }),
      },
    ],
  };

  return {
    bytesPerSample: meta.bytesPerSample,
    activeAxes,
    sizes: meta.sizes,
    indexer,
    root: {
      zarrJson: encodeJson({
        zarr_format: 3,
        node_type: "group",
        attributes: { ome },
      }),
    },
    resolutions,
  };
}

export class OmeTiffAsOmeZarrStore implements AsyncReadable {
  #tiff: Tiff;
  #context: Promise<Context> | undefined = undefined;

  constructor(tiff: Tiff) {
    this.#tiff = tiff;
  }

  static async fromStore(internal_store: AsyncReadable): Promise<OmeTiffAsOmeZarrStore> {
    return new OmeTiffAsOmeZarrStore(await Tiff.create(new SourceFromAsyncReadable(internal_store)));
  }

  #getContext(): Promise<Context> {
    this.#context ??= createVirtualZarrMetadata(this.#tiff);
    return this.#context;
  }

  async get(key: AbsolutePath, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const keyResult = parseKey(key);
    if (keyResult.kind === "unknown") {
      return undefined;
    }
    const context = await this.#getContext();
    if (keyResult.kind === "meta") {
      if (keyResult.value.kind === "root") {
        return context.root.zarrJson;
      }
      const resolution = keyResult.value.value;
      return context.resolutions[resolution]?.zarrJson;
    }
    const { bytesPerSample, activeAxes } = context;
    const { resolution, chunkCoords } = keyResult;
    const level = context.resolutions[resolution];
    if (!level || chunkCoords.length !== activeAxes.length) {
      return undefined;
    }
    const { shape, chunkShape, layout } = level;
    if (chunkCoords.some((coord, i) => coord >= Math.ceil(shape[i] / chunkShape[i]))) {
      return undefined;
    }
    // Map chunk coords (in collapsed-axis order) to TIFF t/c/z/y/x
    const t = activeAxes.includes('t') ? chunkCoords[activeAxes.indexOf('t')] : 0;
    const c = activeAxes.includes('c') ? chunkCoords[activeAxes.indexOf('c')] : 0;
    const z = activeAxes.includes('z') ? chunkCoords[activeAxes.indexOf('z')] : 0;
    const y = chunkCoords[activeAxes.indexOf('y')];
    const x = chunkCoords[activeAxes.indexOf('x')];
    const image = await context.indexer({ t, c, z }, resolution);
    const planeLayout = getSegmentLayout(image);
    assert(
      planeLayout.segmentWidth === layout.segmentWidth && planeLayout.segmentHeight === layout.segmentHeight,
      `IFD ${image.id} segment size differs from the first plane of level ${resolution}`,
    );
    const { segmentWidth, segmentHeight } = layout;
    const segment = await readSegment(image, y * layout.segmentsAcross + x, options);
    if (!segment) {
      // Sparse / empty tile — return zeros
      return new Uint8Array(segmentWidth * segmentHeight * bytesPerSample);
    }
    return decodeSegment(segment, {
      segmentWidth,
      segmentHeight,
      samplesPerPixel: 1,
      bytesPerSample,
      predictor: image.value(TiffTag.Predictor) ?? Predictor.None,
      isLittleEndian: this.#tiff.isLittleEndian,
    });
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const data = await this.get(key, options);
    return data === undefined ? undefined : sliceRange(data, range);
  }

  /**
   * Generate Zarr v3 consolidated metadata for this store.
   *
   * Returns the root `zarr.json` object with a `consolidated_metadata` field
   * that embeds the array metadata for every resolution level.
   */
  async getConsolidatedMetadata(): Promise<Record<string, unknown>> {
    const context = await this.#getContext();
    return consolidateMetadata(context.root.zarrJson, context.resolutions.map((r) => r.zarrJson));
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

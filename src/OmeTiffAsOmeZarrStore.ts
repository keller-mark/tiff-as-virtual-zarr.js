import {
  fromFile as geoFromFile,
  fromUrl as geoFromUrl,
  fromArrayBuffer,
  fromCustomClient,
  GeoTIFFImage,
  BaseClient,
  BaseResponse,
} from 'geotiff';
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import type { ImageSchema } from 'zod-ome-ngff/0.5';
import type { z } from 'zod';
import { type Pixels, type Channel, type DimensionOrder } from './ome-tiff-types.js';
import { createOffsetsProxy } from './proxies.js';

// ── Metadata for each scale level ────────────────────────────────────────────
interface ScaleInfo {
  shape: number[];       // full array shape at this scale [dim0, ..., Y, X]
  tileShape: number[];   // chunk shape [1, ..., 1, tileH, tileW]
  dataType: string;      // zarr v3 data_type string
  scaleFactorY: number;  // relative to scale 0
  scaleFactorX: number;
}

// ── Parsed TIFF structure ────────────────────────────────────────────────────
interface TiffMeta {
  pixels: Pixels;
  activeDims: string[];                        // non-singleton non-spatial dims, outermost first
  activeSizes: number[];
  nonSpatialOrderFastToSlow: string[];         // e.g. ['C','Z','T'] for DimOrder XYCZT
  nonSpatialSizes: Record<string, number>;
  scales: ScaleInfo[];
  numScales: number;
  channels: Channel[];
  interleaved: boolean;
}

// ── OME-XML parser ────────────────────────────────────────────────────────────
async function parseOmeXml(xml: string): Promise<{ pixels: Pixels; channels: Channel[] }> {
  let parser: DOMParser;
  if (typeof DOMParser !== 'undefined') {
    parser = new DOMParser();
  } else {
    // Node.js / test environment — xmldom must be installed as a dep
    const { DOMParser: NodeDOMParser } = await import(/* @vite-ignore */ 'xmldom');
    parser = new NodeDOMParser() as unknown as DOMParser;
  }

  const doc = parser.parseFromString(xml, 'text/xml');
  const pixelsEl = doc.getElementsByTagName('Pixels')[0];
  if (!pixelsEl) throw new Error('No Pixels element in OME-XML');

  const ga = (name: string): string | null => pixelsEl.getAttribute(name);

  const pixels: Pixels = {
    ID: ga('ID') ?? '',
    DimensionOrder: (ga('DimensionOrder') ?? 'XYCZT') as DimensionOrder,
    Type: (ga('Type') ?? 'uint8') as Pixels['Type'],
    SizeX: parseInt(ga('SizeX') ?? '0'),
    SizeY: parseInt(ga('SizeY') ?? '0'),
    SizeZ: parseInt(ga('SizeZ') ?? '1'),
    SizeT: parseInt(ga('SizeT') ?? '1'),
    SizeC: parseInt(ga('SizeC') ?? '1'),
    PhysicalSizeX: toFloat(ga('PhysicalSizeX')),
    PhysicalSizeXUnit: ga('PhysicalSizeXUnit') as Pixels['PhysicalSizeXUnit'],
    PhysicalSizeY: toFloat(ga('PhysicalSizeY')),
    PhysicalSizeYUnit: ga('PhysicalSizeYUnit') as Pixels['PhysicalSizeYUnit'],
    PhysicalSizeZ: toFloat(ga('PhysicalSizeZ')),
    PhysicalSizeZUnit: ga('PhysicalSizeZUnit') as Pixels['PhysicalSizeZUnit'],
    SignificantBits: parseInt(ga('SignificantBits') ?? '0'),
    BigEndian: ga('BigEndian') === 'true',
    Interleaved: ga('Interleaved') === 'true',
    TiffData: { IFD: '', PlaneCount: 0 },
    Channels: [],
  };

  const channelEls = doc.getElementsByTagName('Channel');
  const channels: Channel[] = [];
  for (let i = 0; i < channelEls.length; i++) {
    const el = channelEls[i];
    const colorStr = el.getAttribute('Color');
    let color: number[] | undefined;
    if (colorStr != null) {
      // OME Color is a packed signed 32-bit RGBA integer
      const u = parseInt(colorStr) >>> 0;
      color = [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
    }
    channels.push({
      ID: el.getAttribute('ID') ?? `Channel:0:${i}`,
      SamplesPerPixel: parseInt(el.getAttribute('SamplesPerPixel') ?? '1'),
      ...(el.getAttribute('Name') != null ? { Name: el.getAttribute('Name')! } : {}),
      ...(color ? { Color: color } : {}),
    });
  }
  pixels.Channels = channels;

  return { pixels, channels };
}

function toFloat(s: string | null): number {
  return s != null ? parseFloat(s) : 0;
}

// ── Unit conversion (OME-XML → UDUNITS-2 / OME-NGFF) ─────────────────────────
// OME-XML uses symbol shorthand (e.g. "µm"); OME-NGFF expects the UDUNITS-2
// full name (e.g. "micrometer").
const OME_UNIT_TO_NGFF: Record<string, string> = {
  Ym: 'yottameter', Zm: 'zettameter', Em: 'exameter', Pm: 'petameter',
  Tm: 'terameter', Gm: 'gigameter', Mm: 'megameter', km: 'kilometer',
  hm: 'hectometer', dam: 'decameter', m: 'meter', dm: 'decimeter',
  cm: 'centimeter', mm: 'millimeter', µm: 'micrometer', nm: 'nanometer',
  pm: 'picometer', fm: 'femtometer', am: 'attometer', zm: 'zeptometer',
  ym: 'yoctometer', Å: 'angstrom',
  thou: 'thou', li: 'link', in: 'inch', ft: 'foot', yd: 'yard',
  mi: 'mile', ua: 'astronomicalUnit', ly: 'lightYear', pc: 'parsec',
  pt: 'point', pixel: 'pixel', 'reference frame': 'referenceFrame',
};

function omeUnitToNgff(unit: string | null | undefined): string | undefined {
  if (!unit) return undefined;
  return OME_UNIT_TO_NGFF[unit] ?? unit;
}

// ── Type conversion ───────────────────────────────────────────────────────────
function omeTypeToZarr(omeType: string): string {
  const map: Record<string, string> = {
    uint8: 'uint8', uint16: 'uint16', uint32: 'uint32',
    int8: 'int8', int16: 'int16', int32: 'int32',
    float: 'float32', double: 'float64',
    bit: 'uint8',
  };
  return map[omeType] ?? 'uint8';
}

// ── IFD index calculation (ported from Viv's getRelativeOmeIfdIndex) ──────────
function getRelativeIfdIndex(
  sel: { t: number; z: number; c: number },
  dimensionOrder: DimensionOrder,
  sizes: { t: number; z: number; c: number },
): number {
  const { t, z, c } = sel;
  switch (dimensionOrder) {
    case 'XYZCT': return z + sizes.z * c + sizes.z * sizes.c * t;
    case 'XYZTC': return z + sizes.z * t + sizes.z * sizes.t * c;
    case 'XYCTZ': return c + sizes.c * t + sizes.c * sizes.t * z;
    case 'XYCZT': return c + sizes.c * z + sizes.c * sizes.z * t;
    case 'XYTCZ': return t + sizes.t * c + sizes.t * sizes.c * z;
    case 'XYTZC': return t + sizes.t * z + sizes.t * sizes.z * c;
    default: throw new Error(`Invalid DimensionOrder: ${dimensionOrder}`);
  }
}

// ── Custom geotiff client backed by an AsyncReadable store ────────────────────
//
// Reads the entire TIFF from store.get('/') on first access and caches it in
// memory, then serves byte-range slices to geotiff's internal reader.
// For large remote TIFFs, prefer OmeTiffAsOmeZarrStore.fromUrl() so that
// geotiff can issue true HTTP Range requests.

class StoreTiffResponse extends BaseResponse {
  private readonly _statusCode: number;
  private readonly _data: ArrayBuffer;
  private readonly _rangeOffset: number;
  private readonly _rangeLength: number;
  private readonly _total: number;

  constructor(
    statusCode: number,
    data: ArrayBuffer,
    rangeOffset = 0,
    rangeLength?: number,
    total = 0,
  ) {
    super();
    this._statusCode = statusCode;
    this._data = data;
    this._rangeOffset = rangeOffset;
    this._rangeLength = rangeLength ?? data.byteLength;
    this._total = total || data.byteLength;
  }

  // BaseResponse.status is typed as void in the .d.ts (an upstream quirk); at
  // runtime it must return a number so that BaseResponse.ok works correctly.
  get status(): any { return this._statusCode; }

  getHeader(name: string): string {
    if (name.toLowerCase() === 'content-range') {
      const end = this._rangeOffset + this._rangeLength - 1;
      return `bytes ${this._rangeOffset}-${end}/${this._total}`;
    }
    return '';
  }

  getData(): ArrayBuffer { return this._data; }
}

class StoreTiffClient extends BaseClient {
  private _store: AsyncReadable;
  private _cachedData: ArrayBuffer | null = null;

  constructor(store: AsyncReadable) {
    super('/');
    this._store = store;
  }

  private async _getAll(): Promise<ArrayBuffer> {
    if (!this._cachedData) {
      const bytes = await this._store.get('/' as AbsolutePath);
      if (!bytes) throw new Error('StoreTiffClient: store returned no data at "/"');
      this._cachedData = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }
    return this._cachedData;
  }

  async request(
    { headers = {} }: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<StoreTiffResponse> {
    const all = await this._getAll();
    const rangeHeader = (headers as Record<string, string>)['Range'];
    if (rangeHeader) {
      // geotiff sends Range: bytes=offset-(offset+length) where end is exclusive
      const m = rangeHeader.match(/bytes=(\d+)-(\d+)/);
      if (m) {
        const offset = parseInt(m[1]);
        const length = parseInt(m[2]) - offset;
        return new StoreTiffResponse(206, all.slice(offset, offset + length), offset, length, all.byteLength);
      }
    }
    return new StoreTiffResponse(200, all);
  }
}

// ── Main store class ──────────────────────────────────────────────────────────
export class OmeTiffAsOmeZarrStore implements AsyncReadable {
  private _tiff: any;
  private _meta: TiffMeta | null = null;
  // Cache of GeoTIFFImage instances keyed by "scale:baseIfdIndex"
  private _imgCache = new Map<string, GeoTIFFImage>();

  private constructor(tiff: any) {
    this._tiff = tiff;
  }

  static async fromFile(path: string): Promise<OmeTiffAsOmeZarrStore> {
    return new OmeTiffAsOmeZarrStore(await geoFromFile(path));
  }

  static async fromUrl(url: string, options?: Record<string, any>): Promise<OmeTiffAsOmeZarrStore> {
    return new OmeTiffAsOmeZarrStore(await geoFromUrl(url, options));
  }

  /**
   * Create a store from an AsyncReadable that serves the raw TIFF bytes at
   * key '/'.  The full TIFF is buffered in memory on first access; for
   * large remote TIFFs prefer `fromUrl` so geotiff can issue true HTTP Range
   * requests instead.
   */
  static async fromStore(
    store: AsyncReadable,
    offsets?: number[],
  ): Promise<OmeTiffAsOmeZarrStore> {
    const client = new StoreTiffClient(store) as unknown as BaseClient;
    const tiff = await fromCustomClient(client);
    return new OmeTiffAsOmeZarrStore(offsets ? createOffsetsProxy(tiff, offsets) : tiff);
  }

  // ── AsyncReadable interface ────────────────────────────────────────────────

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const parts = key.replace(/^\//, '').split('/');
    const meta = await this._getMetadata();

    if (parts.length === 1 && parts[0] === 'zarr.json') {
      return encodeJson(this._buildRootZarrJson(meta));
    }

    if (parts.length === 2 && parts[1] === 'zarr.json') {
      const scale = parseInt(parts[0]);
      if (isNaN(scale) || scale < 0 || scale >= meta.numScales) return undefined;
      return encodeJson(this._buildArrayZarrJson(meta, scale));
    }

    if (parts.length >= 2 && parts[1] !== 'zarr.json') {
      const scale = parseInt(parts[0]);
      if (isNaN(scale) || scale < 0 || scale >= meta.numScales) return undefined;
      // zarrita's default chunk key encoding prefixes coords with 'c': c/i0/i1/...
      const coordParts = parts[1] === 'c' ? parts.slice(2) : parts.slice(1);
      const coords = coordParts.map(Number);
      if (coords.some(isNaN)) return undefined;
      return this._getChunk(meta, scale, coords);
    }

    return undefined;
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    const full = await this.get(key);
    if (!full) return undefined;
    const { offset = 0, length, suffixLength } = range;
    if (suffixLength != null) {
      return full.slice(Math.max(0, full.length - suffixLength));
    }
    if (length != null) {
      return full.slice(offset, offset + length);
    }
    return full.slice(offset);
  }

  // ── Metadata initialisation ────────────────────────────────────────────────

  private async _getMetadata(): Promise<TiffMeta> {
    if (this._meta) return this._meta;

    const img0 = await this._tiff.getImage(0);
    this._imgCache.set('0:0', img0);

    const fd0 = img0.fileDirectory;
    const { pixels, channels } = await parseOmeXml(fd0.ImageDescription ?? '');

    const dataType = omeTypeToZarr(pixels.Type);
    const baseW: number = fd0.ImageWidth;
    const baseH: number = fd0.ImageLength;
    const tileW: number = fd0.TileWidth ?? baseW;
    const tileH: number = fd0.TileLength ?? (fd0.RowsPerStrip ?? baseH);

    const dimOrderUpper = pixels.DimensionOrder.toUpperCase() as DimensionOrder;
    const nonSpatialOrderFastToSlow = dimOrderUpper.slice(2).split('');
    const nonSpatialSizes: Record<string, number> = {
      T: pixels.SizeT, Z: pixels.SizeZ, C: pixels.SizeC,
    };

    // Active dims: non-singleton non-spatial dims, outermost (slow) first
    const slowToFast = [...nonSpatialOrderFastToSlow].reverse();
    const activeDims: string[] = [];
    const activeSizes: number[] = [];
    for (const d of slowToFast) {
      if (nonSpatialSizes[d] > 1) {
        activeDims.push(d.toLowerCase());
        activeSizes.push(nonSpatialSizes[d]);
      }
    }

    const subIFDs: number[] = fd0.SubIFDs
      ? Array.from(fd0.SubIFDs as ArrayLike<number>).map(Number)
      : [];
    const numScales = 1 + subIFDs.length;

    const scales: ScaleInfo[] = [
      {
        shape: [...activeSizes, baseH, baseW],
        tileShape: [...activeSizes.map(() => 1), tileH, tileW],
        dataType,
        scaleFactorY: 1.0,
        scaleFactorX: 1.0,
      },
    ];

    for (let s = 1; s < numScales; s++) {
      const subImg = await this._getGeoImg(s, 0);
      const sfd = subImg.fileDirectory;
      const sw: number = sfd.ImageWidth;
      const sh: number = sfd.ImageLength;
      const stw: number = sfd.TileWidth ?? sw;
      const sth: number = sfd.TileLength ?? (sfd.RowsPerStrip ?? sh);
      scales.push({
        shape: [...activeSizes, sh, sw],
        tileShape: [...activeSizes.map(() => 1), sth, stw],
        dataType,
        scaleFactorY: baseH / sh,
        scaleFactorX: baseW / sw,
      });
    }

    this._meta = {
      pixels,
      activeDims,
      activeSizes,
      nonSpatialOrderFastToSlow,
      nonSpatialSizes,
      scales,
      numScales,
      channels,
      interleaved: pixels.Interleaved,
    };
    return this._meta;
  }

  // Get (or create) a GeoTIFFImage for the given scale and base IFD index
  private async _getGeoImg(scale: number, baseIfdIndex: number): Promise<GeoTIFFImage> {
    const key = `${scale}:${baseIfdIndex}`;
    if (this._imgCache.has(key)) return this._imgCache.get(key)!;

    let img: GeoTIFFImage;
    if (scale === 0) {
      img = await this._tiff.getImage(baseIfdIndex);
    } else {
      const baseImg = await this._getGeoImg(0, baseIfdIndex);
      const subIFDs: number[] = baseImg.fileDirectory.SubIFDs
        ? Array.from(baseImg.fileDirectory.SubIFDs as ArrayLike<number>).map(Number)
        : [];
      if (scale - 1 >= subIFDs.length) throw new Error(`No sub-IFD for scale ${scale}`);
      const result = await this._tiff.parseFileDirectoryAt(subIFDs[scale - 1]);
      img = new GeoTIFFImage(
        result.fileDirectory,
        result.geoKeyDirectory,
        (baseImg as any).dataView,
        this._tiff.littleEndian,
        false,
        this._tiff.source,
      );
    }
    this._imgCache.set(key, img);
    return img;
  }

  // ── Zarr metadata builders ─────────────────────────────────────────────────

  private _buildRootZarrJson(
    meta: TiffMeta,
  ): { zarr_format: number; node_type: string; attributes: z.infer<typeof ImageSchema> } {
    const { pixels } = meta;
    const physX = pixels.PhysicalSizeX || 1.0;
    const physY = pixels.PhysicalSizeY || 1.0;
    const unit = omeUnitToNgff(pixels.PhysicalSizeXUnit);

    const axes: object[] = [];
    for (const d of meta.activeDims) {
      if (d === 't') axes.push({ name: 't', type: 'time' });
      else if (d === 'c') axes.push({ name: 'c', type: 'channel' });
      else if (d === 'z') axes.push({ name: 'z', type: 'space', ...(unit ? { unit } : {}) });
    }
    axes.push({ name: 'y', type: 'space', ...(unit ? { unit } : {}) });
    axes.push({ name: 'x', type: 'space', ...(unit ? { unit } : {}) });

    const datasets = meta.scales.map((s, i) => ({
      path: String(i),
      coordinateTransformations: [
        {
          type: 'scale',
          scale: axes.map((ax: any) => {
            if (ax.name === 'y') return physY * s.scaleFactorY;
            if (ax.name === 'x') return physX * s.scaleFactorX;
            return 1.0;
          }),
        },
      ],
    }));

    const omeroChannels = meta.channels.map((ch) => ({
      label: ch.Name,
      active: true,
      ...(ch.Color
        ? {
            color: `#${ch.Color.slice(0, 3)
              .map((v) => v.toString(16).padStart(2, '0'))
              .join('')}`,
          }
        : {}),
    }));

    return {
      zarr_format: 3,
      node_type: 'group',
      attributes: {
        ome: {
          version: '0.5',
          multiscales: [{ axes, datasets, name: '/' }],
          ...(omeroChannels.length > 0 ? { omero: { channels: omeroChannels } } : {}),
        },
      } as unknown as z.infer<typeof ImageSchema>,
    };
  }

  private _buildArrayZarrJson(meta: TiffMeta, scale: number): object {
    const info = meta.scales[scale];
    return {
      zarr_format: 3,
      node_type: 'array',
      shape: info.shape,
      data_type: info.dataType,
      chunk_grid: {
        name: 'regular',
        configuration: { chunk_shape: info.tileShape },
      },
      chunk_key_encoding: {
        name: 'default',
        configuration: { separator: '/' },
      },
      fill_value: 0,
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      dimension_names: [...meta.activeDims, 'y', 'x'],
      attributes: {},
    };
  }

  // ── Chunk reading ──────────────────────────────────────────────────────────

  private async _getChunk(
    meta: TiffMeta,
    scale: number,
    coords: number[]
  ): Promise<Uint8Array | undefined> {
    const info = meta.scales[scale];
    const ndim = info.shape.length;
    if (coords.length !== ndim) return undefined;

    const xTile = coords[ndim - 1];
    const yTile = coords[ndim - 2];
    const nonSpatialCoords = coords.slice(0, ndim - 2);

    let t = 0, z = 0, c = 0;
    for (let i = 0; i < meta.activeDims.length; i++) {
      const d = meta.activeDims[i].toUpperCase();
      if (d === 'T') t = nonSpatialCoords[i];
      else if (d === 'Z') z = nonSpatialCoords[i];
      else if (d === 'C') c = nonSpatialCoords[i];
    }

    const baseIfdIndex = getRelativeIfdIndex(
      { t, z, c },
      meta.pixels.DimensionOrder,
      { t: meta.nonSpatialSizes['T'], z: meta.nonSpatialSizes['Z'], c: meta.nonSpatialSizes['C'] },
    );

    const geoImg = await this._getGeoImg(scale, baseIfdIndex);

    const tileW = info.tileShape[ndim - 1];
    const tileH = info.tileShape[ndim - 2];
    const imageW = info.shape[ndim - 1];
    const imageH = info.shape[ndim - 2];

    const x0 = xTile * tileW;
    const y0 = yTile * tileH;
    const x1 = Math.min(x0 + tileW, imageW);
    const y1 = Math.min(y0 + tileH, imageH);

    if (x0 >= imageW || y0 >= imageH) return undefined;

    const interleave = meta.interleaved;
    const rasters: any = await geoImg.readRasters({
      window: [x0, y0, x1, y1],
      interleave,
    });

    // For non-interleaved TIFFs (the common OME-TIFF case), geotiff returns an
    // array of typed arrays (one per sample); we want sample 0.
    // For interleaved TIFFs, readRasters returns the typed array directly.
    const rasterData: ArrayBufferView & { BYTES_PER_ELEMENT: number } =
      interleave ? rasters : rasters[0];

    const actualW = x1 - x0;
    const actualH = y1 - y0;

    // Full tile — return raw bytes directly
    if (actualW === tileW && actualH === tileH) {
      return new Uint8Array(
        (rasterData as any).buffer,
        (rasterData as any).byteOffset,
        (rasterData as any).byteLength,
      );
    }

    // Partial (edge) tile — zero-pad to full chunk size
    const bpe = rasterData.BYTES_PER_ELEMENT;
    const out = new Uint8Array(tileH * tileW * bpe);
    const src = new Uint8Array(
      (rasterData as any).buffer,
      (rasterData as any).byteOffset,
      (rasterData as any).byteLength,
    );
    for (let row = 0; row < actualH; row++) {
      out.set(
        src.subarray(row * actualW * bpe, (row + 1) * actualW * bpe),
        row * tileW * bpe,
      );
    }
    return out;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function encodeJson(obj: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

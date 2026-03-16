import { fromFile, fromUrl, GeoTIFFImage } from 'geotiff';
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';

// ── OME-XML types ────────────────────────────────────────────────────────────
interface OmePixels {
  DimensionOrder: string;
  Type: string;
  SizeX: number;
  SizeY: number;
  SizeZ: number;
  SizeT: number;
  SizeC: number;
  PhysicalSizeX?: number;
  PhysicalSizeXUnit?: string;
  PhysicalSizeY?: number;
  PhysicalSizeYUnit?: string;
}

interface OmeChannel {
  Name?: string;
}

interface ParsedOmeXml {
  pixels: OmePixels;
  channels: OmeChannel[];
}

// ── Metadata for each scale level ───────────────────────────────────────────
interface ScaleInfo {
  shape: number[];       // full array shape at this scale [dim0, ..., Y, X]
  tileShape: number[];   // chunk shape [1, ..., 1, tileH, tileW]
  dataType: string;      // zarr v3 data_type string
  scaleFactorY: number;  // relative to scale 0
  scaleFactorX: number;
}

// ── Parsed TIFF structure ────────────────────────────────────────────────────
interface TiffMeta {
  ome: ParsedOmeXml;
  activeDims: string[];          // non-singleton non-spatial dims, outermost first
  activeSizes: number[];
  nonSpatialOrderFastToSlow: string[];  // e.g. ['C','Z','T'] for DimOrder XYCZT
  nonSpatialSizes: Record<string, number>;
  scales: ScaleInfo[];
  numScales: number;
  channels: OmeChannel[];
}

// ── Minimal OME-XML parser ────────────────────────────────────────────────────
function getAttr(str: string, name: string): string | undefined {
  const m = str.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function parseOmeXml(xml: string): ParsedOmeXml {
  const pixelsMatch = xml.match(/<Pixels([^>]*)>/);
  if (!pixelsMatch) throw new Error('No Pixels element in OME-XML');
  const p = pixelsMatch[1];

  const pixels: OmePixels = {
    DimensionOrder: getAttr(p, 'DimensionOrder') ?? 'XYCZT',
    Type: getAttr(p, 'Type') ?? 'uint8',
    SizeX: parseInt(getAttr(p, 'SizeX') ?? '0'),
    SizeY: parseInt(getAttr(p, 'SizeY') ?? '0'),
    SizeZ: parseInt(getAttr(p, 'SizeZ') ?? '1'),
    SizeT: parseInt(getAttr(p, 'SizeT') ?? '1'),
    SizeC: parseInt(getAttr(p, 'SizeC') ?? '1'),
    PhysicalSizeX: getAttr(p, 'PhysicalSizeX') != null ? parseFloat(getAttr(p, 'PhysicalSizeX')!) : undefined,
    PhysicalSizeXUnit: getAttr(p, 'PhysicalSizeXUnit'),
    PhysicalSizeY: getAttr(p, 'PhysicalSizeY') != null ? parseFloat(getAttr(p, 'PhysicalSizeY')!) : undefined,
    PhysicalSizeYUnit: getAttr(p, 'PhysicalSizeYUnit'),
  };

  const channels: OmeChannel[] = [];
  const channelRegex = /<Channel([^>]*?)(?:\/?>)/g;
  let m: RegExpExecArray | null;
  while ((m = channelRegex.exec(xml)) !== null) {
    channels.push({ Name: getAttr(m[1], 'Name') });
  }

  return { pixels, channels };
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

// ── IFD index calculation ─────────────────────────────────────────────────────
function getIfdIndex(
  sel: { t: number; z: number; c: number },
  nonSpatialOrderFastToSlow: string[],
  nonSpatialSizes: Record<string, number>
): number {
  const vals: Record<string, number> = { T: sel.t, Z: sel.z, C: sel.c };
  let index = 0;
  let stride = 1;
  for (const dim of nonSpatialOrderFastToSlow) {
    index += vals[dim] * stride;
    stride *= nonSpatialSizes[dim];
  }
  return index;
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
    return new OmeTiffAsOmeZarrStore(await fromFile(path));
  }

  static async fromUrl(url: string, options?: Record<string, any>): Promise<OmeTiffAsOmeZarrStore> {
    return new OmeTiffAsOmeZarrStore(await fromUrl(url, options));
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
    if (full === undefined) return undefined;
    let start: number;
    let end: number;
    if ('offset' in range) {
      start = range.offset;
      end = range.offset + range.length;
    } else {
      start = Math.max(0, full.length - range.suffixLength);
      end = full.length;
    }
    return full.slice(start, end);
  }

  // ── Metadata initialisation ────────────────────────────────────────────────

  private async _getMetadata(): Promise<TiffMeta> {
    if (this._meta) return this._meta;

    const img0 = await this._tiff.getImage(0);
    this._imgCache.set('0:0', img0);

    const fd0 = img0.fileDirectory;
    const ome = parseOmeXml(fd0.ImageDescription ?? '');
    const { pixels } = ome;

    const dataType = omeTypeToZarr(pixels.Type);
    const baseW: number = fd0.ImageWidth;
    const baseH: number = fd0.ImageLength;
    const tileW: number = fd0.TileWidth ?? baseW;
    const tileH: number = fd0.TileLength ?? (fd0.RowsPerStrip ?? baseH);

    const dimOrderUpper = pixels.DimensionOrder.toUpperCase();
    const nonSpatialOrderFastToSlow = dimOrderUpper.slice(2).split('') as string[];
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
      ome,
      activeDims,
      activeSizes,
      nonSpatialOrderFastToSlow,
      nonSpatialSizes,
      scales,
      numScales,
      channels: ome.channels,
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

  private _buildRootZarrJson(meta: TiffMeta): object {
    const { pixels } = meta.ome;
    const physX = pixels.PhysicalSizeX ?? 1.0;
    const physY = pixels.PhysicalSizeY ?? 1.0;
    const unit = pixels.PhysicalSizeXUnit;

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

    const omeroChannels = meta.channels.map((ch) => ({ label: ch.Name, active: true }));

    return {
      zarr_format: 3,
      node_type: 'group',
      attributes: {
        ome: {
          version: '0.5',
          multiscales: [{ axes, datasets, name: '/' }],
          ...(omeroChannels.length > 0 ? { omero: { channels: omeroChannels } } : {}),
        },
      },
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

    const baseIfdIndex = getIfdIndex(
      { t, z, c },
      meta.nonSpatialOrderFastToSlow,
      meta.nonSpatialSizes
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

    const rasters: any = await geoImg.readRasters({
      window: [x0, y0, x1, y1],
      samples: [0],
      interleave: false,
    });

    const rasterData: ArrayBufferView & { BYTES_PER_ELEMENT: number } = rasters[0];
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

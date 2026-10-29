import { Compression, PlanarConfiguration, Predictor, SampleFormat, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import { SourceFromAsyncReadable } from "./SourceFromAsyncReadable.js";
import { encodeJson, parseKey, decompressTile, loadSubIfd } from "./tiff-utils.js";

type PlainAxisName = 'c' | 'y' | 'x' | 's';

/** Whether the TIFF is tiled or stripped. */
type TiffLayout =
  | { kind: 'tiled'; tileWidth: number; tileHeight: number }
  | { kind: 'stripped'; stripHeight: number; imageWidth: number };

type PlainContext = {
  layout: TiffLayout;
  bytesPerSample: number;
  samplesPerPixel: number;
  predictor: Predictor;
  activeAxes: PlainAxisName[];
  indexer(coords: { c: number }, resolution: number): Promise<TiffImage>;
  root: { zarrJson: Uint8Array };
  resolutions: Array<{
    sizes: { c: number; y: number; x: number };
    zarrJson: Uint8Array;
  }>;
};

function sampleFormatToZarrType(bitsPerSample: number, fmt: SampleFormat): string {
  switch (fmt) {
    case SampleFormat.Uint:  return `uint${bitsPerSample}`;
    case SampleFormat.Int:   return `int${bitsPerSample}`;
    case SampleFormat.Float: return `float${bitsPerSample}`;
    default:                 return `uint${bitsPerSample}`;
  }
}

async function createPlainTiffContext(tiff: Tiff): Promise<PlainContext> {
  const image = tiff.images[0];

  const { width, height } = image.size;
  const bitsPerSampleArr = image.value(TiffTag.BitsPerSample);
  const bitsPerSample = bitsPerSampleArr ? bitsPerSampleArr[0] : 8;
  const sampleFormatArr = image.value(TiffTag.SampleFormat);
  const sampleFmt = sampleFormatArr ? sampleFormatArr[0] : SampleFormat.Uint;
  const samplesPerPixel = image.value(TiffTag.SamplesPerPixel) ?? 1;
  const planarConfig = image.value(TiffTag.PlanarConfiguration) ?? PlanarConfiguration.Contig;
  const predictor = image.value(TiffTag.Predictor) ?? Predictor.None;
  const bytesPerSample = bitsPerSample / 8;
  const zarrType = sampleFormatToZarrType(bitsPerSample, sampleFmt);

  // Layout: tiled vs stripped
  let layout: TiffLayout;
  if (image.isTiled()) {
    const { width: tw, height: th } = image.tileSize;
    layout = { kind: 'tiled', tileWidth: tw, tileHeight: th };
  } else {
    const stripCount = image.stripCount;
    const stripHeight = stripCount > 0 ? Math.ceil(height / stripCount) : height;
    layout = { kind: 'stripped', stripHeight, imageWidth: width };
  }

  // Determine axes from SamplesPerPixel and PlanarConfiguration
  let activeAxes: PlainAxisName[];
  if (samplesPerPixel === 1) {
    // Grayscale — simple 2D
    activeAxes = ['y', 'x'];
  } else if (planarConfig === PlanarConfiguration.Contig) {
    // Chunky interleaved (e.g. RGB stored as RGBRGB...) — YXS
    activeAxes = ['y', 'x', 's'];
  } else {
    // Planar — separate IFDs per channel — CYX
    activeAxes = ['c', 'y', 'x'];
  }

  // Check for SubIFDs (pyramidal)
  const subIfds = (await image.fetch(TiffTag.SubIFDs)) as number[] | null;
  const numResolutions = subIfds ? subIfds.length + 1 : 1;

  const ome = {
    version: '0.5',
    multiscales: [
      {
        datasets: Array.from({ length: numResolutions }, (_, i) => {
          const scaleFactor = Math.pow(2, i);
          return {
            path: i.toString(),
            coordinateTransformations: [{
              type: 'scale',
              scale: activeAxes.map((axis) => {
                if (axis === 'y' || axis === 'x') return scaleFactor;
                return 1.0;
              }),
            }],
          };
        }),
        axes: activeAxes.map((name) => {
          if (name === 'c') return { name: 'c', type: 'channel' };
          if (name === 's') return { name: 's', type: 'space' };
          return { name, type: 'space' };
        }),
      },
    ],
  };

  const subIfdCache = new Map<number, TiffImage>();

  const indexer = async (coords: { c: number }, resolution: number): Promise<TiffImage> => {
    // For planar TIFFs each channel is a separate IFD in the main chain
    const baseImageIdx = planarConfig === PlanarConfiguration.Separate ? coords.c : 0;
    const baseImage = tiff.images[baseImageIdx];

    if (resolution === 0) return baseImage;

    const subIfdOffsets = (await baseImage.fetch(TiffTag.SubIFDs)) as number[];
    const offset = subIfdOffsets[resolution - 1];
    const cached = subIfdCache.get(offset);
    if (cached) return cached;

    const subImage = await loadSubIfd(tiff, offset);
    subIfdCache.set(offset, subImage);
    return subImage;
  };

  return {
    layout,
    bytesPerSample,
    samplesPerPixel,
    predictor,
    activeAxes,
    indexer,
    root: {
      zarrJson: encodeJson({
        zarr_format: 3,
        node_type: 'group',
        attributes: { ome },
      }),
    },
    resolutions: Array.from({ length: numResolutions }, (_, resolution) => {
      const scaledHeight = height >> resolution;
      const scaledWidth = width >> resolution;

      // Chunk shape depends on layout and axis convention
      let chunkShape: number[];
      if (layout.kind === 'tiled') {
        const tw = layout.tileWidth;
        const th = layout.tileHeight;
        chunkShape = activeAxes.map((axis) => {
          if (axis === 'y') return th;
          if (axis === 'x') return tw;
          if (axis === 's') return samplesPerPixel; // all samples in one chunk
          return 1; // 'c': one plane per chunk
        });
      } else {
        // Stripped: chunk covers full image width and one strip height
        chunkShape = activeAxes.map((axis) => {
          if (axis === 'y') return layout.stripHeight;
          if (axis === 'x') return layout.imageWidth;
          if (axis === 's') return samplesPerPixel;
          return 1; // 'c'
        });
      }

      const shape = activeAxes.map((axis) => {
        if (axis === 'y') return scaledHeight;
        if (axis === 'x') return scaledWidth;
        if (axis === 's') return samplesPerPixel;
        return samplesPerPixel; // 'c': number of channels
      });

      return {
        sizes: { c: samplesPerPixel, y: scaledHeight, x: scaledWidth },
        zarrJson: encodeJson({
          zarr_format: 3,
          node_type: 'array',
          shape,
          data_type: zarrType,
          chunk_grid: {
            name: 'regular',
            configuration: { chunk_shape: chunkShape },
          },
          chunk_key_encoding: {
            name: 'default',
            configuration: { separator: '/' },
          },
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          fill_value: 0,
          attributes: {},
        }),
      };
    }),
  };
}

export class TiffAsOmeZarrStore implements AsyncReadable {
  #tiff: Tiff;
  #context: PlainContext | undefined = undefined;

  constructor(tiff: Tiff) {
    this.#tiff = tiff;
  }

  static async fromStore(internal_store: AsyncReadable): Promise<TiffAsOmeZarrStore> {
    return new TiffAsOmeZarrStore(await Tiff.create(new SourceFromAsyncReadable(internal_store)));
  }

  async get(key: AbsolutePath, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const keyResult = parseKey(key);
    if (keyResult.kind === 'unknown') return undefined;

    if (!this.#context) {
      this.#context = await createPlainTiffContext(this.#tiff);
    }

    if (keyResult.kind === 'meta') {
      if (keyResult.value.kind === 'root') return this.#context.root.zarrJson;
      return this.#context.resolutions[keyResult.value.value]?.zarrJson;
    }

    const { layout, bytesPerSample, samplesPerPixel, predictor, activeAxes } = this.#context;
    const { resolution, chunkCoords } = keyResult;
    if (!this.#context.resolutions[resolution]) return undefined;

    // Number of bytes per "pixel unit" in the tile/strip data.
    // For chunky (YXS), all samples are interleaved so multiply by samplesPerPixel.
    const bytesPerUnit = activeAxes.includes('s') ? bytesPerSample * samplesPerPixel : bytesPerSample;

    const c = activeAxes.includes('c') ? chunkCoords[activeAxes.indexOf('c')] : 0;
    const yChunk = chunkCoords[activeAxes.indexOf('y')];
    const xChunk = chunkCoords[activeAxes.indexOf('x')];

    const image = await this.#context.indexer({ c }, resolution);
    const compression = image.value(TiffTag.Compression) ?? 1 as Compression;

    if (layout.kind === 'tiled') {
      const { tileWidth, tileHeight } = layout;
      const tile = await image.getTile(xChunk, yChunk, { signal: options.signal });
      if (!tile) {
        return new Uint8Array(tileWidth * tileHeight * bytesPerUnit);
      }
      return decompressTile(tile, { tileWidth, tileHeight, bytesPerPixel: bytesPerUnit, predictor, isLittleEndian: this.#tiff.isLittleEndian });
    } else {
      // Stripped: yChunk is the strip index, xChunk is always 0
      const { stripHeight, imageWidth } = layout;
      const strip = await image.getStrip(yChunk);
      if (!strip) {
        return new Uint8Array(stripHeight * imageWidth * bytesPerUnit);
      }
      return decompressTile(
        { bytes: strip.bytes, compression },
        { tileWidth: imageWidth, tileHeight: stripHeight, bytesPerPixel: bytesPerUnit, predictor, isLittleEndian: this.#tiff.isLittleEndian },
      );
    }
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
   */
  async getConsolidatedMetadata(): Promise<Record<string, unknown>> {
    if (!this.#context) {
      this.#context = await createPlainTiffContext(this.#tiff);
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
        kind: 'inline',
        must_understand: false,
      },
    };
  }
}

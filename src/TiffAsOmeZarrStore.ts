import { PlanarConfiguration, SampleFormat, Tiff, type TiffImage, TiffTag } from "@cogeotiff/core";
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import { SourceFromAsyncReadable } from "./SourceFromAsyncReadable.js";
import { CYMRGB } from "./OmeTiffAsOmeZarrStore.js";
import {
  assert,
  arrayZarrJson,
  consolidateMetadata,
  createSubIfdResolver,
  defaultWindow,
  encodeJson,
  getSegmentLayout,
  levelScaleFactor,
  omeroModel,
  parseKey,
  planChunkEncoding,
  readChunk,
  sampleFormatToZarrType,
  sliceRange,
  type ChunkEncoding,
  type SegmentLayout,
} from "./tiff-utils.js";
import type { Ome } from './types.js';

type PlainAxisName = 'c' | 'y' | 'x';

type PlainContext = {
  bytesPerSample: number;
  samplesPerPixel: number;
  planar: boolean;
  activeAxes: PlainAxisName[];
  root: { zarrJson: Uint8Array };
  resolutions: Array<{
    image: TiffImage;
    layout: SegmentLayout;
    encoding: ChunkEncoding;
    shape: number[];
    chunkShape: number[];
    zarrJson: Uint8Array;
  }>;
};

const RGB_CHANNELS = [['R', 'FF0000'], ['G', '00FF00'], ['B', '0000FF']];

function plainOmero(dataType: string, samplesPerPixel: number, model: 'color' | 'greyscale'): Ome.Omero {
  const window = defaultWindow(dataType);
  return {
    id: 1,
    version: '0.1',
    channels: Array.from({ length: samplesPerPixel }, (_, i) => {
      // In the color model the first three samples are R, G, B; any extra
      // samples (e.g. alpha) are inactive.
      const rgb = model === 'color' ? RGB_CHANNELS[i] : undefined;
      return {
        active: i < (model === 'color' ? 3 : 6),
        label: rgb?.[0],
        color: rgb?.[1] ?? (samplesPerPixel === 1 ? 'FFFFFF' : CYMRGB[i % CYMRGB.length].slice(1)),
        coefficient: 1,
        family: 'linear',
        inverted: false,
        window: { ...window },
      } satisfies Ome.Channel;
    }),
    rdefs: {
      model,
    },
  };
}

async function createPlainTiffContext(tiff: Tiff): Promise<PlainContext> {
  const image = tiff.images[0];

  const bitsPerSampleArr = image.value(TiffTag.BitsPerSample);
  const bitsPerSample = bitsPerSampleArr ? bitsPerSampleArr[0] : 8;
  assert(
    [8, 16, 32, 64].includes(bitsPerSample),
    `Unsupported BitsPerSample: ${bitsPerSample}`,
  );
  const sampleFormatArr = image.value(TiffTag.SampleFormat);
  const sampleFmt = sampleFormatArr ? sampleFormatArr[0] : SampleFormat.Uint;
  const samplesPerPixel = image.value(TiffTag.SamplesPerPixel) ?? 1;
  const planarConfig = image.value(TiffTag.PlanarConfiguration) ?? PlanarConfiguration.Contig;
  const bytesPerSample = bitsPerSample / 8;
  const dataType = sampleFormatToZarrType(bitsPerSample, sampleFmt);
  // Planar-separate data stores each sample plane as its own run of segments
  // in the same IFD; chunky data interleaves all samples within each segment.
  const planar = samplesPerPixel > 1 && planarConfig === PlanarConfiguration.Separate;

  // Multi-sample images expose samples as a leading channel axis (CYX), which
  // is the canonical OME-NGFF order. Chunky segments are de-interleaved on read.
  const activeAxes: PlainAxisName[] = samplesPerPixel > 1 ? ['c', 'y', 'x'] : ['y', 'x'];

  // SubIFDs hold the pyramid levels, if any.
  const subIfds = (await image.fetch(TiffTag.SubIFDs)) as number[] | null;
  const numResolutions = subIfds ? subIfds.length + 1 : 1;
  const resolveLevel = createSubIfdResolver(tiff);
  const levelImages = await Promise.all(
    Array.from({ length: numResolutions }, (_, r) => resolveLevel(image, r)),
  );

  const resolutions = levelImages.map((levelImage) => {
    const layout = getSegmentLayout(levelImage);
    const encoding = planChunkEncoding(levelImage, layout, {
      isLittleEndian: tiff.isLittleEndian,
      samplesPerPixel: planar ? 1 : samplesPerPixel,
    });
    const shape = activeAxes.map((axis) => {
      if (axis === 'y') return layout.height;
      if (axis === 'x') return layout.width;
      return samplesPerPixel; // 'c'
    });
    const chunkShape = activeAxes.map((axis) => {
      if (axis === 'y') return layout.segmentHeight;
      if (axis === 'x') return layout.segmentWidth;
      return planar ? 1 : samplesPerPixel; // 'c'
    });
    return {
      image: levelImage,
      layout,
      encoding,
      shape,
      chunkShape,
      zarrJson: arrayZarrJson({ shape, chunkShape, dataType, codecs: encoding.codecs }),
    };
  });

  const base = resolutions[0].layout;
  const model = omeroModel(image.value(TiffTag.Photometric), samplesPerPixel);
  const ome = {
    version: '0.5',
    multiscales: [
      {
        datasets: resolutions.map(({ layout }, i) => ({
          path: i.toString(),
          coordinateTransformations: [{
            type: 'scale',
            scale: activeAxes.map((axis) => {
              if (axis === 'y') return levelScaleFactor(base.height, layout.height, i);
              if (axis === 'x') return levelScaleFactor(base.width, layout.width, i);
              return 1.0;
            }),
          }],
        })),
        axes: activeAxes.map((name) => ({ name, type: name === 'c' ? 'channel' : 'space' })),
      },
    ],
    ...(model ? { omero: plainOmero(dataType, samplesPerPixel, model) } : {}),
  };

  return {
    bytesPerSample,
    samplesPerPixel,
    planar,
    activeAxes,
    root: {
      zarrJson: encodeJson({
        zarr_format: 3,
        node_type: 'group',
        attributes: { ome },
      }),
    },
    resolutions,
  };
}

export class TiffAsOmeZarrStore implements AsyncReadable {
  #tiff: Tiff;
  #context: Promise<PlainContext> | undefined = undefined;

  constructor(tiff: Tiff) {
    this.#tiff = tiff;
  }

  static async fromStore(internal_store: AsyncReadable): Promise<TiffAsOmeZarrStore> {
    return new TiffAsOmeZarrStore(await Tiff.create(new SourceFromAsyncReadable(internal_store)));
  }

  #getContext(): Promise<PlainContext> {
    this.#context ??= createPlainTiffContext(this.#tiff);
    return this.#context;
  }

  async get(key: AbsolutePath, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const keyResult = parseKey(key);
    if (keyResult.kind === 'unknown') return undefined;

    const context = await this.#getContext();

    if (keyResult.kind === 'meta') {
      if (keyResult.value.kind === 'root') return context.root.zarrJson;
      return context.resolutions[keyResult.value.value]?.zarrJson;
    }

    const { bytesPerSample, samplesPerPixel, planar, activeAxes } = context;
    const { resolution, chunkCoords } = keyResult;
    const level = context.resolutions[resolution];
    if (!level || chunkCoords.length !== activeAxes.length) return undefined;
    const { image, layout, shape, chunkShape } = level;
    if (chunkCoords.some((coord, i) => coord >= Math.ceil(shape[i] / chunkShape[i]))) return undefined;

    const c = activeAxes.includes('c') ? chunkCoords[activeAxes.indexOf('c')] : 0;
    const yChunk = chunkCoords[activeAxes.indexOf('y')];
    const xChunk = chunkCoords[activeAxes.indexOf('x')];

    const segmentsPerPlane = layout.segmentsAcross * layout.segmentsDown;
    const segmentIndex = (planar ? c * segmentsPerPlane : 0) + yChunk * layout.segmentsAcross + xChunk;
    return readChunk(image, segmentIndex, {
      encoding: level.encoding,
      layout,
      // Number of samples interleaved within each segment.
      samplesPerPixel: planar ? 1 : samplesPerPixel,
      bytesPerSample,
      isLittleEndian: this.#tiff.isLittleEndian,
      signal: options.signal,
    });
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const data = await this.get(key, options);
    return data === undefined ? undefined : sliceRange(data, range);
  }

  /**
   * Generate Zarr v3 consolidated metadata for this store.
   */
  async getConsolidatedMetadata(): Promise<Record<string, unknown>> {
    const context = await this.#getContext();
    return consolidateMetadata(context.root.zarrJson, context.resolutions.map((r) => r.zarrJson));
  }
}

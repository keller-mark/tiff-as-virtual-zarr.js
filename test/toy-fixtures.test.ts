import { describe, it, expect, beforeAll } from 'vitest';
import { open, get as zarrGet, slice } from 'zarrita';
import { FileSystemStore } from '@zarrita/storage';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { OmeTiffAsOmeZarrStore } from '../src/OmeTiffAsOmeZarrStore.js';
import { TiffAsOmeZarrStore } from '../src/TiffAsOmeZarrStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

// ── OmeTiffAsOmeZarrStore – toy OME-TIFF ──────────────────────────────────────
// test_image.ome.tif: CYX uint8, 3 channels, 128×128, pyramidal with 3 SubIFDs
// OmeTiffAsOmeZarrStore exposes subIfds.length + 1 = 4 levels.
describe('OmeTiffAsOmeZarrStore – toy OME-TIFF (CYX uint8, 3×128×128)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'test_image.ome.tif'))
    );
    refStore = new FileSystemStore(join(FIXTURES, 'test_image.ome.zarr'));
  });

  it('root group attrs expose OME-NGFF v0.5 with c, y, x axes', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.version).toBe('0.5');
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['c', 'y', 'x']);
    expect(axes.find((a: any) => a.name === 'c').type).toBe('channel');
  });

  it('has channel omero metadata with DAPI, GFP, Brightfield labels', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const channels = attrs.ome.omero?.channels ?? [];
    expect(channels.length).toBe(3);
    expect(channels.map((c: any) => c.label)).toEqual(['DAPI', 'GFP', 'Brightfield']);
  });

  it('exposes 4 resolution levels (subIfds.length + 1)', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.multiscales[0].datasets.length).toBe(4);
  });

  it('scale-0 shape matches reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    expect(tiffArr.shape).toEqual([3, 128, 128]);
    expect(tiffArr.shape).toEqual(refArr.shape);
    expect(tiffArr.dtype).toBe('uint8');
  });

  it('scale-1 shape matches reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('1'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('1'), { kind: 'array' });
    expect(tiffArr.shape).toEqual([3, 64, 64]);
    expect(tiffArr.shape).toEqual(refArr.shape);
  });

  it('scale-0 pixel values match reference zarr for channel 0 (DAPI)', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [0, slice(0, 128), slice(0, 128)]);
    const refData = await zarrGet(refArr, [0, slice(0, 128), slice(0, 128)]);
    expect(tiffData.data).toEqual(refData.data);
    const dToy0 = tiffData.data as any; let sumToy0 = 0; for (let i = 0; i < dToy0.length; i++) sumToy0 += dToy0[i]; expect(sumToy0).toBe(1143443);
  });

  it('scale-0 pixel values match reference zarr for channel 1 (GFP)', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [1, slice(0, 128), slice(0, 128)]);
    const refData = await zarrGet(refArr, [1, slice(0, 128), slice(0, 128)]);
    expect(tiffData.data).toEqual(refData.data);
    const dToy1 = tiffData.data as any; let sumToy1 = 0; for (let i = 0; i < dToy1.length; i++) sumToy1 += dToy1[i]; expect(sumToy1).toBe(1143443);
  });

  it('scale-0 pixel values match reference zarr for channel 2 (Brightfield)', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [2, slice(0, 128), slice(0, 128)]);
    const refData = await zarrGet(refArr, [2, slice(0, 128), slice(0, 128)]);
    expect(tiffData.data).toEqual(refData.data);
    const dToy2 = tiffData.data as any; let sumToy2 = 0; for (let i = 0; i < dToy2.length; i++) sumToy2 += dToy2[i]; expect(sumToy2).toBe(1143388);
  });
});

// ── getConsolidatedMetadata – toy OME-TIFF ────────────────────────────────────
describe('getConsolidatedMetadata – toy OME-TIFF', () => {
  let virtual: Record<string, unknown>;

  beforeAll(async () => {
    const store = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'test_image.ome.tif'))
    );
    virtual = await store.getConsolidatedMetadata();
  });

  it('has consolidated_metadata with inline kind', () => {
    const cm = (virtual as any).consolidated_metadata;
    expect(cm).toBeDefined();
    expect(cm.kind).toBe('inline');
    expect(cm.must_understand).toBe(false);
  });

  it('shape and dtype for each level match reference zarr', () => {
    const rootJson = JSON.parse(readFileSync(join(FIXTURES, 'test_image.ome.zarr', 'zarr.json'), 'utf8'));
    const refMeta = rootJson.consolidated_metadata?.metadata ?? {};
    const cm = (virtual as any).consolidated_metadata;
    const virtualLevels = Object.keys(cm.metadata)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((k) => ({ shape: cm.metadata[k].shape, dtype: cm.metadata[k].data_type }));
    expect(virtualLevels.length).toBe(4);
    for (let i = 0; i < virtualLevels.length; i++) {
      expect(virtualLevels[i].shape).toEqual(refMeta[i.toString()].shape);
      expect(virtualLevels[i].dtype).toBe(refMeta[i.toString()].data_type);
    }
  });
});

// ── TiffAsOmeZarrStore – toy plain TIFF ───────────────────────────────────────
// test_image.plain.tif: RGB uint8, YXC interleaved (SamplesPerPixel=3, Contig)
// → TiffAsOmeZarrStore maps to axes ['c', 'y', 'x'], shape [3, 128, 128]
describe('TiffAsOmeZarrStore – toy plain TIFF (RGB uint8, 128×128×3)', () => {
  let plainStore: TiffAsOmeZarrStore;

  beforeAll(async () => {
    plainStore = await TiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'test_image.plain.tif'))
    );
  });

  it('axes are c, y, x (chunky interleaved RGB exposed as channels)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['c', 'y', 'x']);
    expect(axes[0].type).toBe('channel');
  });

  it('scale-0 has shape [3, 128, 128] with one chunk spanning all samples', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.shape).toEqual([3, 128, 128]);
    expect(arr.chunks).toEqual([3, 64, 64]);
  });

  it('scale-0 has correct dtype', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.dtype).toBe('uint8');
  });

  it('only one resolution level (no SubIFDs in plain TIFF)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.multiscales[0].datasets.length).toBe(1);
  });

  it('pixel values match reference zarr channel data', async () => {
    // The plain TIFF stores (R, G, B) interleaved per pixel; the store
    // de-interleaves them so sample s == reference zarr channel s.
    const refStore = new FileSystemStore(join(FIXTURES, 'test_image.ome.zarr'));
    const plainGroup = await open(plainStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const plainArr = await open(plainGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });

    const plainData = await zarrGet(plainArr, [null, slice(0, 100), slice(0, 100)]);
    const refData = await zarrGet(refArr, [null, slice(0, 100), slice(0, 100)]);
    expect(plainData.data).toEqual(refData.data);
  });
});

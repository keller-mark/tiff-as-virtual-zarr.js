import { describe, it, expect, beforeAll } from 'vitest';
import { open, get as zarrGet, slice } from 'zarrita';
import { FileSystemStore } from '@zarrita/storage';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { TiffAsOmeZarrStore } from '../src/TiffAsOmeZarrStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

// ── 9836842 v0.3 – plain TIFF (grayscale, C=4→channel 0) ──────────────────────
describe('TiffAsOmeZarrStore – 9836842 v0.3 plain TIFF (grayscale uint16)', () => {
  let plainStore: TiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    plainStore = await TiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '9836842.v0_3.plain.tif'))
    );
    refStore = new FileSystemStore(join(FIXTURES, '9836842.v0_3.cropped.zarr'));
  });

  it('axes are y, x (grayscale)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['y', 'x']);
  });

  it('scale-0 has correct shape', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.shape).toEqual([512, 512]);
  });

  it('scale-0 has correct dtype', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.dtype).toBe('uint16');
  });

  it('only one resolution level (no SubIFDs in plain TIFF)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.multiscales[0].datasets.length).toBe(1);
  });

  it('scale-0 pixel values match reference zarr channel 0', async () => {
    const plainGroup = await open(plainStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const plainArr = await open(plainGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const plainData = await zarrGet(plainArr, [slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [0, slice(0, 256), slice(0, 256)]);
    expect(plainData.data).toEqual(refData.data);
  });
});

// ── 10501752 v0.4 – plain TIFF (grayscale, C=50→channel 0) ───────────────────
describe('TiffAsOmeZarrStore – 10501752 v0.4 plain TIFF (grayscale float64)', () => {
  let plainStore: TiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    plainStore = await TiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '10501752.v0_4.plain.tif'))
    );
    refStore = new FileSystemStore(join(FIXTURES, '10501752.v0_4.zarr'));
  });

  it('axes are y, x (grayscale)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['y', 'x']);
  });

  it('scale-0 has correct shape', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.shape).toEqual([494, 464]);
  });

  it('scale-0 has correct dtype', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.dtype).toBe('float64');
  });

  it('only one resolution level (no SubIFDs in plain TIFF)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.multiscales[0].datasets.length).toBe(1);
  });

  it('scale-0 pixel values match reference zarr channel 0', async () => {
    const plainGroup = await open(plainStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const plainArr = await open(plainGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const plainData = await zarrGet(plainArr, [slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [0, slice(0, 256), slice(0, 256)]);
    expect(plainData.data).toEqual(refData.data);
  });
});

// ── ExpD_chicken_embryo_MIP v0.5 – plain TIFF (grayscale, no C axis) ──────────
describe('TiffAsOmeZarrStore – ExpD_chicken_embryo_MIP v0.5 plain TIFF (grayscale uint8)', () => {
  let plainStore: TiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    plainStore = await TiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.plain.tif'))
    );
    refStore = new FileSystemStore(
      join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.cropped.ome.zarr')
    );
  });

  it('axes are y, x (grayscale)', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['y', 'x']);
  });

  it('scale-0 has correct shape', async () => {
    const group = await open(plainStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.shape).toEqual([512, 512]);
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

  it('scale-0 pixel values match reference zarr', async () => {
    const plainGroup = await open(plainStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const plainArr = await open(plainGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const plainData = await zarrGet(plainArr, [slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [slice(0, 256), slice(0, 256)]);
    expect(plainData.data).toEqual(refData.data);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { open, get as zarrGet, slice } from 'zarrita';
import { FileSystemStore } from '@zarrita/storage';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { OmeTiffAsOmeZarrStore } from '../src/OmeTiffAsOmeZarrStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

// ── 9836842 v0.3 – CYX uint16 ─────────────────────────────────────────────────
describe('OmeTiffAsOmeZarrStore – 9836842 v0.3 (CYX uint16)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '9836842.v0_3.ome.tif'))
    );
    refStore = new FileSystemStore(join(FIXTURES, '9836842.v0_3.cropped.zarr'));
  });

  it('root group attrs expose OME-NGFF v0.5 with c, y, x axes', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.version).toBe('0.5');
    const ms = attrs.ome.multiscales[0];
    expect(ms.axes.map((a: any) => a.name)).toEqual(['c', 'y', 'x']);
    expect(ms.axes.find((a: any) => a.name === 'c').type).toBe('channel');
    expect(ms.axes.find((a: any) => a.name === 'y').type).toBe('space');
    expect(ms.axes.find((a: any) => a.name === 'x').type).toBe('space');
    expect(ms.datasets.length).toBeGreaterThanOrEqual(2);
    for (const ds of ms.datasets) {
      expect(typeof ds.path).toBe('string');
      expect(ds.coordinateTransformations[0].type).toBe('scale');
    }
  });

  it('scale-0 array shape matches reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    expect(tiffArr.shape).toEqual(refArr.shape);
  });

  it('scale-0 pixel values match reference zarr for channel 0', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [0, slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [0, slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
    const d0 = tiffData.data as any; let sum0 = 0; for (let i = 0; i < d0.length; i++) sum0 += d0[i]; expect(sum0).toBe(15036502);
    expect(tiffArr.attrs).toEqual(refArr.attrs);

    /*
    // attrs.version will be different since the virtualized store upgrades the metadata.
    delete refGroup.attrs['version'];
    delete tiffGroup.attrs['version'];
    expect(tiffGroup.attrs).toEqual({
      ome: refGroup.attrs
    });
    */
    
  });

  it('scale-0 pixel values match reference zarr for channel 1', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [1, slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [1, slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
    const d1 = tiffData.data as any; let sum1 = 0; for (let i = 0; i < d1.length; i++) sum1 += d1[i]; expect(sum1).toBe(14802284);
  });

  it('scale-1 array shape is half of scale-0', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const arr0 = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const arr1 = await open(tiffGroup.resolve('1'), { kind: 'array' });
    expect(arr1.shape[0]).toBe(arr0.shape[0]);  // C unchanged
    expect(arr1.shape[1]).toBeLessThan(arr0.shape[1]);
    expect(arr1.shape[2]).toBeLessThan(arr0.shape[2]);
  });

  it('getRange returns a byte slice of the metadata', async () => {
    const full = await tiffStore.get('/zarr.json' as any);
    const range = await tiffStore.getRange('/zarr.json' as any, { offset: 0, length: 10 });
    expect(range).toEqual(full!.slice(0, 10));
  });

  it('returns undefined for out-of-range scale', async () => {
    expect(await tiffStore.get('/99/zarr.json' as any)).toBeUndefined();
  });
});

// ── ExpD_chicken_embryo_MIP v0.5 – YX uint8 ───────────────────────────────────
describe('OmeTiffAsOmeZarrStore – ExpD_chicken_embryo_MIP v0.5 (YX uint8)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.ome.tif'))
    );
    refStore = new FileSystemStore(
      join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.cropped.ome.zarr')
    );
  });

  it('root group attrs expose OME-NGFF v0.5 with y, x axes only (C collapsed)', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.version).toBe('0.5');
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['y', 'x']);
    expect(axes.every((a: any) => a.type === 'space')).toBe(true);
  });

  it('root group attrs have coordinate transformations with physical scale', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    const ds0 = attrs.ome.multiscales[0].datasets[0];
    const scaleCt = ds0.coordinateTransformations[0];
    expect(scaleCt.type).toBe('scale');
    // PhysicalSizeX = 1.6 µm → scale values should be 1.6
    expect(scaleCt.scale.every((v: number) => Math.abs(v - 1.6) < 0.001)).toBe(true);
  });

  it('scale-0 array shape matches reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    expect(tiffArr.shape).toEqual(refArr.shape);

    expect(tiffArr.attrs).toEqual(refArr.attrs);
    //expect(tiffGroup.attrs).toEqual(refGroup.attrs);
  });

  it('scale-0 pixel values match reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
    const dE = tiffData.data as any; let sumE = 0; for (let i = 0; i < dE.length; i++) sumE += dE[i]; expect(sumE).toBe(6360);
  });

  it('scale-1 array shape is half of scale-0', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const arr0 = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const arr1 = await open(tiffGroup.resolve('1'), { kind: 'array' });
    expect(arr1.shape[0]).toBeLessThan(arr0.shape[0]);
    expect(arr1.shape[1]).toBeLessThan(arr0.shape[1]);
  });
});

// ── mouse_liver – pre-bioformats v6 (no SubIFDs), YX uint16 ───────────────────
describe('OmeTiffAsOmeZarrStore – mouse_liver (legacy bioformats, no SubIFDs)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'mouse_liver.ome.tif'))
    );
  });

  it('store opens without error', () => {
    expect(tiffStore).toBeDefined();
  });

  it('root group attrs expose OME-NGFF v0.5 with y, x axes only (T/C/Z collapsed)', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.version).toBe('0.5');
    const ms = attrs.ome.multiscales[0];
    expect(ms.axes.map((a: any) => a.name)).toEqual(['y', 'x']);
  });

  it('has exactly one resolution level (legacy single-IFD image)', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.multiscales[0].datasets.length).toBe(1);
    expect(attrs.ome.multiscales[0].datasets[0].path).toBe('0');
  });

  it('scale-0 array node has correct shape and dtype', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const arr = await open(group.resolve('0'), { kind: 'array' });
    expect(arr.shape).toEqual([250, 250]);
    expect(arr.dtype).toBe('uint16');
  });
});

// ── 10501752 v0.4 – CYX float64 ───────────────────────────────────────────────
describe('OmeTiffAsOmeZarrStore – 10501752 v0.4 (CYX float64)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '10501752.v0_4.ome.tif'))
    );
    refStore = new FileSystemStore(join(FIXTURES, '10501752.v0_4.zarr'));
  });

  it('root group attrs expose OME-NGFF v0.5 with c, y, x axes', async () => {
    const group = await open(tiffStore, { kind: 'group' });
    const attrs = group.attrs as any;
    expect(attrs.ome.version).toBe('0.5');
    const axes = attrs.ome.multiscales[0].axes;
    expect(axes.map((a: any) => a.name)).toEqual(['c', 'y', 'x']);
  });

  it('scale-0 array shape matches reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    expect(tiffArr.shape).toEqual(refArr.shape);

    expect(tiffArr.attrs).toEqual(refArr.attrs);

    /*
    // attrs.version will be different since the virtualized store upgrades the metadata.
    delete refGroup.attrs['version'];
    delete tiffGroup.attrs['version'];
    delete refGroup.attrs['_creator'];
    expect(tiffGroup.attrs).toEqual({
      ome: refGroup.attrs
    });
    */
  });

  it('scale-0 pixel values match reference zarr for channel 0', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [0, slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [0, slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
    const d10_0 = tiffData.data as any; let sum10_0 = 0; for (let i = 0; i < d10_0.length; i++) sum10_0 += d10_0[i]; expect(sum10_0).toBeCloseTo(253309.998, 2);
  });

  it('scale-0 pixel values match reference zarr for channel 25', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [25, slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [25, slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
    const d10_25 = tiffData.data as any; let sum10_25 = 0; for (let i = 0; i < d10_25.length; i++) sum10_25 += d10_25[i]; expect(sum10_25).toBeCloseTo(401377.119, 2);
  });
});

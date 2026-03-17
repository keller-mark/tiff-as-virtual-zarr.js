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
    tiffStore = await OmeTiffAsOmeZarrStore.fromFile(
      join(FIXTURES, '9836842.v0_3.ome.tif')
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
    tiffStore = await OmeTiffAsOmeZarrStore.fromFile(
      join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.ome.tif')
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
    expect(tiffGroup.attrs).toEqual(refGroup.attrs);
  });

  it('scale-0 pixel values match reference zarr', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
  });

  it('scale-1 array shape is half of scale-0', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const arr0 = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const arr1 = await open(tiffGroup.resolve('1'), { kind: 'array' });
    expect(arr1.shape[0]).toBeLessThan(arr0.shape[0]);
    expect(arr1.shape[1]).toBeLessThan(arr0.shape[1]);
  });
});

// ── 10501752 v0.4 – CYX float64 ───────────────────────────────────────────────
describe('OmeTiffAsOmeZarrStore – 10501752 v0.4 (CYX float64)', () => {
  let tiffStore: OmeTiffAsOmeZarrStore;
  let refStore: FileSystemStore;

  beforeAll(async () => {
    tiffStore = await OmeTiffAsOmeZarrStore.fromFile(
      join(FIXTURES, '10501752.v0_4.ome.tif')
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
  });

  it('scale-0 pixel values match reference zarr for channel 25', async () => {
    const tiffGroup = await open(tiffStore, { kind: 'group' });
    const refGroup = await open(refStore, { kind: 'group' });
    const tiffArr = await open(tiffGroup.resolve('0'), { kind: 'array' });
    const refArr = await open(refGroup.resolve('0'), { kind: 'array' });
    const tiffData = await zarrGet(tiffArr, [25, slice(0, 256), slice(0, 256)]);
    const refData = await zarrGet(refArr, [25, slice(0, 256), slice(0, 256)]);
    expect(tiffData.data).toEqual(refData.data);
  });
});

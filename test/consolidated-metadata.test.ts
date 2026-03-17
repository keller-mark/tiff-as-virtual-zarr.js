import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { FileSystemStore } from '@zarrita/storage';
import { OmeTiffAsOmeZarrStore } from '../src/OmeTiffAsOmeZarrStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

function normalizeZarrV2Dtype(dtype: string): string {
  const map: Record<string, string> = {
    '|u1': 'uint8', '<u1': 'uint8', '>u1': 'uint8',
    '<u2': 'uint16', '>u2': 'uint16',
    '<u4': 'uint32', '>u4': 'uint32',
    '<u8': 'uint64', '>u8': 'uint64',
    '|i1': 'int8', '<i1': 'int8',
    '<i2': 'int16', '<i4': 'int32', '<i8': 'int64',
    '<f4': 'float32', '>f4': 'float32',
    '<f8': 'float64', '>f8': 'float64',
  };
  return map[dtype] ?? dtype;
}

function readZarrV2Levels(zarrPath: string): Array<{ shape: number[]; dtype: string }> {
  const zmetadata = JSON.parse(readFileSync(join(zarrPath, '.zmetadata'), 'utf8'));
  const metadata = zmetadata.metadata;
  const levels: Array<{ shape: number[]; dtype: string }> = [];
  for (let i = 0; ; i++) {
    const entry = metadata[`${i}/.zarray`];
    if (!entry) break;
    levels.push({ shape: entry.shape, dtype: normalizeZarrV2Dtype(entry.dtype) });
  }
  return levels;
}

function readZarrV3Levels(zarrPath: string): Array<{ shape: number[]; dtype: string }> {
  const root = JSON.parse(readFileSync(join(zarrPath, 'zarr.json'), 'utf8'));
  const consolMeta = root.consolidated_metadata?.metadata ?? {};
  const levels: Array<{ shape: number[]; dtype: string }> = [];
  for (let i = 0; ; i++) {
    const entry = consolMeta[i.toString()];
    if (!entry) break;
    levels.push({ shape: entry.shape, dtype: entry.data_type });
  }
  return levels;
}

// ── 9836842 v0.3 – CYX uint16 ─────────────────────────────────────────────────
describe('getConsolidatedMetadata – 9836842 v0.3 (CYX uint16)', () => {
  let virtual: Record<string, unknown>;

  beforeAll(async () => {
    const store = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '9836842.v0_3.ome.tif'))
    );
    virtual = await store.getConsolidatedMetadata();
  });

  it('has zarr_format 3 at root', () => {
    expect((virtual as any).zarr_format).toBe(3);
    expect((virtual as any).node_type).toBe('group');
  });

  it('has consolidated_metadata with inline kind', () => {
    const cm = (virtual as any).consolidated_metadata;
    expect(cm).toBeDefined();
    expect(cm.kind).toBe('inline');
    expect(cm.must_understand).toBe(false);
    expect(typeof cm.metadata).toBe('object');
  });

  it('shape and dtype for each level match reference zarr', () => {
    const refLevels = readZarrV2Levels(join(FIXTURES, '9836842.v0_3.cropped.zarr'));
    const cm = (virtual as any).consolidated_metadata;
    const virtualLevels = Object.keys(cm.metadata)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((k) => ({ shape: cm.metadata[k].shape, dtype: cm.metadata[k].data_type }));
    expect(virtualLevels.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < virtualLevels.length; i++) {
      expect(virtualLevels[i].shape).toEqual(refLevels[i].shape);
      expect(virtualLevels[i].dtype).toBe(refLevels[i].dtype);
    }
  });
});

// ── 10501752 v0.4 – CYX float64 ───────────────────────────────────────────────
describe('getConsolidatedMetadata – 10501752 v0.4 (CYX float64)', () => {
  let virtual: Record<string, unknown>;

  beforeAll(async () => {
    const store = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, '10501752.v0_4.ome.tif'))
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
    const refLevels = readZarrV2Levels(join(FIXTURES, '10501752.v0_4.zarr'));
    const cm = (virtual as any).consolidated_metadata;
    const virtualLevels = Object.keys(cm.metadata)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((k) => ({ shape: cm.metadata[k].shape, dtype: cm.metadata[k].data_type }));
    expect(virtualLevels.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < virtualLevels.length; i++) {
      expect(virtualLevels[i].shape).toEqual(refLevels[i].shape);
      expect(virtualLevels[i].dtype).toBe(refLevels[i].dtype);
    }
  });
});

// ── ExpD_chicken_embryo_MIP v0.5 – YX uint8 ───────────────────────────────────
describe('getConsolidatedMetadata – ExpD_chicken_embryo_MIP v0.5 (YX uint8)', () => {
  let virtual: Record<string, unknown>;

  beforeAll(async () => {
    const store = await OmeTiffAsOmeZarrStore.fromStore(
      new FileSystemStore(join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.ome.tif'))
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
    const refLevels = readZarrV3Levels(join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.cropped.ome.zarr'));
    const cm = (virtual as any).consolidated_metadata;
    const virtualLevels = Object.keys(cm.metadata)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((k) => ({ shape: cm.metadata[k].shape, dtype: cm.metadata[k].data_type }));
    expect(virtualLevels.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < virtualLevels.length; i++) {
      expect(virtualLevels[i].shape).toEqual(refLevels[i].shape);
      expect(virtualLevels[i].dtype).toBe(refLevels[i].dtype);
    }
  });
});

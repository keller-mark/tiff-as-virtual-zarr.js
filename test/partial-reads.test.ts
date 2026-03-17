import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';
import { OmeTiffAsOmeZarrStore } from '../src/OmeTiffAsOmeZarrStore.js';
import { open, get as zarrGet, slice } from 'zarrita';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

/**
 * Wraps raw TIFF bytes and records every getRange() call made against key '/'.
 * Lets tests verify that files are read partially (via HTTP-style range requests)
 * rather than being loaded in full.
 */
class SourceSpy implements AsyncReadable {
  readonly fileSize: number;
  /** Every range request that was served, in call order. */
  readonly getRangeCalls: Array<{ offset: number; length: number }> = [];
  /** Number of full-file get() calls (should stay 0 when range requests work). */
  getCalls = 0;
  private ab: ArrayBuffer;

  constructor(ab: ArrayBuffer) {
    this.ab = ab;
    this.fileSize = ab.byteLength;
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    if (key === '/') {
      this.getCalls++;
      return new Uint8Array(this.ab);
    }
    return undefined;
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    if (key !== '/') return undefined;

    let offset: number;
    let length: number;
    if ('suffixLength' in range) {
      offset = Math.max(0, this.ab.byteLength - range.suffixLength);
      length = this.ab.byteLength - offset;
    } else {
      offset = range.offset;
      length = range.length;
    }

    // Clamp to actual file bounds so we never throw a RangeError.
    const safeLength = Math.min(length, this.ab.byteLength - offset);
    if (safeLength <= 0) return new Uint8Array(0);

    const result = new Uint8Array(this.ab, offset, safeLength);
    this.getRangeCalls.push({ offset, length: safeLength });
    return result;
  }

  /**
   * Returns the number of unique (non-overlapping) bytes fetched across all
   * getRange() calls.
   */
  uniqueBytesFetched(): number {
    if (this.getRangeCalls.length === 0) return 0;

    const intervals = this.getRangeCalls
      .map(({ offset, length }) => [offset, offset + length] as [number, number])
      .sort((a, b) => a[0] - b[0]);

    let total = 0;
    let curStart = intervals[0][0];
    let curEnd = intervals[0][1];
    for (let i = 1; i < intervals.length; i++) {
      const [start, end] = intervals[i];
      if (start <= curEnd) {
        curEnd = Math.max(curEnd, end);
      } else {
        total += curEnd - curStart;
        curStart = start;
        curEnd = end;
      }
    }
    total += curEnd - curStart;
    return total;
  }

  /** Fraction of the file read (0–1). */
  fractionRead(): number {
    return this.uniqueBytesFetched() / this.fileSize;
  }
}

function makeSourceSpy(fixtureName: string): SourceSpy {
  const buf = readFileSync(join(FIXTURES, fixtureName));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new SourceSpy(ab);
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function openAndReadChannel0(
  spy: SourceSpy,
  fixtureName: string,
  hasCAxis: boolean,
): Promise<void> {
  const store = await OmeTiffAsOmeZarrStore.fromStore(spy);
  const group = await open(store, { kind: 'group' });
  const arr = await open(group.resolve('0'), { kind: 'array' });
  if (hasCAxis) {
    await zarrGet(arr, [0, slice(0, 256), slice(0, 256)]);
  } else {
    await zarrGet(arr, [slice(0, 256), slice(0, 256)]);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('partial reads', () => {
  describe('getRange is used (not get) for raw TIFF byte access', () => {
    it('9836842.v0_3.ome.tif: range requests are issued, not full-file reads', async () => {
      const spy = makeSourceSpy('9836842.v0_3.ome.tif');
      await openAndReadChannel0(spy, '9836842.v0_3.ome.tif', true);

      expect(spy.getRangeCalls.length).toBeGreaterThan(0);
      // The full-file get() fallback should never be triggered when getRange is available.
      expect(spy.getCalls).toBe(0);
    });

    it('10501752.v0_4.ome.tif: range requests are issued, not full-file reads', async () => {
      const spy = makeSourceSpy('10501752.v0_4.ome.tif');
      await openAndReadChannel0(spy, '10501752.v0_4.ome.tif', true);

      expect(spy.getRangeCalls.length).toBeGreaterThan(0);
      expect(spy.getCalls).toBe(0);
    });
  });

  describe('less than 100% of the file is read when reading one channel', () => {
    it('9836842.v0_3.ome.tif (CYX uint16, 3 channels): channel 0 reads < 100%', async () => {
      const spy = makeSourceSpy('9836842.v0_3.ome.tif');
      await openAndReadChannel0(spy, '9836842.v0_3.ome.tif', true);

      expect(spy.fractionRead()).toBeLessThan(1.0);
    });

    it('10501752.v0_4.ome.tif (CYX float64, 50 channels): channel 0 reads < 10%', async () => {
      // This file is ~15 MB with 50 channels; reading a single channel's 256×256
      // crop should stay well under 10 % of the total bytes.
      const spy = makeSourceSpy('10501752.v0_4.ome.tif');
      await openAndReadChannel0(spy, '10501752.v0_4.ome.tif', true);

      expect(spy.fractionRead()).toBeLessThan(0.1);
    });
  });

  describe('no single range request reads the entire file at once', () => {
    it('9836842.v0_3.ome.tif: every range request is smaller than the full file', async () => {
      const spy = makeSourceSpy('9836842.v0_3.ome.tif');
      await openAndReadChannel0(spy, '9836842.v0_3.ome.tif', true);

      expect(spy.getRangeCalls.length).toBeGreaterThan(0);
      const maxSingleRead = Math.max(...spy.getRangeCalls.map((c) => c.length));
      expect(maxSingleRead).toBeLessThan(spy.fileSize);
    });

    it('10501752.v0_4.ome.tif: every range request is smaller than the full file', async () => {
      const spy = makeSourceSpy('10501752.v0_4.ome.tif');
      await openAndReadChannel0(spy, '10501752.v0_4.ome.tif', true);

      expect(spy.getRangeCalls.length).toBeGreaterThan(0);
      const maxSingleRead = Math.max(...spy.getRangeCalls.map((c) => c.length));
      expect(maxSingleRead).toBeLessThan(spy.fileSize);
    });
  });
});

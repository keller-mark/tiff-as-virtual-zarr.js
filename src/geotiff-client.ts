// ── Custom geotiff client backed by an AsyncReadable store ────────────────────

import { BaseClient, BaseResponse } from 'geotiff';
import type { AsyncReadable, AbsolutePath } from '@zarrita/storage';

export class StoreTiffResponse extends BaseResponse {
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
    this._total = total;
  }

  // BaseResponse.status is typed as void in the .d.ts (an upstream quirk); at
  // runtime it must return a number so that BaseResponse.ok works correctly.
  get status(): any { return this._statusCode; }

  getHeader(name: string): string {
    if (name.toLowerCase() === 'content-range') {
      // When file size is unknown, return '' so geotiff leaves _fileSize=null
      // (meaning: no upper-bound on block fetches). Returning a synthetic total
      // equal to the chunk length would cap geotiff at that size and prevent it
      // from reading IFDs or tag values stored beyond the first block.
      if (this._total === 0) return '';
      const end = this._rangeOffset + this._rangeLength - 1;
      return `bytes ${this._rangeOffset}-${end}/${this._total}`;
    }
    return '';
  }

  getData(): ArrayBuffer { return this._data; }
}

export class StoreTiffClient extends BaseClient {
  private _store: AsyncReadable;

  constructor(store: AsyncReadable) {
    super('/');
    this._store = store;
  }

  private static _toBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async request(
    { headers = {}, signal: _signal }: { headers?: HeadersInit; signal?: AbortSignal } = {},
  ): Promise<StoreTiffResponse> {
    const rangeHeader = (headers as Record<string, string>)['Range'];
    const m = rangeHeader?.match(/bytes=(\d+)-(\d+)/);

    if (!m) {
      throw new Error(
        'StoreTiffClient: only range requests are supported. ' +
        'Reading the full OME-TIFF file is not permitted (file may be terabytes in size).',
      );
    }

    const offset = parseInt(m[1]);
    const length = parseInt(m[2]) - offset;

    if (this._store.getRange) {
      // Preferred path: use store.getRange for true range requests.
      const bytes = await this._store.getRange('/' as AbsolutePath, { offset, length });
      if (!bytes) throw new Error('StoreTiffClient: store.getRange returned no data at "/"');
      return new StoreTiffResponse(206, StoreTiffClient._toBuffer(bytes), offset, length);
    }

    // Fallback: store has no getRange — use store.get.
    const bytes = await this._store.get('/' as AbsolutePath);
    if (!bytes) throw new Error('StoreTiffClient: store.get returned no data at "/"');
    const slice = bytes.slice(offset, offset + length);
    return new StoreTiffResponse(206, StoreTiffClient._toBuffer(slice), offset, length, bytes.byteLength);
  }
}

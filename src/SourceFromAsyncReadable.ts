import { ContentRange, Source, SourceError, SourceMetadata } from '@chunkd/source';
import type { AsyncReadable, AbsolutePath, RangeQuery } from '@zarrita/storage';

export class SourceFromAsyncReadable implements Source {
  type = 'source-from-async-readable';
  internal_store: AsyncReadable;
  headers?: Record<string, string>;
  url: URL;

  // TODO: change headers to Options, and use generics: AsyncReadable<Options>.
  constructor(internal_store: AsyncReadable, headers?: Record<string, string>) {
    this.internal_store = internal_store;
    this.headers = headers;
    this.url = new URL('source-from-async-readable://'); // Placeholder.
  }

  /** Optional metadata, only populated if a .head() or .fetchBytes() has already been returned */
  metadata?: SourceMetadata;

  head(): Promise<SourceMetadata> {
    // TODO? Throw error instead?
    return Promise.resolve({ size: undefined });
  }

  async fetch(offset: number, length?: number, options?: { signal: AbortSignal }): Promise<ArrayBuffer> {
    try {
        if(offset > 0 && length === undefined) {
            throw new SourceError(`Length must be provided when offset is positive`, 400, this);
        } else if(offset === 0 && length === undefined) {
            // Read whole file?
            const bytes = await this.internal_store.get('/', options);
            if (bytes === undefined) throw new SourceError(`Key '/' not found in store`, 404, this);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        }
    
        const range: RangeQuery = offset < 0 || length === undefined ? { suffixLength: Math.abs(offset) } : { offset, length };
        if (this.internal_store.getRange) {
            const bytes = await this.internal_store.getRange('/', range, options);
            if (bytes === undefined) throw new SourceError(`Key '/' not found in store`, 404, this);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        }
        // Store doesn't support getRange, so we have to fetch the whole file and slice it ourselves.
        const allBytes = await this.internal_store.get('/', options);
        if (allBytes === undefined) throw new SourceError(`Key '/' not found in store`, 404, this);
        const slice = allBytes.slice(offset, length !== undefined ? offset + length : undefined);
        return slice.buffer as ArrayBuffer;
    } catch (e) {
      if (SourceError.is(e) && (e as SourceError).source === this) throw e;
      throw new SourceError(`Failed to fetch`, 500, this, e);
    }
  }
}

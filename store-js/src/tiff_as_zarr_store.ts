import type { AbsolutePath, AsyncReadable, RangeQuery } from "@zarrita/storage";
import type { GeoTIFF, GeoTIFFImage } from 'geotiff';

/**
 * Readonly store which reads an OME-TIFF as an OME-Zarr.
 *
 * ```typescript
 * import * as zarr from "zarrita";
 * const store = new TiffAsZarrStore("http://localhost:8080/data.ome.tif");
 * ```
 */
class TiffAsZarrStore implements AsyncReadable {
	#ome_tiff_url: AsyncReadable;

	constructor(ome_tiff_url: string) {
		this.#ome_tiff_url = ome_tiff_url;
	}


	async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
		// TODO: implement
	}

	async getRange(
		key: AbsolutePath,
		range: RangeQuery,
  ): Promise < Uint8Array | undefined > {
  		// TODO: implement
  }
}

export default TiffAsZarrStore;

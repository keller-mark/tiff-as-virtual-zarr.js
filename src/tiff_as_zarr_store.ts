import type { AbsolutePath, AsyncReadable, RangeQuery } from "@zarrita/storage";
import type { GeoTIFF, GeoTIFFImage } from "geotiff";

/** OME pixel type → Zarr v3 data_type */
const OME_DTYPE_MAP: Record<string, string> = {
	uint8: "uint8",
	uint16: "uint16",
	uint32: "uint32",
	int8: "int8",
	int16: "int16",
	int32: "int32",
	float: "float32",
	double: "float64",
};

/** TIFF compression → Zarr v3 codecs */
const TIFF_COMPRESSION_TO_ZARR_CODEC: Record<number, object[]> = {
	1: [{ name: "bytes" }], // uncompressed
	8: [{ name: "bytes" }, { name: "zlib", configuration: { level: 6 } }], // DEFLATE
	32946: [{ name: "bytes" }, { name: "zlib", configuration: { level: 6 } }],
	50000: [
		{ name: "bytes" },
		{ name: "zstd", configuration: { level: 1, checksum: false } },
	],
};

/** Axis type lookup */
const DIM_TYPES: Record<string, string> = {
	T: "time",
	Z: "space",
	C: "channel",
	Y: "space",
	X: "space",
};

/** Map OME dtype → max integer value (for omero window metadata) */
const DTYPE_MAX: Record<string, number> = {
	uint8: 255,
	uint16: 65535,
	uint32: 4294967295,
	int8: 127,
	int16: 32767,
	int32: 2147483647,
};

interface OmeInfo {
	axes: { name: string; type: string }[];
	shape: number[];
	dtype: string;
	channels: { name: string }[];
	dimensionOrder: string;
	sizeC: number;
	sizeZ: number;
	sizeT: number;
	sizeY: number;
	sizeX: number;
}

function parseOmeXml(xmlStr: string): OmeInfo {
	// Use a simple regex-based parser since we're in a JS environment
	// (DOMParser is browser-only; we want Node.js compatibility too)
	const pixelsMatch = xmlStr.match(/<Pixels\s([^>]+)>/);
	if (!pixelsMatch) throw new Error("No Pixels element found in OME-XML");

	const pixelsAttrs = pixelsMatch[1];
	const attr = (name: string): string => {
		const m = pixelsAttrs.match(new RegExp(`${name}="([^"]+)"`));
		return m ? m[1] : "";
	};

	const sizeC = parseInt(attr("SizeC") || "1");
	const sizeZ = parseInt(attr("SizeZ") || "1");
	const sizeT = parseInt(attr("SizeT") || "1");
	const sizeY = parseInt(attr("SizeY"));
	const sizeX = parseInt(attr("SizeX"));
	const dtype = OME_DTYPE_MAP[attr("Type")] || attr("Type");
	const dimensionOrder = attr("DimensionOrder") || "XYCZT";

	// Parse channel names
	const channels: { name: string }[] = [];
	const channelRegex = /<Channel\s[^>]*?Name="([^"]*)"[^>]*?\/?>|<Channel\s[^>]*?Name="([^"]*)"[^>]*?>/g;
	let chMatch: RegExpExecArray | null;
	while ((chMatch = channelRegex.exec(xmlStr)) !== null) {
		channels.push({ name: chMatch[1] || chMatch[2] || "" });
	}

	// Build axes from dimension order (reversed = slowest to fastest)
	const dimSizes: Record<string, number> = {
		T: sizeT,
		Z: sizeZ,
		C: sizeC,
		Y: sizeY,
		X: sizeX,
	};
	const orderedDims = [...dimensionOrder].reverse();

	const axes: { name: string; type: string }[] = [];
	const shape: number[] = [];
	for (const dim of orderedDims) {
		const size = dimSizes[dim];
		if (size > 1 || dim === "Y" || dim === "X") {
			axes.push({ name: dim.toLowerCase(), type: DIM_TYPES[dim] });
			shape.push(size);
		}
	}

	return {
		axes,
		shape,
		dtype,
		channels,
		dimensionOrder,
		sizeC,
		sizeZ,
		sizeT,
		sizeY,
		sizeX,
	};
}

/**
 * Readonly store which reads an OME-TIFF as an OME-Zarr (NGFF v0.5).
 *
 * Presents the OME-TIFF pixel data as Zarr v3 chunks without copying
 * or re-encoding. TIFF tiles/strips are served directly as Zarr chunks.
 *
 * The store must be initialized with {@link TiffAsZarrStore.fromTiff}
 * or {@link TiffAsZarrStore.fromFile} before use, since `GeoTIFF`
 * requires async construction.
 *
 * ```typescript
 * import * as zarr from "zarrita";
 * import { fromFile } from "geotiff";
 *
 * const tiff = await fromFile("data.ome.tif");
 * const store = await TiffAsZarrStore.fromTiff(tiff);
 * const root = await zarr.open(store, { kind: "group" });
 * ```
 */
class TiffAsZarrStore implements AsyncReadable {
	#tiff: GeoTIFF;
	#storeDict: Map<string, Uint8Array> = new Map();
	#chunkMap: Map<string, { offset: number; length: number }> = new Map();

	private constructor(tiff: GeoTIFF) {
		this.#tiff = tiff;
	}

	/**
	 * Create a store from an already-opened GeoTIFF instance.
	 */
	static async fromTiff(tiff: GeoTIFF): Promise<TiffAsZarrStore> {
		const store = new TiffAsZarrStore(tiff);
		await store.#init();
		return store;
	}

	/**
	 * Create a store from a local file path (Node.js only).
	 */
	static async fromFile(filePath: string): Promise<TiffAsZarrStore> {
		const { fromFile } = await import("geotiff");
		const tiff = await fromFile(filePath);
		return TiffAsZarrStore.fromTiff(tiff);
	}

	async #init(): Promise<void> {
		const tiff = this.#tiff;
		const firstImage = await tiff.getImage(0);
		const fd = firstImage.fileDirectory;
		const omeXml = fd.ImageDescription;

		if (!omeXml || !omeXml.includes("<OME")) {
			throw new Error("Not an OME-TIFF file: no OME-XML in ImageDescription");
		}

		const omeInfo = parseOmeXml(omeXml);
		const imageCount = await tiff.getImageCount();

		// Determine chunk shape
		let chunkY: number;
		let chunkX: number;
		if (fd.TileWidth && fd.TileLength) {
			chunkX = fd.TileWidth;
			chunkY = fd.TileLength;
		} else {
			// Stripped: one chunk per page
			chunkY = omeInfo.sizeY;
			chunkX = omeInfo.sizeX;
		}

		const fullChunkShape = omeInfo.axes.map((ax) => {
			if (ax.name === "y") return chunkY;
			if (ax.name === "x") return chunkX;
			return 1;
		});

		// Determine codecs from TIFF compression
		const compression = fd.Compression ?? 1;
		const codecs = TIFF_COMPRESSION_TO_ZARR_CODEC[compression];
		if (!codecs) {
			throw new Error(`Unsupported TIFF compression: ${compression}`);
		}

		// Build array metadata
		const arrayMetadata = {
			zarr_format: 3,
			node_type: "array",
			shape: omeInfo.shape,
			data_type: omeInfo.dtype,
			chunk_grid: {
				name: "regular",
				configuration: { chunk_shape: fullChunkShape },
			},
			chunk_key_encoding: {
				name: "default",
				configuration: { separator: "/" },
			},
			fill_value: 0,
			codecs,
			attributes: {},
			dimension_names: omeInfo.axes.map((ax) => ax.name),
		};

		// Build omero channel metadata
		const maxVal = DTYPE_MAX[omeInfo.dtype] ?? 1;
		const channelMeta = omeInfo.channels.map((ch) => ({
			label: ch.name,
			color: "FFFFFF",
			window: { start: 0, end: maxVal, min: 0, max: maxVal },
		}));

		const scaleTransform = omeInfo.axes.map(() => 1.0);

		const rootMetadata = {
			zarr_format: 3,
			node_type: "group",
			attributes: {
				ome: {
					version: "0.5",
					multiscales: [
						{
							datasets: [
								{
									path: "0",
									coordinateTransformations: [
										{ type: "scale", scale: scaleTransform },
									],
								},
							],
							name: "/",
							axes: omeInfo.axes,
						},
					],
				},
				omero: {
					name: "OME-TIFF",
					version: "0.3",
					rdefs: { model: "greyscale" },
					channels: channelMeta,
				},
			},
		};

		// Store metadata as encoded JSON
		const encoder = new TextEncoder();
		this.#storeDict.set("zarr.json", encoder.encode(JSON.stringify(rootMetadata)));
		this.#storeDict.set("0/zarr.json", encoder.encode(JSON.stringify(arrayMetadata)));

		// Build chunk-to-offset mapping
		await this.#buildChunkMap(omeInfo, imageCount, chunkY, chunkX);
	}

	async #buildChunkMap(
		omeInfo: OmeInfo,
		imageCount: number,
		chunkY: number,
		chunkX: number,
	): Promise<void> {
		const tiff = this.#tiff;
		const axes = omeInfo.axes;
		const tilesY = Math.ceil(omeInfo.sizeY / chunkY);
		const tilesX = Math.ceil(omeInfo.sizeX / chunkX);

		const nonSpatialDims = axes.filter(
			(ax) => ax.name !== "y" && ax.name !== "x",
		);
		const nonSpatialSizes = nonSpatialDims.map((ax) => {
			if (ax.name === "c") return omeInfo.sizeC;
			if (ax.name === "z") return omeInfo.sizeZ;
			if (ax.name === "t") return omeInfo.sizeT;
			return 1;
		});

		for (let pageIdx = 0; pageIdx < imageCount; pageIdx++) {
			const image = await tiff.getImage(pageIdx);
			const fd = image.fileDirectory;

			// Compute non-spatial coordinates from page index
			const nonSpatialCoords: number[] = [];
			let remaining = pageIdx;
			for (let i = nonSpatialSizes.length - 1; i >= 0; i--) {
				nonSpatialCoords.unshift(remaining % nonSpatialSizes[i]);
				remaining = Math.floor(remaining / nonSpatialSizes[i]);
			}

			if (fd.TileOffsets && fd.TileByteCounts) {
				// Tiled TIFF
				let tileIdx = 0;
				for (let ty = 0; ty < tilesY; ty++) {
					for (let tx = 0; tx < tilesX; tx++) {
						const chunkCoords = [...nonSpatialCoords, ty, tx];
						const key = "0/c/" + chunkCoords.join("/");
						this.#chunkMap.set(key, {
							offset: fd.TileOffsets[tileIdx],
							length: fd.TileByteCounts[tileIdx],
						});
						tileIdx++;
					}
				}
			} else if (fd.StripOffsets && fd.StripByteCounts) {
				// Stripped TIFF
				const chunkCoords = [...nonSpatialCoords, 0, 0];
				const key = "0/c/" + chunkCoords.join("/");
				if (fd.StripOffsets.length === 1) {
					this.#chunkMap.set(key, {
						offset: fd.StripOffsets[0],
						length: fd.StripByteCounts[0],
					});
				} else {
					// Multiple strips — use first offset and total size
					let totalBytes = 0;
					for (let i = 0; i < fd.StripByteCounts.length; i++) {
						totalBytes += fd.StripByteCounts[i];
					}
					this.#chunkMap.set(key, {
						offset: fd.StripOffsets[0],
						length: totalBytes,
					});
				}
			}
		}
	}

	async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
		// Strip the leading "/"
		const normalizedKey = key.startsWith("/") ? key.slice(1) : key;

		// Check metadata keys
		const metaBuf = this.#storeDict.get(normalizedKey);
		if (metaBuf) {
			return metaBuf;
		}

		// Check chunk keys
		const chunkInfo = this.#chunkMap.get(normalizedKey);
		if (chunkInfo) {
			const results = await this.#tiff.source.fetch([
				{ offset: chunkInfo.offset, length: chunkInfo.length },
			]);
			return new Uint8Array(results[0]);
		}

		return undefined;
	}

	async getRange(
		key: AbsolutePath,
		range: RangeQuery,
	): Promise<Uint8Array | undefined> {
		const fullData = await this.get(key);
		if (!fullData) return undefined;

		if ("suffixLength" in range) {
			return fullData.slice(fullData.length - range.suffixLength);
		}
		return fullData.slice(range.offset, range.offset + range.length);
	}

	close(): void {
		this.#tiff.close();
	}
}

export default TiffAsZarrStore;

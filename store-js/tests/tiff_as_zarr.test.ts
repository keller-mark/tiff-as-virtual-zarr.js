import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fromFile } from "geotiff";
import * as zarr from "zarrita";
import { resolve } from "path";
import TiffAsZarrStore from "../src/tiff_as_zarr_store.js";

const DATA_DIR = resolve(import.meta.dirname, "../../data");
const TIFF_PATH = resolve(DATA_DIR, "test_image.ome.tif");

let store: TiffAsZarrStore;

beforeAll(async () => {
	store = await TiffAsZarrStore.fromFile(TIFF_PATH);
});

afterAll(() => {
	store.close();
});

describe("Store metadata", () => {
	it("should have zarr.json at root", async () => {
		const buf = await store.get("/zarr.json");
		expect(buf).toBeDefined();
	});

	it("should produce a valid Zarr v3 group", async () => {
		const buf = await store.get("/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.zarr_format).toBe(3);
		expect(meta.node_type).toBe("group");
	});

	it("should contain OME multiscales", async () => {
		const buf = await store.get("/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.attributes.ome).toBeDefined();
		expect(meta.attributes.ome.multiscales).toBeDefined();
		expect(meta.attributes.ome.multiscales.length).toBeGreaterThanOrEqual(1);
	});

	it("should have correct axes (c, y, x)", async () => {
		const buf = await store.get("/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		const axes = meta.attributes.ome.multiscales[0].axes;
		const names = axes.map((a: { name: string }) => a.name);
		expect(names).toContain("c");
		expect(names).toContain("y");
		expect(names).toContain("x");
	});

	it("should have dataset path '0'", async () => {
		const buf = await store.get("/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		const datasets = meta.attributes.ome.multiscales[0].datasets;
		expect(datasets.length).toBeGreaterThanOrEqual(1);
		expect(datasets[0].path).toBe("0");
	});

	it("should have omero channel metadata", async () => {
		const buf = await store.get("/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.attributes.omero).toBeDefined();
		const channels = meta.attributes.omero.channels;
		expect(channels.length).toBe(3);
		const labels = channels.map((c: { label: string }) => c.label);
		expect(labels).toContain("DAPI");
		expect(labels).toContain("GFP");
		expect(labels).toContain("Brightfield");
	});

	it("should have array zarr.json", async () => {
		const buf = await store.get("/0/zarr.json");
		expect(buf).toBeDefined();
	});

	it("should have correct array metadata", async () => {
		const buf = await store.get("/0/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.zarr_format).toBe(3);
		expect(meta.node_type).toBe("array");
		expect(meta.data_type).toBe("uint8");
		expect(meta.shape).toEqual([3, 128, 128]);
	});

	it("should have correct chunk shape", async () => {
		const buf = await store.get("/0/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		const chunkShape = meta.chunk_grid.configuration.chunk_shape;
		expect(chunkShape[0]).toBe(1); // one channel per chunk
		expect(chunkShape[1]).toBe(128); // full image height (non-tiled)
		expect(chunkShape[2]).toBe(128); // full image width (non-tiled)
	});

	it("should use default chunk key encoding with /", async () => {
		const buf = await store.get("/0/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.chunk_key_encoding.name).toBe("default");
		expect(meta.chunk_key_encoding.configuration.separator).toBe("/");
	});

	it("should have correct dimension names", async () => {
		const buf = await store.get("/0/zarr.json");
		const meta = JSON.parse(new TextDecoder().decode(buf!));
		expect(meta.dimension_names).toEqual(["c", "y", "x"]);
	});
});

describe("Store chunks", () => {
	it("should serve chunk data for each channel", async () => {
		for (const c of [0, 1, 2]) {
			const buf = await store.get(`/0/c/${c}/0/0`);
			expect(buf).toBeDefined();
		}
	});

	it("should return undefined for missing chunks", async () => {
		const buf = await store.get("/0/c/99/0/0");
		expect(buf).toBeUndefined();
	});

	it("should return correct chunk data size", async () => {
		const buf = await store.get("/0/c/0/0/0");
		expect(buf!.byteLength).toBe(128 * 128); // uint8, 128x128
	});

	it("should return data matching direct tifffile read", async () => {
		const tiff = await fromFile(TIFF_PATH);
		for (let c = 0; c < 3; c++) {
			const image = await tiff.getImage(c);
			const raster = (await image.readRasters({ interleave: true })) as Uint8Array;

			const buf = await store.get(`/0/c/${c}/0/0`);
			const chunkData = buf!;

			expect(chunkData.byteLength).toBe(raster.length);
			for (let i = 0; i < raster.length; i++) {
				if (chunkData[i] !== raster[i]) {
					throw new Error(
						`Channel ${c}: mismatch at byte ${i}: store=${chunkData[i]} vs tiff=${raster[i]}`,
					);
				}
			}
		}
		tiff.close();
	});
});

describe("Store via zarrita", () => {
	it("should open as a zarr group", async () => {
		const root = await zarr.open(store, { kind: "group" });
		expect(root).toBeDefined();
		expect(root.kind).toBe("group");
	});

	it("should have correct array shape", async () => {
		const root = await zarr.open(store, { kind: "group" });
		const arr = await zarr.open(root.resolve("0"), { kind: "array" });
		expect(arr.shape).toEqual([3, 128, 128]);
	});

	it("should have correct array dtype", async () => {
		const root = await zarr.open(store, { kind: "group" });
		const arr = await zarr.open(root.resolve("0"), { kind: "array" });
		expect(arr.dtype).toBe("uint8");
	});

	it("should read pixel data matching tifffile", async () => {
		const tiff = await fromFile(TIFF_PATH);

		const root = await zarr.open(store, { kind: "group" });
		const arr = await zarr.open(root.resolve("0"), { kind: "array" });

		for (let c = 0; c < 3; c++) {
			const chunk = await arr.getChunk([c, 0, 0]);
			const image = await tiff.getImage(c);
			const raster = (await image.readRasters({ interleave: true })) as Uint8Array;

			expect(chunk.data.length).toBe(raster.length);
			for (let i = 0; i < raster.length; i++) {
				if (chunk.data[i] !== raster[i]) {
					throw new Error(
						`Channel ${c}: mismatch at byte ${i}: zarr=${chunk.data[i]} vs tiff=${raster[i]}`,
					);
				}
			}
		}

		tiff.close();
	});
});

describe("Store getRange", () => {
	it("should return a byte range of metadata", async () => {
		const full = await store.get("/zarr.json");
		const partial = await store.getRange("/zarr.json", {
			offset: 0,
			length: 10,
		});
		expect(partial).toBeDefined();
		expect(partial!.byteLength).toBe(10);
		for (let i = 0; i < 10; i++) {
			expect(partial![i]).toBe(full![i]);
		}
	});

	it("should return suffix bytes", async () => {
		const full = await store.get("/zarr.json");
		const suffix = await store.getRange("/zarr.json", { suffixLength: 5 });
		expect(suffix).toBeDefined();
		expect(suffix!.byteLength).toBe(5);
		for (let i = 0; i < 5; i++) {
			expect(suffix![i]).toBe(full![full!.length - 5 + i]);
		}
	});

	it("should return undefined for missing key", async () => {
		const result = await store.getRange("/nonexistent", {
			offset: 0,
			length: 10,
		});
		expect(result).toBeUndefined();
	});
});

describe("Store equality and construction", () => {
	it("should create store via fromTiff", async () => {
		const tiff = await fromFile(TIFF_PATH);
		const s = await TiffAsZarrStore.fromTiff(tiff);
		const buf = await s.get("/zarr.json");
		expect(buf).toBeDefined();
		s.close();
	});
});

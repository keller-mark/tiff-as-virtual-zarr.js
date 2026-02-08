## Submodules

This repository contains the following as git submodules:
- viv: Library for multiscale visualization of high-resolution multiplexed bioimaging data on the web.
  - Most relevant subdirectory of viv: `packages/loaders/src/`
- zod-ome-ngff: OME-Zarr (aka OME-NGFF) metadata schema validation in Zod (TypeScript).
- zarrita.js: Zarr implementation in TypeScript/JavaScript.
- zarr-python: Zarr implementation in Python.
- yaozarrs: OME-Zarr metadata schema validation in Pydantic (Python).

## Project goal

Read OME-TIFF files as virtual OME-Zarr stores — without copying or re-encoding pixel data. TIFF tiles/strips are served directly as Zarr chunks by mapping Zarr chunk key requests to byte ranges within the TIFF file.

The Python and JS implementations are in `store-python/` and `store-js/`, respectively.

## Fixtures

`create_fixtures.py` (run via `uv run create_fixtures.py`) generates test data in `data/`:
- `test_image.ome.tif` — 3-channel (DAPI, GFP, Brightfield) CYX uint8 image, 128x128, uncompressed, not tiled (1 strip per page, 3 pages).
- `test_image.ome.zarr/` — Zarr v3 OME-Zarr with 5 pyramid levels, chunks (1, 64, 64), zstd compression, default chunk key encoding with `/` separator.

Note: The TIFF and Zarr fixtures are generated independently from the same source image, so they use different compression and chunking. The store implementation bridges this gap.

## Python store (`store-python/`)

### Structure
- `src/tiff_as_zarr_store.py` — `TiffAsZarrStore(Store)` implementation.
- `tests/test_tiff_as_zarr.py` — 29 tests. Import as `from src.tiff_as_zarr_store import TiffAsZarrStore`.
- Build: `hatchling`. Packages: `src/` directory (configured via `[tool.hatch.build.targets.wheel]`).
- Run tests: `cd store-python && uv run --extra dev pytest tests/ -v`

### Key implementation details

**TiffAsZarrStore** extends `zarr.abc.store.Store` (Zarr v3 async store API):
- Read-only (`supports_writes=False`, `supports_deletes=False`, `supports_listing=True`).
- Constructor takes a `tiff_path` string. Parses OME-XML via `xml.etree.ElementTree`.
- Generates two metadata entries: `zarr.json` (root group with OME multiscales + omero channel metadata) and `0/zarr.json` (array metadata).
- Builds a `_chunk_map: dict[str, tuple[int, int]]` mapping chunk keys (e.g., `0/c/0/0/0`) to `(file_offset, byte_count)` in the TIFF.
- Chunk keys use Zarr v3 default encoding with `/` separator: `0/c/{channel}/{y_chunk}/{x_chunk}`.
- Raw bytes are read from TIFF via `tif.filehandle.seek(offset)` / `.read(bytecount)`.

**How TIFF maps to Zarr:**
- Each TIFF page = one 2D plane. Pages are indexed by channel (for CYX), or by multi-dim coordinate for TZCYX.
- `page.dataoffsets` / `page.databytecounts` give byte ranges for tiles (tiled TIFF) or strips (stripped TIFF).
- For compressed tiled TIFFs, raw compressed tile bytes can be served directly as Zarr chunks — the TIFF compression (zlib, zstd) maps to equivalent Zarr codecs.
- For uncompressed stripped TIFFs, raw bytes are served with `codecs: [{"name": "bytes"}]`.
- Compression mapping: TIFF compression 1 → no codec; 8/32946 → zlib; 50000 → zstd.

**tifffile API essentials:**
- `tifffile.TiffFile(path)` — open TIFF. Access `.is_ome`, `.ome_metadata` (XML string), `.series[0]` (shape/dtype/axes), `.pages[i]` (individual IFDs).
- `page.is_tiled`, `page.tilelength`, `page.tilewidth` — tile info.
- `page.dataoffsets`, `page.databytecounts` — byte ranges of tiles/strips in the file.
- `page.compression` — compression enum (`.value` for int code).
- `page.decode` — returns `(compressor_dict, filters_list)` in Zarr v2 numcodecs format.
- Pages after page 0 may be `TiffFrame` objects (lightweight); check `hasattr` before accessing page-only attributes.

**Zarr v3 Store API (required methods):**
- `async get(key, prototype, byte_range)` — core read method, return `Buffer | None`.
- `async get_partial_values(prototype, key_ranges)` — batch read.
- `async exists(key)`, `async set(key, value)`, `async delete(key)`.
- `list()`, `list_prefix(prefix)`, `list_dir(prefix)` — return `AsyncIterator[str]`.
- `__eq__`, `supports_writes`, `supports_deletes`, `supports_listing`.
- Use `prototype.buffer.from_bytes(raw_bytes)` to create Buffer objects.
- Use `buf.to_bytes()` to extract bytes from a Buffer (not `bytes(buf)`).
- Use `_normalize_byte_range_index(value, byte_range)` for byte range slicing.

### Dependencies
- `zarr>=3.0.0`, `tifffile>=2026.1.28`, `ome-zarr==0.13.0`, `numpy`.
- Dev: `pytest>=8.4.1`, `pytest-asyncio>=0.25.0`.
- Async tests use `@pytest.mark.asyncio` with `asyncio_mode = "strict"` in pyproject.toml.

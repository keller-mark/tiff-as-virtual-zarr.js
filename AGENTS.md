## Submodules

This repository contains the following as git submodules, for your reference:
- ngff-spec: the OME-NGFF specification.
- zod-ome-ngff: OME-Zarr (aka OME-NGFF) metadata schema validation in Zod (TypeScript).
- zarrita.js: Zarr implementation in TypeScript/JavaScript.
- viv: Library for multiscale visualization of high-resolution multiplexed bioimaging data on the web.
  - Most relevant subdirectory of viv: `packages/loaders/src/`.



## Project goal

Read OME-TIFF files as virtual OME-Zarr stores — without copying or re-encoding pixel data. TIFF tiles/strips are served directly as Zarr chunks by mapping Zarr chunk key requests to byte ranges within the TIFF file.

OmeTiffAsOmeZarrStore should be defined in the NPM package and exported. This class must implement zarrita's
AsyncReadable interface. Given the convention of mapping OME-TIFF to OME-Zarr in the README, this store should enable a user to run .get and
 .getRange to obtain the store's metadata or array data. Internally, the store should fetch the OME-TIFF data for the
corresponding OME-XML metadata or TIFF array chunks.Metadata should be transformed via zod-ome-ngff and re-encoded to match what would be
returned when running .get or .getRange on the equivalent OME-NGFF image. Same for the TIFF data - given a requested chunk, the user should
obtain what they would expect to be returned from the equivalent OME-NGFF image. Unit tests should ensure this equivalence of metadata and
array data, so that the user can ultimately read their OME-TIFF as if it were a "virtualized" OME-NGFF image. The user should not be able to
 tell that the underlying data on-disk is not in OME-NGFF format.

To clarify: the OME-NGFF metadata should be up-converted to the latest v0.5 when necessary. In unit tests, comparisons
 of metadata do not need to be byte-for-byte, they can compare the final JSON object/array representation. Also, the store will need to
virtually return the zarr array metadata that corresponds to the underlying tiff array shape/chunking.

Although the test fixtures are small, we want this store to support very large tiff files, so
getRange will be used to read the underlying OME-TIFF image file using range requests. We always want to read the minimal subset of bytes of
 the file that are necessary, and we never want to read the full file.

## Fixtures
See `fixtures/README.md`.

A developer should be able to run Python scripts containing UV script metadata, which convert the downloaded OME-NGFF
sample images to OME-TIFF format. If the images are large, we will crop them. We need two separate scripts: one that supports the v0.5
OME-NGFF images, and depends on corresponding versions of the tifffile and ome-zarr and zarr (v3) python packages, and a second script that
supports the pre-v0.5 OME-NGFF images, and depends on tifffile, ome-zarr, and zarr python packages for the zarr v2 format. See
fixtures/README.md. After running the conversion scripts, the user should obtain equivalent OME-NGFF and OME-TIFF files. Thus, if cropping
is required, the script should also write the cropped OME-NGFF image for equivalence with the converted OME-TIFF images.

Note: The TIFF and Zarr fixtures are generated independently from the same source image, so they use different compression and chunking. The store implementation bridges this gap.

**How TIFF maps to Zarr:**
- Each TIFF page = one 2D plane. Pages are indexed by channel (for CYX), or by multi-dim coordinate for TZCYX.
- `page.dataoffsets` / `page.databytecounts` give byte ranges for tiles (tiled TIFF) or strips (stripped TIFF).
- For compressed tiled TIFFs, raw compressed tile bytes can be served directly as Zarr chunks — the TIFF compression (zlib, zstd) maps to equivalent Zarr codecs.
- For uncompressed stripped TIFFs, raw bytes are served with `codecs: [{"name": "bytes"}]`.
- Compression mapping: TIFF compression 1 → no codec; 8/32946 → zlib; 50000 → zstd.


## Tech stack:

- Python scripts using argparse and UV inline script metadata for dependencies: tifffile, zarr, ome-zarr, numpy. Separate scripts for Zarr v2 (OME-NGFF v0.4 and earlier) and Zarr v3 (OME-NGFF v0.5 and later).
- PNPM for node and NPM package management and running scripts
- Typescript
- Zarrita.js
- Zod and zod-ome-ngff
- Vitest for unit tests
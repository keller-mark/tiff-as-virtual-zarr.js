# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "zarr>=3.0.0",
#     "tifffile>=2026.1.28",
#     "imagecodecs",
# ]
# ///
"""
Create small TIFF / OME-TIFF fixtures covering layout and codec edge cases
(see SPEC.md), plus a reference Zarr v3 store holding the expected arrays.

Outputs (written to ./edge_cases/):
  <case>.tif              – one TIFF per case (see CASES below)
  reference.zarr/<case>/<level>
                          – expected virtual array for each case and level,
                            already in the axis order the virtual store exposes

Usage:
    uv run create_edge_case_fixtures.py
"""
import os
import shutil
from os.path import join

import numpy as np
import zarr
from tifffile import TiffWriter

OUT_DIR = "edge_cases"
HEIGHT, WIDTH = 100, 90  # deliberately not multiples of the tile/strip sizes

rng = np.random.default_rng(42)


def rand(shape, dtype):
    dtype = np.dtype(dtype)
    if dtype.kind == "f":
        return (rng.standard_normal(shape) * 100).astype(dtype)
    info = np.iinfo(dtype)
    return rng.integers(info.min, info.max, size=shape, dtype=dtype, endpoint=True)


def pyramid(arr, levels):
    """2x point subsampling on the last two axes (ceil-halving sizes)."""
    out = [arr]
    for _ in range(levels):
        out.append(out[-1][..., ::2, ::2])
    return out


def write_plain(name, data, byteorder="<", **kwargs):
    with TiffWriter(join(OUT_DIR, f"{name}.tif"), byteorder=byteorder) as tif:
        tif.write(data, **kwargs)


def main():
    if os.path.exists(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR)
    ref = zarr.open_group(join(OUT_DIR, "reference.zarr"), mode="w", zarr_format=3)

    def add_ref(name, levels):
        group = ref.create_group(name)
        for i, arr in enumerate(levels):
            a = group.create_array(
                str(i), shape=arr.shape, dtype=arr.dtype, chunks=arr.shape,
                compressors=None, fill_value=0,
            )
            a[...] = arr

    # ── Stripped layouts: last strip is short (100 rows / 16 rows-per-strip) ──
    d = rand((HEIGHT, WIDTH), "uint16")
    write_plain("strip_u16_none", d, photometric="minisblack", rowsperstrip=16)
    add_ref("strip_u16_none", [d])

    d = rand((HEIGHT, WIDTH), "uint8")
    write_plain("strip_u8_lzw", d, photometric="minisblack", rowsperstrip=16, compression="lzw")
    add_ref("strip_u8_lzw", [d])

    d = rand((HEIGHT, WIDTH), "int16")
    write_plain("strip_i16_be_zlib_pred2", d, byteorder=">", photometric="minisblack",
                rowsperstrip=16, compression="zlib", predictor=True)
    add_ref("strip_i16_be_zlib_pred2", [d])

    # ── Horizontal predictor on multi-byte samples ──
    for dtype, bo in [("uint16", "<"), ("uint16", ">"), ("int32", "<")]:
        d = rand((HEIGHT, WIDTH), dtype)
        name = f"tile_{np.dtype(dtype).str[1:]}_{'be' if bo == '>' else 'le'}_pred2"
        write_plain(name, d, byteorder=bo, photometric="minisblack", tile=(32, 32),
                    compression="zlib", predictor=True)
        add_ref(name, [d])

    # ── Floating-point predictor ──
    for dtype, bo in [("float32", "<"), ("float64", ">")]:
        d = rand((HEIGHT, WIDTH), dtype)
        name = f"tile_{np.dtype(dtype).str[1:]}_{'be' if bo == '>' else 'le'}_pred3"
        write_plain(name, d, byteorder=bo, photometric="minisblack", tile=(32, 32),
                    compression="zlib", predictor="floatingpoint")
        add_ref(name, [d])

    # ── zstd ──
    d = rand((HEIGHT, WIDTH), "uint16")
    write_plain("tile_u16_zstd", d, photometric="minisblack", tile=(32, 32), compression="zstd")
    add_ref("tile_u16_zstd", [d])

    # ── RGB: chunky (contig) and planar (separate) ──
    rgb = rand((3, HEIGHT, WIDTH), "uint8")  # CYX
    write_plain("rgb_contig_tiled_pred2", np.moveaxis(rgb, 0, -1), photometric="rgb",
                tile=(32, 32), compression="zlib", predictor=True)
    add_ref("rgb_contig_tiled_pred2", [rgb])

    write_plain("rgb_contig_strip", np.moveaxis(rgb, 0, -1), photometric="rgb",
                rowsperstrip=16)
    add_ref("rgb_contig_strip", [rgb])

    write_plain("rgb_separate_tiled", rgb, photometric="rgb", planarconfig="separate",
                tile=(32, 32), compression="zlib")
    add_ref("rgb_separate_tiled", [rgb])

    rgb16 = rand((3, HEIGHT, WIDTH), "uint16")
    write_plain("rgb_separate_strip_be", rgb16, byteorder=">", photometric="rgb",
                planarconfig="separate", rowsperstrip=16)
    add_ref("rgb_separate_strip_be", [rgb16])

    # ── Plain pyramid with SubIFDs and non-square tiles ──
    levels = pyramid(rand((HEIGHT, WIDTH), "uint16"), 2)
    with TiffWriter(join(OUT_DIR, "pyramid_plain.tif")) as tif:
        tif.write(levels[0], photometric="minisblack", tile=(32, 48), compression="zlib",
                  subifds=len(levels) - 1)
        for lvl in levels[1:]:
            tif.write(lvl, photometric="minisblack", tile=(32, 48), compression="zlib",
                      subfiletype=1)
    add_ref("pyramid_plain", levels)

    # ── OME-TIFF: Z-stack, 2 channels, non-square tiles, ceil-halving pyramid ──
    zcyx = rand((3, 2, HEIGHT, WIDTH), "uint16")
    levels = pyramid(zcyx, 2)
    with TiffWriter(join(OUT_DIR, "ome_zstack.ome.tif"), ome=True) as tif:
        tif.write(
            levels[0], photometric="minisblack", tile=(32, 48), compression="zlib",
            predictor=True, subifds=len(levels) - 1,
            metadata={
                "axes": "ZCYX",
                "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm",
                "PhysicalSizeY": 0.25, "PhysicalSizeYUnit": "µm",
                "PhysicalSizeZ": 2.0, "PhysicalSizeZUnit": "nm",
                "Channel": {"Name": ["A", "B"]},
            },
        )
        for lvl in levels[1:]:
            tif.write(lvl, photometric="minisblack", tile=(32, 48), compression="zlib",
                      predictor=True, subfiletype=1)
    # Virtual axis order is c, z, y, x.
    add_ref("ome_zstack", [np.swapaxes(lvl, 0, 1) for lvl in levels])

    # ── OME-TIFF: stripped, 2 channels ──
    cyx = rand((2, HEIGHT, WIDTH), "uint8")
    with TiffWriter(join(OUT_DIR, "ome_stripped.ome.tif"), ome=True) as tif:
        tif.write(cyx, photometric="minisblack", rowsperstrip=16,
                  metadata={"axes": "CYX", "Channel": {"Name": ["A", "B"]}})
    add_ref("ome_stripped", [cyx])

    print(f"Wrote edge-case fixtures to {OUT_DIR}/")


if __name__ == "__main__":
    main()

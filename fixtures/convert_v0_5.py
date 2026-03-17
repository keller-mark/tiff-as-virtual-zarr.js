# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "zarr>=3.0.0",
#     "ome-zarr==0.13.0",
#     "tifffile>=2026.1.28",
# ]
# ///
"""
Convert a v0.5 OME-NGFF zarr store (zarr v3 format) to OME-TIFF.

If the image exceeds --crop-size pixels in Y or X, it is cropped from the
top-left corner.  When cropping occurs, a matching cropped OME-NGFF v0.5 zarr
is also written so that the TIFF and zarr fixtures are equivalent.

In addition to the OME-TIFF, a plain (non-OME) TIFF is always written alongside
it:  grayscale (YX) when there is only one channel or more than three channels,
RGB (YXC, 3 channels) when there are exactly 2–3 channels.  Any Z or T axes are
reduced to index 0.

zarr.consolidate_metadata is also called on the reference zarr store so that
tests can compare against a ground-truth consolidated metadata representation.

Usage:
    uv run convert_v0_5.py <input.ome.zarr> [--output <out.ome.tif>] [--crop-size 512]

Download sample v0.5 images first (from fixtures/README.md):
    uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk \\
        --no-sign-request s3://idr/zarr/v0.5/idr0066/ExpD_chicken_embryo_MIP.ome.zarr \\
        ExpD_chicken_embryo_MIP.v0_5.ome.zarr
"""
import argparse
import numpy as np
from pathlib import Path

import zarr
from ome_zarr.writer import write_multiscale
from tifffile import TiffWriter

DEFAULT_CROP = 512
TILE_SIZE = 256


def get_axis_index(axes: list[str], name: str) -> int | None:
    try:
        return axes.index(name)
    except ValueError:
        return None


def axes_to_str(axes: list[str]) -> str:
    """Convert list of lowercase axis names to uppercase OME-TIFF axes string."""
    return "".join(a.upper() for a in axes)


def get_channel_names(attrs: dict) -> list[str] | None:
    """Extract channel names from omero metadata."""
    omero = attrs.get("omero") or attrs.get("ome", {}).get("omero")
    if omero:
        channels = omero.get("channels", [])
        return [ch.get("label", f"Ch{i}") for i, ch in enumerate(channels)]
    return None


def get_physical_sizes(multiscales: dict, axes: list[str]) -> dict[str, float]:
    """Extract physical pixel sizes (for x/y/z) from coordinateTransformations."""
    sizes: dict[str, float] = {}
    datasets = multiscales.get("datasets", [])
    for t in datasets[0].get("coordinateTransformations", []) if datasets else []:
        if t["type"] == "scale":
            for i, ax in enumerate(axes):
                if ax in ("x", "y", "z"):
                    sizes[ax] = t["scale"][i]
    for t in multiscales.get("coordinateTransformations", []):
        if t["type"] == "scale":
            for i, ax in enumerate(axes):
                if ax in ("x", "y", "z") and ax not in sizes:
                    sizes[ax] = t["scale"][i]
    return sizes


def write_cropped_zarr_v5(
    out_path: Path,
    axes_meta: list[dict],
    datasets_meta: list[dict],
    datasets_data: list[np.ndarray],
    source_group: zarr.Group,
) -> None:
    """Write a cropped OME-NGFF v0.5 zarr store using ome-zarr."""
    out_group = zarr.open_group(str(out_path), mode="w", zarr_format=3)

    # Build per-level storage options, clamping chunks to the cropped shape
    storage_options = []
    for ds, data in zip(datasets_meta, datasets_data):
        orig_chunks = source_group[ds["path"]].chunks
        clamped = tuple(min(c, s) for c, s in zip(orig_chunks, data.shape))
        storage_options.append({"chunks": clamped})

    # Preserve coordinate transformations from original metadata
    coordinate_transformations = [
        ds.get("coordinateTransformations") for ds in datasets_meta
    ]

    write_multiscale(
        pyramid=datasets_data,
        group=out_group,
        axes=axes_meta,
        coordinate_transformations=coordinate_transformations,
        storage_options=storage_options,
    )
    print(f"Wrote cropped OME-NGFF v0.5 zarr: {out_path}")


def make_plain_tiff_array(
    data: np.ndarray,
    ax_names: list[str],
) -> tuple[np.ndarray, str]:
    """Reduce an ND array to a 2-D (YX) or 3-D (YXC) array for a plain TIFF.

    Rules:
    - T and Z axes are reduced to index 0.
    - C == 3: keep all three channels, reorder to YXC → photometric "rgb".
    - C == 1: squeeze the C dim → grayscale "minisblack".
    - C == 0 (no C axis): already grayscale.
    - C > 3 or C == 2: take the first channel only → grayscale "minisblack".

    Returns (array, photometric).
    """
    arr = data
    remaining = list(ax_names)

    # Squeeze T and Z to index 0
    for ax in ("t", "z"):
        if ax in remaining:
            idx = remaining.index(ax)
            arr = arr.take(0, axis=idx)
            remaining.pop(remaining.index(ax))

    c_idx = remaining.index("c") if "c" in remaining else None

    if c_idx is None:
        # Already grayscale YX
        return arr, "minisblack"

    n_channels = arr.shape[c_idx]

    if n_channels == 3:
        # Reorder to YXC (move C to last)
        arr = np.moveaxis(arr, c_idx, -1)
        return arr, "rgb"
    elif n_channels == 1:
        arr = arr.squeeze(axis=c_idx)
        return arr, "minisblack"
    else:
        # 2 channels, or > 3 channels: take channel 0 → grayscale
        arr = arr.take(0, axis=c_idx)
        return arr, "minisblack"


def write_plain_tiff(
    data: np.ndarray,
    ax_names: list[str],
    output_path: Path,
    tile_opts: dict,
) -> None:
    """Write a plain (non-OME) TIFF: grayscale (YX) or RGB (YXC)."""
    arr, photometric = make_plain_tiff_array(data, ax_names)
    print(f"Writing plain TIFF (photometric={photometric}, shape={arr.shape}) …")
    with TiffWriter(str(output_path), ome=False) as tif:
        tif.write(
            arr,
            photometric=photometric,
            compression="zlib",
            **tile_opts,
        )
    print(f"Wrote plain TIFF: {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert v0.5 OME-NGFF zarr (zarr v3) to OME-TIFF"
    )
    parser.add_argument("input", help="Path to input v0.5 OME-NGFF zarr store")
    parser.add_argument(
        "--output",
        help="Output OME-TIFF path (default: input name with .ome.tif extension)",
    )
    parser.add_argument(
        "--crop-size",
        type=int,
        default=DEFAULT_CROP,
        metavar="PIXELS",
        help=f"Max pixels per Y/X axis before cropping (default: {DEFAULT_CROP})",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()

    if args.output:
        output_path = Path(args.output).resolve()
    else:
        name = input_path.name
        for suffix in (".ome.zarr", ".zarr"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        output_path = input_path.parent / f"{name}.ome.tif"

    print(f"Input:     {input_path}")
    print(f"Output:    {output_path}")
    print(f"Crop size: {args.crop_size}")

    # ------------------------------------------------------------------
    # Open zarr v3 store
    # ------------------------------------------------------------------
    group = zarr.open_group(str(input_path), mode="r", zarr_format=3)
    attrs = dict(group.attrs)

    # v0.5 wraps OME metadata under the "ome" key
    ome_attrs: dict = attrs.get("ome", attrs)
    multiscales = ome_attrs["multiscales"][0]
    axes_meta: list[dict] = multiscales["axes"]
    axes = [ax["name"] for ax in axes_meta]
    datasets: list[dict] = multiscales["datasets"]

    y_idx = get_axis_index(axes, "y")
    x_idx = get_axis_index(axes, "x")
    if y_idx is None or x_idx is None:
        raise ValueError(f"Could not find 'y' and 'x' axes in: {axes}")

    # Filter to only scale levels that are present in the store
    datasets = [ds for ds in datasets if ds["path"] in group]
    if not datasets:
        raise RuntimeError("No scale levels found in the zarr store.")

    print(f"Axes: {axes}")
    print(f"Scale levels available: {len(datasets)}")

    # ------------------------------------------------------------------
    # Determine crop from level-0 shape
    # ------------------------------------------------------------------
    level0_shape = group[datasets[0]["path"]].shape
    print(f"Level 0 shape: {level0_shape}")

    needs_crop = (
        level0_shape[y_idx] > args.crop_size
        or level0_shape[x_idx] > args.crop_size
    )

    # ------------------------------------------------------------------
    # Read (and crop) each resolution level
    # ------------------------------------------------------------------
    all_data: list[np.ndarray] = []
    for i, ds in enumerate(datasets):
        path = ds["path"]
        arr = group[path]
        level_shape = arr.shape

        if needs_crop:
            scale_y = level0_shape[y_idx] / level_shape[y_idx]
            scale_x = level0_shape[x_idx] / level_shape[x_idx]
            crop_y = min(level_shape[y_idx], max(1, round(args.crop_size / scale_y)))
            crop_x = min(level_shape[x_idx], max(1, round(args.crop_size / scale_x)))
            slices: list = [slice(None)] * len(level_shape)
            slices[y_idx] = slice(0, crop_y)
            slices[x_idx] = slice(0, crop_x)
            data = arr[tuple(slices)]
        else:
            data = arr[:]

        print(f"  Level {i} ({path}): {level_shape} → {data.shape}")
        all_data.append(data)

    # ------------------------------------------------------------------
    # Build OME-TIFF metadata
    # ------------------------------------------------------------------
    axes_str = axes_to_str(axes)
    channel_names = get_channel_names(attrs)
    phys_sizes = get_physical_sizes(multiscales, axes)

    tiff_meta: dict = {"axes": axes_str}
    if channel_names:
        tiff_meta["Channel"] = {"Name": channel_names}
    if "x" in phys_sizes:
        tiff_meta["PhysicalSizeX"] = phys_sizes["x"]
        tiff_meta["PhysicalSizeXUnit"] = "µm"
    if "y" in phys_sizes:
        tiff_meta["PhysicalSizeY"] = phys_sizes["y"]
        tiff_meta["PhysicalSizeYUnit"] = "µm"

    full_res = all_data[0]
    use_tile = (
        full_res.shape[y_idx] > TILE_SIZE or full_res.shape[x_idx] > TILE_SIZE
    )
    tile_opts: dict = {"tile": (TILE_SIZE, TILE_SIZE)} if use_tile else {}

    # ------------------------------------------------------------------
    # Write OME-TIFF (pyramidal, zlib-compressed)
    # ------------------------------------------------------------------
    print(f"\nWriting OME-TIFF (tiled={use_tile}, levels={len(all_data)}) …")
    with TiffWriter(str(output_path), ome=True, bigtiff=True) as tif:
        for i, data in enumerate(all_data):
            if i == 0:
                tif.write(
                    data,
                    photometric="minisblack",
                    compression="zlib",
                    subifds=len(all_data) - 1,
                    metadata=tiff_meta,
                    **tile_opts,
                )
            else:
                tif.write(
                    data,
                    photometric="minisblack",
                    compression="zlib",
                    subfiletype=1,
                    **tile_opts,
                )
    print(f"Wrote OME-TIFF: {output_path}")

    # ------------------------------------------------------------------
    # Write plain TIFF (grayscale or RGB, no OME metadata)
    # ------------------------------------------------------------------
    plain_stem = output_path.stem
    if plain_stem.endswith(".ome"):
        plain_stem = plain_stem[: -len(".ome")]
    plain_tif_path = output_path.parent / f"{plain_stem}.plain.tif"
    write_plain_tiff(all_data[0], axes, plain_tif_path, tile_opts)

    # ------------------------------------------------------------------
    # Write cropped OME-NGFF zarr (only when cropping occurred)
    # ------------------------------------------------------------------
    cropped_zarr_path: Path | None = None
    if needs_crop:
        stem = output_path.stem
        if stem.endswith(".ome"):
            stem = stem[: -len(".ome")]
        cropped_zarr_path = output_path.parent / f"{stem}.cropped.ome.zarr"
        # Keep only dataset entries that were retained
        cropped_datasets = datasets[: len(all_data)]
        write_cropped_zarr_v5(
            cropped_zarr_path, axes_meta, cropped_datasets, all_data, group
        )

    # ------------------------------------------------------------------
    # Consolidate zarr metadata on the reference store
    # ------------------------------------------------------------------
    zarr_ref_path = cropped_zarr_path if cropped_zarr_path is not None else input_path
    print(f"\nConsolidating zarr metadata: {zarr_ref_path} …")
    zarr.consolidate_metadata(str(zarr_ref_path))
    print("Consolidated metadata written.")


if __name__ == "__main__":
    main()

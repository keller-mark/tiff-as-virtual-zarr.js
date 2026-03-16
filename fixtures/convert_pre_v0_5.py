# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "zarr>=2.11,<3.0",
#     "ome-zarr==0.10.2",
#     "tifffile>=2026.1.28",
# ]
# ///
"""
Convert a pre-v0.5 OME-NGFF zarr store (zarr v2 format, OME-NGFF v0.3 or v0.4)
to OME-TIFF.

If the image exceeds --crop-size pixels in Y or X, it is cropped from the
top-left corner.  When cropping occurs, a matching cropped OME-NGFF zarr (v2)
is also written so that the TIFF and zarr fixtures are equivalent.

Usage:
    uv run convert_pre_v0_5.py <input.zarr> [--output <out.ome.tif>] [--crop-size 512]

Download sample pre-v0.5 images first (from fixtures/README.md):
    uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk \\
        --no-sign-request s3://idr/zarr/v0.4/idr0101A/13457227.zarr 13457227.v0_4.zarr
    uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk \\
        --no-sign-request s3://idr/zarr/v0.3/9836842.zarr 9836842.v0_3.zarr
"""
import argparse
import numpy as np
from pathlib import Path

import zarr
from ome_zarr.writer import write_multiscale
from tifffile import TiffWriter

DEFAULT_CROP = 512
TILE_SIZE = 256


def get_axis_index(axes: list, name: str) -> int | None:
    """Find an axis by name in a list of axis names or axis dicts."""
    for i, ax in enumerate(axes):
        ax_name = ax["name"] if isinstance(ax, dict) else ax
        if ax_name == name:
            return i
    return None


def axes_to_str(axes: list) -> str:
    """Convert axes (strings or dicts) to an uppercase OME-TIFF axes string."""
    names = [ax["name"] if isinstance(ax, dict) else ax for ax in axes]
    return "".join(n.upper() for n in names)


def get_channel_names(attrs: dict) -> list[str] | None:
    """Extract channel names from omero metadata."""
    omero = attrs.get("omero")
    if omero:
        channels = omero.get("channels", [])
        return [ch.get("label", f"Ch{i}") for i, ch in enumerate(channels)]
    return None


def get_physical_sizes(multiscales: dict, axes: list) -> dict[str, float]:
    """Extract physical pixel sizes from coordinateTransformations (v0.4) or
    legacy top-level scale metadata."""
    sizes: dict[str, float] = {}
    ax_names = [ax["name"] if isinstance(ax, dict) else ax for ax in axes]

    datasets = multiscales.get("datasets", [])
    for t in datasets[0].get("coordinateTransformations", []) if datasets else []:
        if t["type"] == "scale":
            for i, name in enumerate(ax_names):
                if name in ("x", "y", "z"):
                    sizes[name] = t["scale"][i]

    for t in multiscales.get("coordinateTransformations", []):
        if t["type"] == "scale":
            for i, name in enumerate(ax_names):
                if name in ("x", "y", "z") and name not in sizes:
                    sizes[name] = t["scale"][i]
    return sizes


def write_cropped_zarr_v2(
    out_path: Path,
    axes: list,
    datasets_meta: list[dict],
    datasets_data: list[np.ndarray],
    source_group: zarr.Group,
    coordinate_transformations: list | None,
) -> None:
    """Write a cropped OME-NGFF zarr store (zarr v2) using ome-zarr."""
    out_group = zarr.open_group(str(out_path), mode="w")

    storage_options = []
    for ds, data in zip(datasets_meta, datasets_data):
        orig_arr = source_group[ds["path"]]
        orig_chunks = orig_arr.chunks
        clamped = tuple(min(c, s) for c, s in zip(orig_chunks, data.shape))
        storage_options.append({"chunks": clamped})

    write_multiscale(
        pyramid=datasets_data,
        group=out_group,
        axes=axes,
        coordinate_transformations=coordinate_transformations,
        storage_options=storage_options,
    )
    print(f"Wrote cropped OME-NGFF zarr (v2): {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert pre-v0.5 OME-NGFF zarr (zarr v2) to OME-TIFF"
    )
    parser.add_argument("input", help="Path to input OME-NGFF zarr store (v0.3 or v0.4)")
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
    # Open zarr v2 store
    # ------------------------------------------------------------------
    group = zarr.open_group(str(input_path), mode="r")
    attrs = dict(group.attrs)

    # Pre-v0.5 stores multiscales at the top level (no "ome" wrapper)
    multiscales = attrs["multiscales"][0]
    axes = multiscales.get("axes", [])  # absent in v0.3, list of dicts in v0.4

    # In v0.3, axes were not stored; infer from array ndim
    if not axes:
        sample_path = multiscales["datasets"][0]["path"]
        ndim = group[sample_path].ndim
        # Common default axes for OME-NGFF v0.3 (TCZYX order, dropping leading dims)
        default_axes = ["t", "c", "z", "y", "x"]
        axes = default_axes[-ndim:]
        print(f"No axes metadata found (v0.3); inferred: {axes}")

    ax_names = [ax["name"] if isinstance(ax, dict) else ax for ax in axes]
    datasets: list[dict] = multiscales["datasets"]

    y_idx = get_axis_index(axes, "y")
    x_idx = get_axis_index(axes, "x")
    if y_idx is None or x_idx is None:
        raise ValueError(f"Could not find 'y' and 'x' axes in: {ax_names}")

    # Filter to only scale levels that are present on disk
    datasets = [ds for ds in datasets if ds["path"] in group]
    if not datasets:
        raise RuntimeError("No scale levels found in the zarr store.")

    print(f"Axes: {ax_names}")
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
    # Write cropped OME-NGFF zarr (only when cropping occurred)
    # ------------------------------------------------------------------
    if needs_crop:
        stem = output_path.stem
        if stem.endswith(".ome"):
            stem = stem[: -len(".ome")]
        cropped_zarr_path = output_path.parent / f"{stem}.cropped.zarr"

        # Preserve per-dataset coordinateTransformations if present
        coord_transforms = [
            ds.get("coordinateTransformations") for ds in datasets[: len(all_data)]
        ]
        # Pass None if no transforms were present (v0.3)
        if all(t is None for t in coord_transforms):
            coord_transforms = None

        write_cropped_zarr_v2(
            cropped_zarr_path,
            axes,
            datasets[: len(all_data)],
            all_data,
            group,
            coord_transforms,
        )


if __name__ == "__main__":
    main()

# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "numpy>=1.21.2",
#     'zarr>=2.5.0,<3',
#     'numcodecs>=0.5.7,<0.16.0',
#     'ome-zarr<0.10.3',
#     'tifffile>=2020.10.1',
# ]
# ///
"""
Create toy OME-TIFF and OME-Zarr image fixtures for testing.

Usage:
    uv run create_fixtures.py
"""
import numpy as np
import zarr
from ome_zarr.writer import write_image
from tifffile import TiffWriter


def make_toy_image(num_channels=3, height=128, width=128, dtype="uint8"):
    """Create a toy CYX image array with gradient patterns per channel."""
    rng = np.random.default_rng(42)
    img = rng.integers(0, 255, size=(num_channels, height, width), dtype=np.uint8)
    return img.astype(dtype)


def write_ome_tiff(img_arr, channel_names, output_path, axes="CYX"):
    """Write an image array to OME-TIFF."""
    tiff_writer = TiffWriter(output_path, ome=True)
    tiff_writer.write(
        img_arr,
        metadata={
            "axes": axes,
            "Channel": {"Name": channel_names},
        },
    )
    tiff_writer.close()
    print(f"Wrote OME-TIFF: {output_path}")


def write_ome_zarr(img_arr, channel_names, output_path, axes="cyx", chunks=(1, 64, 64)):
    """Write an image array to OME-Zarr."""
    z_root = zarr.open_group(output_path, mode="w")

    default_window = {
        "start": 0,
        "end": int(np.iinfo(img_arr.dtype).max),
        "min": 0,
        "max": int(np.iinfo(img_arr.dtype).max),
    }

    write_image(
        image=img_arr,
        group=z_root,
        axes=axes,
        storage_options=dict(chunks=chunks),
    )

    z_root.attrs["omero"] = {
        "name": "Toy Image",
        "version": "0.3",
        "rdefs": {"model": "greyscale"},
        "channels": [
            {
                "label": name,
                "color": "FFFFFF",
                "window": default_window,
            }
            for name in channel_names
        ],
    }
    print(f"Wrote OME-Zarr: {output_path}")


def main():
    channel_names = ["DAPI", "GFP", "Brightfield"]
    img = make_toy_image(num_channels=len(channel_names))
    print(f"Created toy image: shape={img.shape}, dtype={img.dtype}")

    write_ome_tiff(img, channel_names, "test_image.ome.tif")
    write_ome_zarr(img, channel_names, "test_image.ome.zarr")


if __name__ == "__main__":
    main()

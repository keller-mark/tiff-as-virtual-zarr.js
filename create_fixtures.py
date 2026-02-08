# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "zarr>=3.0.0",
#     'ome-zarr==0.13.0',
#     'tifffile>=2026.1.28',
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
from os.path import join

DATA_DIR = "data"


def make_toy_image(num_channels=3, height=128, width=128, dtype="uint8"):
    """Create a toy CYX image array with geometric calibration patterns.

    Every channel gets:
      - A 1-px border around the full extent of the image.
      - Cross-hairs through the centre.
      - A circle inscribed in the shorter dimension (becomes an ellipse if
        the aspect ratio is wrong).
      - Grid lines every 1/4 of each dimension.

    Each channel also receives a unique background fill so channels remain
    visually distinguishable.
    """
    max_val = np.iinfo(dtype).max
    img = np.zeros((num_channels, height, width), dtype=dtype)

    # Pixel coordinate grids
    ys = np.arange(height)
    xs = np.arange(width)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")

    # --- shared calibration overlay (boolean mask) ---
    line_w = max(1, min(height, width) // 128)  # thin but visible

    # 1-px border
    border = (
        (yy < line_w) | (yy >= height - line_w) |
        (xx < line_w) | (xx >= width - line_w)
    )

    # Cross-hairs through the centre
    cy, cx = height // 2, width // 2
    crosshair = (
        (np.abs(yy - cy) < line_w) |
        (np.abs(xx - cx) < line_w)
    )

    # Grid lines at every 1/4 of each dimension
    grid = np.zeros_like(border)
    for frac in (0.25, 0.5, 0.75):
        grid |= np.abs(yy - int(frac * height)) < line_w
        grid |= np.abs(xx - int(frac * width)) < line_w

    # Circle inscribed in the shorter dimension
    radius = min(height, width) / 2 - 2 * line_w
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    circle = np.abs(dist - radius) < line_w

    overlay = border | crosshair | grid | circle

    # --- per-channel background fills (normalised to [0, 1]) ---
    xn = xx / max(width - 1, 1)   # [0, 1]
    yn = yy / max(height - 1, 1)  # [0, 1]

    backgrounds = [
        xn,                         # horizontal gradient
        yn,                         # vertical gradient
        (xn + yn) / 2,             # diagonal gradient
        1 - np.sqrt((xn - 0.5) ** 2 + (yn - 0.5) ** 2) / np.sqrt(0.5),
        (((xn * 8).astype(int) ^ (yn * 8).astype(int)) & 1).astype(float),
    ]

    fg = 1.0   # overlay drawn at full brightness
    bg_scale = 0.35  # dim the background so the overlay stands out

    for c in range(num_channels):
        bg = np.clip(backgrounds[c % len(backgrounds)], 0, 1) * bg_scale
        combined = np.where(overlay, fg, bg)
        img[c] = (combined * max_val).astype(dtype)

    return img


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

    write_ome_tiff(img, channel_names, join(DATA_DIR, "test_image.ome.tif"))
    write_ome_zarr(img, channel_names, join(DATA_DIR, "test_image.ome.zarr"))


if __name__ == "__main__":
    main()

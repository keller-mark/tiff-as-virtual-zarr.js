from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from logging import getLogger
from typing import TYPE_CHECKING, Any

import numpy as np
import tifffile
from zarr.abc.store import ByteRequest, Store
from zarr.core.buffer import Buffer
from zarr.core.buffer.core import default_buffer_prototype
from zarr.core.common import concurrent_map
from zarr.storage._utils import _normalize_byte_range_index

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterable

    from zarr.core.buffer import BufferPrototype


logger = getLogger(__name__)

# OME-XML namespace
_OME_NS = {"ome": "http://www.openmicroscopy.org/Schemas/OME/2016-06"}

# Map OME pixel types to numpy dtype strings
_OME_DTYPE_MAP = {
    "uint8": "uint8",
    "uint16": "uint16",
    "uint32": "uint32",
    "int8": "int8",
    "int16": "int16",
    "int32": "int32",
    "float": "float32",
    "double": "float64",
}

# Map TIFF compression codes to Zarr v3 codec configurations
_TIFF_COMPRESSION_TO_ZARR_CODEC: dict[int, list[dict]] = {
    1: [{"name": "bytes"}],  # no compression
    8: [{"name": "bytes"}, {"name": "zlib", "configuration": {"level": 6}}],  # DEFLATE
    32946: [{"name": "bytes"}, {"name": "zlib", "configuration": {"level": 6}}],  # DEFLATE alt
    50000: [{"name": "bytes"}, {"name": "zstd", "configuration": {"level": 1, "checksum": False}}],  # ZSTD
}


def _parse_ome_xml(xml_str: str) -> dict:
    """Parse OME-XML metadata into a structured dict.

    Returns a dict with keys: axes, shape, dtype, channels, dimension_order.
    """
    root = ET.fromstring(xml_str)
    pixels = root.find(".//ome:Pixels", _OME_NS)
    if pixels is None:
        raise ValueError("No Pixels element found in OME-XML")

    attrs = pixels.attrib
    size_c = int(attrs.get("SizeC", "1"))
    size_z = int(attrs.get("SizeZ", "1"))
    size_t = int(attrs.get("SizeT", "1"))
    size_y = int(attrs["SizeY"])
    size_x = int(attrs["SizeX"])
    dtype = _OME_DTYPE_MAP.get(attrs["Type"], attrs["Type"])
    dimension_order = attrs.get("DimensionOrder", "XYCZT")

    channels = []
    for ch_elem in root.findall(".//ome:Channel", _OME_NS):
        channels.append({
            "name": ch_elem.attrib.get("Name", ""),
            "samples_per_pixel": int(ch_elem.attrib.get("SamplesPerPixel", "1")),
        })

    # Build axes and shape from dimension order (only include dims with size > 1, except Y and X)
    # Standard OME dimension order is given as e.g. "XYCZT" meaning
    # the storage order from fastest to slowest varying is X, Y, C, Z, T
    # In numpy/zarr, dimensions are ordered from slowest to fastest: T, Z, C, Y, X
    dim_sizes = {"T": size_t, "Z": size_z, "C": size_c, "Y": size_y, "X": size_x}
    dim_types = {"T": "time", "Z": "space", "C": "channel", "Y": "space", "X": "space"}

    # Reversed dimension order gives slowest-to-fastest (numpy convention)
    ordered_dims = list(reversed(dimension_order))

    axes = []
    shape = []
    for dim in ordered_dims:
        size = dim_sizes[dim]
        if size > 1 or dim in ("Y", "X"):
            axes.append({"name": dim.lower(), "type": dim_types[dim]})
            shape.append(size)

    return {
        "axes": axes,
        "shape": shape,
        "dtype": dtype,
        "channels": channels,
        "dimension_order": dimension_order,
        "size_c": size_c,
        "size_z": size_z,
        "size_t": size_t,
        "size_y": size_y,
        "size_x": size_x,
    }


class TiffAsZarrStore(Store):
    """A read-only Zarr v3 store that virtualizes an OME-TIFF file.

    Presents the OME-TIFF as an OME-Zarr (NGFF v0.5) store without copying
    or re-encoding the pixel data. TIFF tiles/strips are served directly as
    Zarr chunks.

    Parameters
    ----------
    tiff_path : str
        Path to the OME-TIFF file.
    chunk_shape : tuple of int, optional
        The (Y, X) chunk shape to use for the Zarr arrays. If not provided,
        uses the TIFF tile size (for tiled TIFFs) or the full image extent
        (for stripped TIFFs).
    """

    supports_writes: bool = False
    supports_deletes: bool = False
    supports_listing: bool = True

    _tiff_path: str
    _tiff: tifffile.TiffFile
    _store_dict: dict[str, bytes]
    _chunk_map: dict[str, tuple[int, int]]  # key -> (file_offset, byte_count)

    def __init__(
        self,
        tiff_path: str,
        *,
        chunk_shape: tuple[int, ...] | None = None,
    ) -> None:
        super().__init__(read_only=True)
        self._tiff_path = tiff_path
        self._tiff = tifffile.TiffFile(tiff_path)
        self._store_dict = {}
        self._chunk_map = {}
        self._init_store(chunk_shape=chunk_shape)

    def _init_store(self, *, chunk_shape: tuple[int, ...] | None = None) -> None:
        """Build the virtual store mapping from the OME-TIFF structure."""
        tif = self._tiff

        if not tif.is_ome:
            raise ValueError(f"Not an OME-TIFF file: {self._tiff_path}")

        ome_info = _parse_ome_xml(tif.ome_metadata)
        series = tif.series[0]
        keyframe = tif.pages[0]

        dtype = np.dtype(ome_info["dtype"])

        # Determine chunk shape
        if chunk_shape is not None:
            chunk_y, chunk_x = chunk_shape[-2], chunk_shape[-1]
        elif keyframe.is_tiled:
            chunk_y = keyframe.tilelength
            chunk_x = keyframe.tilewidth
        else:
            # For stripped TIFFs, each page is one chunk
            chunk_y = ome_info["size_y"]
            chunk_x = ome_info["size_x"]

        # Build the full chunk shape to match the axes
        # For each axis, one chunk covers the full extent except Y and X
        full_chunk_shape = []
        for ax in ome_info["axes"]:
            if ax["name"] == "y":
                full_chunk_shape.append(chunk_y)
            elif ax["name"] == "x":
                full_chunk_shape.append(chunk_x)
            else:
                full_chunk_shape.append(1)

        # Determine codecs from TIFF compression
        compression_value = keyframe.compression.value if hasattr(keyframe.compression, 'value') else int(keyframe.compression)
        codecs = _TIFF_COMPRESSION_TO_ZARR_CODEC.get(compression_value)
        if codecs is None:
            raise ValueError(
                f"Unsupported TIFF compression: {keyframe.compression} (value={compression_value})"
            )

        # Build array metadata (zarr.json for the array at path "0")
        array_metadata = {
            "zarr_format": 3,
            "node_type": "array",
            "shape": ome_info["shape"],
            "data_type": dtype.name,
            "chunk_grid": {
                "name": "regular",
                "configuration": {
                    "chunk_shape": full_chunk_shape,
                },
            },
            "chunk_key_encoding": {
                "name": "default",
                "configuration": {"separator": "/"},
            },
            "fill_value": 0,
            "codecs": codecs,
            "attributes": {},
            "dimension_names": [ax["name"] for ax in ome_info["axes"]],
        }

        # Build root group metadata with OME multiscales
        channel_meta = []
        for ch in ome_info["channels"]:
            channel_meta.append({
                "label": ch["name"],
                "color": "FFFFFF",
                "window": {
                    "start": 0,
                    "end": int(np.iinfo(dtype).max) if np.issubdtype(dtype, np.integer) else 1,
                    "min": 0,
                    "max": int(np.iinfo(dtype).max) if np.issubdtype(dtype, np.integer) else 1,
                },
            })

        scale_transform = [1.0] * len(ome_info["axes"])

        root_metadata = {
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [
                        {
                            "datasets": [
                                {
                                    "path": "0",
                                    "coordinateTransformations": [
                                        {"type": "scale", "scale": scale_transform},
                                    ],
                                },
                            ],
                            "name": "/",
                            "axes": ome_info["axes"],
                        },
                    ],
                },
                "omero": {
                    "name": "OME-TIFF",
                    "version": "0.3",
                    "rdefs": {"model": "greyscale"},
                    "channels": channel_meta,
                },
            },
        }

        # Store metadata as JSON bytes
        self._store_dict["zarr.json"] = json.dumps(root_metadata).encode("utf-8")
        self._store_dict["0/zarr.json"] = json.dumps(array_metadata).encode("utf-8")

        # Build chunk-to-file-offset mapping
        self._build_chunk_map(ome_info, chunk_y, chunk_x)

    def _build_chunk_map(
        self,
        ome_info: dict,
        chunk_y: int,
        chunk_x: int,
    ) -> None:
        """Map Zarr chunk keys to byte ranges in the TIFF file."""
        tif = self._tiff
        axes = ome_info["axes"]
        size_y = ome_info["size_y"]
        size_x = ome_info["size_x"]

        tiles_y = math.ceil(size_y / chunk_y)
        tiles_x = math.ceil(size_x / chunk_x)

        keyframe = tif.pages[0]

        # Determine how pages are ordered in the TIFF.
        # In OME-TIFF, pages correspond to planes. The ordering depends on
        # DimensionOrder. For CYX data (the common case), each page is one
        # channel plane.
        #
        # We iterate pages in order and compute chunk coordinates for each.
        for page_idx in range(len(tif.pages)):
            page = tif.pages[page_idx]

            # Compute the non-spatial coordinate of this page.
            # For CYX: page_idx = channel_idx
            # For more complex dimension orders, we'd need to decode
            # the page's position from TiffData elements, but for the
            # common single-series case, pages are ordered per the
            # dimension order.
            #
            # Build the leading (non-Y/X) chunk coordinates from page index.
            non_spatial_dims = [ax for ax in axes if ax["name"] not in ("y", "x")]
            non_spatial_sizes = []
            for ax in non_spatial_dims:
                name = ax["name"]
                if name == "c":
                    non_spatial_sizes.append(ome_info["size_c"])
                elif name == "z":
                    non_spatial_sizes.append(ome_info["size_z"])
                elif name == "t":
                    non_spatial_sizes.append(ome_info["size_t"])

            # Compute multi-dimensional index for non-spatial dims
            # Pages are ordered fastest-varying last per the reversed dimension order
            non_spatial_coords = []
            remaining = page_idx
            for size in reversed(non_spatial_sizes):
                non_spatial_coords.insert(0, remaining % size)
                remaining //= size

            if keyframe.is_tiled:
                # Tiled TIFF: each page has multiple tiles
                offsets = page.dataoffsets
                bytecounts = page.databytecounts

                tile_idx = 0
                for ty in range(tiles_y):
                    for tx in range(tiles_x):
                        # Build the full chunk coordinate
                        chunk_coords = list(non_spatial_coords) + [ty, tx]
                        key = "0/c/" + "/".join(str(c) for c in chunk_coords)
                        self._chunk_map[key] = (offsets[tile_idx], bytecounts[tile_idx])
                        tile_idx += 1
            else:
                # Stripped TIFF: each page is one chunk (when chunk == full image)
                if len(page.dataoffsets) == 1:
                    # Single strip covers the whole page
                    chunk_coords = list(non_spatial_coords) + [0, 0]
                    key = "0/c/" + "/".join(str(c) for c in chunk_coords)
                    self._chunk_map[key] = (page.dataoffsets[0], page.databytecounts[0])
                else:
                    # Multiple strips: we need to concatenate them.
                    # Store as a list of (offset, bytecount) pairs.
                    # We'll handle this in get() by reading and concatenating.
                    chunk_coords = list(non_spatial_coords) + [0, 0]
                    key = "0/c/" + "/".join(str(c) for c in chunk_coords)
                    # For multi-strip, store a sentinel and handle in get()
                    total_bytes = sum(page.databytecounts)
                    # Store first offset and total size - we'll read contiguously
                    # (strips are typically contiguous in OME-TIFF)
                    self._chunk_map[key] = (page.dataoffsets[0], total_bytes)

    def _read_bytes_from_tiff(self, offset: int, length: int) -> bytes:
        """Read raw bytes from the TIFF file at the given offset."""
        fh = self._tiff.filehandle
        fh.seek(offset)
        return fh.read(length)

    async def get(
        self,
        key: str,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Buffer | None:
        if prototype is None:
            prototype = default_buffer_prototype()
        if not self._is_open:
            await self._open()
        assert isinstance(key, str)

        # Check metadata keys first
        if key in self._store_dict:
            value = prototype.buffer.from_bytes(self._store_dict[key])
            if byte_range is not None:
                start, stop = _normalize_byte_range_index(value, byte_range)
                return prototype.buffer.from_buffer(value[start:stop])
            return value

        # Check chunk keys
        if key in self._chunk_map:
            offset, length = self._chunk_map[key]
            raw_bytes = self._read_bytes_from_tiff(offset, length)
            value = prototype.buffer.from_bytes(raw_bytes)
            if byte_range is not None:
                start, stop = _normalize_byte_range_index(value, byte_range)
                return prototype.buffer.from_buffer(value[start:stop])
            return value

        return None

    async def get_partial_values(
        self,
        prototype: BufferPrototype,
        key_ranges: Iterable[tuple[str, ByteRequest | None]],
    ) -> list[Buffer | None]:
        async def _get(key: str, byte_range: ByteRequest | None) -> Buffer | None:
            return await self.get(key, prototype=prototype, byte_range=byte_range)

        return await concurrent_map(key_ranges, _get, limit=None)

    async def exists(self, key: str) -> bool:
        return key in self._store_dict or key in self._chunk_map

    async def set(self, key: str, value: Buffer) -> None:
        raise NotImplementedError("TiffAsZarrStore is read-only")

    async def delete(self, key: str) -> None:
        raise NotImplementedError("TiffAsZarrStore is read-only")

    async def clear(self) -> None:
        raise NotImplementedError("TiffAsZarrStore is read-only")

    def __eq__(self, value: object) -> bool:
        if not isinstance(value, TiffAsZarrStore):
            return False
        return self._tiff_path == value._tiff_path

    async def list(self) -> AsyncIterator[str]:
        for key in self._store_dict:
            yield key
        for key in self._chunk_map:
            yield key

    async def list_prefix(self, prefix: str) -> AsyncIterator[str]:
        for key in self._store_dict:
            if key.startswith(prefix):
                yield key
        for key in self._chunk_map:
            if key.startswith(prefix):
                yield key

    async def list_dir(self, prefix: str) -> AsyncIterator[str]:
        prefix = prefix.rstrip("/")
        all_keys = list(self._store_dict.keys()) + list(self._chunk_map.keys())
        if prefix == "":
            keys_unique = {k.split("/")[0] for k in all_keys}
        else:
            keys_unique = {
                key.removeprefix(prefix + "/").split("/")[0]
                for key in all_keys
                if key.startswith(prefix + "/") and key != prefix
            }
        for key in keys_unique:
            yield key

    def close(self) -> None:
        """Close the underlying TIFF file."""
        if hasattr(self, '_tiff') and self._tiff is not None:
            self._tiff.close()

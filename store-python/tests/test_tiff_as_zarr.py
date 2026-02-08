"""Tests for TiffAsZarrStore, verifying equivalence with fixture OME-Zarr."""

import json
from pathlib import Path

import numpy as np
import pytest
import zarr

from src.tiff_as_zarr_store import TiffAsZarrStore

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
TIFF_PATH = DATA_DIR / "test_image.ome.tif"
ZARR_PATH = DATA_DIR / "test_image.ome.zarr"


@pytest.fixture
def store():
    s = TiffAsZarrStore(str(TIFF_PATH))
    yield s
    s.close()


class TestStoreMetadata:
    """Test that the store produces correct Zarr v3 metadata."""

    @pytest.mark.asyncio
    async def test_root_zarr_json_exists(self, store):
        assert await store.exists("zarr.json")

    @pytest.mark.asyncio
    async def test_root_zarr_json_is_group(self, store):
        buf = await store.get("zarr.json")
        meta = json.loads(buf.to_bytes())
        assert meta["zarr_format"] == 3
        assert meta["node_type"] == "group"

    @pytest.mark.asyncio
    async def test_root_has_ome_multiscales(self, store):
        buf = await store.get("zarr.json")
        meta = json.loads(buf.to_bytes())
        assert "ome" in meta["attributes"]
        ome = meta["attributes"]["ome"]
        assert "multiscales" in ome
        assert len(ome["multiscales"]) >= 1

    @pytest.mark.asyncio
    async def test_multiscale_axes(self, store):
        buf = await store.get("zarr.json")
        meta = json.loads(buf.to_bytes())
        axes = meta["attributes"]["ome"]["multiscales"][0]["axes"]
        axis_names = [a["name"] for a in axes]
        # The fixture has CYX axes
        assert "c" in axis_names
        assert "y" in axis_names
        assert "x" in axis_names

    @pytest.mark.asyncio
    async def test_multiscale_datasets(self, store):
        buf = await store.get("zarr.json")
        meta = json.loads(buf.to_bytes())
        datasets = meta["attributes"]["ome"]["multiscales"][0]["datasets"]
        assert len(datasets) >= 1
        assert datasets[0]["path"] == "0"

    @pytest.mark.asyncio
    async def test_omero_channels(self, store):
        buf = await store.get("zarr.json")
        meta = json.loads(buf.to_bytes())
        assert "omero" in meta["attributes"]
        channels = meta["attributes"]["omero"]["channels"]
        assert len(channels) == 3
        labels = [ch["label"] for ch in channels]
        assert "DAPI" in labels
        assert "GFP" in labels
        assert "Brightfield" in labels

    @pytest.mark.asyncio
    async def test_array_zarr_json_exists(self, store):
        assert await store.exists("0/zarr.json")

    @pytest.mark.asyncio
    async def test_array_metadata(self, store):
        buf = await store.get("0/zarr.json")
        meta = json.loads(buf.to_bytes())
        assert meta["zarr_format"] == 3
        assert meta["node_type"] == "array"
        assert meta["data_type"] == "uint8"
        # Shape should be (3, 128, 128) for 3 channels, 128x128 image
        assert meta["shape"] == [3, 128, 128]

    @pytest.mark.asyncio
    async def test_array_chunk_shape(self, store):
        buf = await store.get("0/zarr.json")
        meta = json.loads(buf.to_bytes())
        chunk_shape = meta["chunk_grid"]["configuration"]["chunk_shape"]
        # Channel dim should be 1 (one channel per chunk)
        assert chunk_shape[0] == 1
        # Spatial dims should be the full image extent for non-tiled TIFF
        assert chunk_shape[1] == 128
        assert chunk_shape[2] == 128

    @pytest.mark.asyncio
    async def test_array_chunk_key_encoding(self, store):
        buf = await store.get("0/zarr.json")
        meta = json.loads(buf.to_bytes())
        encoding = meta["chunk_key_encoding"]
        assert encoding["name"] == "default"
        assert encoding["configuration"]["separator"] == "/"

    @pytest.mark.asyncio
    async def test_array_dimension_names(self, store):
        buf = await store.get("0/zarr.json")
        meta = json.loads(buf.to_bytes())
        assert meta["dimension_names"] == ["c", "y", "x"]


class TestStoreChunks:
    """Test that chunk data is correctly served from the TIFF file."""

    @pytest.mark.asyncio
    async def test_chunk_keys_exist(self, store):
        # For 3 channels, 1 spatial chunk each -> 3 chunks
        assert await store.exists("0/c/0/0/0")
        assert await store.exists("0/c/1/0/0")
        assert await store.exists("0/c/2/0/0")

    @pytest.mark.asyncio
    async def test_missing_chunk_returns_none(self, store):
        result = await store.get("0/c/99/0/0")
        assert result is None

    @pytest.mark.asyncio
    async def test_chunk_data_size(self, store):
        buf = await store.get("0/c/0/0/0")
        # 128 * 128 * 1 byte (uint8, uncompressed)
        assert len(buf.to_bytes()) == 128 * 128

    @pytest.mark.asyncio
    async def test_chunk_data_matches_tiff(self, store):
        """Verify chunk bytes match what tifffile reads directly."""
        import tifffile as tf

        with tf.TiffFile(str(TIFF_PATH)) as tif:
            expected = tif.asarray()

        for c in range(3):
            buf = await store.get(f"0/c/{c}/0/0")
            chunk_arr = np.frombuffer(buf.to_bytes(), dtype=np.uint8).reshape(128, 128)
            np.testing.assert_array_equal(chunk_arr, expected[c])


class TestStoreWithZarr:
    """Test that zarr can open and read data through the store."""

    def test_open_as_group(self, store):
        root = zarr.open_group(store=store, mode="r")
        assert root is not None

    def test_array_shape(self, store):
        root = zarr.open_group(store=store, mode="r")
        arr = root["0"]
        assert arr.shape == (3, 128, 128)

    def test_array_dtype(self, store):
        root = zarr.open_group(store=store, mode="r")
        arr = root["0"]
        assert arr.dtype == np.dtype("uint8")

    def test_read_pixel_data(self, store):
        """Read pixels through zarr and compare with direct tifffile read."""
        import tifffile as tf

        with tf.TiffFile(str(TIFF_PATH)) as tif:
            expected = tif.asarray()

        root = zarr.open_group(store=store, mode="r")
        arr = root["0"]
        actual = arr[:]
        np.testing.assert_array_equal(actual, expected)

    def test_read_single_channel(self, store):
        """Read a single channel slice."""
        import tifffile as tf

        with tf.TiffFile(str(TIFF_PATH)) as tif:
            expected = tif.asarray()

        root = zarr.open_group(store=store, mode="r")
        arr = root["0"]
        for c in range(3):
            np.testing.assert_array_equal(arr[c], expected[c])

    def test_read_spatial_slice(self, store):
        """Read a spatial sub-region."""
        import tifffile as tf

        with tf.TiffFile(str(TIFF_PATH)) as tif:
            expected = tif.asarray()

        root = zarr.open_group(store=store, mode="r")
        arr = root["0"]
        np.testing.assert_array_equal(arr[0, 10:20, 30:40], expected[0, 10:20, 30:40])


class TestStoreListing:
    """Test store listing capabilities."""

    @pytest.mark.asyncio
    async def test_list_all_keys(self, store):
        keys = set()
        async for key in store.list():
            keys.add(key)
        assert "zarr.json" in keys
        assert "0/zarr.json" in keys
        assert "0/c/0/0/0" in keys
        assert "0/c/1/0/0" in keys
        assert "0/c/2/0/0" in keys

    @pytest.mark.asyncio
    async def test_list_prefix(self, store):
        keys = set()
        async for key in store.list_prefix("0/c/"):
            keys.add(key)
        assert "0/c/0/0/0" in keys
        assert "0/c/1/0/0" in keys
        assert "0/c/2/0/0" in keys
        assert "zarr.json" not in keys

    @pytest.mark.asyncio
    async def test_list_dir_root(self, store):
        entries = set()
        async for entry in store.list_dir(""):
            entries.add(entry)
        assert "zarr.json" in entries
        assert "0" in entries


class TestStoreReadOnly:
    """Test that write operations raise errors."""

    @pytest.mark.asyncio
    async def test_set_raises(self, store):
        from zarr.core.buffer.core import default_buffer_prototype
        buf = default_buffer_prototype().buffer.from_bytes(b"data")
        with pytest.raises(NotImplementedError):
            await store.set("key", buf)

    @pytest.mark.asyncio
    async def test_delete_raises(self, store):
        with pytest.raises(NotImplementedError):
            await store.delete("key")

    @pytest.mark.asyncio
    async def test_clear_raises(self, store):
        with pytest.raises(NotImplementedError):
            await store.clear()


class TestStoreEquality:
    def test_same_path_equal(self):
        s1 = TiffAsZarrStore(str(TIFF_PATH))
        s2 = TiffAsZarrStore(str(TIFF_PATH))
        assert s1 == s2
        s1.close()
        s2.close()

    def test_different_type_not_equal(self, store):
        assert store != "not a store"

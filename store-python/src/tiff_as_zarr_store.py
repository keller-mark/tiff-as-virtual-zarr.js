from __future__ import annotations

from logging import getLogger
from typing import TYPE_CHECKING, Any

from zarr.abc.store import ByteRequest, Store
from zarr.core.buffer import Buffer
from zarr.core.buffer.core import default_buffer_prototype
from zarr.core.common import concurrent_map
from zarr.storage._utils import _normalize_byte_range_index

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterable, MutableMapping

    from zarr.core.buffer import BufferPrototype


logger = getLogger(__name__)


# TODO: implement the virtual OME-TIFF to OME-Zarr logic. currently this is just a copy of MemoryStore.
class TiffAsZarrStore(Store):
    """
    Store for local memory.

    Parameters
    ----------
    store_dict : dict
        Initial data
    read_only : bool
        Whether the store is read-only

    Attributes
    ----------
    supports_writes
    supports_deletes
    supports_listing
    """

    supports_writes: bool = False
    supports_deletes: bool = False
    supports_listing: bool = False

    _store_dict: MutableMapping[str, Buffer]

    def __init__(
        self,
        store_dict: MutableMapping[str, Buffer] | None = None,
        *,
        read_only: bool = False,
    ) -> None:
        super().__init__(read_only=read_only)
        if store_dict is None:
            store_dict = {}
        self._store_dict = store_dict

    async def clear(self) -> None:
        # docstring inherited
        self._store_dict.clear()


    async def get(
        self,
        key: str,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Buffer | None:
        # docstring inherited
        if prototype is None:
            prototype = default_buffer_prototype()
        if not self._is_open:
            await self._open()
        assert isinstance(key, str)
        try:
            value = self._store_dict[key]
            start, stop = _normalize_byte_range_index(value, byte_range)
            return prototype.buffer.from_buffer(value[start:stop])
        except KeyError:
            return None

    async def get_partial_values(
        self,
        prototype: BufferPrototype,
        key_ranges: Iterable[tuple[str, ByteRequest | None]],
    ) -> list[Buffer | None]:
        # docstring inherited

        # All the key-ranges arguments goes with the same prototype
        async def _get(key: str, byte_range: ByteRequest | None) -> Buffer | None:
            return await self.get(key, prototype=prototype, byte_range=byte_range)

        return await concurrent_map(key_ranges, _get, limit=None)

    async def exists(self, key: str) -> bool:
        # docstring inherited
        return key in self._store_dict

    async def _get_bytes(
        self,
        key: str = "",
        *,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> bytes:
        """
        Retrieve raw bytes from the memory store asynchronously.

        This is a convenience override that makes the ``prototype`` parameter optional
        by defaulting to the standard buffer prototype. See the base ``Store.get_bytes``
        for full documentation.

        Parameters
        ----------
        key : str, optional
            The key identifying the data to retrieve. Defaults to an empty string.
        prototype : BufferPrototype, optional
            The buffer prototype to use for reading the data. If None, uses
            ``default_buffer_prototype()``.
        byte_range : ByteRequest, optional
            If specified, only retrieve a portion of the stored data.

        Returns
        -------
        bytes
            The raw bytes stored at the given key.

        Raises
        ------
        FileNotFoundError
            If the key does not exist in the store.

        See Also
        --------
        Store.get_bytes : Base implementation with full documentation.
        get_bytes_sync : Synchronous version of this method.

        Examples
        --------
        >>> store = await MemoryStore.open()
        >>> await store.set("data", Buffer.from_bytes(b"hello"))
        >>> # No need to specify prototype for MemoryStore
        >>> data = await store.get_bytes("data")
        >>> print(data)
        b'hello'
        """
        if prototype is None:
            prototype = default_buffer_prototype()
        return await super()._get_bytes(key, prototype=prototype, byte_range=byte_range)

    def _get_bytes_sync(
        self,
        key: str = "",
        *,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> bytes:
        """
        Retrieve raw bytes from the memory store synchronously.

        This is a convenience override that makes the ``prototype`` parameter optional
        by defaulting to the standard buffer prototype. See the base ``Store.get_bytes``
        for full documentation.

        Parameters
        ----------
        key : str, optional
            The key identifying the data to retrieve. Defaults to an empty string.
        prototype : BufferPrototype, optional
            The buffer prototype to use for reading the data. If None, uses
            ``default_buffer_prototype()``.
        byte_range : ByteRequest, optional
            If specified, only retrieve a portion of the stored data.

        Returns
        -------
        bytes
            The raw bytes stored at the given key.

        Raises
        ------
        FileNotFoundError
            If the key does not exist in the store.

        Warnings
        --------
        Do not call this method from async functions. Use ``get_bytes()`` instead.

        See Also
        --------
        Store.get_bytes_sync : Base implementation with full documentation.
        get_bytes : Asynchronous version of this method.

        Examples
        --------
        >>> store = MemoryStore()
        >>> store.set("data", Buffer.from_bytes(b"hello"))
        >>> # No need to specify prototype for MemoryStore
        >>> data = store.get_bytes("data")
        >>> print(data)
        b'hello'
        """
        if prototype is None:
            prototype = default_buffer_prototype()
        return super()._get_bytes_sync(key, prototype=prototype, byte_range=byte_range)

    async def _get_json(
        self,
        key: str = "",
        *,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Any:
        """
        Retrieve and parse JSON data from the memory store asynchronously.

        This is a convenience override that makes the ``prototype`` parameter optional
        by defaulting to the standard buffer prototype. See the base ``Store.get_json``
        for full documentation.

        Parameters
        ----------
        key : str, optional
            The key identifying the JSON data to retrieve. Defaults to an empty string.
        prototype : BufferPrototype, optional
            The buffer prototype to use for reading the data. If None, uses
            ``default_buffer_prototype()``.
        byte_range : ByteRequest, optional
            If specified, only retrieve a portion of the stored data.
            Note: Using byte ranges with JSON may result in invalid JSON.

        Returns
        -------
        Any
            The parsed JSON data. This follows the behavior of ``json.loads()`` and
            can be any JSON-serializable type: dict, list, str, int, float, bool, or None.

        Raises
        ------
        FileNotFoundError
            If the key does not exist in the store.
        json.JSONDecodeError
            If the stored data is not valid JSON.

        See Also
        --------
        Store.get_json : Base implementation with full documentation.
        get_json_sync : Synchronous version of this method.
        get_bytes : Method for retrieving raw bytes without parsing.

        Examples
        --------
        >>> store = await MemoryStore.open()
        >>> import json
        >>> metadata = {"zarr_format": 3, "node_type": "array"}
        >>> await store.set("zarr.json", Buffer.from_bytes(json.dumps(metadata).encode()))
        >>> # No need to specify prototype for MemoryStore
        >>> data = await store.get_json("zarr.json")
        >>> print(data)
        {'zarr_format': 3, 'node_type': 'array'}
        """
        if prototype is None:
            prototype = default_buffer_prototype()
        return await super()._get_json(key, prototype=prototype, byte_range=byte_range)

    def _get_json_sync(
        self,
        key: str = "",
        *,
        prototype: BufferPrototype | None = None,
        byte_range: ByteRequest | None = None,
    ) -> Any:
        """
        Retrieve and parse JSON data from the memory store synchronously.

        This is a convenience override that makes the ``prototype`` parameter optional
        by defaulting to the standard buffer prototype. See the base ``Store.get_json``
        for full documentation.

        Parameters
        ----------
        key : str, optional
            The key identifying the JSON data to retrieve. Defaults to an empty string.
        prototype : BufferPrototype, optional
            The buffer prototype to use for reading the data. If None, uses
            ``default_buffer_prototype()``.
        byte_range : ByteRequest, optional
            If specified, only retrieve a portion of the stored data.
            Note: Using byte ranges with JSON may result in invalid JSON.

        Returns
        -------
        Any
            The parsed JSON data. This follows the behavior of ``json.loads()`` and
            can be any JSON-serializable type: dict, list, str, int, float, bool, or None.

        Raises
        ------
        FileNotFoundError
            If the key does not exist in the store.
        json.JSONDecodeError
            If the stored data is not valid JSON.

        Warnings
        --------
        Do not call this method from async functions. Use ``get_json()`` instead.

        See Also
        --------
        Store.get_json_sync : Base implementation with full documentation.
        get_json : Asynchronous version of this method.
        get_bytes_sync : Method for retrieving raw bytes without parsing.

        Examples
        --------
        >>> store = MemoryStore()
        >>> import json
        >>> metadata = {"zarr_format": 3, "node_type": "array"}
        >>> store.set("zarr.json", Buffer.from_bytes(json.dumps(metadata).encode()))
        >>> # No need to specify prototype for MemoryStore
        >>> data = store.get_json("zarr.json")
        >>> print(data)
        {'zarr_format': 3, 'node_type': 'array'}
        """
        if prototype is None:
            prototype = default_buffer_prototype()
        return super()._get_json_sync(key, prototype=prototype, byte_range=byte_range)

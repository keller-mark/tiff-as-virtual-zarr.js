# tiff-as-virtual-zarr.js

This is an effort to read and write OME-TIFF data via the Zarr store interface.
In other words, given an OME-TIFF file, we want to conceptually/virtually mapping OME-TIFF tiles and resolutions to Zarr chunks and OME-Zarr multiscales.
We will translate OME-XML metadata to OME-NGFF metadata.


For now, we only support the single-file OME-TIFF use case.

The implementation is based heavily on Viv's TiffPixelSource and its related utilities.

## Development

```sh
pnpm install
```

Run unit tests:

```sh
pnpm run test
```

## Virtual tiff-to-zarr mapping

### `/.zattrs` (Zarr v2) or `/zarr.json` (Zarr v3) attrs for root metadata

This should list the dimensions, multiscales, and channels according to the OME-NGFF metadata schema.

### Image array `/{scale}/.zattrs`

This should list the shape and `dtype` of the array and other properties such as compression parameters.

#### Tile chunk `/{scale}/{tile_index}`

This key identifies a particular tile in the multidimensional array representing a particular scale of a multiscale image.

## Related work

- https://github.com/cgohlke/tifffile/blob/976465b328f7724041b230917f65ca29a3e2294b/tifffile/zarr.py#L235
- https://github.com/zarr-developers/VirtualiZarr
- https://github.com/virtual-zarr/virtual-tiff and [#32](https://github.com/virtual-zarr/virtual-tiff/issues/32)
- https://github.com/pymmcore-plus/ome-writers
  - https://github.com/tlambert03/ome-writers/blob/6f14f841700a0586f57e9e518123baa4756a497b/src/ome_writers/_backends/_live_tiff_store.py


-----

Note: This is not an effort to read Zarr as TIFF (the reverse).

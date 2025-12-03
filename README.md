# tiff-as-virtual-zarr

This is an effort to read and write OME-TIFF data via the Zarr store interface.
In other words, given an OME-TIFF file, we want to conceptually/virtually mapping OME-TIFF tiles and resolutions to Zarr chunks and OME-Zarr multiscales.
In particular, we can translate OME-XML metadata to OME-NGFF metadata.


As a proof-of-concept, we will first implement this mapping using Python. However eventually, we want to implement this via Rust.

## Virtual tiff-to-zarr mapping

### `/.zattrs` (Zarr v2) or `/zarr.json` (Zarr v3) attrs for root of dataframe

This should list the dimensions, multiscales, and channels according to the OME-NGFF metadata schema.

### Image array `/{scale}/.zattrs`

This should list the shape and `dtype` of the array and other properties such as compression parameters.

#### Tile chunk `/{scale}/{tile_index}`

This key identifies a particular tile in the multidimensional array representing a particular scale of a multiscale image.

-----

Note: This is not an effort to read Zarr as TIFF (the reverse).

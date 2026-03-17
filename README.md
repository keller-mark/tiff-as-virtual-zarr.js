# tiff-as-virtual-zarr.js

Read OME-TIFF data via the Zarr store interface, with "virtualized" OME-NGFF metadata.
In other words, given an OME-TIFF file, we want to conceptually/virtually map the image tiles and pyramid resolutions to Zarr chunks and OME-Zarr multiscales.
We translate OME-XML metadata to OME-NGFF metadata.

For now, we only support the single-file OME-TIFF use case, and we translate metadata to OME-NGFF v0.5.

The implementation was originally based on [Viv](https://github.com/hms-dbmi/viv)'s TiffPixelSource ([696f1d52](https://github.com/keller-mark/tiff-as-virtual-zarr.js/blob/696f1d523c63e2af3a4e9c674bb220ec833acf8e/src/OmeTiffAsOmeZarrStore.ts)) but is now based on [Vizarr](https://github.com/hms-dbmi/vizarr)'s [OmeTiffStore](https://github.com/hms-dbmi/vizarr/blob/main/src/ome-tiff-store.ts).

## Development

```sh
pnpm install
```

Run unit tests:

```sh
pnpm run test
```

## Virtual tiff-to-zarr mapping

### `/zarr.json` (Zarr v3) attrs for root metadata

This should list the dimensions, multiscales, and channels according to the OME-NGFF metadata schema.

### Image array `/{scale}/zarr.json`

This should list the shape and `dtype` of the array and other properties such as compression parameters.

#### Tile chunk `/{scale}/{tile_index}`

This key identifies a particular tile in the multidimensional array representing a particular scale of a multiscale image.

## Related work

- https://github.com/hms-dbmi/vizarr/pull/254
- https://github.com/cgohlke/tifffile/blob/976465b328f7724041b230917f65ca29a3e2294b/tifffile/zarr.py#L235
- https://github.com/zarr-developers/VirtualiZarr
- https://github.com/virtual-zarr/virtual-tiff and [#32](https://github.com/virtual-zarr/virtual-tiff/issues/32)
- https://github.com/pymmcore-plus/ome-writers
  - https://github.com/tlambert03/ome-writers/blob/6f14f841700a0586f57e9e518123baa4756a497b/src/ome_writers/_backends/_live_tiff_store.py
- https://github.com/keller-mark/hdf5-as-virtual-zarr.js

## Citation

Cite the Viv paper if you use this code:

> Trevor Manz, Ilan Gold, Nathan Heath Patterson, Chuck McCallum, Mark S Keller, Bruce W Herr II, Katy Börner, Jeffrey M Spraggins, Nils Gehlenborg,
> "[Viv: multiscale visualization of high-resolution multiplexed bioimaging data on the web](https://www.nature.com/articles/s41592-022-01482-7)."
> **Nature Methods** (2022), [doi:10.31219/10.1038/s41592-022-01482-7](https://doi.org/10.1038/s41592-022-01482-7)

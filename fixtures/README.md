## Download OME-NGFF fixtures from IDR

OME-NGFF sample images from https://idr.github.io/ome-ngff-samples/

```sh
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.5/idr0062A/6001240_labels.zarr 6001240_labels.v0_5.ome.zarr
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.5/idr0066/ExpD_chicken_embryo_MIP.ome.zarr ExpD_chicken_embryo_MIP.v0_5.ome.zarr
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.4/idr0101A/13457227.zarr 13457227.v0_4.zarr
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.4/idr0076A/10501752.zarr 10501752.v0_4.zarr
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.4/idr0062A/6001240.zarr 6001240.v0_4.zarr
uv run --with awscli aws s3 sync --endpoint-url https://uk1s3.embassy.ebi.ac.uk --no-sign-request s3://idr/zarr/v0.3/9836842.zarr 9836842.v0_3.zarr
```
## Edge-case fixtures

`create_edge_case_fixtures.py` writes small synthetic TIFF / OME-TIFF files to `edge_cases/`. They cover layouts the IDR-derived fixtures don't: short final strips, predictors 2 and 3 on multi-byte and big-endian data, LZW and zstd, chunky and planar-separate RGB, three non-RGB samples, non-square tiles, ceil-halving pyramids, and Z-stacks with physical sizes. It also writes `edge_cases/reference.zarr`, which holds the expected virtual array for every case and level.

```sh
uv run create_edge_case_fixtures.py
```

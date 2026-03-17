#!/usr/bin/env bash
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")/../fixtures" && pwd)"
cd "$FIXTURES_DIR"

S3_ENDPOINT="https://uk1s3.embassy.ebi.ac.uk"

download_if_missing() {
  local target="$1"
  local s3_path="$2"
  if [ ! -e "$target" ]; then
    echo "Downloading $target ..."
    uv run --with awscli aws s3 sync \
      --endpoint-url "$S3_ENDPOINT" \
      --no-sign-request \
      "s3://idr/$s3_path" "$target"
  else
    echo "Already exists: $target"
  fi
}

convert_if_missing() {
  # $1 = OME-TIFF output, $2 = plain TIFF output, $3 = script, $4 = input zarr
  local ome_tif="$1"
  local plain_tif="$2"
  local script="$3"
  local input="$4"
  if [ ! -f "$ome_tif" ] || [ ! -f "$plain_tif" ]; then
    echo "Converting $input ..."
    uv run "$script" "$input"
  else
    echo "Already exists: $ome_tif, $plain_tif"
  fi
}

create_toy_if_missing() {
  # $1 = OME-TIFF, $2 = plain TIFF, $3 = zarr dir, $4 = script
  local ome_tif="$1"
  local plain_tif="$2"
  local zarr_dir="$3"
  local script="$4"
  if [ ! -f "$ome_tif" ] || [ ! -f "$plain_tif" ] || [ ! -e "$zarr_dir" ]; then
    echo "Creating toy fixtures ..."
    uv run "$script"
  else
    echo "Already exists: $ome_tif, $plain_tif, $zarr_dir"
  fi
}

# ── Download source zarr stores ────────────────────────────────────────────────
download_if_missing "9836842.v0_3.zarr"                           "zarr/v0.3/9836842.zarr"
download_if_missing "10501752.v0_4.zarr"                          "zarr/v0.4/idr0076A/10501752.zarr"
download_if_missing "ExpD_chicken_embryo_MIP.v0_5.ome.zarr"       "zarr/v0.5/idr0066/ExpD_chicken_embryo_MIP.ome.zarr"

# ── Convert to OME-TIFF + plain TIFF (and write cropped reference zarrs if needed) ──
convert_if_missing "9836842.v0_3.ome.tif"                 "9836842.v0_3.plain.tif"                 "convert_pre_v0_5.py" "9836842.v0_3.zarr"
convert_if_missing "10501752.v0_4.ome.tif"                "10501752.v0_4.plain.tif"                "convert_pre_v0_5.py" "10501752.v0_4.zarr"
convert_if_missing "ExpD_chicken_embryo_MIP.v0_5.ome.tif" "ExpD_chicken_embryo_MIP.v0_5.plain.tif" "convert_v0_5.py"     "ExpD_chicken_embryo_MIP.v0_5.ome.zarr"

# ── Generate toy fixtures ──────────────────────────────────────────────────────
create_toy_if_missing "test_image.ome.tif" "test_image.plain.tif" "test_image.ome.zarr" "create_toy_fixtures.py"

echo "All fixtures ready."

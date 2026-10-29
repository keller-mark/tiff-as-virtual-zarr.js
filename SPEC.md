# Specification: TIFF and OME-TIFF as virtual OME-Zarr stores

Derived from: the reference TypeScript implementation in this repository (`src/OmeTiffAsOmeZarrStore.ts`, `src/TiffAsOmeZarrStore.ts`, `src/tiff-utils.ts`).

This document says how a Zarr client in any programming language can expose a TIFF or OME-TIFF file as a **read-only, virtual OME-Zarr (OME-NGFF v0.5, Zarr v3) store**, without copying or re-encoding the file. Two store types are defined:

| Store | Input | Metadata source |
| --- | --- | --- |
| `OmeTiffAsOmeZarrStore` (§3) | Single-file OME-TIFF | OME-XML in the first IFD's `ImageDescription` tag |
| `TiffAsOmeZarrStore` (§4) | Any baseline TIFF (no OME-XML required) | TIFF tags only |

A consumer of either store MUST NOT be able to tell it apart from a real OME-Zarr v0.5 image hierarchy, as far as the keys defined below go.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in RFC 2119.

---

## 1. Terminology

- **Source**: the byte source holding the TIFF file (local file, HTTP URL, object store, or another Zarr store whose key `/` resolves to the TIFF bytes). The source MUST support byte-range reads (`offset + length`, and ideally suffix reads).
- **IFD**: a TIFF Image File Directory. The **main IFD chain** is the linked list that starts at the header offset. **SubIFDs** are IFDs pointed to by tag 330 (`SubIFDs`) of an IFD in the main chain.
- **Plane**: one 2D (Y, X) image stored in one IFD.
- **Level** / **resolution** `r`: one pyramid level, `r = 0` being full resolution.
- **Segment**: a TIFF tile (tiled layout) or strip (stripped layout). Its byte range is given by `TileOffsets`/`TileByteCounts` (tags 324/325) or `StripOffsets`/`StripByteCounts` (tags 273/279).
- **Virtual key**: a Zarr v3 store key that the store answers by computing a value instead of reading a stored object.

---

## 2. Common requirements (both store types)

### 2.1 Store interface

Each store MUST implement the read-only part of the host Zarr library's store abstraction:

- `get(key) → bytes | absent`
- `getRange(key, range) → bytes | absent`, where `range` is either `{offset, length}` or `{suffixLength}`.

Write, delete and list operations are out of scope. A store MAY also implement `list`/`list_dir` by listing the virtual keys in §2.2.

`getRange(key, range)` MUST return exactly the bytes that `get(key)` would return, sliced to the requested range: `[offset, offset+length)`, or the last `suffixLength` bytes (clamped at 0).

A store SHOULD let callers pass a cancellation signal (or the language's equivalent) through `get`/`getRange` to the source reads it issues.

### 2.2 Key space

Keys are absolute and slash-separated. Each store MUST recognise exactly these keys:

| Key pattern | Meaning |
| --- | --- |
| `/zarr.json` | Root group metadata (§2.4) |
| `/{r}/zarr.json` | Array metadata for level `r` (§2.5) |
| `/{r}/c/{i0}/{i1}/…/{iN-1}` | Encoded chunk of level `r` at chunk grid coordinates `(i0 … iN-1)` (§2.6) |

`{r}` and every `{ik}` are non-negative base-10 integers. `N` is the number of axes of the array.

Any other key, or a recognised key whose level or chunk coordinates fall outside the valid range, MUST return *absent* (`undefined` / `None` / "key not found"). It MUST NOT raise an error.

### 2.3 Laziness and I/O budget

- Opening a store MUST read only the TIFF header and the IFDs needed to answer metadata. It MUST NOT read pixel data.
- A store MUST NOT read the whole source in one request, and SHOULD NOT read it in full at all, unless the caller asks for every chunk.
- Building the virtual metadata SHOULD happen once, lazily on the first `get`, and be cached for the lifetime of the store.
- The SubIFDs of the first plane are needed to answer level shapes and chunk shapes, so they MAY be read when opening. The SubIFDs of every other plane SHOULD be parsed lazily, on the first request for a chunk that needs them, and cached by file offset.
- Serving a chunk MUST read only the byte range(s) of the segment(s) backing that chunk (plus any IFD/offset-table bytes not yet cached). When an IFD's offset/byte-count arrays are large, implementations SHOULD fetch only the entries they need.

### 2.4 Root group metadata (`/zarr.json`)

The response MUST be a UTF-8 JSON document with this shape:

```json
{
  "zarr_format": 3,
  "node_type": "group",
  "attributes": {
    "ome": {
      "version": "0.5",
      "multiscales": [ { "axes": [ … ], "datasets": [ … ] } ],
      "omero": { … }
    }
  }
}
```

- `multiscales` MUST contain exactly one entry.
- `datasets[r].path` MUST be the string `"{r}"` for `r = 0 … L-1`, where `L` is the level count.
- `datasets[r].coordinateTransformations` MUST contain exactly one `{"type": "scale", "scale": [...]}` with one value per axis.
- `omero` is OPTIONAL. Its rules are defined per store type.
- The result MUST validate against the OME-NGFF v0.5 JSON schema.

Clients compare metadata as parsed JSON, not as bytes. Whitespace and key order are therefore not significant.

### 2.5 Array metadata (`/{r}/zarr.json`)

```json
{
  "zarr_format": 3,
  "node_type": "array",
  "shape": [ … ],
  "data_type": "<dtype>",
  "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [ … ] } },
  "chunk_key_encoding": { "name": "default", "configuration": { "separator": "/" } },
  "codecs": [ { "name": "bytes", "configuration": { "endian": "little" } } ],
  "fill_value": 0,
  "attributes": {}
}
```

- `shape` and `chunk_shape` MUST have one entry per axis, in the order of `multiscales[0].axes`.
- `data_type` MUST be one of the Zarr v3 core numeric types (§2.7).
- `chunk_key_encoding` MUST be `default` with separator `/`. This is what produces the `/{r}/c/…` chunk keys.
- `codecs`: see §2.6.

### 2.6 Chunk payloads

Chunk *(level r, coordinates i)* maps to exactly **one TIFF segment** in **one IFD**. The store-specific sections define how to find that IFD and segment.

Two strategies are allowed for serving the payload. The `codecs` array in §2.5 MUST match the strategy the store uses.

**Strategy A — decode in the store (the reference implementation does this).**
The store reads the segment bytes and then:

1. **Decompresses** them according to TIFF `Compression` (tag 259). Implementations MUST support `1` (none), `5` (LZW), `8` and `32946` (Deflate/zlib). They MAY support others (e.g. `50000` zstd, `34887` LERC), and MUST fail with a clear error on any they don't support.
2. **Reverses the predictor** (tag 317). Let `spp` be the number of samples interleaved per pixel in the segment (§2.6.1), `bps = BitsPerSample / 8`, and `rowSamples = segmentWidth × spp`. Each row is processed independently:
   - `Predictor = 2` (horizontal differencing): treat the row as `rowSamples` unsigned integers of `bps` bytes in the **file's** byte order. For `i` from `spp` to `rowSamples − 1`, set `v[i] = (v[i] + v[i − spp]) mod 2^(8·bps)`. This happens before step 3.
   - `Predictor = 3` (floating point): first undifference the row's `rowSamples × bps` bytes byte-wise: `b[i] = (b[i] + b[i − spp]) mod 256`. The row then holds `bps` byte planes of `rowSamples` bytes each, most significant byte first. Sample `j` is reassembled as little-endian bytes `out[j·bps + k] = b[(bps − 1 − k) · rowSamples + j]` for `k = 0 … bps−1`. The result is already little-endian, so step 3 is skipped.
   - Any other predictor value MUST cause an error.
3. **Normalises byte order to little-endian.** If the TIFF header is big-endian (`MM`) and the sample size is > 1 byte, reverse the bytes of each sample.
4. **Pads to the full chunk size.** The returned buffer MUST be exactly `prod(chunk_shape) × bytes_per_element` bytes. TIFF tiles are already padded to full tile size. Strips are not padded: the last strip of an image has `ImageLength mod RowsPerStrip` rows. Pad it with `fill_value` (zero bytes) up to the full chunk.
5. **Reorders samples** if the store exposes interleaved samples as a leading channel axis (§4.2): convert the `(y, x, s)` buffer to `(s, y, x)` order.

The codec chain is then just `[{"name": "bytes", "configuration": {"endian": "little"}}]`.

**Strategy B — pass compressed bytes through (OPTIONAL optimisation).**
If the TIFF compression has an equivalent Zarr v3 codec, and no predictor or byte swap is needed (or it can be expressed as a codec), the store MAY return the raw segment bytes unchanged and declare the matching codec chain:

| TIFF `Compression` | Zarr v3 `codecs` |
| --- | --- |
| 1 | `[bytes]` |
| 8, 32946 | `[bytes, {"name": "zlib", …}]`* |
| 50000 | `[bytes, {"name": "zstd", …}]` |

\* `zlib` is not a core Zarr v3 codec, and many readers only ship `gzip`. Only use Strategy B with codecs the target clients support. The `bytes` codec's `endian` MUST match the TIFF header byte order.

Strategy B is not allowed when segment shapes differ from the declared chunk shape, e.g. unpadded final strips. A store MUST NOT mix strategies within one array.

**Sparse / missing segments.** If a segment's byte count is 0 (or its offset is 0), the chunk MUST be served as an all-`fill_value` buffer of full chunk size (Strategy A). Alternatively it MAY be reported *absent*, which Zarr readers interpret as `fill_value`.

#### 2.6.1 Interleaved samples

The number of samples interleaved per pixel within a segment, `spp`, is `1` for single-sample or planar-separate images. For chunky-interleaved images (`PlanarConfiguration = 1` and `SamplesPerPixel > 1`) it is `SamplesPerPixel`. A decoded segment holds `segmentWidth × segmentHeight × spp` samples. Sub-byte sample sizes (1-bit, 4-bit) are out of scope.

### 2.7 Data type mapping

| TIFF `SampleFormat` (339) | `BitsPerSample` (258) | OME-XML `Pixels@Type` | Zarr `data_type` |
| --- | --- | --- | --- |
| 1 (uint) / absent | 8, 16, 32, 64 | `uint8`, `uint16`, `uint32` | `uint{bits}` |
| 2 (int) | 8, 16, 32, 64 | `int8`, `int16`, `int32` | `int{bits}` |
| 3 (IEEE float) | 32, 64 | `float`, `double` | `float32`, `float64` |

`bit`, `complex` and `double-complex` are out of scope. The store MUST reject them when opened.

### 2.8 Pyramid geometry

For level `r`:

- `shape_y(r)`, `shape_x(r)` MUST be the `ImageLength` (257) and `ImageWidth` (256) of the IFD backing that level. Writers differ in rounding (e.g. 247 → 123 or 124), so these MUST NOT be derived from the level-0 size.
- The spatial `scale` for Y/X at level `r` is `scale(0) × f(r)` per axis, where the downsampling factor is:
  - `f(r) = 2^r` if `size(r)` equals `floor(size(0) / 2^r)` or `ceil(size(0) / 2^r)` (a power-of-two pyramid with either rounding);
  - otherwise `f(r) = size(0) / size(r)`.

  This keeps scales exact (e.g. `[1.6, 3.2, 6.4, …]`) for the usual power-of-two pyramids, where a plain size ratio would drift at small levels. Non-spatial axes MUST have scale `1.0`, except `z` in §3.6.

### 2.9 Consolidated metadata (OPTIONAL)

A store MAY expose a helper that returns the root `zarr.json` object augmented with:

```json
"consolidated_metadata": {
  "kind": "inline",
  "must_understand": false,
  "metadata": { "0": { …/0/zarr.json… }, "1": { … }, … }
}
```

Each `metadata["{r}"]` MUST equal the parsed `/{r}/zarr.json`. Because `must_understand` is `false`, the plain `/zarr.json` key MAY omit this field.

### 2.10 Text encoding

ASCII-typed TIFF tags that hold XML (notably `ImageDescription`) MUST be decoded as **UTF-8**, not Latin-1, so that characters such as `µ` in `µm` survive. Trailing NUL bytes MUST be stripped before parsing.

---

## 3. `OmeTiffAsOmeZarrStore`

Exposes a single-file OME-TIFF (Bio-Formats layout) as one OME-Zarr multiscale image.

### 3.1 Opening

1. Read the TIFF/BigTIFF header and the main IFD chain (tag values only, not pixel data).
2. Read `ImageDescription` (270) of IFD 0, decode it as UTF-8 (§2.10), and parse it as OME-XML.
3. Use the **first** `Image` element. Multi-image (multi-series) OME-TIFFs expose only series 0.
4. From `Image/Pixels`, read the attributes `SizeX`, `SizeY`, `SizeZ`, `SizeC`, `SizeT`, `DimensionOrder`, `Type`, `PhysicalSizeX`, `PhysicalSizeXUnit`, `PhysicalSizeY`, `PhysicalSizeYUnit`, `Interleaved`, and the `Channel` children.
5. Validate:
   - All five `Size*` are integers ≥ 1.
   - `DimensionOrder` is one of `XYZCT`, `XYZTC`, `XYCTZ`, `XYCZT`, `XYTCZ`, `XYTZC`.
   - `Interleaved` is absent or `"false"`. Interleaved RGB OME-TIFFs are out of scope.
   - Every Channel has `SamplesPerPixel = 1` (or absent).
   - `Type` maps to a supported dtype (§2.7).

   If validation fails, opening MUST fail with an error.

### 3.2 Axes

The array axes are the **active axes**: a subset of `t, c, z, y, x` in that fixed order (the OME-NGFF canonical order).

| Axis | `axes[]` entry |
| --- | --- |
| `t` | `{"name": "t", "type": "time"}` |
| `c` | `{"name": "c", "type": "channel"}` |
| `z` | `{"name": "z", "type": "space"}` (+ `"unit"` from `PhysicalSizeZUnit` if present) |
| `y` | `{"name": "y", "type": "space"}` (+ `"unit"` from `PhysicalSizeYUnit` if present) |
| `x` | `{"name": "x", "type": "space"}` (+ `"unit"` from `PhysicalSizeXUnit` if present) |

Units SHOULD be converted from OME-XML symbols to OME-NGFF unit names (`µm` → `micrometer`, `nm` → `nanometer`, `mm` → `millimeter`, `Å` → `angstrom`, `s` → `second`, …). A `unit` is emitted only when the matching `PhysicalSize*` is a positive number. If the size has no unit attribute, the OME-XML schema default `µm` applies.


### 3.3 Levels (pyramid discovery)

Use the first mechanism that applies:

1. **SubIFDs (Bio-Formats ≥ 6).** If IFD 0 has tag `SubIFDs` (330) with `n` entries, then `L = n + 1`. Level 0 of plane `p` is main-chain IFD `p`. Level `r ≥ 1` of plane `p` is `SubIFDs[r − 1]` of main-chain IFD `p`.
2. **Legacy sequential pyramid (Bio-Formats < 6).** Let `P = SizeT × SizeC × SizeZ` (planes per level) and `M` = number of IFDs in the main chain. Then `L = max(1, floor(M / P))`, and level `r` of plane `p` is main-chain IFD `p + r × P`.
3. Otherwise `L = 1`.

### 3.4 Plane index

The plane index `p` of `(t, c, z)` depends on `DimensionOrder`. The first letter after `XY` varies fastest:

| `DimensionOrder` | `p` |
| --- | --- |
| `XYZCT` | `z + Z·c + Z·C·t` |
| `XYZTC` | `z + Z·t + Z·T·c` |
| `XYCZT` | `c + C·z + C·Z·t` |
| `XYCTZ` | `c + C·t + C·T·z` |
| `XYTCZ` | `t + T·c + T·C·z` |
| `XYTZC` | `t + T·z + T·Z·c` |

(`Z`, `C`, `T` are `SizeZ`, `SizeC`, `SizeT`.)

If the OME-XML has explicit `TiffData` elements with `IFD`/`FirstZ`/`FirstC`/`FirstT` attributes, they SHOULD take precedence over this formula.

### 3.5 Array metadata

For level `r`:

- `shape`: for each active axis, `SizeT`, `SizeC` or `SizeZ` for `t`/`c`/`z`, and `shape_y(r)`/`shape_x(r)` (§2.8) for `y`/`x`.
- `chunk_shape`: `1` for `t`, `c`, `z`. For `y`/`x` it is the segment size of the first plane's IFD at level `r`: `TileLength` (323) / `TileWidth` (322) when tiled, or `RowsPerStrip` (clamped to the level height) / `ImageWidth` when stripped. Tiles need not be square or powers of two. Each level MAY use a different segment size. All planes within one level MUST share it; a chunk request that finds a different segment size MUST fail with an error.
- `data_type`: from `Pixels@Type` (§2.7). It MUST agree with `BitsPerSample`/`SampleFormat` of IFD 0.


### 3.6 Root metadata

- `multiscales[0].axes`: §3.2.
- `multiscales[0].datasets[r].coordinateTransformations[0].scale`: for `y`/`x`, `PhysicalSizeY`/`PhysicalSizeX` (or `1.0` if the attribute is absent, non-numeric or ≤ 0), multiplied by the level factor (§2.8). For `z`, `PhysicalSizeZ` (same default). For `t`/`c`, `1.0`.
- `multiscales[0].name` MAY be set to `Image@Name`.
- `omero` MUST be present if, and only if, the number of `Pixels/Channel` elements equals `SizeC`. It has this form:

```json
{
  "id": 1,
  "version": "0.1",
  "name": "<Image@Name or 'unknown'>",
  "rdefs": { "model": "greyscale" },
  "channels": [
    {
      "label": "<Channel@Name>",
      "color": "<RRGGBB>",
      "active": true,
      "coefficient": 1,
      "family": "linear",
      "inverted": false,
      "window": { "min": 0, "max": 65535, "start": 0, "end": 65535 }
    }
  ]
}
```

- `color`: if `Channel@Color` is present, it is a signed 32-bit integer in **RGBA** byte order. Write it as big-endian int32 and take the first three bytes as `RRGGBB` (lower-case hex, zero-padded, no `#`). Otherwise use the default palette `[00FFFF, FFFF00, FF00FF, FF0000, 00FF00, 0000FF]` cycled by channel index.
- `active`: `true` for the first 6 channels, `false` for the rest.
- `window`: for integer types, `min = start` and `max = end` are the dtype's range (e.g. `0…255` for `uint8`, `−32768…32767` for `int16`). Float types have no natural range, so they use `0…1`.

### 3.7 Chunk resolution

For key `/{r}/c/{i…}`:

1. Reject with *absent* if `r ≥ L`, the number of coordinates ≠ number of active axes, or any coordinate ≥ `ceil(shape / chunk_shape)` on its axis.
2. Read `t`, `c`, `z` from the coordinates of the matching active axes (0 when the axis is inactive). Read `ty`, `tx` from the `y`, `x` coordinates.
3. Compute `p` (§3.4), then find the IFD for `(p, r)` (§3.3).
4. Segment index within the IFD: `k = ty × ceil(ImageWidth / TileWidth) + tx` when tiled, or `k = ty` when stripped (`tx` is always 0).
5. Read entry `k` of `TileOffsets`/`TileByteCounts` (or `StripOffsets`/`StripByteCounts`), fetch that range, and produce the payload (§2.6) with `spp = 1`.

---

## 4. `TiffAsOmeZarrStore`

Exposes a generic TIFF, whose metadata comes only from TIFF tags, as an OME-Zarr multiscale image. Useful for files without OME-XML, or as a fallback when the OME-XML is missing or invalid.

### 4.1 Opening

Read the header and main IFD chain, then read these tags from IFD 0:

| Tag | Default if absent |
| --- | --- |
| `ImageWidth` (256), `ImageLength` (257) | — (required) |
| `BitsPerSample` (258) | 8 (use the first value) |
| `SampleFormat` (339) | 1 (uint) (use the first value) |
| `SamplesPerPixel` (277) | 1 |
| `PlanarConfiguration` (284) | 1 (contig / chunky) |
| `Predictor` (317) | 1 (none) |
| `TileWidth`/`TileLength` (322/323) | — (if present ⇒ tiled) |
| `RowsPerStrip` (278) | `ImageLength` |
| `SubIFDs` (330) | none |

All samples MUST have the same `BitsPerSample` and `SampleFormat`.

### 4.2 Axes

Let `S = SamplesPerPixel`.

| Condition | Active axes | Notes |
| --- | --- | --- |
| `S = 1` | `y, x` | Grayscale |
| `S > 1` and `PlanarConfiguration = 1` | `c, y, x` | Chunky / interleaved (e.g. RGB). One segment holds every sample, so one chunk spans the whole `c` axis. The store de-interleaves each segment from `(y, x, s)` to `(c, y, x)` order (§2.6, step 5). |
| `S > 1` and `PlanarConfiguration = 2` | `c, y, x` | Planar. Sample planes are stored separately. |

Axis entries: `y`, `x` → `{"type": "space"}`, `c` → `{"type": "channel"}`. Samples always form a leading `channel` axis, because OME-NGFF v0.5 requires channel axes to come before space axes.

No units are emitted. All base scales are `1.0`.

### 4.3 Levels

- If IFD 0 has `SubIFDs` with `n` entries, `L = n + 1`. Level `r ≥ 1` is `SubIFDs[r − 1]` of the relevant base IFD.
- Otherwise `L = 1`. Further main-chain IFDs are **not** interpreted as pyramid levels (they could be unrelated pages).

### 4.4 Array metadata

For level `r`, with `H(r)`, `W(r)` from §2.8 and tags read from the level's IFD:

| Axis | `shape` | `chunk_shape` (tiled) | `chunk_shape` (stripped) |
| --- | --- | --- | --- |
| `c` | `S` | `S` if chunky, `1` if planar | `S` if chunky, `1` if planar |
| `y` | `H(r)` | `TileLength` | `RowsPerStrip` (clamped to `H(r)`) |
| `x` | `W(r)` | `TileWidth` | `W(r)` (full width) |

`data_type`: `{uint|int|float}{BitsPerSample}` from `SampleFormat` (§2.7).

For stripped images, the strip height MUST be taken from `RowsPerStrip`, not computed as `ceil(H / stripCount)`. With planar-separate layout, `StripOffsets` contains `S × stripsPerPlane` entries.

### 4.5 Chunk resolution

For key `/{r}/c/{i…}`:

1. Reject with *absent* on out-of-range level or coordinates (as in §3.7, step 1).
2. Read `c` (0 if the axis is inactive), `cy`, `cx` from the coordinates. For chunky images `c` is always `0`.
3. Find the IFD:
   - Planar-separate TIFFs SHOULD store all sample planes in the **same** IFD, as consecutive runs of segments (TIFF 6.0). The segment index is `k = c × segmentsPerPlane + k₀`.
   - Some writers instead put each sample plane in its own main-chain IFD. Implementations MAY detect this (e.g. `SamplesPerPixel = 1` on each page with `N` pages) and use IFD `c` with `k = k₀`.
   - For `r ≥ 1`, use `SubIFDs[r − 1]` of the selected base IFD.
4. Find the segment index `k₀`:
   - Tiled: `k₀ = cy × ceil(W(r) / TileWidth) + cx`.
   - Stripped: `k₀ = cy` (and `cx` MUST be `0`).
5. Fetch the segment and produce the payload (§2.6), using `spp` from §2.6.1. Pad final strips to the full chunk height. For chunky images, de-interleave to `(c, y, x)`.

---

## 5. Conformance testing

An implementation is conformant if, for a TIFF/OME-TIFF and an OME-Zarr v0.5 image generated independently from the same pixels (see `fixtures/`):

1. **Metadata equivalence.** Parsed `/zarr.json` → `attributes.ome.multiscales[0].axes` equal the reference's (axis names, types and units). `datasets.length` equals the reference's. Each `datasets[r].coordinateTransformations` scale is equal within floating-point tolerance.
2. **Array equivalence.** For every level `r`, `/{r}/zarr.json` `shape` and `data_type` equal the reference's. `chunk_shape` and `codecs` are *allowed* to differ (the TIFF tiling is independent of the Zarr chunking).
3. **Pixel equivalence.** Decoding any region of any level through a standard Zarr v3 reader gives values identical to the same region read from the reference OME-Zarr.
4. **Partial I/O.** When reading one chunk or one channel, the store issues only range requests (never a whole-file `get`). No single request spans the whole file, and the total bytes read are well below the file size (e.g. < 10% when reading 1 of 50 channels).
5. **Absent keys.** Unknown keys and out-of-range levels return *absent* without raising.
6. **Range semantics.** `getRange(k, {offset, length})` = `get(k)[offset : offset+length]`, and `getRange(k, {suffixLength: n})` = the last `n` bytes of `get(k)`.

---

## Appendix A. Known gaps in the reference TypeScript implementation

The reference implementation (`src/`) follows every MUST in this specification. It does not implement these optional (SHOULD/MAY) features:

| Area | Spec | Reference implementation |
| --- | --- | --- |
| `TiffData` mapping (§3.4) | SHOULD take precedence over the `DimensionOrder` formula | Always uses the formula |
| Planar IFD-per-plane (§4.5) | MAY detect sample planes stored in separate IFDs | Only same-IFD segment runs (the TIFF 6.0 layout) |
| Strip offset reads (§2.3) | SHOULD fetch only the needed offset/byte-count entries | Loads the full `StripOffsets`/`StripByteCounts` arrays on first use (tile offsets are read per entry) |
| Compression (§2.6) | MAY support codecs beyond none/LZW/Deflate | Also supports zstd (50000). No LERC, JPEG, or WebP. |
| Strategy B (§2.6) | MAY pass compressed bytes through | Always decodes in the store (Strategy A) |

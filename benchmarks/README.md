# CoSON benchmarks

The benchmark suite is separate from CoSON runtime code. It does not change the package API or add runtime dependencies.

## Install benchmark-only dependencies

From the CoSON module directory:

```sh
npm --prefix benchmarks install
```

CBOR-X and BSON are development-only dependencies of this private benchmark package. The CoSON-only run does not use either competitor.

## Reproduce the latest reports

```sh
npm --prefix benchmarks run coson
npm --prefix benchmarks run compare
npm --prefix benchmarks run decode-reconstruction
node --expose-gc --max-old-space-size=256 benchmarks/operators-only.js
```

- `coson` measures current CoSON alone on the standard dataset matrix.
- `compare` runs current CoSON, CBOR-X, and BSON on identical datasets, and reports fidelity failures separately from lossless performance comparisons.
- `decode-reconstruction` compares `decode(payload)` with `decode(payload, { reconstruct: false })` using the V6 decode fixtures.
- `operators-only.js` measures native serialization against the current operator-preserving decode/re-encode forwarding path, with no competitor codecs.

All runs use exposed GC and overwrite only their matching `*-latest.md` report. Each report records its benchmark timestamp and methodology. The matrix is 10, 50, and 100 KiB documents; 20, 50, and 100 properties; JSON, Extended, and Mixed binary profiles; three warmup batches; five measured batches of 100 operations.

The latest saved reports are the baselines present in this folder. Peak RSS is sampled and can miss brief spikes. Retained ArrayBuffer bytes are displayed as a subset of external memory, not added to it.

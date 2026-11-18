# CoSON, CBOR-X and BSON Comparative Benchmark

Benchmark UTC: 2026-11-18T12:46:38.909Z
CoSON source SHA-256: 7a84180d2993c5ac0bfef0b6d34babf7ffadd18fe2be68988b5079458614e5a6
Environment: Node v24.18.0; linux/x64; heap cap 256 MiB; exposed GC.
Method: 3 warmups; 5 measured batches; 100 operations per batch. Latency is median of five batch averages. Encode/decode memory sampled in isolated workers; RSS sampled every 1 ms. Retained values are median post-GC deltas per operation.

Dataset matrix is unchanged: 10/50/100 KiB; 20/50/100 properties; JSON, Extended, and Mixed binary profiles. Percentage improvement = (competitor − CoSON) / competitor × 100; positive favors CoSON. Only pairs where both codecs round-trip the dataset losslessly are used for performance deltas.

## Workload fidelity

| Codec | JSON | Extended | Mixed binary | Total |
|---|---:|---:|---:|---:|
| CoSON | 9/9 | 9/9 | 9/9 | 27/27 |
| CBOR-X | 9/9 | 0/9 | 0/9 | 9/27 |
| BSON | 9/9 | 0/9 | 0/9 | 9/27 |

Lossy/unsupported dataset cases (kept out of lossless performance comparisons):

| Profile | Size | Properties | Codec | Outcome |
|---|---:|---:|---|---|
| Extended | 10 KiB | 20 | CBOR-X | $.field008: value differs |
| Extended | 10 KiB | 20 | BSON | $.field002: prototype differs |
| Extended | 10 KiB | 50 | CBOR-X | $.field008: value differs |
| Extended | 10 KiB | 50 | BSON | $.field002: prototype differs |
| Extended | 10 KiB | 100 | CBOR-X | $.field008: value differs |
| Extended | 10 KiB | 100 | BSON | $.field002: prototype differs |
| Mixed binary | 10 KiB | 20 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 10 KiB | 20 | BSON | $.field002: prototype differs |
| Mixed binary | 10 KiB | 50 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 10 KiB | 50 | BSON | $.field002: prototype differs |
| Mixed binary | 10 KiB | 100 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 10 KiB | 100 | BSON | $.field002: prototype differs |
| Extended | 50 KiB | 20 | CBOR-X | $.field008: value differs |
| Extended | 50 KiB | 20 | BSON | $.field002: prototype differs |
| Extended | 50 KiB | 50 | CBOR-X | $.field008: value differs |
| Extended | 50 KiB | 50 | BSON | $.field002: prototype differs |
| Extended | 50 KiB | 100 | CBOR-X | $.field008: value differs |
| Extended | 50 KiB | 100 | BSON | $.field002: prototype differs |
| Mixed binary | 50 KiB | 20 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 50 KiB | 20 | BSON | $.field002: prototype differs |
| Mixed binary | 50 KiB | 50 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 50 KiB | 50 | BSON | $.field002: prototype differs |
| Mixed binary | 50 KiB | 100 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 50 KiB | 100 | BSON | $.field002: prototype differs |
| Extended | 100 KiB | 20 | CBOR-X | $.field008: value differs |
| Extended | 100 KiB | 20 | BSON | $.field002: prototype differs |
| Extended | 100 KiB | 50 | CBOR-X | $.field008: value differs |
| Extended | 100 KiB | 50 | BSON | $.field002: prototype differs |
| Extended | 100 KiB | 100 | CBOR-X | $.field008: value differs |
| Extended | 100 KiB | 100 | BSON | $.field002: prototype differs |
| Mixed binary | 100 KiB | 20 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 100 KiB | 20 | BSON | $.field002: prototype differs |
| Mixed binary | 100 KiB | 50 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 100 KiB | 50 | BSON | $.field002: prototype differs |
| Mixed binary | 100 KiB | 100 | CBOR-X | $.field002: prototype differs |
| Mixed binary | 100 KiB | 100 | BSON | $.field002: prototype differs |

## Latency and encoded size by target size

Median across the nine profile/property cases. Fidelity cells show lossless cases / nine.

| KiB | Codec | Encode ms | Decode ms | Payload bytes | Fidelity |
|---:|---|---:|---:|---:|---:|
| 10 | CoSON | 0.1070 | 0.0386 | 10374 | 9/9 |
| 10 | CBOR-X | 0.0365 | 0.0394 | 10056 | 3/9 |
| 10 | BSON | 0.0373 | 0.1156 | 10314 | 3/9 |
| 50 | CoSON | 0.1769 | 0.0666 | 51332 | 9/9 |
| 50 | CBOR-X | 0.0365 | 0.0603 | 51064 | 3/9 |
| 50 | BSON | 0.0452 | 0.2400 | 51274 | 3/9 |
| 100 | CoSON | 0.2734 | 0.1130 | 102532 | 9/9 |
| 100 | CBOR-X | 0.0529 | 0.0795 | 102264 | 3/9 |
| 100 | BSON | 0.0580 | 0.4292 | 102474 | 3/9 |

## Memory by target size

Peak is sampled RSS increase. Retained ArrayBuffer bytes are shown as a subset of external memory; do not add them to external.

| KiB | Codec | Encode peak MiB | Decode peak MiB | Encode retained heap / external / AB B/op | Decode retained heap / external / AB B/op |
|---:|---|---:|---:|---:|---:|
| 10 | CoSON | 2.88 | 3.04 | 212 / 10407 / 10374 | 11000 / 11056 / 0 |
| 10 | CBOR-X | 0.64 | 4.79 | 147 / 12165 / 12165 | 15170 / 12165 / 0 |
| 10 | BSON | 1.40 | 9.45 | 151 / 11141 / 11141 | 12016 / 11141 / 0 |
| 50 | CoSON | 5.64 | 22.33 | 211 / 51339 / 51332 | 51937 / 52169 / 0 |
| 50 | CBOR-X | 0.68 | 17.70 | 149 / 61440 / 60826 | 52679 / 61986 / 0 |
| 50 | BSON | 3.94 | 24.20 | 217 / 51274 / 51274 | 52976 / 51274 / 0 |
| 100 | CoSON | 12.54 | 49.96 | 211 / 102538 / 102532 | 103137 / 103369 / 0 |
| 100 | CBOR-X | 0.76 | 34.27 | 164 / 122880 / 122880 | 103369 / 122880 / 0 |
| 100 | BSON | 7.08 | 38.74 | 219 / 102474 / 102474 | 104176 / 102474 / 0 |

## CoSON percentage differences

Medians of per-dataset differences, across exact-lossless pairs only. Values are unavailable when no common lossless pairs exist. Retained memory is heap plus external; ArrayBuffer backing is already inside external.

| Competitor | Lossless pairs | Encode | Decode | Payload | Encode peak RSS | Decode peak RSS | Retained encode memory | Retained decode memory |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CBOR-X | 9 | -249.8% | +0.9% | -0.3% | -734.9% | -15.3% | +15.1% | +13.8% |
| BSON | 9 | -182.1% | +75.2% | +0.1% | -19% | -28.6% | +0.2% | +0.3% |

## Additional supported-type fidelity checks

These cases are tested separately and are not added to timed datasets.

| Case | CoSON | CBOR-X | BSON |
|---|---|---|---|
| undefined property | lossless | lossless | FAIL: $: keys differ |
| invalid Date | lossless | lossless | FAIL: $.value: Date differs |
| DataView | lossless | FAIL: $.value: prototype differs | FAIL: $.value: prototype differs |
| Buffer | lossless | lossless | FAIL: $.value: prototype differs |
| reserved operator collisions | lossless | lossless | lossless |
| Int8Array | lossless | lossless | FAIL: $.value: prototype differs |
| Uint8ClampedArray | lossless | lossless | FAIL: $.value: prototype differs |
| Int16Array | lossless | lossless | FAIL: $.value: prototype differs |
| Uint16Array | lossless | lossless | FAIL: $.value: prototype differs |
| Int32Array | lossless | lossless | FAIL: $.value: prototype differs |
| Uint32Array | lossless | lossless | FAIL: $.value: prototype differs |
| Float32Array | lossless | lossless | FAIL: $.value: prototype differs |
| Float64Array | lossless | lossless | FAIL: $.value: prototype differs |
| BigInt64Array | lossless | lossless | FAIL: $.value: prototype differs |
| BigUint64Array | lossless | lossless | FAIL: $.value: prototype differs |
| Float16Array | lossless | FAIL: $.value: prototype differs | FAIL: $.value: prototype differs |

## Limits

Peak RSS sampling can miss brief spikes shorter than 1 ms. External memory includes ArrayBuffer backing; the separately shown AB column is only a subset. Memory and latency are Node.js measurements.

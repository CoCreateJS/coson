# CoSON V6 Performance and Memory Benchmark

Benchmark UTC: 2026-11-18T12:07:58.627Z
Source: /home/ubuntu/Dev/CoCreateJS/modules/coson/src/index.js SHA-256 7a84180d2993c5ac0bfef0b6d34babf7ffadd18fe2be68988b5079458614e5a6.
Environment: Node v24.18.0; linux/x64; heap cap 256 MiB; exposed GC.
Method: 3 warmups; 5 measured batches; 100 operations per batch. Latency is the median of five batch averages. Encode/decode memory sampled in isolated workers; RSS sampled every 1 ms. Retained values are median post-GC deltas per operation.

Dataset matrix: 10/50/100 KiB; 20/50/100 properties; JSON, Extended, and Mixed binary profiles. No competitors were run. Fidelity checks below are separate from timed datasets.

## Workload fidelity

| Profile | Lossless cases |
|---|---:|
| JSON | 9/9 |
| Extended | 9/9 |
| Mixed binary | 9/9 |

## Encoding latency

Median ms/op over successful cases per size.

| KiB | CoSON V6 ms/op | Successful cases |
|---:|---:|---:|
| 10 | 0.0975 | 9/9 |
| 50 | 0.1742 | 9/9 |
| 100 | 0.3275 | 9/9 |

## Decoding latency

Median ms/op over successful cases per size.

| KiB | CoSON V6 ms/op | Successful cases |
|---:|---:|---:|
| 10 | 0.0366 | 9/9 |
| 50 | 0.0709 | 9/9 |
| 100 | 0.1102 | 9/9 |

## Encoding memory

Peak RSS is sampled increase. Retained ArrayBuffer bytes are shown as a subset of external memory and are not added to it.

| KiB | Peak RSS MiB | Retained heap / external / ArrayBuffer B/op |
|---:|---:|---:|
| 10 | 2.81 | 222 / 10410 / 10374 |
| 50 | 5.88 | 212 / 51339 / 51332 |
| 100 | 10.30 | 221 / 102538 / 102532 |

## Decoding memory

Peak RSS is sampled increase. Retained ArrayBuffer bytes are shown as a subset of external memory and are not added to it.

| KiB | Peak RSS MiB | Retained heap / external / ArrayBuffer B/op |
|---:|---:|---:|
| 10 | 2.25 | 10983 / 11056 / 0 |
| 50 | 22.28 | 51942 / 52169 / 0 |
| 100 | 49.98 | 103142 / 103369 / 0 |

## Encoded payload size

Median across lossless cases per size.

| KiB | CoSON V6 bytes |
|---:|---:|
| 10 | 10374 |
| 50 | 51332 |
| 100 | 102532 |

## Additional supported-type fidelity checks

Tested separately; these do not add timed workload.

| Type / pattern | Result |
|---|---|
| undefined property | lossless |
| invalid Date | lossless |
| DataView | lossless |
| Buffer | lossless |
| reserved operator collisions | lossless |
| Int8Array | lossless |
| Uint8ClampedArray | lossless |
| Int16Array | lossless |
| Uint16Array | lossless |
| Int32Array | lossless |
| Uint32Array | lossless |
| Float32Array | lossless |
| Float64Array | lossless |
| BigInt64Array | lossless |
| BigUint64Array | lossless |
| Float16Array | lossless |

## Limits

Peak RSS sampling can miss brief spikes shorter than 1 ms. External memory includes ArrayBuffer backing; the ArrayBuffer field is a subset, not additional memory. These are Node.js measurements.

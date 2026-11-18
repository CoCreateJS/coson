# CoSON Operator Processing Benchmark

Benchmark UTC: 2026-11-18T15:46:41.148Z
Source SHA-256: b3bce4ea8cd4d4b12883a004d5a2c1b2c6ad18cd5731b8e34613135aca92ef61
Environment: Node v24.18.0; linux/x64; exposed GC; heap limit 256 MiB.
Method: 3 warmup batches, 5 measured batches, 100 operations per batch. Latency is the median of batch averages. Retained memory is the median post-GC delta per operation; ArrayBuffer bytes are shown as a subset of external memory, not added to it. Run with: node --expose-gc --max-old-space-size=256 benchmarks/operators-only.js.
Workload: 50 properties per document; JSON, Extended and Mixed binary profiles at target sizes 10, 50 and 100 KiB. No competitor codecs were run.

## Round-trip and framing fidelity

| Profile | Target KiB | Actual approx KiB | Native frame B | Repacked frame B | Native + forwarded lossless | Input unchanged | Byte-identical frame |
|---|---:|---:|---:|---:|---|---|---|
| JSON | 10 | 10.0 | 10248 | 10248 | yes | yes | yes |
| JSON | 50 | 50.0 | 51209 | 51209 | yes | yes | yes |
| JSON | 100 | 100.0 | 102409 | 102409 | yes | yes | yes |
| Extended | 10 | 9.9 | 11803 | 11803 | yes | yes | yes |
| Extended | 50 | 49.9 | 52764 | 52764 | yes | yes | yes |
| Extended | 100 | 99.9 | 103964 | 103964 | yes | yes | yes |
| Mixed binary | 10 | 10.0 | 10406 | 10406 | yes | yes | yes |
| Mixed binary | 50 | 50.0 | 51364 | 51364 | yes | yes | yes |
| Mixed binary | 100 | 100.0 | 102564 | 102564 | yes | yes | yes |

## Latency at 10 KiB

Median across three profiles; ms/op.

| Operation | Median ms/op |
|---|---:|
| encode native | 0.1824 |
| decode native | 0.0376 |
| decode preserve | 0.0430 |
| encode prepared | 0.0934 |
| forward decode+encode | 0.1560 |

## Latency at 50 KiB

Median across three profiles; ms/op.

| Operation | Median ms/op |
|---|---:|
| encode native | 0.1744 |
| decode native | 0.0664 |
| decode preserve | 0.0725 |
| encode prepared | 0.1740 |
| forward decode+encode | 0.2552 |

## Latency at 100 KiB

Median across three profiles; ms/op.

| Operation | Median ms/op |
|---|---:|
| encode native | 0.2921 |
| decode native | 0.0924 |
| decode preserve | 0.1055 |
| encode prepared | 0.2945 |
| forward decode+encode | 0.3993 |

## Retained memory

Median across all nine datasets. Heap and external are reported separately; ArrayBuffer is a subset of external.

| Operation | Heap B/op | External B/op | ArrayBuffer B/op |
|---|---:|---:|---:|
| encode native | 208 | 155 | 51364 |
| decode native | 51568 | 0 | 0 |
| decode preserve | 51568 | 0 | 0 |
| encode prepared | 208 | 155 | 51364 |
| forward decode+encode | 208 | 155 | 51364 |

## Interpretation and limits

The `decode preserve` and `encode prepared` rows measure the two operators-disabled stages. `forward decode+encode` measures their combined intermediate transport path. Native round-trip and forwarded round-trip fidelity are verified separately with Node's strict deep comparison.

This run reports retained post-GC memory only; it does not measure peak RSS or transient peak heap. RSS sampling is intentionally omitted because this focused runner executes in one process. Results are Node-specific and synthetic; the byte-identical column checks the current deterministic fixtures and is not a general wire-compatibility guarantee.

# CoSON V6 Decode Reconstruction Cost

Benchmark UTC: 2026-11-18T12:15:01.993Z
Source SHA-256: 7a84180d2993c5ac0bfef0b6d34babf7ffadd18fe2be68988b5079458614e5a6
Environment: Node v24.18.0; linux/x64; 256 MiB; exposed GC.
Method: 3 warmup batches, 5 measured batches, 100 operations per batch. Latency is median of five batch averages. Memory workers are isolated by dataset and decode mode; RSS is sampled every 1 ms.

Every pair uses the same encoded frame bytes. One untimed encode creates each fixture payload; encoding is excluded from all measurements. Dataset matrix: 10/50/100 KiB, 20/50/100 properties, JSON, Extended, and Mixed binary.

Reconstruction overhead = decode(payload) minus decode(payload, { reconstruct: false }); percentage uses the no-reconstruction result as baseline. Positive means full reconstruction costs more; negative means it is faster or uses less memory. Retained total is heap + external. ArrayBuffer is shown separately as a subset of external and is not added again.

## Decode latency by profile and size

Each cell aggregates the three property counts by median. Overhead is the median paired difference across those property counts.

| Profile | KiB | Reconstruct ms/op | No reconstruction ms/op | Absolute overhead ms/op | Overhead % |
|---|---:|---:|---:|---:|---:|
| JSON | 10 | 0.0264 | 0.0267 | -0.0003 | -1.3% |
| JSON | 50 | 0.0590 | 0.0609 | -0.0019 | -3.2% |
| JSON | 100 | 0.0992 | 0.0992 | +0.0001 | +0.1% |
| Extended | 10 | 0.1098 | 0.0404 | +0.0694 | +171.9% |
| Extended | 50 | 0.1395 | 0.0739 | +0.0656 | +88.7% |
| Extended | 100 | 0.1817 | 0.1159 | +0.0658 | +56.8% |
| Mixed binary | 10 | 0.0371 | 0.0281 | +0.0090 | +32.1% |
| Mixed binary | 50 | 0.0662 | 0.0545 | +0.0115 | +19.2% |
| Mixed binary | 100 | 0.0951 | 0.0854 | +0.0115 | +13.1% |

## Decode memory by profile and size

Peak RSS uses isolated worker increases. Retained columns report heap / external / ArrayBuffer bytes per operation; ArrayBuffer is part of external.

| Profile | KiB | Peak RSS full / raw MiB | Peak overhead MiB / % | Retained total full / raw B/op | Retained overhead B/op / % | Retained AB full / raw B/op |
|---|---:|---:|---:|---:|---:|---:|
| JSON | 10 | 2.79 / 2.94 | -0.133 / -4.6% | 21396 / 21396 | 0.0 / 0.0% | 0 / 0 |
| JSON | 50 | 21.47 / 21.25 | +0.512 / +2.4% | 103445 / 103445 | 0.0 / 0.0% | 0 / 0 |
| JSON | 100 | 43.79 / 43.77 | -0.016 / -0.0% | 205717 / 205717 | 0.0 / 0.0% | 0 / 0 |
| Extended | 10 | 8.98 / 3.14 | +4.359 / +139.4% | 23015 / 23455 | -440.2 / -1.9% | 0 / 0 |
| Extended | 50 | 26.42 / 21.68 | +4.109 / +18.8% | 104940 / 105368 | -427.8 / -0.4% | 0 / 0 |
| Extended | 100 | 48.89 / 44.12 | +4.777 / +10.8% | 207340 / 207776 | -435.9 / -0.2% | 0 / 0 |
| Mixed binary | 10 | 2.60 / 2.18 | +0.434 / +20.0% | 20509 / 19723 | +784.9 / +4.0% | 11056 / 0 |
| Mixed binary | 50 | 19.32 / 18.38 | +0.844 / +4.6% | 96957 / 93441 | +3515.2 / +3.8% | 54745 / 0 |
| Mixed binary | 100 | 40.68 / 39.71 | +0.984 / +2.5% | 192250 / 185322 | +6928.2 / +3.7% | 109358 / 0 |

## Full reconstruction fidelity

`decode(payload)` was compared with the original object; no-reconstruction output is an intermediate representation and is not expected to restore native types.

| Profile | Exact round trips |
|---|---:|
| JSON | 9/9 |
| Extended | 9/9 |
| Mixed binary | 9/9 |

## Limits

RSS sampling can miss peaks shorter than 1 ms. Memory figures are Node.js estimates; external memory includes ArrayBuffer backing. The ArrayBuffer column is informational and not additive.

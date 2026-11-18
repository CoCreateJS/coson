# COSON

**JavaScript serialization that keeps the types your application actually uses.**

COSON is a dependency-free ESM module for browser and Node.js applications. It serializes structured JavaScript values with collision-safe type operators and places binary values in raw, length-prefixed sections of the same `Uint8Array` payload.

```sh
npm install @cocreate/coson
```

```js
import { encode, decode } from "@cocreate/coson";

const message = {
    id: "request-123",
    createdAt: new Date(),
    count: 123n,
    values: new Map([["active", true]]),
    bytes: new Uint8Array([0, 128, 255])
};

const payload = encode(message); // Uint8Array
const restored = decode(payload);
```

The browser and Node.js use the same ESM entry point. COSON relies on built-in JavaScript APIs and has no runtime package dependencies.

## Why COSON

Many application records are small or medium-sized, and serialization performance depends on their shape as much as their byte length. COSON is designed for applications that need dependable JavaScript type preservation, efficient decoding, and direct handling of binary values.

- **Preserves JavaScript values:** dates, `BigInt`, `Map`, `Set`, `RegExp`, `undefined`, `NaN`, infinities, negative zero, and typed binary values retain their type and value.
- **Keeps binary raw:** binary payloads are not converted to Base64 or numeric arrays.
- **Decodes typed arrays with views:** when alignment permits, decoded typed arrays reference the encoded payload rather than copying their bytes.
- **Runs in browser and Node.js:** one portable implementation, with no Node-only serializer.

## How it compares

We benchmarked COSON against CBOR-X and BSON on identical inputs. Two benchmark views are useful, and they measure different implementations:

1. **The package implementation** adds a typed skeleton and SplitBinary framing so it can preserve the full supported value set and raw binary.
2. **COSON Inline Hybrid** is a structured-only performance study of native JSON preprocessing without binary framing. It helps explain how object shape affects the JSON strategy, but its timings are not timings for the package entry point.

### Current package: 32 KiB common-values case

This dataset had 34 properties, eight array entries, and no binary values. Every codec reconstructed it losslessly. Times are milliseconds; lower is faster.

| Codec | Encode | Decode | Round trip | Encoded bytes | Retained JS heap | Retained backing |
|---|---:|---:|---:|---:|---:|---:|
| COSON (Inline Hybrid + SplitBinary) | 0.482 | 0.283 | 0.812 | 33,326 | 37.1 KiB | 32.5 KiB |
| CBOR-X | **0.107** | **0.182** | **0.335** | **32,643** | **6.2 KiB** | 380 KiB |
| BSON | 0.110 | 0.417 | 0.577 | 32,817 | 37.5 KiB | 32.0 KiB |

Here COSON decoded about **32% faster than BSON**, while its complete round trip was about **41% slower**. CBOR-X had the fastest encoding, decoding, and round trip in this case. COSON retained much less backing storage than CBOR-X, but more JavaScript heap; its backing storage and heap were close to BSON. This is one workload sample, not a general memory guarantee.

### Structured-only Inline Hybrid: shape and crossover

The separate crossover study tested ordinary and mixed objects with 32 keys, plus content-heavy objects with seven fixed keys and longer strings. At 32 KiB, all three participants were lossless. Times are median milliseconds from three measured runs after two warmups.

| Dataset shape | Codec | Encode | Decode | Round trip |
|---|---|---:|---:|---:|
| Ordinary object, 32 keys | COSON Inline Hybrid | 0.417 | **0.174** | 0.592 |
|  | CBOR-X | **0.095** | 0.229 | **0.308** |
|  | BSON | 0.137 | 0.490 | 0.615 |
| Mixed values, 32 keys | COSON Inline Hybrid | 0.439 | **0.187** | 0.641 |
|  | CBOR-X | **0.109** | 0.235 | **0.352** |
|  | BSON | 0.142 | 0.478 | **0.624** |
| Content-heavy object, 7 keys | COSON Inline Hybrid | 0.224 | 0.096 | 0.321 |
|  | CBOR-X | 0.075 | **0.080** | **0.155** |
|  | BSON | **0.069** | 0.265 | 0.350 |

In this structured-only study, COSON Inline Hybrid decoded about **61–65% faster than BSON** at 32 KiB. Its round trip was about **4% faster** on ordinary objects and **8% faster** on content-heavy objects, and about **3% slower** on mixed objects. CBOR-X had the fastest round trip in all three cases. The crossover runs found COSON Inline Hybrid decoding faster than CBOR-X through 64 KiB on ordinary and mixed objects; with content-heavy objects, CBOR-X was already faster at 32 KiB. Encoding was slower for COSON Inline Hybrid across the tested profiles and sizes.

This points to a possible fit for decode-heavy workloads, especially when objects have fewer keys and larger strings. The direct Inline Hybrid results should not be used as a speed claim for the packaged SplitBinary implementation, which does extra work to preserve the broader type set and binary framing.

### Memory and binary tradeoffs

For the package's 32 KiB common-values case, COSON retained about **37.1 KiB of JavaScript heap** and **32.5 KiB of backing storage**. CBOR-X retained about **6.2 KiB of heap** and **380 KiB of backing storage**; BSON retained about **37.5 KiB of heap** and **32.0 KiB of backing storage**. Peak memory depends on the runtime and sampling window, so the benchmark reports heap and backing storage separately.

COSON can decode typed arrays as views into the encoded payload, avoiding a separate copy of those bytes. That can reduce duplicate backing storage, but a small retained view also keeps the entire encoded payload alive. Copy a decoded view when it needs to outlive a large payload. The external codecs did not pass lossless round trips for the tested binary datasets, so the benchmark does not claim a binary-memory or speed win over them.

### Type coverage

In the comprehensive structured and binary round-trip suite, COSON reconstructed **42 of 42** tested dataset and codec pairs losslessly. CBOR-X and BSON each reconstructed **9 of 42**. Those totals include values such as `undefined`, negative zero, `RegExp.lastIndex`, maps, sets, and typed binary data that are not losslessly supported by every participant. We compare speed only when all codecs in a case pass the same round-trip check; the coverage totals describe type support, not equal-workload performance.

The structured-only crossover benchmark uses values supported losslessly by all three codecs. Its ordinary and mixed datasets contain 32 top-level keys; its content-heavy profile uses seven fixed keys and grows large string fields instead of adding keys. Runs used Node.js 24 on Linux, with two warmups, three measured runs, and garbage collection before samples. Browser performance and application-specific results may differ.

## Supported values

- `null`, `undefined`, booleans, strings, and numbers, including `NaN`, infinities, and negative zero
- `BigInt`, `Date` (including invalid dates), `RegExp` including `lastIndex`, `Map`, and `Set`
- Plain objects with string keys and arrays
- `ArrayBuffer` and signed, unsigned, clamped, floating-point, and BigInt typed arrays where available

Binary bytes remain raw in the encoded frame. Decoded typed arrays are views into the frame where alignment permits. A decoded `ArrayBuffer` is copied to preserve its standalone buffer boundaries.

## Limitations

- Circular references and repeated/shared object references are rejected; object identity is not preserved.
- Sparse arrays, enumerable symbol keys, accessor properties, class instances, `DataView`, and unsupported typed-array kinds are rejected.
- Functions, symbols, and other unsupported primitive values are rejected.
- Plain object prototypes are normalized to `Object.prototype`; custom prototypes are not preserved.
- The frame is versioned. Use COSON's `encode` and `decode` as a matched pair; malformed or unknown frames throw.

See the [format specification](specifications/format.md) for the frame layout and operator rules.

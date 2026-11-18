# COSON

**Lossless JavaScript serialization, designed for efficient servers.**

COSON is a dependency-free ESM encoder and decoder for browser and Node.js applications. It preserves supported JavaScript types, including binary data, and keeps the serialized structured content readable.

Install with npm:

    npm install @cocreate/coson

    import { encode, decode } from "@cocreate/coson";

    const request = {
        id: "request-123",
        createdAt: new Date(),
        count: 123n,
        values: new Map([["active", true]]),
        bytes: new Uint8Array([0, 128, 255])
    };

    const payload = encode(request); // Uint8Array
    const restored = decode(payload);

The same ESM entry works in browsers and Node.js. COSON uses native JavaScript APIs and has no runtime package dependencies.

## Designed for the server

COSON is designed for applications where the client can spend a little more time encoding so the server can decode efficiently and handle many requests with less avoidable memory allocation. At scale, memory held by each server process affects how much concurrent work it can support.

COSON supports binary values and can decode typed arrays as views into the encoded payload when alignment permits, avoiding a separate copy of binary bytes. The structured content is UTF-8 JSON and remains readable, which makes it possible to inspect or use some values on the server without reconstructing every JavaScript type.

## Benchmark snapshot

We compared COSON with CBOR-X and BSON using the same 32 KiB JavaScript object with 34 properties, eight array entries, and no binary values. All three reconstructed this dataset losslessly. Times are milliseconds; memory figures show retained values after the benchmark operation and garbage collection.

| Codec | Encode | Decode | Round trip | Encoded bytes | Retained heap | Retained backing | Combined retained |
|---|---:|---:|---:|---:|---:|---:|---:|
| COSON | 0.482 | 0.283 | 0.812 | 33,326 | 37.1 KiB | 32.5 KiB | 102.2 KiB |
| CBOR-X | **0.107** | **0.182** | **0.335** | **32,643** | **6.2 KiB** | 380 KiB | **6.2 KiB** |
| BSON | 0.110 | 0.417 | 0.577 | 32,817 | 37.5 KiB | 32.0 KiB | 69.6 KiB |

In this sample, COSON decoded about **32% faster than BSON**, while its encoding took longer and its full round trip was about **41% slower**. CBOR-X was fastest overall in this case. COSON retained less backing storage than CBOR-X, but its combined retained memory was higher. Memory results depend on the workload and on which measure is considered; this sample does not show lower total memory in every comparison.

The design favors decode efficiency and avoids copying raw binary when possible. That tradeoff can be useful when data is encoded on clients and decoded or inspected repeatedly on servers. Validate the benefit against your own server workload, concurrency, and payload sizes.

## Readable data

COSON's structured representation is UTF-8 JSON. Server code can read it to route, validate, or work with string content without reconstructing every value as a JavaScript object. Values that need native JavaScript behavior, such as Date, Map, Set, or typed arrays, should be restored with decode.

## Lossless type support

COSON preserves the following supported values and structures:

- null, undefined, booleans, strings, and numbers, including NaN, infinities, and negative zero
- BigInt, Date (including invalid dates), RegExp including lastIndex, Map, and Set
- Plain objects with string keys, and arrays
- ArrayBuffer and signed, unsigned, clamped, floating-point, and BigInt typed arrays where available

In the comprehensive round-trip suite, COSON successfully reconstructed **42 of 42** tested dataset and codec pairs. CBOR-X and BSON each reconstructed **9 of 42**. These coverage tests include values that the competing codecs cannot all preserve, so coverage totals are separate from equivalent-type speed comparisons.

## Limitations

- Circular references and repeated/shared object references are rejected; object identity is not preserved.
- Sparse arrays, enumerable symbol keys, accessor properties, class instances, DataView, and unsupported typed-array kinds are rejected.
- Functions, symbols, and other unsupported primitive values are rejected.
- Custom object prototypes are not preserved; plain objects decode with Object.prototype.
- A small decoded typed-array view can keep the full encoded payload in memory. Copy the view if it must outlive a larger payload.
- The format is versioned. Use COSON's encode and decode as a matched pair; malformed or unknown data throws.

See the [format specification](specifications/format.md) for details.

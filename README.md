# CoSON

### CoCreate Object Serialization Notation

**One format. Two functions. Zero dependencies.**

CoSON is a lightweight, schemaless, self-contained JavaScript serialization format engineered for **lossless native type preservation, raw binary transport, and memory-efficient server-side decoding**.

Designed for distributed systems at scale, CoSON combines native JSON processing, inline type operators, raw binary framing, and indexed reconstruction to minimize unnecessary processing and memory allocation.

Unlike approaches that optimize encoding and decoding equally, CoSON deliberately prioritizes decoding efficiency. In client-server architectures, encoding work can be distributed across client devices while decoding costs accumulate on shared server infrastructure.

**Encode at the edge. Decode at scale.**

**Preserve the structure. Preserve the types. Preserve the binary.**

## Memory efficiency is infrastructure efficiency

Serialization has a direct impact on server resource consumption.

Every unnecessary allocation competes with application workloads, concurrent connections, caches, and other processes. At scale, reducing serialization overhead can increase server capacity, reduce garbage collection pressure, and potentially lower infrastructure costs.

CoSON is engineered around that reality.

### Memory and performance comparison

A 32 KiB JSON-compatible object, containing 34 properties and eight array entries, was serialized and reconstructed losslessly by CoSON, CBOR-X, and BSON.

| Metric | CoSON | CBOR-X | BSON |
| --- | ---: | ---: | ---: |
| Retained JS heap | 37.1 KiB | **6.2 KiB** | 37.5 KiB |
| Retained binary backing | 32.5 KiB | 380 KiB | **32.0 KiB** |
| **Combined retained memory** | **69.6 KiB** | 386.2 KiB | **69.5 KiB** |
| Decode latency | 0.283 ms | **0.182 ms** | 0.417 ms |
| Encode latency | 0.482 ms | **0.107 ms** | 0.110 ms |
| Encoded payload | 33,326 B | **32,643 B** | 32,817 B |

**In this measured workload:**

- CoSON retained approximately **82% less combined reported memory than CBOR-X**.
- CoSON decoded approximately **32% faster than BSON**, with nearly identical combined retained memory.
- In separate exact-fidelity benchmarks, **CoSON preserved all 27/27 datasets (100%)**, compared with **9/27 (33.3%) for CBOR-X** and **9/27 (33.3%) for BSON**. CoSON also passed **16/16 additional native-type tests**, compared with 14/16 for CBOR-X and 1/16 for BSON, under the tested configurations.
- CBOR-X achieved the fastest encoding and decoding latency.
- CoSON required additional encoding time, consistent with its server-first optimization priorities.

Combined retained memory is the sum of the reported retained JavaScript heap and binary backing storage. It is not peak process memory or peak RSS.

These measurements come from an earlier CoSON implementation and a specific equivalent-type workload. They are not universal performance guarantees or a direct comparison of the current indexed implementation.

### Why server-side memory matters

Consider a distributed application serving thousands of clients.

Each client can encode its own requests, but the receiving servers must collectively decode and process those requests.

Reducing the resources required per operation can create opportunities for:

- Higher concurrent workload capacity.
- Lower allocation and garbage collection pressure.
- More memory available for application data and caching.
- Reduced infrastructure requirements.
- Lower operating costs at sustained scale.

Actual savings depend on concurrency, payload composition, memory lifetimes, garbage collection behavior, and the surrounding application.

**CoSON is designed to optimize the resources required to process data, not merely the time required to serialize it.**

## Why CoSON?

CoSON combines capabilities that are often evaluated separately when selecting a serialization format.

| Capability | CoSON approach |
| --- | --- |
| Native type fidelity | Preserves supported JavaScript values without custom handlers |
| Server efficiency | Prioritizes decoding and memory-conscious processing |
| Binary transport | Stores raw binary without Base64 conversion |
| Structural readability | Retains UTF-8 JSON inside the serialized envelope |
| Indexed reconstruction | Uses encoder-generated metadata to guide decoding |
| Schemaless operation | Requires no predefined schemas |
| Self-contained payloads | Includes type metadata and binary content |
| Portability | Works across compatible JavaScript runtimes |
| Minimal integration | Two primary functions and no external dependencies |

**Binary where it matters. JSON where it excels.**

## Installation

```bash
npm install @cocreate/coson
```

## Getting started

```javascript
import { encode, decode } from "@cocreate/coson";

const request = {
    id: "request-123",
    createdAt: new Date(),
    count: 123n,
    values: new Map([["active", true]]),
    bytes: new Uint8Array([0, 128, 255])
};

const payload = encode(request);
const restored = decode(payload);

console.log(restored.createdAt instanceof Date); // true
console.log(typeof restored.count);               // bigint
console.log(restored.values instanceof Map);      // true
console.log(restored.bytes instanceof Uint8Array); // true
```

`encode()` converts supported JavaScript values into a self-contained `Uint8Array`.

`decode()` reconstructs their supported native types and structures.

No schema definitions, type registration, or external metadata are required.

## Design principles

CoSON is built around six principles.

| Principle | Objective |
| --- | --- |
| Lossless | Preserve supported native JavaScript types and values |
| Efficient | Minimize avoidable processing, allocation, and copying |
| Readable | Retain structured content as standard JSON |
| Self-contained | Include type information and binary data within each payload |
| Portable | Maintain consistent serialization across compatible environments |
| Simple | Expose a minimal API without external dependencies |

These principles guide both the wire format and its implementation.

## Server-first architecture

**Performance is measured in time. Scalability is measured in capacity. Efficiency is measured in both.**

Serialization is frequently benchmarked as a pair of operations: encoding and decoding.

In distributed applications, however, the infrastructure cost of those operations may be very different.

Client-side encoding can be distributed across independent devices. Server-side decoding often takes place within a smaller pool of shared compute resources.

CoSON is engineered with this asymmetry in mind.

Rather than minimizing encoding time at every cost, its architecture permits additional encoder work when that can simplify or reduce decoder work.

A CoSON payload can be encoded once and subsequently received, inspected, routed, persisted, replicated, and redistributed across multiple systems.

Not every stage requires complete native object reconstruction.

### Encoder-generated reconstruction index

**The encoder discovers. The decoder reconstructs.**

During serialization, CoSON can generate an index identifying the locations of encoded native types.

The decoder uses this metadata to locate values requiring reconstruction without recursively searching the entire parsed structure.

When an index is unavailable, recursive reconstruction remains supported.

```javascript
const payload = encode(value);
const restored = decode(payload);
```

Index handling is automatic and does not require callers to manage reconstruction paths.

The index introduces some encoding work and payload overhead. Its effectiveness depends on the number and distribution of values requiring reconstruction.

### Operator processing and deferred reconstruction

`operators` controls whether CoSON converts native JavaScript values to and from CoSON operators. It defaults to `true` for both encoding and decoding.

| Method | `operators` | Behavior |
|---|---|---|
| `encode` | `true` (default) | Convert native values to operators and build a transport frame. |
| `encode` | `false` | Transport an already prepared operator representation and its root binary sections without converting non-binary operators. |
| `decode` | `true` (default) | Reconstruct supported native JavaScript values. |
| `decode` | `false` | Preserve operators and expose binary sections through root `$binary` metadata when present. |
| `decode` | `"binary"` | Reconstruct binary values while preserving non-binary operators. |

The value `"binary"` is decode-only. The earlier `reconstruct` decode option remains available for backward compatibility; a non-nullish `operators` option takes precedence, otherwise the legacy option is consulted.

```javascript
const frame = encode(value, { operators: true });
const restored = decode(frame, { operators: true });

// Preserve the CoSON operator representation for inspection or forwarding.
const prepared = decode(frame, { operators: false });
```

With `operators: false`, decoding leaves non-binary operator objects intact. Binary wire operators become direct string references, and raw binary bytes are attached to the original root object as typed descriptors:

For example, a message with two binary values is returned in this shape:

```javascript
{
    method: "upload",
    created: { $date: 1767225600000 },
    image: "$binary[0]",
    pixels: "$binary[1]",
    $binary: [
        { $Uint8Array: bytes0 },
        { $Uint16Array: bytes1 }
    ]
}
```

```javascript
const prepared = decode(payload, { operators: false });
const imageReference = prepared.image; // "$binary[0]"
const imageBytes = prepared.$binary[0].$Uint8Array;
const pixelBytes = prepared.$binary[1].$Uint16Array;
```

Each descriptor key preserves the encoded binary type. The descriptor value is raw bytes, not a reconstructed typed array. Available keys are `$ArrayBuffer`, `$Int8Array`, `$Uint8Array`, `$Uint8ClampedArray`, `$Int16Array`, `$Uint16Array`, `$Int32Array`, `$Uint32Array`, `$Float32Array`, `$Float64Array`, `$BigInt64Array`, `$BigUint64Array`, `$DataView`, `$Float16Array`, and `$Buffer`. `$Float16Array` is available when the runtime provides `Float16Array`; `$Buffer` requires the global Node.js `Buffer` constructor and a matching Buffer value.

| Native binary type | Descriptor operator |
|---|---|
| ArrayBuffer | `$ArrayBuffer` |
| Int8Array, Uint8Array, Uint8ClampedArray | `$Int8Array`, `$Uint8Array`, `$Uint8ClampedArray` |
| Int16Array, Uint16Array, Int32Array, Uint32Array | `$Int16Array`, `$Uint16Array`, `$Int32Array`, `$Uint32Array` |
| Float16Array, Float32Array, Float64Array | `$Float16Array`, `$Float32Array`, `$Float64Array` |
| BigInt64Array, BigUint64Array | `$BigInt64Array`, `$BigUint64Array` |
| DataView, Buffer | `$DataView`, `$Buffer` |

The references and descriptors are an in-memory representation, not another CoSON wire format. `encode(prepared, { operators: false })` accepts this prepared form and converts the references back to wire-level binary operators. CoSON does not execute non-binary operators or evaluate reference strings.

With binary sections, the decoded root must be a non-array object that is not itself an operator and has no own `$binary` property. A literal string matching the canonical reference form, such as `"$binary[0]"`, is reserved in this prepared representation: decoding with operators disabled rejects it to prevent ambiguity. The root `$binary` property is reserved for transport metadata. With no binary sections, `decode(..., { operators: false })` returns the parsed structured value unchanged.

Creating the representation still parses JSON, traverses the object, and allocates reference strings and descriptor containers. The raw byte views share and retain the payload's backing memory; copy bytes when independent ownership is required or when retaining the full payload is undesirable. This mode should not be assumed to have zero processing or allocation cost.

### Symmetrical operator-preserving transport

An application can forward or modify a prepared envelope and package it into another frame without reconstructing native application values in between:

```javascript
const incoming = encode(message); // Native values -> frame
const prepared = decode(incoming, { operators: false });

prepared.server = destination;

const outgoing = encode(prepared, { operators: false });
const received = decode(outgoing, { operators: true });
```

`prepared` and a subsequent `decode(outgoing, { operators: false })` contain equivalent operator structures and binary contents. Object and byte-view identity is not guaranteed. The full lifecycle is:

```text
Native JavaScript
  → encode(operators: true)
  → CoSON frame
  → decode(operators: false)
  → operator representation + root $binary metadata
  → application processing / routing / storage
  → encode(operators: false)
  → CoSON frame
  → decode(operators: true)
  → Native JavaScript
```

This supports deferred reconstruction patterns for routing, authorization, workflow processing, CRUD handling, storage, replication, and forwarding. CoSON supplies the representation; it does not itself implement these application integrations or execute CoCreateJS AST operators.

`encode(value, { operators: false })` expects an already prepared, JSON-compatible operator representation. It extracts raw bytes from root `$binary` descriptors, removes that non-empty metadata container from the structured JSON, converts valid direct binary references to the existing wire marker, preserves other operators, and builds the frame. It does not perform native JavaScript type conversion. The input object is not mutated. Binary sections must use supported descriptor keys with raw `Uint8Array` bytes; every section must be referenced, references must be valid, and multibyte payload lengths must meet their type's alignment requirement.

The prepared binary path requires a non-array object root. Root arrays and root binary values can use the regular `operators: true` serialization and reconstruction path. Do not add literal strings in the reserved `"$binary[index]"` form to a prepared object: the encoder interprets a valid index as a binary reference and rejects invalid or unavailable indexes.

An empty `$binary: []` is not treated as a binary section container by the current encoder and remains ordinary structured data. Do not use it as a prepared binary envelope.

Disabling operator processing does not disable framing or all structured work. CoSON still inspects references, serializes JSON, and can generate reconstruction indexes. Frame construction allocates output storage and copies structured and binary bytes. No benchmark claims are made here for this mode.

## Serialization architecture

**Native JavaScript. Native JSON. Raw binary.**

CoSON combines three mechanisms within one versioned serialization format.

### 1. Native JSON

Structured content is represented as UTF-8 JSON and processed using native JavaScript JSON capabilities.

This provides an established representation for ordinary objects and arrays without requiring a custom binary object parser.

### 2. Inline type operators

Values that JSON cannot represent faithfully use inline type operators.

For example:

```javascript
const value = {
    count: 123n,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
};
```

The structured representation conceptually contains:

```json
{
    "count": {
        "$bigint": "123"
    },
    "createdAt": {
        "$date": "2026-01-01T00:00:00.000Z"
    }
}
```

Type information remains associated with the corresponding value.

CoSON also distinguishes encoded operators from ordinary application objects containing reserved operator names.

### 3. Raw binary framing

Binary values are stored in dedicated raw binary sections.

The structured JSON contains references to those sections rather than embedding binary as Base64 strings.

This preserves binary data without requiring binary-to-text conversion.

### Versioned binary envelope

Conceptually:

```text
┌────────────────────────────────┐
│ CoSON header                   │
│ Version and framing metadata   │
├────────────────────────────────┤
│ Structured UTF-8 JSON          │
│ Inline native type operators   │
├────────────────────────────────┤
│ Reconstruction metadata        │
│ When present                   │
├────────────────────────────────┤
│ Raw binary sections            │
│ Binary values and typed arrays │
└────────────────────────────────┘
```

The diagram illustrates the logical components, not their exact byte order.

The complete payload is binary, while its structured section remains JSON.

See the [format specification](specifications/format.md) for precise encoding, framing, and compatibility rules.

## Native binary support

**CoSON stores binary as binary.**

JSON-based transport commonly requires binary values to be converted into text, often using Base64.

Base64 increases encoded binary size by approximately 33%, excluding surrounding metadata and intermediate processing overhead.

CoSON avoids this conversion by storing binary values as raw bytes within its serialized envelope.

Benefits include:

- No Base64 inflation.
- No binary-to-text conversion.
- No external binary references.
- Self-contained transport of structured and binary content.
- Zero-copy reconstruction for compatible binary views.

### Zero-copy decoding

When alignment and buffer compatibility permit, CoSON can reconstruct typed arrays as views into the existing encoded payload.

This avoids allocating and copying an additional binary backing buffer.

```javascript
const original = {
    bytes: new Uint8Array([1, 2, 3, 4])
};

const payload = encode(original);
const restored = decode(payload);
```

Zero-copy reconstruction is conditional. Some binary types or buffer layouts require copying.

A decoded view may retain the original payload's entire backing buffer. Applications requiring independent memory ownership should copy the relevant bytes.

## Lossless by default

**Serialize the value. Not just its representation.**

Standard JSON supports a limited subset of JavaScript's native data model.

CoSON extends that foundation to preserve supported JavaScript types, structures, and special values.

### Supported data types

| Category | Supported types and values |
| --- | --- |
| Primitives | `null`, `undefined`, `boolean`, `string`, `number` |
| Special numbers | `NaN`, `Infinity`, `-Infinity`, `-0` |
| Large integers | `BigInt` |
| Objects | Plain objects with string keys |
| Collections | `Array`, `Map`, `Set` |
| Dates | `Date`, including invalid dates |
| Regular expressions | `RegExp`, including `lastIndex` |
| Binary buffers | `ArrayBuffer`, Node.js `Buffer` |
| Binary views | `DataView` |
| Signed integers | `Int8Array`, `Int16Array`, `Int32Array` |
| Unsigned integers | `Uint8Array`, `Uint16Array`, `Uint32Array` |
| Clamped integers | `Uint8ClampedArray` |
| Floating point | `Float32Array`, `Float64Array`, `Float16Array` where available |
| BigInt arrays | `BigInt64Array`, `BigUint64Array` where available |

Supported values can be nested inside supported objects, arrays, Maps, and Sets.

Losslessness refers to the supported data model. Arbitrary JavaScript objects, executable behavior, and shared reference identity are outside its current scope.

## Type fidelity benchmarks

CoSON was evaluated against CBOR-X and BSON using exact round-trip fidelity checks.

A successful round trip requires the decoded result to preserve the tested native values and types, rather than merely producing a structurally similar object.

### Comprehensive workload tests

| Codec | Lossless datasets | Total datasets | Success |
| --- | ---: | ---: | ---: |
| **CoSON** | **27** | **27** | **100%** |
| CBOR-X | 9 | 27 | 33.3% |
| BSON | 9 | 27 | 33.3% |

### Additional native-type tests

| Codec | Lossless tests | Total tests |
| --- | ---: | ---: |
| **CoSON** | **16** | **16** |
| CBOR-X | 14 | 16 |
| BSON | 1 | 16 |

These results reflect the tested codec configurations and exact fidelity criteria.

Other codec configurations, extension handlers, or different fidelity requirements may produce different results.

Fidelity comparisons are separate from performance comparisons. Performance should be compared using workloads where each codec reconstructs equivalent values.

## Decoding performance

CoSON's server-first architecture makes decoding latency and memory behavior primary performance considerations.

### Current indexed implementation

The current experimental indexed implementation was benchmarked using:

| Property | Configuration |
| --- | --- |
| Runtime | Node.js v24.18.0 |
| Platform | Linux x64 |
| V8 heap limit | 256 MiB |
| Warmup batches | 3 |
| Measured batches | 5 |
| Operations per batch | 100 |
| Garbage collection | Exposed |
| Dataset sizes | 10, 50, 100 KiB |
| Profiles | JSON, extended types, mixed binary |

Median latency across the tested datasets at each document size:

| Document size | Encode | Decode |
| --- | ---: | ---: |
| 10 KiB | 0.0975 ms | **0.0366 ms** |
| 50 KiB | 0.1742 ms | **0.0709 ms** |
| 100 KiB | 0.3275 ms | **0.1102 ms** |

All 27 workload datasets passed exact round-trip fidelity checks.

### Reconstruction overhead

CoSON also benchmarks decoding with and without native type reconstruction.

The following measurements use 100 KiB payloads.

| Profile | Full decode | No reconstruction | Additional reconstruction cost |
| --- | ---: | ---: | ---: |
| JSON | 0.0992 ms | 0.0992 ms | ~0 ms |
| Extended types | 0.1817 ms | 0.1159 ms | 0.0658 ms |
| Mixed binary | 0.0951 ms | 0.0854 ms | 0.0115 ms |

The additional cost includes reconstruction-index processing and native type restoration.

The results show:

- Ordinary JSON incurs effectively no additional reconstruction cost.
- Mixed binary reconstruction adds relatively little processing time.
- Extended native types require more reconstruction work.
- Envelope processing, UTF-8 conversion, and JSON parsing remain part of both decoding modes.

These measurements help identify where decoding optimizations have the greatest potential impact.

### Performance objectives

CoSON is not designed to win every individual serialization benchmark.

Its priorities are:

1. Exact preservation of supported native values.
2. Efficient server-side decoding.
3. Memory-conscious processing.
4. Raw binary transport.
5. Readable structured representations.
6. Minimal integration complexity.

A codec may encode faster while requiring more memory, or decode faster while preserving fewer native types under a particular configuration.

CoSON is designed to balance these considerations for real application and infrastructure workloads.

## One format across the data lifecycle

**Encode once. Inspect, persist, route, and distribute.**

CoSON is independent of any particular storage engine, transport protocol, or cloud provider.

The same serialized representation can move between application and infrastructure boundaries.

| Environment | Applications |
| --- | --- |
| Browser | Application state and client-side persistence |
| HTTP | Request and response payloads |
| WebSocket | Real-time communication |
| Server | Request processing and application logic |
| Database | Document and object persistence |
| Filesystem | Serialized files and documents |
| Object storage | Cloud and distributed persistence |
| Workers | Inter-process communication |
| Server mesh | State synchronization and message routing |
| Distributed systems | Replication and data exchange |

Applications can retain or forward encoded payloads when native reconstruction is unnecessary.

This can avoid repeated serialization and deserialization at intermediate processing stages.

## Schemaless and self-contained

CoSON requires no predefined schemas or shared serialization state.

Each encoded payload contains the information required to reconstruct its supported values using a compatible decoder.

Applications do not need to synchronize record definitions, register custom handlers for supported native types, or maintain external type metadata.

This makes payloads independently usable across processes, machines, and compatible JavaScript environments.

## Content type and file extension

CoSON uses the file extension:

```text
.coson
```

A proposed vendor MIME type is:

```text
application/vnd.cocreatejs.coson
```

This identifier can be used in content-type registries, HTTP APIs, storage metadata, and application-level codec selection.

For example:

```http
Content-Type: application/vnd.cocreatejs.coson
```

The MIME type identifies the format. It does not automatically download a decoder, identify a domain, or authorize execution of remote JavaScript.

A future codec registry or discovery service could separately associate the MIME type with a trusted decoder implementation or remote decoding endpoint.

The proposed MIME type should not be treated as formally registered unless registration is completed.

## Runtime compatibility

CoSON uses ECMAScript modules and standard JavaScript APIs.

It targets:

- Node.js.
- Modern browsers.
- Compatible JavaScript runtimes supporting the required APIs.

No native bindings, platform-specific binaries, or external runtime dependencies are required.

Some native types, such as Node.js `Buffer` and `Float16Array`, depend on runtime availability.

## Limitations

CoSON provides lossless serialization for its supported JavaScript data model.

Current limitations include:

- Circular references are rejected.
- Repeated or shared object references are rejected.
- Object reference identity is not preserved.
- Sparse arrays and enumerable symbol keys are unsupported.
- Accessor properties and arbitrary class instances are unsupported.
- Functions, symbols, and executable behavior are not serialized.
- Custom object prototypes are not preserved.
- Shared-memory semantics are not preserved.
- `Blob`, `File`, streams, and asynchronous binary sources are not supported by the synchronous encoder.
- Zero-copy reconstruction depends on alignment and buffer compatibility.
- A small decoded binary view may retain the entire original payload buffer.
- The complete CoSON payload is binary, not a standalone JSON document.
- Unsupported format versions and malformed payloads cause decoding errors.

The format is versioned to support controlled evolution and compatibility handling.

## Project

CoSON is developed as an independent serialization primitive within the [CoCreateJS](https://github.com/CoCreateJS) ecosystem.

It is designed to support CoCreate infrastructure while remaining independently usable in compatible JavaScript applications.

CoSON is not tied to a particular database, framework, communication protocol, or cloud provider.

- [GitHub repository](https://github.com/CoCreateJS/coson)
- [npm package](https://www.npmjs.com/package/@cocreate/coson)
- [Format specification](specifications/format.md)

---

**One format. Two functions. Zero dependencies.**

**Encode at the edge. Decode at scale.**

Designed for memory efficiency. Built for distributed systems.

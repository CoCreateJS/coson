
# CoSON Format Specification

CoCreate Object Serialization Notation

## 1. Overview

CoSON is a binary-framed object serialization format designed to preserve structured data, native JavaScript types, and raw binary content.

The format combines:

- Native JSON structured representation.
- Inline type operators.
- Raw binary sections.
- Optional reconstruction indexing.
- Alignment-aware binary reconstruction.

The public `operators` option independently controls native-value/operator conversion. Operator processing, binary framing, and native reconstruction are separate concerns: a frame can carry raw binary sections while a decoded value preserves its operator representation.

Ordinary JSON-compatible values retain their natural representation. Extended types are represented using reserved strings and inline operator objects.

Binary content is stored independently of the structured representation without Base64 encoding or numeric-array conversion.

The format is independent of the underlying transport, runtime, and storage medium.

## 2. Binary Envelope

A CoSON payload is represented as a contiguous sequence of bytes.

The envelope consists of:

| Section | Encoding |
|---|---|
| Magic | 3 bytes |
| Format version | 1 byte |
| Feature flags | 1 byte |
| Structured length | Unsigned variable integer |
| Binary section count | Unsigned variable integer |
| Reconstruction index length | Optional unsigned variable integer |
| Reconstruction index | Optional UTF-8 JSON |
| Structured representation | UTF-8 JSON |
| Binary sections | Raw binary frames |

The reconstruction index length and reconstruction index are present only when the reconstruction index flag is enabled.

### 2.1 Magic and Version

The first three bytes identify the format:

    53 42 43

The fourth byte identifies the wire format version.

Currently defined versions:

| Version | Description |
|---|---|
| 3 | Unindexed structured representation |
| 4 | Optional indexed reconstruction |

Wire format versions are independent of package release versions.

### 2.2 Feature Flags

Feature flags are represented by a single byte.

| Bit | Value | Description |
|---|---:|---|
| 0 | 1 | Extended type operators are present |
| 1 | 2 | Reconstruction index is present |

All other bits are reserved.

The reconstruction index flag requires the extended type operator flag.

Version 3 supports only the extended type operator flag.

Version 4 supports both flags.

Decoders must reject unsupported feature flags.

### 2.3 Variable Integers

Lengths and section counts use unsigned base-128 variable integer encoding.

Each byte contains seven value bits and one continuation bit.

The most significant bit indicates whether another byte follows.

Values must:

- Be non-negative.
- Use canonical encoding.
- Remain within the JavaScript safe integer range.

Decoders must reject truncated, overflowing, and noncanonical variable integers.

## 3. Structured Representation

The structured section contains UTF-8 encoded JSON.

Standard JSON-compatible values are represented without additional type metadata.

Supported ordinary values include:

- Strings.
- Finite numbers other than negative zero.
- Booleans.
- Null.
- Arrays.
- Plain objects.

Object properties use string keys.

Extended values are represented using reserved strings or single-key operator objects.

## 4. Reserved Strings

Extended values that require no additional arguments use reserved strings.

| JavaScript value | Structured representation |
|---|---|
| undefined | "$undefined" |
| NaN | "$nan" |
| Infinity | "$infinity" |
| -Infinity | "$negativeInfinity" |

A literal string matching a reserved string must be escaped using the `$string` operator.

Example:

    {
        "$string": "$undefined"
    }

This distinguishes the literal string "$undefined" from the JavaScript undefined value.

## 5. Type Operators

Parameterized extended values are represented as objects containing exactly one reserved operator key.

| Operator | Argument |
|---|---|
| $number | Special number identifier |
| $bigint | Decimal integer string |
| $date | Unix timestamp in milliseconds or null |
| $regexp | Source, flags, and lastIndex |
| $map | Array of key/value pairs |
| $set | Array of values |
| $binary | Binary section index and type identifier |
| $string | Escaped reserved string |
| $literal | Escaped object entries |

Operators may contain additional encoded values where applicable.

### 5.1 Negative Zero

Negative zero is represented as:

    {
        "$number": "-0"
    }

### 5.2 BigInt

BigInt values use decimal strings.

    {
        "$bigint": "12345678901234567890"
    }

### 5.3 Date

Date values use Unix timestamps in milliseconds.

    {
        "$date": 1735689600000
    }

Invalid dates are represented using null.

    {
        "$date": null
    }

### 5.4 RegExp

Regular expressions preserve their source, flags, and lastIndex.

    {
        "$regexp": ["example", "gi", 0]
    }

The lastIndex value may itself contain an encoded value.

### 5.5 Map

Maps are represented as ordered arrays of key/value pairs.

    {
        "$map": [
            ["name", "CoCreate"],
            ["active", true]
        ]
    }

Both keys and values may contain extended types.

Map insertion order is preserved.

### 5.6 Set

Sets are represented as ordered arrays of values.

    {
        "$set": [1, 2, 3]
    }

Set values may contain extended types.

Set insertion order is preserved.

### 5.7 Literal Objects

An ordinary object containing exactly one reserved operator key must be escaped to prevent ambiguity.

Original object:

    {
        "$date": 123
    }

Encoded representation:

    {
        "$literal": [
            ["$date", 123]
        ]
    }

The decoder restores the original object without interpreting its key as an operator.

## 6. Binary Representation

Binary values are separated from the structured representation and stored as raw binary sections.

The structured representation contains a reference identifying the binary section and its original type.

    {
        "$binary": [0, 2]
    }

The first argument is the zero-based binary section index.

The second argument is the binary type identifier.

### 6.1 Binary Type Identifiers

| Identifier | Wire type | Descriptor key in `operators: false` mode | Element size |
|---:|---|---|---:|
| 0 | ArrayBuffer | `$ArrayBuffer` | 1 byte |
| 1 | Int8Array | `$Int8Array` | 1 byte |
| 2 | Uint8Array | `$Uint8Array` | 1 byte |
| 3 | Uint8ClampedArray | `$Uint8ClampedArray` | 1 byte |
| 4 | Int16Array | `$Int16Array` | 2 bytes |
| 5 | Uint16Array | `$Uint16Array` | 2 bytes |
| 6 | Int32Array | `$Int32Array` | 4 bytes |
| 7 | Uint32Array | `$Uint32Array` | 4 bytes |
| 8 | Float32Array | `$Float32Array` | 4 bytes |
| 9 | Float64Array | `$Float64Array` | 8 bytes |
| 10 | BigInt64Array | `$BigInt64Array` | 8 bytes |
| 11 | BigUint64Array | `$BigUint64Array` | 8 bytes |
| 12 | DataView | `$DataView` | 1 byte |
| 13 | Float16Array | `$Float16Array` | 2 bytes |
| 14 | Buffer | `$Buffer` | 1 byte |

Type identifiers must not be reassigned.

Additional binary types may be introduced through future format revisions.

Types require corresponding runtime support. Float16Array is included when available in the runtime. Buffer requires `globalThis.Buffer`; binary type detection uses the registered constructor's exact prototype.

### 6.2 Binary Section Layout

Each binary section consists of:

| Field | Encoding |
|---|---|
| Byte length | Unsigned variable integer |
| Padding length | 1 byte |
| Alignment padding | Zero-filled bytes |
| Binary content | Raw bytes |

The padding length must be between zero and seven bytes.

The binary byte length excludes alignment padding.

Binary sections are stored in the order referenced by their section identifiers.

### 6.3 Binary Alignment

Binary content is aligned according to its element size.

Alignment allows compatible typed-array views to reference the original payload buffer directly.

When alignment permits, reconstruction may occur without copying the binary content.

If alignment requirements cannot be satisfied, the decoder must copy the relevant bytes into a compatible buffer.

ArrayBuffer reconstruction requires an independent buffer containing the referenced bytes.

### 6.4 Byte Ordering

Binary content preserves the original byte sequence.

The current format does not normalize typed-array byte ordering across architectures.

Implementations running on architectures with different native byte ordering must account for this limitation when interpreting multibyte typed arrays.

### 6.5 Binary Ownership

Decoded binary views may share memory with the original encoded payload.

Consequently:

- Modifying a decoded view may modify the payload.
- Retaining a decoded view may retain the underlying payload buffer.
- Independent binary ownership requires copying.

Zero-copy reconstruction is an optimization, not a requirement for format compatibility.

## 7. Reconstruction Index

The reconstruction index is an optional section containing the locations of encoded extended values.

It allows the decoder to reconstruct values directly without discovering operators through a complete structured traversal.

The index is generated during encoding.

Its presence is indicated by the reconstruction index feature flag.

### 7.1 Index Structure

The index contains two arrays:

1. Full reconstruction entries.
2. Binary-only reconstruction entries.

Each entry contains:

- An array of path segments.
- The corresponding operator identifier.

Example:

    [
        [
            [["created"], "$date"],
            [["user", "avatar"], "$binary"]
        ],
        [
            [["user", "avatar"], "$binary"]
        ]
    ]

Paths are relative to the root of the parsed structured representation.

### 7.2 Path Segments

Path segments may be:

- Strings representing object keys.
- Non-negative integers representing array indexes.

An empty path identifies the root value.

Path segments are represented independently to preserve keys containing periods or other special characters without ambiguity.

### 7.3 Full Reconstruction Index

The full reconstruction index identifies outermost extended type operators.

Nested values within an indexed operator are reconstructed as part of restoring that operator.

This prevents nested operators from being reconstructed more than once.

### 7.4 Binary Reconstruction Index

The binary reconstruction index identifies every binary reference, including references nested inside other extended type operators.

This allows binary content to be restored independently of other extended types.

### 7.5 Index Validation

Decoders must validate reconstruction entries before applying replacements.

Validation must ensure that:

- Paths use supported segment types.
- Paths reference existing own properties.
- Paths resolve to the expected operator.
- Binary-only entries reference binary operators.
- Reconstruction does not modify object prototypes.

Encoders must produce complete reconstruction indexes.

The current implementation validates indexed targets individually but does not independently verify index completeness.

Implementations must not assume that indexed metadata received from an untrusted source is correct.

## 8. Encoding

With `operators: true`, encoding consists of the following operations:

1. Validate the input value.
2. Identify extended types.
3. Generate inline type representations.
4. Extract raw binary sections.
5. Optionally generate the reconstruction index.
6. Serialize the structured representation as JSON.
7. Construct the binary envelope.

Ordinary JSON-compatible values do not require extended type operators or a reconstruction index.

The encoded result is returned as a Uint8Array.

### 8.1 Encoding API

    encode(value, options)

`options.operators` defaults to `true`.

    encode(value, { operators: true })

This converts native JavaScript values into CoSON operators, extracts raw binary sections, optionally generates a reconstruction index, and builds a frame.

    encode(value, { operators: false })

This accepts a prepared operator representation. For CRUD methods (`object.create`, `object.read`, `object.update`, and `object.delete`), it reads descriptors from each target object, extracts raw bytes, replaces object-local references with the existing wire-level `$binary` operator, and constructs the frame. It does not run native-value conversion. Non-CRUD messages retain root-owned binary metadata.

When `operators` is false, each descriptor must be a one-key object using a registered binary descriptor key; its value must be a `Uint8Array` containing raw bytes. All sections must be referenced. References must identify an existing section, and section byte lengths must satisfy type alignment. SharedArrayBuffer-backed bytes are rejected.

Each CRUD object's `binary` array is transport metadata and is omitted from structured JSON when it contains sections. An empty `binary` array remains ordinary structured data.

The decoded CRUD reference syntax is the literal string `binary[index]`, where `index` is canonical non-negative decimal notation. It identifies an entry in the current object's `binary` array. Each owner starts indexing at zero. The syntax is reserved in binary-bearing owners and is not executable.

The operation does not mutate the input. It still inspects reference positions, serializes structured JSON, creates frame storage and copies structured and binary bytes into the frame.

Optional configuration:

    encode(value, {
        operators: true,
        index: false
    })

`operators` and `index` are independent options. Disabling index generation produces an unindexed payload. With `operators: false`, the index is generated from the prepared representation after binary references have been converted to wire operators.

Encoding does not modify the original input value.

## 9. Decoding

Decoding consists of the following operations:

1. Validate and read the envelope.
2. Extract the structured representation.
3. Identify the binary sections.
4. Parse the structured JSON.
5. Reconstruct extended values when requested.

With native reconstruction enabled, if the payload contains no extended type operators, the parsed structured representation is returned directly. When a reconstruction index is available, it is used automatically; otherwise, the decoder discovers extended types through structured traversal. With `operators: false`, binary references are instead discovered by traversal of the parsed representation and the reconstruction index is not used for that conversion.

### 9.1 Decoding API and operator modes

    decode(payload, options)

`options.operators` defaults to `false`.

| `operators` | Behavior |
|---|---|
| `true` | Reconstruct all supported native values. |
| `false` or omitted | Preserve operators; replace binary wire operators with direct string references and attach typed raw-byte descriptors to each owning CRUD object when sections exist. |
| `"binary"` | Reconstruct binary values and preserve non-binary operators. Decode only. |

The earlier `reconstruct` option remains supported for backward compatibility. A non-nullish `operators` option takes precedence over `reconstruct`; if it is omitted or nullish, the legacy option is consulted. The reconstruction index remains independent of this choice. Indexed and unindexed frames remain supported; unindexed full reconstruction uses recursive fallback, while unindexed binary-only reconstruction collects binary paths.

### 9.2 Operator-preserving decoded representation

The wire-level binary operator remains `{ "$binary": [sectionIndex, typeIdentifier] }`. With `operators: false`, decoding parses the structured JSON and traverses it to replace each binary wire operator with `binary[index]` within its owning CRUD object. Other operators, such as `$date`, remain in the structured representation. Each owning object receives its own `binary` array of one-key descriptors containing views over corresponding raw section bytes. For example:

    {
        "method": "object.create",
        "created": { "$date": 1767225600000 },
        "object": [{
            "image": "binary[0]",
            "pixels": "binary[1]",
            "binary": [
                { "$Uint8Array": bytes0 },
                { "$Uint16Array": bytes1 }
            ]
        }]
    }

Descriptor keys correspond to the binary type identifiers in Section 6.1, including `$Buffer` for type 14. Descriptor values remain byte views; the original type is represented by the key and no native typed-array instance is reconstructed in this mode. Views share and retain the frame's backing memory. Indexes are local to their owner, not global across the envelope.

This is an in-memory decoded representation, not a change to the wire format. The conversion traverses the parsed structure and allocates reference strings and descriptor containers; it does not copy the section bytes. The traversal discovers references in the parsed value and does not use the reconstruction index. Every section must be referenced by exactly one owner, indexes and type identifiers must be valid, and conflicting types for a section are rejected. Canonical strings matching `binary[index]` are reserved in binary-bearing owners; automatic escaping is not implemented.

For CRUD methods, each owner must be an object and its `binary` property is reserved for transport metadata. A section cannot be shared across owners. Non-CRUD messages retain root ownership. With no sections, the parsed value is returned unchanged. Applications resolving references must validate their syntax and index; reference strings must never be evaluated as code.

Example:

    const parsed = decode(payload, { operators: false });
    const imageBytes = parsed.object[0].binary[0].$Uint8Array;

### 9.3 Re-encoding a prepared representation

`encode(prepared, { operators: false })` reassembles object-local prepared representations into a normal CoSON frame. It validates descriptors, extracts their raw bytes, removes local metadata from structured JSON, converts exact `binary[index]` references into the existing wire operator, preserves non-binary operators, and generates an index when enabled. No native application values are reconstructed or converted. The input is not mutated.

All descriptor sections must be referenced. A reference must use canonical decimal syntax, identify an available section, and be unambiguous; unreferenced entries and invalid references are rejected. Only registered type descriptor keys and raw `Uint8Array` bytes are accepted. Typed-array alignment constraints are checked. A prepared object that is changed must be re-indexed from its current contents; previously generated paths are not reused. With no sections, the decoded operator representation can be encoded with `operators: false` as structured operator data, subject to normal validation.

CRUD scope accepts one target object or an array of target objects. Each retains independent local references. Existing prepared objects can be reassembled repeatedly; mutations must keep every reference and descriptor aligned. Stale or unreferenced sections are rejected rather than silently reassigned.

These operator-processing modes reuse the current frame magic, version, flags, length encoding, structured JSON encoding, binary-section layout, type identifiers, alignment, and reconstruction-index format. They do not introduce a wire-format version or alter the wire-level binary marker.

The previous binary-only behavior is selected with `decode(payload, { operators: "binary" })`; it reconstructs binary values while leaving non-binary operator representations unchanged.

## 10. Type Fidelity

CoSON preserves supported values according to their defined representations.

Supported values include:

- String.
- Number.
- Boolean.
- Null.
- Undefined.
- BigInt.
- NaN.
- Infinity.
- Negative Infinity.
- Negative zero.
- Object.
- Array.
- Date.
- RegExp.
- Map.
- Set.
- ArrayBuffer.
- DataView.
- Supported typed arrays.
- Buffer where available.

The format preserves logical values and supported native types, not arbitrary runtime object identity or behavior.

## 11. Unsupported Values

The current format does not preserve:

- Functions.
- Symbols as values.
- Enumerable symbol keys.
- Circular references.
- Repeated or shared object references.
- WeakMap.
- WeakSet.
- Promise.
- Arbitrary class instances.
- SharedArrayBuffer.
- Sparse arrays.
- Custom array properties.
- Accessor properties on structured objects.
- Custom serialization methods.
- Arbitrary object prototypes.

Objects with null prototypes are represented as ordinary objects.

Custom properties attached to supported native objects are not preserved.

Unsupported input values must be rejected when identified by the encoder.

## 12. Validation and Security

Decoders must reject malformed or unsupported payloads.

Validation includes:

- Invalid magic bytes.
- Unsupported format versions.
- Unsupported feature flags.
- Invalid variable integers.
- Invalid UTF-8.
- Invalid JSON.
- Truncated sections.
- Invalid binary references.
- Unsupported binary type identifiers.
- Invalid binary lengths.
- Invalid alignment padding.
- Malformed type operators encountered during reconstruction.
- Invalid reconstruction paths.
- Unexpected trailing bytes.

Decoders must not execute code contained in serialized data.

Reserved operator names must not be interpreted outside their defined representations.

Implementations must protect against prototype modification and unsafe property assignment.

The format does not provide authentication, encryption, compression, or integrity verification.

Applications receiving untrusted payloads should establish appropriate resource limits and transport security.

## 13. Versioning

The wire format version identifies the envelope and representation rules required to decode a payload.

Wire format versions are independent of software package versions.

Decoders must reject unsupported wire format versions.

Existing type identifiers and operator meanings must not be reassigned within a compatible format revision.

Changes affecting decoding compatibility require a new wire format version.

## 14. Interoperability

CoSON is independent of any specific:

- Programming language.
- Network protocol.
- Database engine.
- Filesystem.
- Storage provider.
- Application framework.

A compatible implementation may use different internal encoding and decoding strategies, provided it produces and interprets the defined representations correctly.

Implementations may support different subsets of native types according to runtime capabilities.

Unsupported types must not be silently converted when lossless reconstruction is required.

## 15. Design Principles

CoSON is designed around the following principles:

- Preserve structure.
- Preserve types.
- Preserve binary content.
- Reuse native JSON processing.
- Avoid unnecessary transformations.
- Avoid unnecessary document traversal.
- Minimize copying and memory allocation.
- Prefer direct reconstruction when metadata is available.
- Maintain transport and storage independence.

The format separates structured representation from raw binary content while maintaining a unified serialization envelope.

Performance optimizations must not compromise the fidelity of supported values.

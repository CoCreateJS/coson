# CoSON: Memory-Oriented Serialization for Scalable Infrastructure

*Human-readable structure, native type fidelity and receiver-oriented binary reconstruction*

CoCreateJS | Technical white paper | November 2026 | Working draft


## Abstract

Serialization is typically evaluated through encoding speed, decoding speed and payload size. Those measurements are necessary but incomplete for shared infrastructure, where memory consumption and allocation behavior can constrain the number of concurrent operations a server can sustain. CoSON (CoCreate Object Serialization Notation) is a hybrid serialization architecture that combines native JSON processing, explicit type representations and raw binary sections. Its objective is to preserve structured data, supported native types and binary content while minimizing unnecessary transformations and copies.

The architecture additionally explores sender-generated reconstruction metadata to reduce receiver-side discovery work. This is motivated by asymmetric deployments in which many clients encode requests while a smaller pool of servers decodes them. Human-readable structured content is a first-class requirement: inspection and debugging should not require reconstructing every native value.

An initial Node.js benchmark demonstrates complete fidelity across 27 workload cases and 16 additional targeted checks. On nine mutually lossless JSON workloads, CoSON exhibits lower median retained decoding memory than the tested CBOR-X configuration and substantially lower decoding latency than BSON, but higher peak decoding RSS than both. These results establish a baseline, not proof of superior memory efficiency under production concurrency. Indexed reconstruction remains experimental.

Keywords: serialization, memory efficiency, distributed systems, JSON, binary framing, type fidelity, reconstruction indexing.


## 1. Motivation and design objectives

A serialization layer sits on the boundary between applications, networks and storage. Its costs recur every time a value crosses that boundary. In a shared runtime, allocation and copying can be as consequential as CPU time: transient buffers compete with application state, caches and other requests, while retained objects can extend the lifetime of otherwise disposable memory.

CoSON originated from the need to represent structured values in a JavaScript-oriented distributed infrastructure without requiring an external database or transport-specific representation. The design is independent of any particular storage engine or network protocol. The central question is not merely how quickly a value can be serialized, but how much work and memory must be committed to recovering it at the receiving end.

The design has four primary objectives. Preserve the logical value and supported native type; keep the structured portion intelligible to humans and ordinary JSON tools; retain raw binary bytes rather than expand them into textual representations; and reduce avoidable receiver-side work and allocations. These objectives can conflict. A reconstruction index, for example, adds bytes to the envelope and may add parsing allocations even when it reduces traversal.

Human readability is therefore not treated as a cosmetic property. It supports troubleshooting, inspection, operator auditing and integration with existing JSON-oriented tooling. The complete envelope is binary, however; its structured section must first be extracted and decoded as UTF-8. It is not a plain JSON file.

The intended outcome is a practical balance between memory footprint, throughput, fidelity and inspectability. Maximum throughput in a single-codec microbenchmark is not the sole design criterion.


## 2. Representation and envelope

CoSON preserves ordinary JSON-compatible values in their natural structured form. Extended values are represented by reserved strings or single-key operator objects. For example, a BigInt becomes an object containing a decimal string, while a binary view becomes a reference to an external binary section. Reserved literal strings and objects are escaped to prevent accidental interpretation as operators.

The envelope contains a format identifier, version, feature flags, structured length, binary section count, optional reconstruction metadata, UTF-8 JSON and raw binary sections. Lengths use unsigned base-128 variable integers. Binary sections include byte length and alignment padding. The precise wire contract belongs in the format specification rather than this paper.

Native JSON.stringify and JSON.parse perform the conversion between structured JavaScript values and JSON text. CoSON adds transformations only where required to preserve types and binary data. A feature flag indicates whether reconstruction is necessary; ordinary JSON payloads can bypass the post-parse reconstruction traversal entirely.

The public interface is intentionally small: encode(value) produces a Uint8Array, and decode(payload) restores the supported value. The reference implementation is synchronous and has no runtime dependencies. The proposed indexed implementation selects reconstruction strategy automatically rather than requiring transport-specific configuration.

This design is hybrid rather than purely textual or fully custom binary. It preserves the advantages of a familiar structured notation while allowing binary contents to remain native bytes. It does not claim that native JSON parsing is universally faster than specialized binary decoding.

| Example value | Structured wire representation |
| --- | --- |
| BigInt 42 | {"$bigint":"42"} |
| Uint8Array | {"$binary":[0,2]} |
| Literal "$undefined" | {"$string":"$undefined"} |

The binary row describes the representation inside the encoded frame. In the current `decode(payload, { reconstruct: false })` result, that wire operator is converted to a string reference such as `"$binary[0]"`, and the root `$binary` array contains a typed descriptor such as `{ $Uint8Array: bytes }`. This decoded form is in-memory only; it does not change the wire representation.


## 3. Memory architecture

Binary-to-text conversion can impose substantial costs. Base64 requires 4 × ceil(n/3) characters for n input bytes, before JSON quotes or other framing. For large binary values this is approximately 33% expansion. The in-memory cost of those characters depends on runtime string representation, and conversion may require additional transient allocations. CoSON avoids this transformation by storing raw bytes alongside the structured representation.

Encoding still requires an output buffer and copies raw binary content into it. Decoding can create typed-array views over the received payload when alignment and runtime support permit. An ArrayBuffer requires an independent copy in the reference implementation; unaligned multibyte views may also require copying. Zero-copy is conditional, not a promise that every serialization operation is allocation-free.

A view may retain the entire backing payload even when it exposes only a small region. This is an important trade-off for caches and long-lived application objects. Copying a small retained value can be preferable to holding a large message alive. Ownership must be considered alongside copy avoidance.

Memory should be evaluated in multiple dimensions: peak resident memory during operations, retained heap, external backing memory, allocation rate and garbage-collection behavior. Node.js ArrayBuffer accounting is a subset of external memory and must not be added to it again. Peak RSS also includes allocator and runtime effects, not just live JavaScript objects.

A simplified capacity model is C ≤ floor((B − R − S)/W), where B is a server memory budget, R is baseline resident memory, S is safety headroom and W is incremental memory per concurrent operation. For example, a hypothetical 2 GiB server reserving 768 MiB for baseline and headroom has 1,280 MiB available: reducing W from 8 MiB to 6 MiB increases the modeled capacity from 160 to 213 operations. This is an illustration, not a measured CoSON result. Real capacity also depends on overlapping lifetimes, GC, CPU and I/O.


## 4. Distributed workloads and reconstruction

Encoding and decoding are not necessarily symmetric infrastructure costs. In an inbound client-server workload, encoding can be distributed across many devices while decoding is concentrated in a smaller server fleet. A receiver-oriented design can therefore accept additional sender work when it produces a measurable reduction in shared resource consumption. The inverse applies to server-originated traffic; sender cost is never universally irrelevant.

The baseline decoder parses the structured JSON, then visits its values to restore extended types when the operator flag is present. For a document with N structured nodes, discovery can require O(N) visits in addition to parsing. The experimental indexed design records paths to extended values on the sender. The receiver follows those paths and restores the indicated values, avoiding discovery in unrelated subtrees.

For K independent indexed targets of average path depth d, path access costs approximately O(Kd), plus restoration work and index parsing. Nested Map, Set and other operators can still require traversal inside their arguments. JSON parsing itself is unchanged. Sparse extended values in a large structure are the most promising case; dense extended values or small documents may favor direct traversal.

The proposed index uses path segments rather than dot-separated strings so literal dots in object keys remain unambiguous. It distinguishes full reconstruction from binary-only reconstruction. The default decode call should restore all supported values, choosing indexed or recursive reconstruction automatically.

In the current implementation, `decode(frame, { reconstruct: false })` leaves ordinary non-binary operators in their structured form and converts binary operators into references in the returned in-memory envelope. The original message remains at the root; binary references are strings and raw bytes are attached as typed descriptors:

    {
        method: "upload",
        image: "$binary[0]",
        pixels: "$binary[1]",
        $binary: [
            { $Uint8Array: bytes0 },
            { $Uint16Array: bytes1 }
        ]
    }

The `$binary` entries contain `Uint8Array` views into the input frame's storage. The descriptor key carries the original binary type; the descriptor value is raw bytes rather than a reconstructed typed array. This mode still JSON-parses and traverses the structured value and allocates reference strings and descriptor containers. It avoids copying binary bytes for the views, but should not be treated as zero-work or as a measured performance optimization.

When binary sections exist, this in-memory form requires a non-array object root that is not itself an operator and has no own `$binary` property. User strings that exactly match the reference syntax `"$binary[index]"` can be ambiguous with references. A consumer that resolves references must validate their exact syntax and must not evaluate them as code. The form is not a wire format: it cannot currently be passed to `encode()` to recreate the frame or independently reconstructed into native binary values. The wire operator remains `{ "$binary": [sectionIndex, typeIdentifier] }`; normal reconstruction uses the original frame. This representation alone does not implement CoCreate Socket, Server, DB, or other application adapters; forwarding, storage, or delayed decoding require separate integration.

Index metadata belongs inside the serialization envelope, making the strategy independent of WebSocket, HTTP or storage. Untrusted indexes require validation of paths, operator identities and completeness. The current experimental implementation validates individual targets but does not independently establish completeness. The index is not yet a validated production optimization.


## 5. Empirical evaluation

The baseline comparative benchmark was recorded on 18 November 2026 at 11:33:31 UTC using Node v24.18.0 on Linux/x64, a 256 MiB heap cap and exposed garbage collection. The matrix contains 27 cases: 10, 50 and 100 KiB; 20, 50 and 100 properties; and JSON, extended-type and mixed-binary profiles. Three warmups precede five measured batches of 100 operations. Latency is the median of batch averages. Memory uses isolated workers, 1 ms RSS sampling and post-GC retained deltas.

The following fidelity results reflect the tested configurations and strict JavaScript value/type comparisons. The separate targeted checks are not included in the timed workload matrix. Competitor failures do not establish that the formats cannot represent those values using other configurations or adapters.

| Codec | JSON | Extended | Mixed | Targeted |
| --- | --- | --- | --- | --- |
| CoSON | 9/9 | 9/9 | 9/9 | 16/16 |
| CBOR-X | 9/9 | 0/9 | 0/9 | 14/16 |
| BSON | 9/9 | 0/9 | 0/9 | 1/16 |
| Paired JSON metric | vs CBOR-X | vs BSON |
| --- | --- | --- |
| Encode latency | -165.8% | -215.4% |
| Decode latency | +2.7% | +75.0% |
| Retained decode memory | +13.8% | +0.3% |
| Peak decode RSS | -25.9% | -23.2% |
| Payload size | -0.3% | +0.1% |

Positive values favor CoSON; median of per-dataset differences.


## 6. Findings and interpretation

On the nine mutually lossless JSON cases, CoSON reduces median paired decoding latency by 2.7% relative to CBOR-X and 75% relative to BSON. It also reduces retained decoding memory by 13.8% and 0.3%, respectively. However, peak decoding RSS is 25.9% higher than CBOR-X and 23.2% higher than BSON. Encoding is slower and peak encoding RSS is higher in these same pairs.

These results matter because a memory-oriented architecture should not confuse a smaller retained footprint with a smaller transient working set. In particular, increased peak RSS could offset retained-memory gains under concurrency. The benchmark does not yet establish higher server capacity. The results support further optimization of the decode path rather than an unconditional claim of superiority.

The per-size CoSON measurements below include all nine profile/property cases at each size. They establish the historical baseline for evaluating the proposed index. They must not be compared as lossless equivalents against aggregate competitor measurements that include fidelity failures.

| CoSON baseline | 10 KiB | 50 KiB | 100 KiB |
| --- | --- | --- | --- |
| Encode (ms) | 0.0583 | 0.1473 | 0.2293 |
| Decode (ms) | 0.0403 | 0.0722 | 0.1140 |
| Decode peak RSS (MiB) | 3.12 | 22.18 | 49.96 |
| Decode retained heap (B/op) | 10,948 | 51,908 | 103,108 |
| Decode retained external (B/op) | 10,248 | 51,209 | 102,409 |
| Payload (bytes) | 10,216 | 51,174 | 102,374 |


## 7. Limitations, validation and conclusion

The benchmark uses synthetic datasets and repeated batch operations on one Node.js environment. It does not measure browser encoding, realistic network traffic, concurrent server request lifetimes, production allocation rates or GC pauses. RSS sampling can miss short spikes. Post-GC external accounting may lag object reclamation. Competitor versions and options were not provided in the recorded report, limiting reproducibility. The exact baseline source hash is listed below.

The next experiment should retain the existing workload and runner, testing the indexed implementation using default encode and decode calls only. A follow-up should compare indexed and recursive strategies against the same source build, separating ordinary JSON, sparse extended types and dense extended types. Report index bytes, allocation rate, p95/p99 latency, peak RSS, retained heap and external memory, and GC pauses. Production validation should use varied payloads, realistic concurrency and server memory limits, measuring sustainable throughput before memory pressure or latency targets are exceeded.

CoSON does not preserve arbitrary classes, executable behavior, cycles, shared object identity or all host objects. Binary byte ordering is currently native rather than normalized across architectures. The format provides neither encryption nor authentication. Decoders must validate malformed inputs, impose resource limits and avoid unsafe property access. Indexed reconstruction completeness and adversarial-input handling require additional validation before release.

CoSON's contribution is a deliberate combination of inspectable structured data, native type fidelity, raw binary framing and receiver-oriented optimization. Its long-term success should be judged by the cost of operating real infrastructure, not by speed alone. The baseline demonstrates promising fidelity and selected decode advantages, while also revealing transient memory costs that remain a priority for improvement.

Reference materials: CoSON format specification (specifications/format.md); comparative benchmark, 2026-11-18T11:33:31.454Z; RFC 8259 (JSON); RFC 4648 (Base64); RFC 8949 (CBOR); BSON specification (bsonspec.org). Baseline source SHA-256: 42e0da5cf05dad212aaa3661e85ba8bfce50e89ebb53bc090431d6c6318d33bc.

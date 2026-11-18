# COSON format, version 1

A COSON payload is one `Uint8Array` with this layout:

1. Four-byte magic and version: `53 42 43 01` (`SBC`, version 1).
2. Unsigned base-128 variable integer: structured-section byte length.
3. Unsigned base-128 variable integer: binary-section count.
4. Structured section: UTF-8 JSON containing a typed skeleton.
5. For each binary section: variable integer byte length, one-byte alignment padding count, zero padding bytes, then the raw bytes.

Typed skeleton nodes use arrays with a reserved leading tag, such as `["date", ...]`, `["map", ...]`, `["binary", sectionIndex, typeIndex]`, and `["object", entries]`. The skeleton is serialized using COSON Inline Hybrid: argumentless values use reserved strings, parameterized values use one-key operator objects, and objects shaped like an operator are escaped as literal key/value entries. This prevents user data from being mistaken for metadata.

Binary sections preserve raw bytes without Base64 or numeric-array conversion. A binary reference includes the section index and typed-array identifier. Alignment padding allows decoded typed-array views to reference the original payload buffer.

Lengths use unsigned base-128 encoding and are limited to safe JavaScript integer values. Decoders reject invalid magic/version, truncated data, invalid references, malformed alignment, and trailing bytes.

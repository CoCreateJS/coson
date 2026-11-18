# @cocreate/coson

COSON is a dependency-free JavaScript serializer for browser and Node.js applications. It encodes structured values with collision-safe type operators and stores binary values as raw, length-prefixed sections in a single `Uint8Array` payload.

## Install

```sh
npm install @cocreate/coson
```

## Use

```js
import { encode, decode } from "@cocreate/coson";

const source = {
    message: "hello",
    createdAt: new Date(),
    count: 123n,
    bytes: new Uint8Array([0, 128, 255]),
    values: new Map([["active", true]])
};

const bytes = encode(source); // Uint8Array
const restored = decode(bytes);
```

The same ESM entry is used in browsers and Node.js. It relies on standard JavaScript typed arrays, `TextEncoder`, and `TextDecoder`; no Node-specific serialization APIs or runtime packages are used.

## Supported values

- `null`, `undefined`, booleans, strings, and numbers, including `NaN`, infinities, and negative zero
- `BigInt`, `Date` (including invalid dates), `RegExp` including `lastIndex`, `Map`, and `Set`
- Plain objects with string keys and arrays
- `ArrayBuffer` and typed arrays: signed/unsigned integer arrays, clamped bytes, floating point arrays, and BigInt typed arrays where available

Binary bytes remain binary in the output. Decoded typed arrays are views into the encoded payload where alignment permits. The decoded `ArrayBuffer` value is copied so its standalone buffer boundaries are preserved.

## Limitations

- Circular references and repeated/shared object references are rejected. The format does not preserve object identity.
- Sparse arrays, enumerable symbol keys, accessor properties, class instances, `DataView`, and unsupported typed array kinds are rejected.
- Functions, symbols, and other unsupported primitive values are rejected.
- Plain object prototypes are normalized to `Object.prototype` ; custom prototypes are not preserved.
- Decoded typed-array views can retain the entire encoded payload buffer for as long as the view is retained. Copy a view when independent lifetime is needed.
- The framing format is versioned. `encode` and `decode` are intended to be used as a matched pair; malformed or unknown frames throw.

See [the format specification](specifications/format.md) for the frame layout and operator rules.

import test from "node:test";
import assert from "node:assert/strict";
import { decode, decodeSegments, encode, encodeSegments } from "../src/index.js";

function same(actual, expected) {
    if (expected instanceof Date) {
        assert.ok(actual instanceof Date);
        assert.ok(Object.is(actual.getTime(), expected.getTime()));
    } else if (expected instanceof RegExp) {
        assert.ok(actual instanceof RegExp);
        assert.equal(actual.source, expected.source);
        assert.equal(actual.flags, expected.flags);
        assert.equal(actual.lastIndex, expected.lastIndex);
    } else if (expected instanceof ArrayBuffer) {
        assert.ok(actual instanceof ArrayBuffer);
        assert.deepEqual(new Uint8Array(actual), new Uint8Array(expected));
    } else if (ArrayBuffer.isView(expected)) {
        assert.equal(actual.constructor, expected.constructor);
        assert.deepEqual(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength), new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength));
    } else if (expected instanceof Map) {
        assert.ok(actual instanceof Map);
        assert.equal(actual.size, expected.size);
        for (const [key, value] of expected) same(actual.get(key), value);
    } else if (expected instanceof Set) {
        assert.ok(actual instanceof Set);
        assert.deepEqual([...actual], [...expected]);
    } else if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual));
        assert.equal(actual.length, expected.length);
        expected.forEach((item, index) => same(actual[index], item));
    } else if (expected && typeof expected === "object") {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const key of Object.keys(expected)) same(actual[key], expected[key]);
    } else if (typeof expected === "number" && Number.isNaN(expected)) {
        assert.ok(Number.isNaN(actual));
    } else {
        assert.ok(Object.is(actual, expected), `Expected ${String(expected)}, got ${String(actual)}`);
    }
}

test("round-trips primitives, Unicode, and special numbers", () => {
    for (const value of [null, undefined, true, false, 0, -0, NaN, Infinity, -Infinity, "🌍 café", 0n, -(2n ** 200n)]) {
        const bytes = encode(value);
        assert.ok(bytes instanceof Uint8Array);
        same(decode(bytes, { operators: true }), value);
    }
});

test("round-trips nested values and collision-shaped user data", () => {
    const value = {
        undefinedValue: undefined,
        bigint: 123456789012345678901234n,
        date: new Date(1794966471263),
        invalidDate: new Date(NaN),
        nan: NaN,
        negativeZero: -0,
        regexp: Object.assign(/abc/gi, { lastIndex: 2 }),
        map: new Map([["key", new Set([1, 2])]]),
        literal: { $number: "-0" },
        operatorString: "$undefined",
        nested: [{ text: "hello" }, undefined]
    };
    same(decode(encode(value), { operators: true }), value);
});

test("preserves raw binary values and typed-array constructors", () => {
    const values = [
        new Int8Array([-1, 0, 127]), new Uint8Array([0, 1, 255]),
        new Uint8ClampedArray([0, 128, 255]), new Int16Array([-32768, 4, 32767]),
        new Uint16Array([0, 513, 65535]), new Int32Array([-1, 42]),
        new Uint32Array([0, 4294967295]), new Float32Array([Math.PI, -0]),
        new Float64Array([Math.PI, NaN, Infinity, -Infinity, -0]),
        Uint8Array.from([0, 255, 128]).buffer
    ];
    if (typeof BigInt64Array !== "undefined") values.push(new BigInt64Array([-9n, 10n]), new BigUint64Array([0n, 18446744073709551615n]));
    for (const value of values) same(decode(encode(value), { operators: true }), value);
});

test("typed arrays can view the original encoded buffer", () => {
    const bytes = encode({ body: new Uint8Array(1024 * 1024).fill(0xa5) });
    const restored = decode(bytes, { operators: true });
    assert.equal(restored.body.buffer, bytes.buffer);
    assert.equal(restored.body.byteLength, 1024 * 1024);
});

test("supports binary views and inspection without reconstruction", () => {
    const view = new DataView(Uint8Array.from([1, 2, 3, 4]).buffer, 1, 2);
    const restoredView = decode(encode(view), { operators: true });
    assert.ok(restoredView instanceof DataView);
    assert.deepEqual(new Uint8Array(restoredView.buffer, restoredView.byteOffset, restoredView.byteLength), new Uint8Array([2, 3]));

    if (typeof Buffer !== "undefined") {
        const buffer = Buffer.from([5, 6, 7]);
        assert.ok(Buffer.isBuffer(decode(encode(buffer), { operators: true })));
        assert.deepEqual(decode(encode(buffer), { operators: true }), buffer);
    }

    const payload = encode({ value: undefined, date: new Date(1234) });
    const inspected = decode(payload, { operators: false });
    assert.deepEqual(inspected.value, "$undefined");
    assert.deepEqual(inspected.date, { $date: 1234 });
});

test("defaults to operator-preserving decoding", () => {
    const result = decode(encode({ date: new Date(1234) }));
    assert.deepEqual(result, { date: { $date: 1234 } });
});

test("associates CRUD binaries with each object and reassembles repeatedly", () => {
    const value = {
        method: "object.create",
        object: [
            {
                name: "image.png",
                nested: { preview: new Uint8Array([1, 2, 3]) },
                source: new Uint16Array([300, 400])
            },
            {
                name: "video.mp4",
                file: new ArrayBuffer(4)
            }
        ]
    };
    const frame = encode(value, { operators: true });
    let prepared = decode(frame, { operators: false });

    assert.equal(Object.hasOwn(prepared, "binary"), false);
    assert.equal(prepared.object[0].nested.preview, "binary[0]");
    assert.equal(prepared.object[0].source, "binary[1]");
    assert.equal(prepared.object[1].file, "binary[0]");
    assert.deepEqual(Object.keys(prepared.object[0].binary[0]), ["$Uint8Array"]);
    assert.deepEqual(Object.keys(prepared.object[0].binary[1]), ["$Uint16Array"]);
    assert.deepEqual(Object.keys(prepared.object[1].binary[0]), ["$ArrayBuffer"]);

    const initial = prepared;
    for (let i = 0; i < 3; i++) {
        const repacked = encode(prepared, { operators: false });
        prepared = decode(repacked, { operators: false });
    }

    assert.deepEqual(prepared, initial);
    same(decode(encode(prepared, { operators: false }), { operators: true }), value);
});

test("supports object-local binaries on a single CRUD object", () => {
    const value = {
        method: "object.update",
        object: { id: "asset-1", file: new Uint8Array([9, 8, 7]) }
    };
    const prepared = decode(encode(value), { operators: false });

    assert.equal(prepared.object.file, "binary[0]");
    assert.deepEqual(prepared.object.binary[0].$Uint8Array, new Uint8Array([9, 8, 7]));
    same(decode(encode(prepared, { operators: false }), { operators: true }), value);
});

test("splits a legacy CRUD envelope binary list into object-local sections", () => {
    const prepared = {
        method: "object.create",
        object: [
            { name: "image.png", file: "binary[0]" },
            { name: "video.mp4", file: "binary[1]" }
        ],
        binary: [
            new Uint8Array([1, 2, 3]),
            new Uint16Array([1000, 2000])
        ]
    };
    const frame = encode(prepared, { operators: false });
    const decoded = decode(frame, { operators: false });

    assert.equal(Object.hasOwn(decoded, "binary"), false);
    assert.equal(decoded.object[0].file, "binary[0]");
    assert.equal(decoded.object[1].file, "binary[0]");
    assert.deepEqual(decoded.object[0].binary[0].$Uint8Array, new Uint8Array([1, 2, 3]));
    assert.deepEqual(decoded.object[1].binary[0].$Uint16Array, new Uint8Array(new Uint16Array([1000, 2000]).buffer));
});

test("reassembles mutated object-local binary arrays without stale references", () => {
    const prepared = decode(encode({
        method: "object.create",
        object: { first: new Uint8Array([1]) }
    }), { operators: false });

    prepared.object.binary.push({ $Uint16Array: new Uint8Array(new Uint16Array([20, 30]).buffer) });
    prepared.object.second = "binary[1]";
    const received = decode(encode(prepared, { operators: false }), { operators: true });

    assert.deepEqual(received.object.first, new Uint8Array([1]));
    assert.deepEqual(received.object.second, new Uint16Array([20, 30]));

    delete prepared.object.second;
    prepared.object.binary.splice(1, 1);
    const withoutRemovedBinary = decode(encode(prepared, { operators: false }), { operators: true });
    assert.deepEqual(withoutRemovedBinary.object.first, new Uint8Array([1]));
    assert.equal(Object.hasOwn(withoutRemovedBinary.object, "second"), false);
});

test("rejects binary metadata that conflicts with object data", () => {
    const value = {
        method: "object.create",
        object: { binary: ["application data"], file: new Uint8Array([1]) }
    };
    assert.throws(() => decode(encode(value), { operators: false }), /binary property conflict/);
});

test("rejects literal object-local references when binary sections are present", () => {
    const value = {
        method: "object.create",
        object: { label: "binary[0]", file: new Uint8Array([1]) }
    };

    assert.throws(() => decode(encode(value), { operators: false }), /reserved binary reference string/);
});

test("rejects malformed frames and unsupported input", () => {
    assert.throws(() => decode(new Uint8Array([1, 2, 3])), /COSON/);
    assert.throws(() => decode(Uint8Array.from([...encode(null), 0])), /trailing/i);
    const circular = {};
    circular.self = circular;
    assert.throws(() => encode(circular), /circular or shared/i);
    const shared = {};
    assert.throws(() => encode({ a: shared, b: shared }), /circular or shared/i);
});

test("segmented CoSON keeps structured JSON readable and binary sections native", () => {
    const value = { method: "object.update", object: { label: "readable", file: new Uint16Array([100, 200]) } };
    const segments = encodeSegments(value);
    assert.equal(typeof segments.json, "string");
    assert.match(segments.json, /readable/);
    assert.equal(segments.binaries.length, 1);
    same(decodeSegments(segments, { operators: true }), value);

    const preserved = decodeSegments(segments, { operators: false });
    assert.equal(preserved.object.file, "binary[0]");
    assert.equal(preserved.object.binary[0].$Uint16Array.byteLength, 4);
});

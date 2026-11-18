import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "../src/index.js";

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
        same(decode(bytes), value);
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
    same(decode(encode(value)), value);
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
    for (const value of values) same(decode(encode(value)), value);
});

test("typed arrays can view the original encoded buffer", () => {
    const bytes = encode({ body: new Uint8Array(1024 * 1024).fill(0xa5) });
    const restored = decode(bytes);
    assert.equal(restored.body.buffer, bytes.buffer);
    assert.equal(restored.body.byteLength, 1024 * 1024);
});

test("rejects malformed frames and unsupported input", () => {
    assert.throws(() => decode(new Uint8Array([1, 2, 3])), /SplitBinary/);
    assert.throws(() => decode(Uint8Array.from([...encode(null), 0])), /Trailing/);
    assert.throws(() => encode(new DataView(new ArrayBuffer(3))), /Unsupported/);
    const circular = {};
    circular.self = circular;
    assert.throws(() => encode(circular), /Circular and shared/);
    const shared = {};
    assert.throws(() => encode({ a: shared, b: shared }), /Circular and shared/);
});

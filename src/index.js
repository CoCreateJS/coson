/**
 * COSON: portable structured serialization with raw binary sections.
 *
 * Structured values use the collision-safe Inline Hybrid operator encoding.
 * Binary values are stored as raw, length-prefixed sections in the same frame.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const ARGUMENTLESS = new Set(["$undefined", "$nan", "$infinity", "$negativeInfinity"]);
const OPERATOR_KEYS = new Set([...ARGUMENTLESS, "$number", "$date", "$bigint", "$map", "$set", "$regexp", "$string", "$literal"]);

function operator(name, argument, hybrid) {
	if (hybrid && ARGUMENTLESS.has(name)) return name;
	if (ARGUMENTLESS.has(name)) return { [name]: true };
	return { [name]: argument };
}

function isOperatorObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && OPERATOR_KEYS.has(keys[0]);
}

function transform(value, hybrid) {
	const active = new WeakSet();
	function visit(current) {
		if (current === undefined) return operator("$undefined", true, hybrid);
		if (typeof current === "number") {
			if (Number.isNaN(current)) return operator("$nan", true, hybrid);
			if (current === Infinity) return operator("$infinity", true, hybrid);
			if (current === -Infinity) return operator("$negativeInfinity", true, hybrid);
			if (Object.is(current, -0)) return operator("$number", "-0", hybrid);
			return current;
		}
		if (typeof current === "string") return ARGUMENTLESS.has(current) ? { $string: current } : current;
		if (current === null || typeof current === "boolean") return current;
		if (typeof current === "bigint") return operator("$bigint", current.toString(10), hybrid);
		if (current instanceof Date) return operator("$date", Number.isNaN(current.getTime()) ? null : current.getTime(), hybrid);
		if (current instanceof RegExp) return operator("$regexp", [current.source, current.flags, current.lastIndex], hybrid);
		if (!current || typeof current !== "object") throw new TypeError(`Unsupported value type: ${typeof current}`);
		if (active.has(current)) throw new TypeError("Circular references are not supported");
		active.add(current);
		try {
			if (current instanceof Map) return operator("$map", [...current].map(([key, item]) => [visit(key), visit(item)]), hybrid);
			if (current instanceof Set) return operator("$set", [...current].map(visit), hybrid);
			if (Array.isArray(current)) {
				for (let i = 0; i < current.length; i++) if (!Object.hasOwn(current, i)) throw new TypeError("Sparse arrays are unsupported");
				return current.map(visit);
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Unsupported value type: ${current.constructor?.name ?? "unknown"}`);
			if (Object.getOwnPropertySymbols(current).some((key) => Object.getOwnPropertyDescriptor(current, key).enumerable)) throw new TypeError("Enumerable symbol keys are unsupported");
			const entries = [];
			for (const key of Object.keys(current)) {
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (descriptor.get || descriptor.set) throw new TypeError("Accessor properties are unsupported");
				entries.push([key, visit(current[key])]);
			}
			const result = Object.fromEntries(entries);
			// Escape objects that could be mistaken for operator values. The reserved
			// literal wrapper is decoded as key/value pairs, so nested values still resolve.
			return isOperatorObject(result) ? { $literal: entries } : result;
		} finally {
			active.delete(current);
		}
	}
	return visit(value);
}

function reconstruct(value) {
	function visit(current) {
		if (typeof current === "string") {
			if (current === "$undefined") return undefined;
			if (current === "$nan") return NaN;
			if (current === "$infinity") return Infinity;
			if (current === "$negativeInfinity") return -Infinity;
			return current;
		}
		if (!current || typeof current !== "object") return current;
		if (Array.isArray(current)) return current.map(visit);
		if (!isOperatorObject(current)) {
			const result = Object.create(Object.getPrototypeOf(current) === null ? null : Object.prototype);
			for (const key of Object.keys(current)) Object.defineProperty(result, key, { value: visit(current[key]), enumerable: true, configurable: true, writable: true });
			return result;
		}
		const [name] = Object.keys(current);
		const argument = current[name];
		switch (name) {
			case "$undefined": return undefined;
			case "$nan": return NaN;
			case "$infinity": return Infinity;
			case "$negativeInfinity": return -Infinity;
			case "$number": return Number(argument);
			case "$string": return argument;
			case "$date": return argument === null ? new Date(NaN) : new Date(argument);
			case "$bigint": return BigInt(argument);
			case "$map": return new Map(argument.map(([key, item]) => [visit(key), visit(item)]));
			case "$set": return new Set(argument.map(visit));
			case "$regexp": { const regexp = new RegExp(argument[0], argument[1]); regexp.lastIndex = argument[2]; return regexp; }
			case "$literal": {
				const result = {};
				for (const [key, item] of argument) Object.defineProperty(result, key, { value: visit(item), enumerable: true, configurable: true, writable: true });
				return result;
			}
			default: throw new TypeError(`Unknown inline operator ${name}`);
		}
	}
	return visit(value);
}

function makeCodec(hybrid) {
	return {
		encode(value) { return encoder.encode(JSON.stringify(transform(value, hybrid))); },
		decode(bytes) {
			if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
			if (!(bytes instanceof Uint8Array)) throw new TypeError("decode expects Uint8Array or ArrayBuffer");
			return reconstruct(JSON.parse(decoder.decode(bytes)));
		},
	};
}

const inlineHybrid = makeCodec(true);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAGIC_JSON = [0x53, 0x42, 0x4a, 1]; // SBJ, version 1
const MAGIC_V8 = [0x53, 0x42, 0x56, 1]; // SBV, version 1

const typedArrays = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
if (typeof BigInt64Array !== "undefined") typedArrays.push(BigInt64Array, BigUint64Array);

function varuintSize(value) {
	let bytes = 1;
	while (value >= 128) { value = Math.floor(value / 128); bytes++; }
	return bytes;
}

class Writer {
	constructor(bytes) { this.bytes = bytes; this.offset = 0; }
	byte(value) { this.bytes[this.offset++] = value; }
	varuint(value) {
		while (value >= 128) { this.byte((value % 128) | 128); value = Math.floor(value / 128); }
		this.byte(value);
	}
	data(value) { this.bytes.set(value, this.offset); this.offset += value.byteLength; }
}

class Reader {
	constructor(bytes) {
		if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
		if (!(bytes instanceof Uint8Array)) throw new TypeError("decode expects Uint8Array or ArrayBuffer");
		this.bytes = bytes;
		this.offset = 0;
	}
	need(length) { if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new RangeError("Unexpected end of SplitBinary payload"); }
	byte() { this.need(1); return this.bytes[this.offset++]; }
	varuint() {
		let value = 0, multiplier = 1;
		for (let i = 0; i < 8; i++) {
			const byte = this.byte();
			value += (byte & 127) * multiplier;
			if (!Number.isSafeInteger(value)) throw new RangeError("SplitBinary length exceeds supported range");
			if (!(byte & 128)) return value;
			multiplier *= 128;
		}
		throw new TypeError("Invalid SplitBinary length encoding");
	}
	data(length) { this.need(length); const result = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return result; }
}

function numberNode(value) {
	if (Number.isNaN(value)) return ["number", "nan"];
	if (value === Infinity) return ["number", "+infinity"];
	if (value === -Infinity) return ["number", "-infinity"];
	if (Object.is(value, -0)) return ["number", "-0"];
	return ["number", value];
}

function makeSkeleton(value, sections, seen) {
	if (value === null) return ["null"];
	if (value === undefined) return ["undefined"];
	if (typeof value === "boolean") return ["boolean", value];
	if (typeof value === "number") return numberNode(value);
	if (typeof value === "string") return ["string", value];
	if (typeof value === "bigint") return ["bigint", value.toString()];
	if (typeof value !== "object") throw new TypeError(`Unsupported SplitBinary value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Circular and shared object references are not supported");
	seen.add(value);
	if (value instanceof Date) return ["date", numberNode(value.getTime())];
	if (value instanceof RegExp) return ["regexp", value.source, value.flags, value.lastIndex];
	if (value instanceof ArrayBuffer) {
		const index = sections.push({ bytes: new Uint8Array(value), type: -1 }) - 1;
		return ["binary", index, -1];
	}
	if (ArrayBuffer.isView(value)) {
		const type = typedArrays.indexOf(value.constructor);
		if (type < 0 || value instanceof DataView) throw new TypeError(`Unsupported SplitBinary binary view: ${value.constructor.name}`);
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		const index = sections.push({ bytes, type }) - 1;
		return ["binary", index, type];
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new TypeError("Sparse arrays are not supported");
		return ["array", value.map((item) => makeSkeleton(item, sections, seen))];
	}
	if (value instanceof Map) {
		const entries = [];
		for (const [key, item] of value) entries.push([makeSkeleton(key, sections, seen), makeSkeleton(item, sections, seen)]);
		return ["map", entries];
	}
	if (value instanceof Set) return ["set", [...value].map((item) => makeSkeleton(item, sections, seen))];
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Unsupported SplitBinary object: ${value.constructor?.name ?? "unknown"}`);
	if (Object.getOwnPropertySymbols(value).some((symbol) => Object.getOwnPropertyDescriptor(value, symbol).enumerable)) throw new TypeError("Enumerable symbol keys are not supported");
	const entries = [];
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor.get || descriptor.set) throw new TypeError("Accessor properties are not supported");
		entries.push([key, makeSkeleton(value[key], sections, seen)]);
	}
	return ["object", entries];
}

function restoreNumber(node) {
	if (node[1] === "nan") return NaN;
	if (node[1] === "+infinity") return Infinity;
	if (node[1] === "-infinity") return -Infinity;
	if (node[1] === "-0") return -0;
	return node[1];
}

function restoreSkeleton(node, sections) {
	if (!Array.isArray(node) || typeof node[0] !== "string") throw new TypeError("Invalid SplitBinary structured value");
	switch (node[0]) {
		case "null": return null;
		case "undefined": return undefined;
		case "boolean": return node[1];
		case "number": return restoreNumber(node);
		case "string": return node[1];
		case "bigint": return BigInt(node[1]);
		case "date": return new Date(restoreNumber(node[1]));
		case "regexp": { const value = new RegExp(node[1], node[2]); value.lastIndex = node[3]; return value; }
		case "array": return node[1].map((item) => restoreSkeleton(item, sections));
		case "object": {
			const value = {};
			for (const [key, item] of node[1]) Object.defineProperty(value, key, { value: restoreSkeleton(item, sections), enumerable: true, configurable: true, writable: true });
			return value;
		}
		case "map": return new Map(node[1].map(([key, item]) => [restoreSkeleton(key, sections), restoreSkeleton(item, sections)]));
		case "set": return new Set(node[1].map((item) => restoreSkeleton(item, sections)));
		case "binary": {
			const [index, type] = node.slice(1);
			const bytes = sections[index];
			if (!bytes) throw new TypeError("SplitBinary reference is out of range");
			if (type === -1) return bytes.slice().buffer;
			const Type = typedArrays[type];
			if (!Type || bytes.byteLength % Type.BYTES_PER_ELEMENT) throw new TypeError("Invalid SplitBinary typed array reference");
			if (bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0) return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
			const copy = bytes.slice();
			return new Type(copy.buffer, copy.byteOffset, copy.byteLength / Type.BYTES_PER_ELEMENT);
		}
		default: throw new TypeError(`Unknown SplitBinary structure tag: ${node[0]}`);
	}
}

function encodeFramed(value, serialize, magic) {
	const sections = [];
	const skeleton = makeSkeleton(value, sections, new WeakSet());
	const structured = serialize(skeleton);
	if (!(structured instanceof Uint8Array)) throw new TypeError("Structured serializer must return Uint8Array");
	let total = magic.length + varuintSize(structured.byteLength) + varuintSize(sections.length) + structured.byteLength;
	let cursor = total;
	for (const section of sections) {
		const alignment = section.type < 0 ? 1 : typedArrays[section.type].BYTES_PER_ELEMENT;
		total += varuintSize(section.bytes.byteLength) + 1;
		cursor += varuintSize(section.bytes.byteLength) + 1;
		const padding = (alignment - (cursor % alignment)) % alignment;
		total += padding + section.bytes.byteLength;
		cursor += padding + section.bytes.byteLength;
	}
	const output = new Uint8Array(total);
	const writer = new Writer(output);
	for (const byte of magic) writer.byte(byte);
	writer.varuint(structured.byteLength);
	writer.varuint(sections.length);
	writer.data(structured);
	for (const section of sections) {
		writer.varuint(section.bytes.byteLength);
		const alignment = section.type < 0 ? 1 : typedArrays[section.type].BYTES_PER_ELEMENT;
		const padding = (alignment - ((writer.offset + 1) % alignment)) % alignment;
		writer.byte(padding);
		for (let i = 0; i < padding; i++) writer.byte(0);
		writer.data(section.bytes);
	}
	if (writer.offset !== output.byteLength) throw new Error("SplitBinary frame size calculation mismatch");
	return output;
}

function decodeFramed(bytes, deserialize, magic) {
	const reader = new Reader(bytes);
	for (const expected of magic) if (reader.byte() !== expected) throw new TypeError("Invalid SplitBinary format or version");
	const structuredLength = reader.varuint();
	const sectionCount = reader.varuint();
	const structured = reader.data(structuredLength);
	const skeleton = deserialize(structured);
	const sections = new Array(sectionCount);
	for (let index = 0; index < sectionCount; index++) {
		const length = reader.varuint();
		const padding = reader.byte();
		reader.data(padding);
		sections[index] = reader.data(length);
	}
	if (reader.offset !== reader.bytes.length) throw new TypeError("Trailing bytes after SplitBinary payload");
	return restoreSkeleton(skeleton, sections);
}


const MAGIC_COSON = [0x53, 0x42, 0x43, 1]; // SBC, version 1

/** Encode a supported JavaScript value as a Uint8Array. */
export function encode(value) {
	return encodeFramed(value, (skeleton) => inlineHybrid.encode(skeleton), MAGIC_COSON);
}

/** Decode a value previously encoded by encode(). */
export function decode(bytes) {
	return decodeFramed(bytes, (structured) => inlineHybrid.decode(structured), MAGIC_COSON);
}

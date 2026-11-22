
const MAGIC = [0x53, 0x42, 0x43, 3];
const OPERATORS = 1;
const INDEX = 2;
const MAX_DEPTH = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BufferType = globalThis.Buffer;

const types = [
    ArrayBuffer,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    globalThis.BigInt64Array,
    globalThis.BigUint64Array,
    DataView,
    globalThis.Float16Array,
    BufferType
];

const operators = new Set([
    "$number",
    "$bigint",
    "$date",
    "$regexp",
    "$map",
    "$set",
    "$binary",
    "$string",
    "$literal"
]);

const own = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);

const fail = message => {
    throw new TypeError(`COSON: ${message}`);
};

const special = value =>
    typeof value === "string" &&
    value.length <= 17 &&
    (
        value === "$undefined" ||
        value === "$nan" ||
        value === "$infinity" ||
        value === "$negativeInfinity"
    );

const define = (object, key, value) =>
    Object.defineProperty(object, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
    });

function mark(state, key, value) {
    state.flags |= OPERATORS;
    return { [key]: value };
}

function token(state, value) {
    state.flags |= OPERATORS;
    return value;
}

function descriptor(object, key) {
    const property = Object.getOwnPropertyDescriptor(object, key);

    if (!property || !own(property, "value"))
        fail("accessors and sparse arrays are unsupported");

    return property.value;
}

function symbols(value) {
    for (const key of Object.getOwnPropertySymbols(value)) {
        if (Object.prototype.propertyIsEnumerable.call(value, key))
            fail("enumerable symbol key");
    }
}

function binary(value, state, type) {
    const bytes = type === 0
        ? new Uint8Array(value)
        : new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength
        );

    if (
        typeof SharedArrayBuffer !== "undefined" &&
        bytes.buffer instanceof SharedArrayBuffer
    ) {
        fail("shared buffers are unsupported");
    }

    const index = state.sections.length;

    state.sections.push({
        bytes,
        alignment: types[type].BYTES_PER_ELEMENT || 1
    });

    return mark(state, "$binary", [index, type]);
}

function transform(value, state, depth = 0) {
    if (depth > MAX_DEPTH)
        fail("maximum depth exceeded");

    if (value === null)
        return null;

    switch (typeof value) {
        case "string":
            return special(value)
                ? mark(state, "$string", value)
                : value;

        case "boolean":
            return value;

        case "undefined":
            return token(state, "$undefined");

        case "number":
            if (Number.isNaN(value))
                return token(state, "$nan");

            if (value === Infinity)
                return token(state, "$infinity");

            if (value === -Infinity)
                return token(state, "$negativeInfinity");

            return Object.is(value, -0)
                ? mark(state, "$number", "-0")
                : value;

        case "bigint":
            return mark(state, "$bigint", value.toString());

        case "object":
            break;

        default:
            fail("unsupported value type");
    }

    if (state.seen.has(value))
        fail("circular or shared reference");

    state.seen.add(value);

    symbols(value);

    const prototype = Object.getPrototypeOf(value);

    if (prototype === ArrayBuffer.prototype)
        return binary(value, state, 0);

    if (ArrayBuffer.isView(value)) {
        for (let i = 1; i < types.length; i++) {
            if (types[i] && prototype === types[i].prototype)
                return binary(value, state, i);
        }

        fail("unsupported binary type");
    }

    if (prototype === Date.prototype) {
        return mark(
            state,
            "$date",
            Number.isNaN(value.getTime())
                ? null
                : value.getTime()
        );
    }

    if (prototype === RegExp.prototype) {
        return mark(state, "$regexp", [
            value.source,
            value.flags,
            transform(value.lastIndex, state, depth + 1)
        ]);
    }

    if (prototype === Map.prototype) {
        const entries = [];

        for (const [key, item] of value) {
            entries.push([
                transform(key, state, depth + 1),
                transform(item, state, depth + 1)
            ]);
        }

        return mark(state, "$map", entries);
    }

    if (prototype === Set.prototype) {
        const entries = [];

        for (const item of value)
            entries.push(transform(item, state, depth + 1));

        return mark(state, "$set", entries);
    }

    const keys = Object.keys(value);

    if (own(value, "toJSON")) {
        const hook = descriptor(value, "toJSON");

        if (typeof hook === "function")
            fail("custom toJSON is unsupported");
    }

    if (Array.isArray(value)) {
        if (
            prototype !== Array.prototype ||
            keys.length !== value.length ||
            "toJSON" in Array.prototype
        ) {
            fail("unsupported array shape");
        }

        let result;

        for (let i = 0; i < value.length; i++) {
            if (keys[i] !== String(i))
                fail("sparse array or extra array property");

            const original = descriptor(value, i);
            const item = transform(original, state, depth + 1);

            if (!result && !Object.is(original, item)) {
                result = new Array(value.length);

                for (let j = 0; j < i; j++)
                    result[j] = value[j];
            }

            if (result)
                result[i] = item;
        }

        return result || value;
    }

    if (
        prototype !== Object.prototype &&
        prototype !== null
    ) {
        fail("unsupported prototype");
    }

    if (
        prototype === Object.prototype &&
        "toJSON" in Object.prototype
    ) {
        fail("inherited toJSON");
    }

    const literal =
        keys.length === 1 &&
        operators.has(keys[0]);

    let result;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const original = descriptor(value, key);
        const item = transform(original, state, depth + 1);

        if (literal)
            return mark(state, "$literal", [[key, item]]);

        if (!result && !Object.is(original, item)) {
            result = Object.create(null);

            for (let j = 0; j < i; j++)
                result[keys[j]] = value[keys[j]];
        }

        if (result)
            result[key] = item;
    }

    return result || value;
}

/*
 * Identify reconstruction operators.
 */

function operator(value) {
    if (special(value))
        return value;

    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        return null;
    }

    const keys = Object.keys(value);

    return keys.length === 1 && operators.has(keys[0])
        ? keys[0]
        : null;
}

/*
 * Generate reconstruction paths on the sender.
 *
 * Full reconstruction indexes outermost operators.
 * Binary reconstruction indexes every binary reference,
 * including those nested inside other operators.
 */

function collectIndex(value) {
    const full = [];
    const binary = [];
    const path = [];

    function visit(value, covered = false) {
        const key = operator(value);

        if (key && !covered)
            full.push([path.slice(), key]);

        if (key === "$binary") {
            binary.push([path.slice(), key]);
            return;
        }

        if (key) {
            const argument = value[key];

            if (
                key === "$map" ||
                key === "$set" ||
                key === "$regexp" ||
                key === "$literal"
            ) {
                path.push(key);

                if (key === "$map") {
                    for (let i = 0; i < argument.length; i++) {
                        path.push(i, 0);
                        visit(argument[i][0], true);
                        path.pop();

                        path.push(1);
                        visit(argument[i][1], true);
                        path.pop();
                        path.pop();
                    }
                } else if (key === "$set") {
                    for (let i = 0; i < argument.length; i++) {
                        path.push(i);
                        visit(argument[i], true);
                        path.pop();
                    }
                } else if (key === "$regexp") {
                    path.push(2);
                    visit(argument[2], true);
                    path.pop();
                } else {
                    path.push(0, 1);
                    visit(argument[0][1], true);
                    path.pop();
                    path.pop();
                }

                path.pop();
            }

            return;
        }

        if (!value || typeof value !== "object")
            return;

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                path.push(i);
                visit(value[i], covered);
                path.pop();
            }
        } else {
            for (const key of Object.keys(value)) {
                path.push(key);
                visit(value[key], covered);
                path.pop();
            }
        }
    }

    visit(value);

    return [full, binary];
}

function varSize(value) {
    let size = 1;

    while (value >= 128) {
        value = Math.floor(value / 128);
        size++;
    }

    return size;
}

function writeVar(output, offset, value) {
    while (value >= 128) {
        output[offset++] = (value % 128) | 128;
        value = Math.floor(value / 128);
    }

    output[offset++] = value;

    return offset;
}

/*
 * Binary references are reserved within a prepared binary envelope.
 *
 * Only visit application-value positions, not scalar operator arguments
 * (for example, regexp source strings and literal property names).
 *
 * Copy on write: encoding never modifies the caller's object.
 */

function binaryReference(value) {
    if (typeof value !== "string")
        return null;

    const match = /^\$binary\[(0|[1-9]\d*)\]$/.exec(value);

    return match && match[0] === value
        ? Number(match[1])
        : null;
}

function objectBinaryReference(value) {
    if (typeof value !== "string")
        return null;

    const match = /^binary\[(0|[1-9]\d*)\]$/.exec(value);

    return match && match[0] === value
        ? Number(match[1])
        : null;
}

const objectMethods = new Set([
    "object.create",
    "object.read",
    "object.update",
    "object.delete"
]);

function hasObjectScope(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        objectMethods.has(value.method)
    );
}

function descriptorType(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;

    const keys = Object.keys(entry);

    if (keys.length !== 1 || !(entry[keys[0]] instanceof Uint8Array))
        return null;

    const key = keys[0];
    const type = types.findIndex((Type, index) =>
        Type && key === (
            index === 14
                ? "$Buffer"
                : `$${Type.name}`
        )
    );

    return type < 0
        ? null
        : { type, bytes: entry[key], alignment: types[type].BYTES_PER_ELEMENT || 1 };
}

function binaryDescriptors(owner) {
    if (!Array.isArray(owner?.binary) || !owner.binary.length)
        return null;

    const descriptors = owner.binary.map(descriptorType);

    return descriptors.every(Boolean)
        ? descriptors
        : null;
}

function nativeBinaryDescriptor(value) {
    if (!value || typeof value !== "object")
        return null;

    const prototype = Object.getPrototypeOf(value);
    let type = -1;
    let bytes;

    if (prototype === ArrayBuffer.prototype) {
        type = 0;
        bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
        type = types.findIndex((Type, index) =>
            index > 0 && Type && prototype === Type.prototype
        );

        if (type >= 0) {
            bytes = new Uint8Array(
                value.buffer,
                value.byteOffset,
                value.byteLength
            );
        }
    }

    if (type < 0)
        return null;

    return {
        type,
        bytes,
        alignment: types[type].BYTES_PER_ELEMENT || 1
    };
}

function mapBinaryValues(value, replace, depth = 0) {
    if (depth > MAX_DEPTH)
        fail("maximum depth exceeded");

    const result = replace(value);

    if (!Object.is(result, value))
        return result;

    if (!value || typeof value !== "object")
        return value;

    const key = operator(value);
    const next = item => mapBinaryValues(item, replace, depth + 1);

    if (key === "$regexp") {
        const argument = value[key];
        const item = next(argument[2]);

        return Object.is(item, argument[2])
            ? value
            : { [key]: [argument[0], argument[1], item] };
    }

    if (key === "$literal") {
        const argument = value[key];
        const item = next(argument[0][1]);

        return Object.is(item, argument[0][1])
            ? value
            : { [key]: [[argument[0][0], item]] };
    }

    if (key && key !== "$map" && key !== "$set")
        return value;

    let output;

    for (const property of Object.keys(value)) {
        const original = value[property];
        const item = next(original);

        if (!Object.is(item, original)) {
            if (!output)
                output = Array.isArray(value)
                    ? value.slice()
                    : { ...value };

            define(output, property, item);
        }
    }

    return output || value;
}

/*
 * Repackage an already prepared representation for transportation.
 *
 * Extract raw sections from the root $binary array,
 * restore only wire binary markers, and leave every
 * other operator untouched.
 */

function prepareObjectBinary(owner, state) {
    if (!owner || typeof owner !== "object" || Array.isArray(owner))
        return owner;

    const descriptors = binaryDescriptors(owner);
    const structured = { ...owner };
    delete structured.binary;

    const start = state.sections.length;
    const visited = new Set();
    let references = 0;

    const transformed = mapBinaryValues(structured, item => {
        if (operator(item) === "$binary")
            fail("expected object-local binary reference");

        const index = objectBinaryReference(item);

        if (index === null)
            return item;

        if (!descriptors)
            fail("missing object binary array");

        if (!Number.isSafeInteger(index) || index >= descriptors.length)
            fail("invalid object binary reference");

        visited.add(index);
        references++;

        return {
            $binary: [start + index, descriptors[index].type]
        };
    });

    if (!references)
        return owner;

    if (visited.size !== descriptors.length)
        fail("unreferenced object binary section");

    for (const descriptor of descriptors) {
        if (
            typeof SharedArrayBuffer !== "undefined" &&
            descriptor.bytes.buffer instanceof SharedArrayBuffer
        ) {
            fail("shared buffers are unsupported");
        }

        if (descriptor.bytes.byteLength % descriptor.alignment)
            fail("invalid binary length");

        state.sections.push({
            bytes: descriptor.bytes,
            alignment: descriptor.alignment
        });
    }

    return transformed;
}

function prepareCRUDEnvelopeBinary(value, state) {
    const target = value.object;
    const owners = Array.isArray(target) ? target : [target];
    const rawEntries = value.binary;
    const descriptors = rawEntries.map(entry =>
        descriptorType(entry) || nativeBinaryDescriptor(entry)
    );
    const referenced = new Set();
    const byOwner = new Map();
    let references = 0;
    let changed = false;
    const outputOwners = owners.slice();

    for (let i = 0; i < owners.length; i++) {
        const owner = owners[i];

        if (!owner || typeof owner !== "object" || Array.isArray(owner))
            continue;

        const structured = { ...owner };
        delete structured.binary;
        let ownerReferences = 0;
        const transformed = mapBinaryValues(structured, item => {
            if (operator(item) === "$binary")
                fail("expected prepared binary reference");

            const index = objectBinaryReference(item);

            if (index === null)
                return item;

            if (!Number.isSafeInteger(index) || index >= descriptors.length || !descriptors[index])
                fail("invalid envelope binary reference");

            const previousOwner = byOwner.get(index);
            if (previousOwner !== undefined && previousOwner !== i)
                fail("envelope binary section is shared between objects");

            byOwner.set(index, i);
            referenced.add(index);
            ownerReferences++;
            references++;

            return { $binary: [index, descriptors[index].type] };
        });

        if (ownerReferences) {
            if (own(owner, "binary"))
                fail("object binary property conflict");

            outputOwners[i] = transformed;
            changed = true;
        }
    }

    if (!references)
        return null;

    if (referenced.size !== descriptors.length)
        fail("unreferenced envelope binary section");

    for (const descriptor of descriptors) {
        if (
            typeof SharedArrayBuffer !== "undefined" &&
            descriptor.bytes.buffer instanceof SharedArrayBuffer
        ) {
            fail("shared buffers are unsupported");
        }

        if (descriptor.bytes.byteLength % descriptor.alignment)
            fail("invalid binary length");

        state.sections.push({
            bytes: descriptor.bytes,
            alignment: descriptor.alignment
        });
    }

    if (!changed)
        return null;

    const result = { ...value };
    delete result.binary;
    result.object = Array.isArray(target)
        ? outputOwners
        : outputOwners[0];
    return result;
}

function prepareBinary(value, state) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;

    // Non-CRUD messages retain the established root-owned `$binary` form.
    if (!hasObjectScope(value) && own(value, "$binary") && Array.isArray(value.$binary) && value.$binary.length) {
        const { $binary: entries, ...structured } = value;
        const typeIds = new Array(entries.length);
        const visited = new Set();

        for (let i = 0; i < entries.length; i++) {
            const descriptor = descriptorType(entries[i]);
            if (!descriptor)
                fail("invalid binary entry");
            if (descriptor.bytes.byteLength % descriptor.alignment)
                fail("invalid binary length");
            typeIds[i] = descriptor.type;
            state.sections.push({ bytes: descriptor.bytes, alignment: descriptor.alignment });
        }

        const transformed = mapBinaryValues(structured, item => {
            if (objectBinaryReference(item) !== null)
                fail("expected root binary reference");
            const index = binaryReference(item);
            if (index === null)
                return item;
            if (!Number.isSafeInteger(index) || index >= entries.length)
                fail("invalid binary reference");
            visited.add(index);
            return { $binary: [index, typeIds[index]] };
        });

        if (visited.size !== entries.length)
            fail("unreferenced binary section");

        return transformed;
    }

    let output = value;

    if (hasObjectScope(value)) {
        if (Array.isArray(value.binary) && value.binary.length) {
            const prepared = prepareCRUDEnvelopeBinary(value, state);

            if (prepared) {
                output = prepared;
                const transformed = mapBinaryValues(output, item => {
                    if (objectBinaryReference(item) !== null)
                        fail("binary reference outside CRUD object scope");

                    return item;
                });

                return transformed;
            }
        }

        const target = value.object;

        if (Array.isArray(target)) {
            let objects;

            for (let i = 0; i < target.length; i++) {
                const transformed = prepareObjectBinary(target[i], state);

                if (!Object.is(transformed, target[i])) {
                    if (!objects)
                        objects = target.slice();

                    objects[i] = transformed;
                }
            }

            if (objects) {
                output = { ...value, object: objects };
            }
        } else {
            const transformed = prepareObjectBinary(target, state);

            if (!Object.is(transformed, target))
                output = { ...value, object: transformed };
        }

        const transformed = mapBinaryValues(output, item => {
            if (objectBinaryReference(item) !== null)
                fail("binary reference outside CRUD object scope");

            return item;
        });

        return transformed;
    }

    return prepareObjectBinary(value, state);
}

/*
 * Encode
 *
 * operators: true
 *     Convert native JavaScript values into CoSON operators.
 *     Extract binary values and generate the transport frame.
 *
 * operators: false
 *     Preserve existing CoSON operators.
 *     Extract the root $binary entries.
 *     Package the representation for transportation.
 *
 * index: false
 *     Disable reconstruction index generation.
 */

export function encode(value, options) {
    const state = {
        flags: 0,
        sections: [],
        seen: new WeakSet()
    };

    const mode = options?.operators ?? true;

    if (mode !== true && mode !== false)
        fail("invalid operators mode");

    const transformed = mode
        ? transform(value, state)
        : prepareBinary(value, state);

    let entries;

    if (!mode) {
        // Input is already operator-form data.
        // Inspect only to generate frame flags and indexes.
        // Never apply native type conversion.

        entries = collectIndex(transformed);

        if (entries[0].length)
            state.flags |= OPERATORS;

        if (entries[1].length && !state.sections.length)
            fail("missing binary sections");
    }

    const index =
        state.flags && options?.index !== false
            ? encoder.encode(
                JSON.stringify(
                    entries || collectIndex(transformed)
                )
            )
            : null;

    if (index)
        state.flags |= INDEX;

    const json = JSON.stringify(transformed);

    const structured = BufferType
        ? null
        : encoder.encode(json);

    const length = structured
        ? structured.length
        : BufferType.byteLength(json, "utf8");

    const sections = state.sections;

    const start =
        MAGIC.length +
        1 +
        varSize(length) +
        varSize(sections.length);

    let size =
        start +
        length +
        (index ? varSize(index.length) + index.length : 0);

    for (const section of sections) {
        size += varSize(section.bytes.length) + 1;

        section.padding =
            (section.alignment - size % section.alignment) %
            section.alignment;

        size += section.padding + section.bytes.length;
    }

    const output = new Uint8Array(size);

    output.set(MAGIC);

    if (index)
        output[3] = 4;

    output[4] = state.flags;

    let offset = writeVar(output, 5, length);

    offset = writeVar(output, offset, sections.length);

    if (index) {
        offset = writeVar(output, offset, index.length);

        output.set(index, offset);

        offset += index.length;
    }

    if (structured) {
        output.set(structured, offset);
    } else {
        const written = BufferType.from(
            output.buffer,
            output.byteOffset,
            output.byteLength
        ).write(json, offset, length, "utf8");

        if (written !== length)
            fail("UTF-8 length mismatch");
    }

    offset += length;

    for (const section of sections) {
        offset = writeVar(
            output,
            offset,
            section.bytes.length
        );

        output[offset++] = section.padding;

        offset += section.padding;

        output.set(section.bytes, offset);

        offset += section.bytes.length;
    }

    return output;
}

/*
 * Read and validate the envelope.
 *
 * Supports indexed and unindexed frames.
 */

function frame(input) {
    if (!(input instanceof Uint8Array))
        fail("expected Uint8Array");

    const bytes = new Uint8Array(
        input.buffer,
        input.byteOffset,
        input.byteLength
    );

    let offset = 0;

    function byte() {
        if (offset >= bytes.length)
            fail("truncated frame");

        return bytes[offset++];
    }

    function uint() {
        let value = 0;
        let factor = 1;

        for (let i = 0; i < 8; i++) {
            const part = byte();

            value += (part & 127) * factor;

            if (!Number.isSafeInteger(value))
                fail("invalid integer");

            if (part < 128) {
                if (i && !part)
                    fail("noncanonical integer");

                return value;
            }

            factor *= 128;
        }

        fail("invalid integer");
    }

    function read(length) {
        if (length > bytes.length - offset)
            fail("truncated section");

        const result = bytes.subarray(
            offset,
            offset + length
        );

        offset += length;

        return result;
    }

    for (let i = 0; i < 3; i++) {
        if (byte() !== MAGIC[i])
            fail("unsupported frame magic");
    }

    const version = byte();

    if (version !== 3 && version !== 4)
        fail("unsupported frame version");

    const flags = byte();

    if (
        (flags & ~(version === 4
            ? OPERATORS | INDEX
            : OPERATORS)) ||
        ((flags & INDEX) && !(flags & OPERATORS))
    ) {
        fail("unknown flags");
    }

    const length = uint();
    const count = uint();

    const index = flags & INDEX
        ? read(uint())
        : null;

    const structured = read(length);

    if (
        count > Math.floor((bytes.length - offset) / 2) ||
        (count && !flags)
    ) {
        fail("invalid section count");
    }

    const sections = new Array(count);
    const paddings = new Array(count);

    for (let i = 0; i < count; i++) {
        const length = uint();
        const padding = byte();
        paddings[i] = padding;

        if (padding > 7)
            fail("invalid padding");

        for (let j = 0; j < padding; j++) {
            if (byte())
                fail("nonzero padding");
        }

        sections[i] = read(length);
    }

    if (offset !== bytes.length)
        fail("trailing bytes");

    return {
        flags,
        structured,
        sections,
        paddings,
        index
    };
}

/*
 * Restore native binary values.
 */

function restoreBinary(argument, sections) {
    if (
        !Array.isArray(argument) ||
        argument.length !== 2
    ) {
        fail("invalid binary operator");
    }

    const [index, type] = argument;

    if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= sections.length ||
        !Number.isInteger(type) ||
        !types[type]
    ) {
        fail("invalid binary reference");
    }

    const bytes = sections[index];
    const Type = types[type];

    if (type === 0)
        return new Uint8Array(bytes).buffer;

    if (type === 12) {
        return new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );
    }

    if (type === 14) {
        return BufferType.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );
    }

    const alignment = Type.BYTES_PER_ELEMENT;

    if (bytes.byteLength % alignment)
        fail("invalid binary length");

    const view = bytes.byteOffset % alignment
        ? new Uint8Array(bytes)
        : bytes;

    return new Type(
        view.buffer,
        view.byteOffset,
        view.byteLength / alignment
    );
}

/*
 * Recursive reconstruction.
 *
 * Used for unindexed frames and nested operator arguments.
 */

function reconstruct(value, sections, depth = 0) {
    if (depth > MAX_DEPTH)
        fail("maximum depth exceeded");

    if (value === "$undefined")
        return undefined;

    if (value === "$nan")
        return NaN;

    if (value === "$infinity")
        return Infinity;

    if (value === "$negativeInfinity")
        return -Infinity;

    if (value === null || typeof value !== "object")
        return value;

    const next = item =>
        reconstruct(item, sections, depth + 1);

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            value[i] = next(value[i]);

        return value;
    }

    const keys = Object.keys(value);

    if (keys.length === 1 && operators.has(keys[0])) {
        const argument = value[keys[0]];

        switch (keys[0]) {
            case "$string":
                if (
                    typeof argument !== "string" ||
                    !special(argument)
                ) {
                    fail("invalid string escape");
                }

                return argument;

            case "$number":
                if (argument !== "-0")
                    fail("invalid number");

                return -0;

            case "$bigint":
                if (
                    typeof argument !== "string" ||
                    !/^-?(0|[1-9]\d*)$/.test(argument)
                ) {
                    fail("invalid bigint");
                }

                return BigInt(argument);

            case "$date":
                if (
                    argument !== null &&
                    !Number.isSafeInteger(argument)
                ) {
                    fail("invalid date");
                }

                return new Date(
                    argument === null ? NaN : argument
                );

            case "$regexp": {
                if (
                    !Array.isArray(argument) ||
                    argument.length !== 3 ||
                    typeof argument[0] !== "string" ||
                    typeof argument[1] !== "string"
                ) {
                    fail("invalid regexp");
                }

                const result = new RegExp(
                    argument[0],
                    argument[1]
                );

                result.lastIndex = next(argument[2]);

                return result;
            }

            case "$binary":
                return restoreBinary(argument, sections);

            case "$map": {
                if (!Array.isArray(argument))
                    fail("invalid map");

                const result = new Map();

                for (const entry of argument) {
                    if (
                        !Array.isArray(entry) ||
                        entry.length !== 2
                    ) {
                        fail("invalid map entry");
                    }

                    result.set(
                        next(entry[0]),
                        next(entry[1])
                    );
                }

                return result;
            }

            case "$set": {
                if (!Array.isArray(argument))
                    fail("invalid set");

                const result = new Set();

                for (const item of argument)
                    result.add(next(item));

                return result;
            }

            case "$literal": {
                if (
                    !Array.isArray(argument) ||
                    argument.length !== 1 ||
                    !Array.isArray(argument[0]) ||
                    argument[0].length !== 2 ||
                    !operators.has(argument[0][0])
                ) {
                    fail("invalid literal");
                }

                const result = {};

                define(
                    result,
                    argument[0][0],
                    next(argument[0][1])
                );

                return result;
            }
        }
    }

    for (const key of keys)
        value[key] = next(value[key]);

    return value;
}

/*
 * Indexed reconstruction.
 *
 * Accesses known paths without traversing unrelated properties.
 */

function applyIndex(value, entries, sections, binaryOnly) {
    if (!Array.isArray(entries))
        fail("invalid reconstruction index");

    for (const entry of entries) {
        if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            !Array.isArray(entry[0])
        ) {
            fail("invalid reconstruction entry");
        }

        const [path, key] = entry;

        if (
            path.length > MAX_DEPTH * 4 ||
            (binaryOnly && key !== "$binary")
        ) {
            fail("invalid reconstruction path");
        }

        let parent;
        let target = value;

        for (const part of path) {
            if (
                !(
                    typeof part === "string" ||
                    (Number.isSafeInteger(part) && part >= 0)
                ) ||
                !target ||
                typeof target !== "object" ||
                !own(target, part)
            ) {
                fail("invalid reconstruction path");
            }

            parent = target;
            target = target[part];
        }

        if (operator(target) !== key || !key)
            fail("invalid indexed operator");

        const restored = binaryOnly
            ? restoreBinary(target.$binary, sections)
            : reconstruct(target, sections);

        if (path.length)
            define(parent, path[path.length - 1], restored);
        else
            value = restored;
    }

    return value;
}

/*
 * Prepare the non-reconstructed binary envelope.
 *
 * Converts encoded binary operators:
 *
 *     { $binary: [0, 2] }
 *
 * Into owner-local direct references:
 *
 *     "binary[0]"
 *
 * And attaches byte descriptors to each owner:
 *
 *     binary: [
 *         { $Uint8Array: bytes }
 *     ]
 *
 * CRUD object scopes remain inside the original message envelope.
 * No native application values are reconstructed.
 */

function preserveObjectBinary(value, sections, owner, ownerBySection) {
    const entries = [];
    const localByGlobal = new Map();
    const visited = new Set();
    let references = 0;
    let transformed;

    transformed = mapBinaryValues(value, item => {
        // A binary reference belongs to exactly one object. Reusing a
        // transport section across different owners is ambiguous.

        if (
            binaryReference(item) !== null ||
            objectBinaryReference(item) !== null
        )
            fail("reserved binary reference string");

        const key = operator(item);

        if (key !== "$binary")
            return item;

        const argument = item.$binary;

        if (!Array.isArray(argument) || argument.length !== 2)
            fail("invalid binary operator");

        const [index, type] = argument;

        if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= sections.length ||
            !Number.isInteger(type) ||
            !types[type]
        ) {
            fail("invalid binary reference");
        }

        const claimedBy = ownerBySection.get(index);

        if (claimedBy && claimedBy !== owner)
            fail("binary section is shared between objects");

        ownerBySection.set(index, owner);

        let localIndex = localByGlobal.get(index);

        if (localIndex === undefined) {
            const bytes = sections[index];
            const Type = types[type];
            const alignment = Type.BYTES_PER_ELEMENT || 1;

            if (
                type !== 0 &&
                type !== 12 &&
                bytes.byteLength % alignment
            ) {
                fail("invalid binary length");
            }

            localIndex = entries.length;
            localByGlobal.set(index, localIndex);
            const name = type === 14 ? "Buffer" : Type.name;
            entries.push({ [`$${name}`]: bytes });
        } else {
            const name = Object.keys(entries[localIndex])[0];
            const expected = type === 14
                ? "$Buffer"
                : `$${types[type].name}`;

            if (name !== expected)
                fail("conflicting binary types");
        }

        visited.add(index);
        references++;

        return `binary[${localIndex}]`;
    });

    return { value: transformed, entries, visited, references };
}

function preserveBinary(value, sections) {
    if (!sections.length)
        return value;

    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        operator(value)
    ) {
        fail("binary envelope must be an object");
    }

    const ownerBySection = new Map();
    const crud = hasObjectScope(value);
    const target = crud ? value.object : value;
    const owners = crud
        ? (Array.isArray(target) ? target : [target])
        : [value];
    const ownerResults = new Map();
    const visited = new Set();
    let references = 0;

    for (const owner of owners) {
        if (!owner || typeof owner !== "object" || Array.isArray(owner))
            continue;

        const result = preserveObjectBinary(owner, sections, owner, ownerBySection);

        if (result.references) {
            if (own(owner, "binary"))
                fail("object binary property conflict");

            define(result.value, "binary", result.entries);
            ownerResults.set(owner, result.value);
            references += result.references;

            for (const index of result.visited)
                visited.add(index);
        }
    }

    if (!references || visited.size !== sections.length)
        fail("unreferenced or unowned binary section");

    let transformed = value;

    if (crud) {
        if (Array.isArray(target)) {
            const output = target.slice();
            let changed = false;

            for (let i = 0; i < target.length; i++) {
                const result = ownerResults.get(target[i]);

                if (result) {
                    output[i] = result;
                    changed = true;
                }
            }

            if (changed)
                transformed = { ...value, object: output };
        } else {
            const result = ownerResults.get(target);

            if (result)
                transformed = { ...value, object: result };
        }

        transformed = mapBinaryValues(transformed, item => {
            if (operator(item) === "$binary")
                fail("binary value outside CRUD object scope");
            return item;
        });

        return transformed;
    }

    const result = ownerResults.get(value);

    return result || transformed;
}

/*
 * Decode
 *
 * operators: true
 *     Restore native JavaScript values.
 *
 * operators: "binary"
 *     Restore binary values only.
 *
 * operators: false
 *     Preserve encoded operators.
 *     Replace binary operators with path references.
 *     Attach typed binary sections to root $binary.
 *
 * The previous reconstruct option remains supported
 * for backward compatibility.
 */

export function decode(bytes, options) {
    return decodeParts(frame(bytes), options);
}

function decodeParts({ flags, structured, sections, index }, options) {
    const mode =
        options?.operators ??
        options?.reconstruct ??
        false;

    if (
        mode !== true &&
        mode !== false &&
        mode !== "binary"
    ) {
        fail("invalid operators mode");
    }

    const value = JSON.parse(
        decoder.decode(structured)
    );

    // Preserve the encoded representation.

    if (mode === false)
        return preserveBinary(value, sections);

    // Native JSON fast path.

    if (!(flags & OPERATORS))
        return value;

    // Automatically use the reconstruction index.

    if (index) {
        const entries = JSON.parse(
            decoder.decode(index)
        );

        if (
            !Array.isArray(entries) ||
            entries.length !== 2 ||
            !entries.every(Array.isArray)
        ) {
            fail("invalid index");
        }

        return applyIndex(
            value,
            entries[mode === "binary" ? 1 : 0],
            sections,
            mode === "binary"
        );
    }

    // Binary-only fallback for unindexed frames.

    if (mode === "binary") {
        return sections.length
            ? applyIndex(
                value,
                collectIndex(value)[1],
                sections,
                true
            )
            : value;
    }

    // Full recursive reconstruction fallback.

    return reconstruct(value, sections);
}

/** Encode CoSON as readable structured JSON plus independently transferable binary sections. */
export function encodeSegments(value, options) {
    const state = { flags: 0, sections: [], seen: new WeakSet() };
    const mode = options?.operators ?? true;
    if (mode !== true && mode !== false) fail("invalid operators mode");
    const transformed = mode ? transform(value, state) : prepareBinary(value, state);
    let entries;
    if (!mode) {
        entries = collectIndex(transformed);
        if (entries[0].length) state.flags |= OPERATORS;
        if (entries[1].length && !state.sections.length) fail("missing binary sections");
    }
    const index = state.flags && options?.index !== false
        ? encoder.encode(JSON.stringify(entries || collectIndex(transformed)))
        : null;
    if (index) state.flags |= INDEX;
    const json = JSON.stringify(transformed);
    return {
        json,
        flags: state.flags,
        index,
        binaries: state.sections.map(section => new Uint8Array(
            section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength
        ))
    };
}

function toCoSONBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    fail("CoSON segment must be binary");
}

/** Reassemble segmented CoSON bytes and decode using the standard operator policy. */
export function decodeSegments(segments, options) {
    if (!segments || typeof segments.json !== "string" || !Array.isArray(segments.binaries))
        fail("invalid CoSON segments");
    const index = segments.index == null ? null : toCoSONBytes(segments.index);
    const sections = segments.binaries.map(value => {
        const bytes = toCoSONBytes(value);
        return bytes.byteOffset % 8 ? new Uint8Array(bytes) : bytes;
    });
    const flags = segments.flags;
    if (!Number.isInteger(flags) || flags < 0 || flags > 3 || Boolean(flags & INDEX) !== Boolean(index))
        fail("invalid CoSON segment flags");
    return decodeParts({ flags, structured: encoder.encode(segments.json), sections, index }, options);
}

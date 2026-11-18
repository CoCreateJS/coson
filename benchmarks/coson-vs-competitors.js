import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";
import { serialize as bsonSerialize, deserialize as bsonDeserialize } from "bson";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, "..");
const COSON_PATH = join(MODULE, "src/index.js");
const RUN_STARTED_AT = new Date().toISOString();
const TARGETS = (process.env.COSON_BENCH_SIZES
    ? process.env.COSON_BENCH_SIZES.split(",").map(Number)
    : [10, 50, 100]).map((size) => size * 1024);
const PROPERTY_COUNTS = process.env.COSON_BENCH_PROPERTIES
    ? process.env.COSON_BENCH_PROPERTIES.split(",").map(Number)
    : [20, 50, 100];
const PROFILES = process.env.COSON_BENCH_PROFILES
    ? process.env.COSON_BENCH_PROFILES.split(",")
    : ["JSON", "Extended", "Mixed binary"];
const WARMUPS = 3;
const RUNS = 5;
const BATCH = 100;
const MEMORY_CONCURRENCY = Number(process.env.COSON_BENCH_MEMORY_CONCURRENCY || 2);
const REPORT_PATH = process.env.COSON_BENCH_REPORT
    ? resolve(process.env.COSON_BENCH_REPORT)
    : join(HERE, `coson-vs-competitors-v6-latest.md`);
const textEncoder = new TextEncoder();
const MiB = 1024 ** 2;

async function sourceMetadata() {
    const source = await readFile(COSON_PATH);
    return {
        cosonHash: createHash("sha256").update(source).digest("hex")
    };
}

function gc() {
    if (typeof globalThis.gc !== "function") {
        throw new Error("Run with node --expose-gc");
    }
    globalThis.gc();
}

function bytesOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("Encoder did not return a binary payload");
}

function restoreBson(value) {
    if (value?._bsontype === "Binary") return Uint8Array.from(value.value(true));
    if (Array.isArray(value)) return value.map(restoreBson);
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            Object.defineProperty(output, key, {
                value: restoreBson(item), enumerable: true, configurable: true, writable: true
            });
        }
        return output;
    }
    return value;
}

function codecByName(name, v2, v3) {
    if (name === "CoSON") return { name, encode: v3.encode, decode: v3.decode };
    if (name === "CBOR-X") return { name, encode: cborEncode, decode: cborDecode };
    if (name === "BSON") return { name, encode: bsonSerialize, decode: (bytes) => restoreBson(bsonDeserialize(bytes)) };
    throw new Error(`Unknown codec ${name}`);
}

function codecs(v2, v3) {
    return ["CoSON", "CBOR-X", "BSON"].map((name) => codecByName(name, v2, v3));
}

function additionalFidelityCases() {
    const cases = [
        ["undefined property", { value: undefined }],
        ["invalid Date", { value: new Date(NaN) }],
        ["DataView", { value: new DataView(Uint8Array.from([11, 22, 33, 44]).buffer, 1, 2) }],
        ["Buffer", { value: Buffer.from([5, 127, 255]) }],
        ["reserved operator collisions", {
            strings: ["$undefined", "$nan", "$infinity", "$negativeInfinity"],
            objects: [
                { $undefined: true }, { $nan: true }, { $infinity: true },
                { $negativeInfinity: true }, { $string: "$nan" },
                { $number: "-0" }, { $date: 1794966471263 }, { $bigint: "123" },
                { $map: [["a", 1]] }, { $set: [1, 2] }, { $regexp: ["x", "gi", 0] },
                { $binary: ["Uint8Array", 3] }, { $literal: [["x", 1]] }
            ]
        }]
    ];
    const typedArrayTypes = [
        "Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
        "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Float16Array"
    ];
    for (const name of typedArrayTypes) {
        const Type = globalThis[name];
        if (!Type) continue;
        const values = name.startsWith("Big") ? [1n, -2n] : [1, -2];
        cases.push([name, { value: new Type(values) }]);
    }
    return cases;
}

async function runAdditionalFidelity() {
    const coson = await import(pathToFileURL(COSON_PATH).href);
    const codecList = codecs(coson, coson);
    return additionalFidelityCases().map(([test, value]) => ({
        test,
        results: codecList.map((codec) => {
            try {
                const result = fidelity(codec.decode(codec.encode(value)), value);
                return { codec: codec.name, lossless: result.lossless, reason: result.reason };
            } catch (error) {
                return { codec: codec.name, lossless: false, reason: `${error.name}: ${error.message}` };
            }
        })
    }));
}

function bytePattern(length, seed) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
        bytes[index] = (index * 31 + seed * 17 + 11) & 255;
    }
    return bytes;
}

function binaryBytes(value) {
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return 0;
}

function taggedForSize(value) {
    if (value === undefined) return { $undefined: true };
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (typeof value === "number") {
        if (Number.isNaN(value)) return { $number: "NaN" };
        if (value === Infinity) return { $number: "Infinity" };
        if (value === -Infinity) return { $number: "-Infinity" };
        if (Object.is(value, -0)) return { $number: "-0" };
        return value;
    }
    if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.getTime() };
    if (value instanceof RegExp) return { $regexp: [value.source, value.flags, value.lastIndex] };
    if (value instanceof Map) return { $map: [...value].map(([key, item]) => [taggedForSize(key), taggedForSize(item)]) };
    if (value instanceof Set) return { $set: [...value].map(taggedForSize) };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return { $binary: [value.constructor.name, binaryBytes(value)] };
    }
    if (Array.isArray(value)) return value.map(taggedForSize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, taggedForSize(item)]));
    }
    return value;
}

function logicalDocumentBytes(value) {
    const structure = textEncoder.encode(JSON.stringify(taggedForSize(value))).byteLength;
    const seen = new WeakSet();
    let rawBinary = 0;
    function visit(item) {
        if (!item || typeof item !== "object" || seen.has(item)) return;
        seen.add(item);
        rawBinary += binaryBytes(item);
        if (item instanceof Map) {
            for (const [key, child] of item) {
                visit(key);
                visit(child);
            }
        } else if (item instanceof Set || Array.isArray(item)) {
            for (const child of item) visit(child);
        } else if (!(item instanceof Date) && !(item instanceof RegExp) &&
                   !(item instanceof ArrayBuffer) && !ArrayBuffer.isView(item)) {
            for (const child of Object.values(item)) visit(child);
        }
    }
    visit(value);
    return structure + rawBinary;
}

function fillStrings(value, targetBytes, profile) {
    const keys = Object.keys(value).filter((key) => typeof value[key] === "string");
    if (!keys.length) return;
    const remaining = targetBytes - logicalDocumentBytes(value);
    if (remaining <= 0) return;
    let left = remaining;
    for (let index = 0; index < keys.length; index++) {
        const share = Math.floor(left / (keys.length - index));
        value[keys[index]] += "x".repeat(share);
        left -= share;
    }
}

function makeDataset(profile, targetBytes, propertyCount) {
    const value = {};
    for (let index = 0; index < propertyCount; index++) {
        const key = `field${String(index).padStart(3, "0")}`;
        if (index === 0) {
            value[key] = { id: "usr-102", active: true, roles: ["editor", "reviewer"], note: "" };
            continue;
        }
        if (index === 1) {
            value[key] = [{ name: "theme", value: "dark" }, { name: "pinned", value: false }];
            continue;
        }
        if (profile === "Extended") {
            switch (index % 10) {
                case 0: value[key] = new Date(1794966471263 + index); break;
                case 1: value[key] = BigInt(index) ** 8n; break;
                case 2: value[key] = new Map([["index", index], ["active", true]]); break;
                case 3: value[key] = new Set(["tag", index]); break;
                case 4: value[key] = Object.assign(new RegExp(`item${index}`, "gi"), { lastIndex: index % 4 }); break;
                case 5: value[key] = NaN; break;
                case 6: value[key] = Infinity; break;
                case 7: value[key] = -Infinity; break;
                case 8: value[key] = -0; break;
                default: value[key] = "";
            }
            continue;
        }
        if (profile === "Mixed binary" && index === 2) {
            value[key] = new ArrayBuffer(0);
            continue;
        }
        if (profile === "Mixed binary" && index === 3) {
            value[key] = new Uint8Array(0);
            continue;
        }
        if (profile === "Mixed binary" && index === 4) {
            value[key] = new Uint16Array(0);
            continue;
        }
        value[key] = "";
    }

    if (profile === "Mixed binary") {
        const budget = Math.floor(targetBytes * 0.2);
        const first = Math.floor(budget / 3);
        const second = Math.floor(budget / 3);
        const third = Math.max(0, Math.floor((budget - first - second) / 2) * 2);
        value.field002 = bytePattern(first, 1).buffer;
        value.field003 = bytePattern(second, 2);
        value.field004 = new Uint16Array(bytePattern(third, 3).buffer);
    }

    fillStrings(value, targetBytes, profile);

    return {
        value,
        targetBytes,
        actualBytes: logicalDocumentBytes(value),
        propertyCount: Object.keys(value).length
    };
}

function compareExact(actual, expected, path = "$", seen = new WeakMap()) {
    if (Object.is(actual, expected)) return null;
    if (typeof actual !== typeof expected || actual === null || expected === null) {
        return `${path}: value or type differs`;
    }
    if (typeof actual !== "object") return `${path}: value differs`;

    let paired = seen.get(actual);
    if (paired?.has(expected)) return null;
    if (!paired) seen.set(actual, paired = new WeakSet());
    paired.add(expected);

    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return `${path}: prototype differs`;
    if (actual instanceof Date) {
        return Object.is(actual.getTime(), expected.getTime()) ? null : `${path}: Date differs`;
    }
    if (actual instanceof RegExp) {
        return actual.source === expected.source && actual.flags === expected.flags && actual.lastIndex === expected.lastIndex
            ? null : `${path}: RegExp differs`;
    }
    if (actual instanceof ArrayBuffer) {
        if (!(expected instanceof ArrayBuffer) || actual.byteLength !== expected.byteLength) return `${path}: ArrayBuffer type or length differs`;
        const left = new Uint8Array(actual);
        const right = new Uint8Array(expected);
        for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return `${path}: binary byte differs`;
        return null;
    }
    if (ArrayBuffer.isView(actual)) {
        if (!ArrayBuffer.isView(expected) || actual.constructor !== expected.constructor || actual.byteLength !== expected.byteLength) {
            return `${path}: binary view type or length differs`;
        }
        const left = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
        const right = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
        for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return `${path}: binary byte differs`;
        return null;
    }
    if (actual instanceof Map) {
        if (!(expected instanceof Map) || actual.size !== expected.size) return `${path}: Map size differs`;
        const left = actual.entries();
        const right = expected.entries();
        let index = 0;
        while (true) {
            const a = left.next();
            const b = right.next();
            if (a.done) return null;
            const keyDifference = compareExact(a.value[0], b.value[0], `${path}.<key${index}>`, seen);
            if (keyDifference) return keyDifference;
            const valueDifference = compareExact(a.value[1], b.value[1], `${path}.<value${index}>`, seen);
            if (valueDifference) return valueDifference;
            index++;
        }
    }
    if (actual instanceof Set) {
        if (!(expected instanceof Set) || actual.size !== expected.size) return `${path}: Set size differs`;
        const left = actual.values();
        const right = expected.values();
        let index = 0;
        while (true) {
            const a = left.next();
            const b = right.next();
            if (a.done) return null;
            const difference = compareExact(a.value, b.value, `${path}.<set${index++}>`, seen);
            if (difference) return difference;
        }
    }

    const leftKeys = Reflect.ownKeys(actual).filter((key) => Object.prototype.propertyIsEnumerable.call(actual, key));
    const rightKeys = Reflect.ownKeys(expected).filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return `${path}: keys differ`;
    for (const key of leftKeys) {
        const difference = compareExact(actual[key], expected[key], `${path}.${String(key)}`, seen);
        if (difference) return difference;
    }
    return null;
}

function fidelity(actual, expected) {
    const reason = compareExact(actual, expected);
    return { lossless: reason === null, reason };
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
    const usable = values.filter(Number.isFinite);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function asMiB(bytes) {
    return bytes == null ? null : +(bytes / MiB).toFixed(3);
}

function ms(value) {
    return value == null ? "n/a" : value.toFixed(4);
}

function bytesLabel(value) {
    if (value == null) return "n/a";
    return value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${Math.round(value)} B`;
}

function memUsage() {
    const current = process.memoryUsage();
    return {
        heap: current.heapUsed,
        external: current.external,
        arrayBuffers: current.arrayBuffers ?? 0
    };
}

function readVmRss(pid) {
    try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        return match ? Number(match[1]) * 1024 : null;
    } catch {
        return null;
    }
}

async function runMemoryWorker(args) {
    const [, , , v2Path, v3Path, profile, targetText, propertyText, codecName, phase] = args;
    const targetBytes = Number(targetText);
    const propertyCount = Number(propertyText);
    const dataset = makeDataset(profile, targetBytes, propertyCount);
    const v2 = await import(pathToFileURL(v2Path).href);
    const v3 = await import(pathToFileURL(v3Path).href);
    const codec = codecByName(codecName, v2, v3);
    const input = dataset.value;
    const warmFrame = codec.encode(input);

    for (let run = 0; run < WARMUPS; run++) {
        for (let index = 0; index < BATCH; index++) {
            if (phase === "encode") codec.encode(input);
            else codec.decode(warmFrame);
        }
        gc();
    }

    let peakFrames = null;
    if (phase === "decode") {
        peakFrames = Array.from({ length: BATCH }, () => codec.encode(input));
        gc();
    }

    const peakBaseline = readVmRss(process.pid) ?? process.memoryUsage().rss;
    process.stdout.write("READY " + JSON.stringify({ baselineRss: peakBaseline }) + "\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));

    const retainedHeapSamples = [];
    const retainedExternalSamples = [];
    const retainedArrayBufferSamples = [];

    for (let run = 0; run < RUNS; run++) {
        gc();
        const before = memUsage();
        let outputs;

        if (phase === "encode") {
            outputs = Array.from({ length: BATCH }, () => codec.encode(input));
        } else {
            outputs = peakFrames.map((frame) => codec.decode(frame));
        }

        gc();
        const after = memUsage();
        retainedHeapSamples.push((after.heap - before.heap) / BATCH);
        retainedExternalSamples.push((after.external - before.external) / BATCH);
        retainedArrayBufferSamples.push((after.arrayBuffers - before.arrayBuffers) / BATCH);
        outputs.length = 0;
        gc();
    }

    process.stdout.write("PEAK_DONE\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));

    if (phase === "decode") {
        peakFrames = null;
        gc();

        // Measure the retained decoded state after releasing the input frames.
        retainedHeapSamples.length = 0;
        retainedExternalSamples.length = 0;
        retainedArrayBufferSamples.length = 0;

        for (let run = 0; run < RUNS; run++) {
            gc();
            const baseline = memUsage();
            const frames = Array.from({ length: BATCH }, () => codec.encode(input));
            gc();
            const decoded = frames.map((frame) => codec.decode(frame));
            frames.length = 0;
            gc();
            const after = memUsage();
            retainedHeapSamples.push((after.heap - baseline.heap) / BATCH);
            retainedExternalSamples.push((after.external - baseline.external) / BATCH);
            retainedArrayBufferSamples.push((after.arrayBuffers - baseline.arrayBuffers) / BATCH);
            decoded.length = 0;
            gc();
        }
    }

    const retainedHeapBytesPerOperation = median(retainedHeapSamples);
    const retainedExternalBytesPerOperation = median(retainedExternalSamples);
    const result = {
        retainedHeapBytesPerOperation,
        retainedExternalBytesPerOperation,
        retainedArrayBufferBytesPerOperation: median(retainedArrayBufferSamples),
        retainedTotalBytesPerOperation:
            retainedHeapBytesPerOperation + retainedExternalBytesPerOperation
    };

    process.stdout.write("RESULT " + JSON.stringify(result) + "\n");
}

function sampleRssTask(codecName, profile, targetBytes, propertyCount, phase, v2Path, v3Path) {
    return new Promise((resolvePromise) => {
        const args = [
            fileURLToPath(import.meta.url),
            "--memory",
            v2Path,
            v3Path,
            profile,
            String(targetBytes),
            String(propertyCount),
            codecName,
            phase
        ];
        const child = spawn(process.execPath, [...process.execArgv, ...args], {
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let ready = false;
        let peakDone = false;
        let baselineRss = 0;
        let peakRss = 0;
        let result = null;
        let sampler = null;
        let finished = false;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            finish("memory worker timed out after 60 seconds");
        }, 180_000);

        function sample() {
            const current = readVmRss(child.pid);
            if (current != null) peakRss = Math.max(peakRss, current);
        }

        function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (sampler) clearInterval(sampler);
            if (error) {
                resolvePromise({ error: String(error), peakRssDeltaBytes: null });
            } else {
                sample();
                resolvePromise({
                    ...result,
                    peakRssDeltaBytes: Math.max(0, peakRss - baselineRss)
                });
            }
        }

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            let newline;
            while ((newline = stdout.indexOf("\n")) >= 0) {
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                if (line.startsWith("READY ")) {
                    const data = JSON.parse(line.slice(6));
                    baselineRss = data.baselineRss;
                    peakRss = baselineRss;
                    ready = true;
                    sampler = setInterval(sample, 1);
                    child.stdin.write("GO\n");
                    if (process.env.COSON_BENCH_DEBUG) process.stdout.write(`worker READY ${codecName} ${phase}\n`);
                } else if (line === "PEAK_DONE") {
                    sample();
                    peakDone = true;
                    if (sampler) clearInterval(sampler);
                    sampler = null;
                    child.stdin.write("CONT\n");
                    if (process.env.COSON_BENCH_DEBUG) process.stdout.write(`worker PEAK_DONE ${codecName} ${phase}\n`);
                } else if (line.startsWith("RESULT ")) {
                    result = JSON.parse(line.slice(7));
                    child.stdin.end();
                    if (process.env.COSON_BENCH_DEBUG) process.stdout.write(`worker RESULT ${codecName} ${phase}\n`);
                }
            }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", finish);
        child.on("close", (code) => {
            if (code !== 0) finish(stderr || ("memory worker exited " + code));
            else if (!ready || !peakDone || !result) finish("memory worker did not return a result");
            else finish(null);
        });
    });
}
async function mapLimit(items, limit, callback) {
    const output = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            output[index] = await callback(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return output;
}

function buildResultRows(v2, v3) {
    const allCodecs = codecs(v2, v3);
    const rows = [];

    for (const profile of PROFILES) {
        for (const targetBytes of TARGETS) {
            for (const propertyCount of PROPERTY_COUNTS) {
                const dataset = makeDataset(profile, targetBytes, propertyCount);
                const row = {
                    profile,
                    targetBytes,
                    actualBytes: dataset.actualBytes,
                    propertyCount,
                    codecs: []
                };

                for (const codec of allCodecs) {
                    let encoded = null;
                    let outputBytes = null;
                    let fidelityResult;
                    try {
                        encoded = codec.encode(dataset.value);
                        outputBytes = bytesOf(encoded).byteLength;
                        try {
                            fidelityResult = fidelity(codec.decode(encoded), dataset.value);
                        } catch (error) {
                            fidelityResult = { lossless: false, reason: `decode error: ${String(error.message).slice(0, 180)}` };
                        }
                    } catch (error) {
                        fidelityResult = { lossless: false, reason: `encode error: ${String(error.message).slice(0, 180)}` };
                    }

                    const encodeSamples = [];
                    const decodeSamples = [];
                    const timeError = { encode: null, decode: null };
                    const encodeBytes = outputBytes;

                    for (let run = 0; run < WARMUPS; run++) {
                        try {
                            for (let index = 0; index < BATCH; index++) codec.encode(dataset.value);
                            const warmFrame = codec.encode(dataset.value);
                            for (let index = 0; index < BATCH; index++) codec.decode(warmFrame);
                        } catch (error) {
                            timeError.encode = error.message;
                            timeError.decode = error.message;
                        }
                        gc();
                    }

                    for (let run = 0; run < RUNS; run++) {
                        gc();
                        try {
                            let start = performance.now();
                            for (let index = 0; index < BATCH; index++) codec.encode(dataset.value);
                            encodeSamples.push((performance.now() - start) / BATCH);
                        } catch (error) {
                            timeError.encode = error.message;
                        }
                        gc();

                        let frame = encoded;
                        if (!frame) {
                            try {
                                frame = codec.encode(dataset.value);
                            } catch (error) {
                                timeError.decode = error.message;
                                continue;
                            }
                        }

                        gc();
                        try {
                            const start = performance.now();
                            for (let index = 0; index < BATCH; index++) codec.decode(frame);
                            decodeSamples.push((performance.now() - start) / BATCH);
                        } catch (error) {
                            timeError.decode = error.message;
                        }
                        gc();
                    }

                    row.codecs.push({
                        name: codec.name,
                        lossless: fidelityResult.lossless,
                        fidelityReason: fidelityResult.reason,
                        outputBytes: encodeBytes,
                        encodeMs: median(encodeSamples),
                        decodeMs: median(decodeSamples),
                        timeError
                    });
                    if (process.env.COSON_BENCH_PROGRESS) {
                        const memory = process.memoryUsage();
                        process.stdout.write(`latency ${profile}/${targetBytes / 1024}KiB/${propertyCount} ${codec.name}: heap=${Math.round(memory.heapUsed / MiB)}MiB external=${Math.round(memory.external / MiB)}MiB\n`);
                    }
                }

                rows.push(row);
                if (process.env.COSON_BENCH_PROGRESS) {
                    process.stdout.write(`latency datasets completed: ${rows.length}/${PROFILES.length * TARGETS.length * PROPERTY_COUNTS.length}\n`);
                }
            }
        }
    }

    return rows;
}

function medianOfRows(rows, codecName, predicate, key) {
    const values = [];
    for (const row of rows) {
        if (predicate && !predicate(row)) continue;
        const entry = row.codecs.find((codec) => codec.name === codecName);
        if (entry && entry[key] != null && Number.isFinite(entry[key])) values.push(entry[key]);
    }
    return median(values);
}

function percentileImprovement(competitor, v3) {
    if (!Number.isFinite(competitor) || competitor === 0 || !Number.isFinite(v3)) return null;
    return ((competitor - v3) / competitor) * 100;
}

function medianImprovement(rows, competitorName, metric, memoryKey = null) {
    const values = [];
    for (const row of rows) {
        const v3 = row.codecs.find((codec) => codec.name === "CoSON V3");
        const competitor = row.codecs.find((codec) => codec.name === competitorName);
        if (!v3?.lossless || !competitor?.lossless) continue;

        let a;
        let b;
        if (memoryKey) {
            a = v3[memoryKey];
            b = competitor[memoryKey];
        } else {
            a = v3[metric];
            b = competitor[metric];
        }

        const change = percentileImprovement(b, a);
        if (change != null) values.push(change);
    }
    return {
        n: values.length,
        improvement: median(values)
    };
}

function medianMemoryImprovement(rows, memoryRows, competitorName, phase, metric) {
    const values = [];
    for (const row of rows) {
        const v3 = row.codecs.find((codec) => codec.name === "CoSON V3");
        const competitor = row.codecs.find((codec) => codec.name === competitorName);
        if (!v3?.lossless || !competitor?.lossless) continue;
        const current = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes &&
            item.propertyCount === row.propertyCount && item.codec === "CoSON V3" && item.phase === phase);
        const previous = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes &&
            item.propertyCount === row.propertyCount && item.codec === competitorName && item.phase === phase);
        const from = previous?.[metric];
        const to = current?.[metric];
        if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to < 0) continue;
        values.push(percentileImprovement(from, to));
    }
    return median(values);
}

function fmtPercent(value) {
    if (value == null) return "n/a";
    const rounded = +value.toFixed(1);
    return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function fmtMiB(value) {
    return value == null ? "n/a" : `${(value / MiB).toFixed(2)}`;
}

function summarizeMemory(memoryRows) {
    return memoryRows.map((result) => {
        const name = result.codec;
        return {
            name,
            profile: result.profile,
            targetBytes: result.targetBytes,
            propertyCount: result.propertyCount,
            phase: result.phase,
            peakRssDeltaBytes: result.peakRssDeltaBytes ?? null,
            retainedHeapBytesPerOperation: result.retainedHeapBytesPerOperation ?? null,
            retainedExternalBytesPerOperation: result.retainedExternalBytesPerOperation ?? null,
            retainedArrayBufferBytesPerOperation: result.retainedArrayBufferBytesPerOperation ?? null,
            error: result.error ?? null
        };
    });
}

function aggregateMemory(memoryRows, phase, targetBytes = null) {
    const rows = memoryRows.filter((row) =>
        row.phase === phase &&
        (targetBytes == null || row.targetBytes === targetBytes) &&
        row.error == null
    );
    const summaries = {};
    for (const name of ["CoSON", "CBOR-X", "BSON"]) {
        const selected = rows.filter((row) => row.codec === name);
        summaries[name] = {
            n: selected.length,
            peakRssDeltaBytes: median(selected.map((row) => row.peakRssDeltaBytes)),
            retainedHeapBytesPerOperation: median(selected.map((row) => row.retainedHeapBytesPerOperation)),
            retainedExternalBytesPerOperation: median(selected.map((row) => row.retainedExternalBytesPerOperation)),
            retainedArrayBufferBytesPerOperation: median(selected.map((row) => row.retainedArrayBufferBytesPerOperation))
        };
    }
    return summaries;
}

function memoryCell(summary, key) {
    const value = summary?.[key];
    return value == null ? "n/a" : Math.round(value).toString();
}

function improvement(base, current) {
    if (!Number.isFinite(base) || base === 0 || !Number.isFinite(current)) return null;
    return ((base - current) / base) * 100;
}

function renderReport(metadata, rows, memoryRows, extraFidelity = []) {
    const names = ["CoSON", "CBOR-X", "BSON"];
    const lines = [
        "# CoSON, CBOR-X and BSON Comparative Benchmark",
        "",
        `Benchmark UTC: ${metadata.timestamp}`,
        `CoSON source SHA-256: ${metadata.cosonHash}`,
        `Environment: Node ${metadata.node}; ${metadata.platform}/${metadata.arch}; heap cap ${metadata.heapLimit}; exposed GC.`,
        `Method: ${WARMUPS} warmups; ${RUNS} measured batches; ${BATCH} operations per batch. Latency is median of five batch averages. Encode/decode memory sampled in isolated workers; RSS sampled every 1 ms. Retained values are median post-GC deltas per operation.`,
        "",
        "Dataset matrix is unchanged: 10/50/100 KiB; 20/50/100 properties; JSON, Extended, and Mixed binary profiles. Percentage improvement = (competitor − CoSON) / competitor × 100; positive favors CoSON. Only pairs where both codecs round-trip the dataset losslessly are used for performance deltas.",
        "",
        "## Workload fidelity",
        "",
        "| Codec | JSON | Extended | Mixed binary | Total |",
        "|---|---:|---:|---:|---:|"
    ];
    for (const name of names) {
        const counts = PROFILES.map((profile) => {
            const group = rows.filter((row) => row.profile === profile);
            const passed = group.filter((row) => row.codecs.find((codec) => codec.name === name)?.lossless).length;
            return `${passed}/${group.length}`;
        });
        const passed = rows.filter((row) => row.codecs.find((codec) => codec.name === name)?.lossless).length;
        lines.push(`| ${name} | ${counts.join(" | ")} | ${passed}/${rows.length} |`);
    }
    lines.push("", "Lossy/unsupported dataset cases (kept out of lossless performance comparisons):", "", "| Profile | Size | Properties | Codec | Outcome |", "|---|---:|---:|---|---|");
    let failures = 0;
    for (const row of rows) for (const codec of row.codecs) if (!codec.lossless) {
        failures++;
        lines.push(`| ${row.profile} | ${row.targetBytes / 1024} KiB | ${row.propertyCount} | ${codec.name} | ${String(codec.fidelityReason || "failed round trip").replaceAll("|", "\\|")} |`);
    }
    if (!failures) lines.push("| None | — | — | — | All dataset round trips lossless |");

    lines.push("", "## Latency and encoded size by target size", "", "Median across the nine profile/property cases. Fidelity cells show lossless cases / nine.", "", "| KiB | Codec | Encode ms | Decode ms | Payload bytes | Fidelity |", "|---:|---|---:|---:|---:|---:|");
    for (const target of TARGETS) for (const name of names) {
        const group = rows.filter((row) => row.targetBytes === target);
        const lossless = group.filter((row) => row.codecs.find((codec) => codec.name === name)?.lossless);
        const get = (key) => median(lossless.map((row) => row.codecs.find((codec) => codec.name === name)?.[key]));
        lines.push(`| ${target / 1024} | ${name} | ${ms(get("encodeMs"))} | ${ms(get("decodeMs"))} | ${Math.round(get("outputBytes") ?? 0)} | ${lossless.length}/${group.length} |`);
    }

    lines.push("", "## Memory by target size", "", "Peak is sampled RSS increase. Retained ArrayBuffer bytes are shown as a subset of external memory; do not add them to external.", "", "| KiB | Codec | Encode peak MiB | Decode peak MiB | Encode retained heap / external / AB B/op | Decode retained heap / external / AB B/op |", "|---:|---|---:|---:|---:|---:|");
    for (const target of TARGETS) for (const name of names) {
        const enc = aggregateMemory(memoryRows, "encode", target)[name];
        const dec = aggregateMemory(memoryRows, "decode", target)[name];
        const cell = (item) => `${memoryCell(item, "retainedHeapBytesPerOperation")} / ${memoryCell(item, "retainedExternalBytesPerOperation")} / ${memoryCell(item, "retainedArrayBufferBytesPerOperation")}`;
        lines.push(`| ${target / 1024} | ${name} | ${fmtMiB(enc?.peakRssDeltaBytes)} | ${fmtMiB(dec?.peakRssDeltaBytes)} | ${cell(enc)} | ${cell(dec)} |`);
    }

    lines.push("", "## CoSON percentage differences", "", "Medians of per-dataset differences, across exact-lossless pairs only. Values are unavailable when no common lossless pairs exist. Retained memory is heap plus external; ArrayBuffer backing is already inside external.", "", "| Competitor | Lossless pairs | Encode | Decode | Payload | Encode peak RSS | Decode peak RSS | Retained encode memory | Retained decode memory |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const otherName of ["CBOR-X", "BSON"]) {
        const values = { encode: [], decode: [], size: [], peakEncode: [], peakDecode: [], retainedEncode: [], retainedDecode: [] };
        let pairs = 0;
        for (const row of rows) {
            const own = row.codecs.find((codec) => codec.name === "CoSON");
            const other = row.codecs.find((codec) => codec.name === otherName);
            if (!own?.lossless || !other?.lossless) continue;
            pairs++;
            for (const [metric, key] of [["encode", "encodeMs"], ["decode", "decodeMs"], ["size", "outputBytes"]]) {
                const change = improvement(other[key], own[key]);
                if (change != null) values[metric].push(change);
            }
            for (const [metric, phase, key] of [
                ["peakEncode", "encode", "peakRssDeltaBytes"], ["peakDecode", "decode", "peakRssDeltaBytes"],
                ["retainedEncode", "encode", "retainedTotalBytesPerOperation"], ["retainedDecode", "decode", "retainedTotalBytesPerOperation"]
            ]) {
                const ownMem = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes && item.propertyCount === row.propertyCount && item.codec === "CoSON" && item.phase === phase);
                const otherMem = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes && item.propertyCount === row.propertyCount && item.codec === otherName && item.phase === phase);
                const change = improvement(otherMem?.[key], ownMem?.[key]);
                if (change != null) values[metric].push(change);
            }
        }
        lines.push(`| ${otherName} | ${pairs} | ${fmtPercent(median(values.encode))} | ${fmtPercent(median(values.decode))} | ${fmtPercent(median(values.size))} | ${fmtPercent(median(values.peakEncode))} | ${fmtPercent(median(values.peakDecode))} | ${fmtPercent(median(values.retainedEncode))} | ${fmtPercent(median(values.retainedDecode))} |`);
    }

    lines.push("", "## Additional supported-type fidelity checks", "", "These cases are tested separately and are not added to timed datasets.", "", "| Case | CoSON | CBOR-X | BSON |", "|---|---|---|---|");
    for (const test of extraFidelity) {
        const cells = names.map((name) => {
            const result = test.results.find((item) => item.codec === name);
            return result?.lossless ? "lossless" : `FAIL: ${(result?.reason || "unsupported").replaceAll("|", "\\|")}`;
        });
        lines.push(`| ${test.test} | ${cells.join(" | ")} |`);
    }
    lines.push("", "## Limits", "", "Peak RSS sampling can miss brief spikes shorter than 1 ms. External memory includes ArrayBuffer backing; the separately shown AB column is only a subset. Memory and latency are Node.js measurements.", "");
    return lines.join("\n");
}

function buildPairwiseReport(rows, memoryRows) {
    // Output rows use only exact-fidelity comparisons; summarized in renderReport.
    memoryRows = memoryRows.filter(Boolean);
    for (const row of rows) {
        for (const codec of row.codecs) {
            const enc = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes && item.propertyCount === row.propertyCount && item.codec === codec.name && item.phase === "encode");
            const dec = memoryRows.find((item) => item.profile === row.profile && item.targetBytes === row.targetBytes && item.propertyCount === row.propertyCount && item.codec === codec.name && item.phase === "decode");
            codec.retainedEncodeTotalBytesPerOperation = enc?.retainedTotalBytesPerOperation ?? null;
            codec.retainedDecodeTotalBytesPerOperation = dec?.retainedTotalBytesPerOperation ?? null;
            codec.peakEncodeRssBytes = enc?.peakRssDeltaBytes ?? null;
            codec.peakDecodeRssBytes = dec?.peakRssDeltaBytes ?? null;
        }
    }
}

async function runSingleBenchmark() {
    if (!globalThis.gc) throw new Error("Run with node --expose-gc");
    const source = await sourceMetadata();
    const v2 = await import(pathToFileURL(COSON_PATH).href);
    const v3 = await import(pathToFileURL(COSON_PATH).href);
    const codecList = codecs(v2, v3);
    const rows = buildResultRows(v2, v3);
    const tasks = [];
    for (const profile of PROFILES) {
        for (const targetBytes of TARGETS) {
            for (const propertyCount of PROPERTY_COUNTS) {
                for (const codec of codecList) {
                    for (const phase of ["encode", "decode"]) {
                        tasks.push({ profile, targetBytes, propertyCount, codec: codec.name, phase });
                    }
                }
            }
        }
    }

    const memoryRows = await mapLimit(tasks, MEMORY_CONCURRENCY, async (task, index) => {
        const measured = rows.find((row) => row.profile === task.profile && row.targetBytes === task.targetBytes && row.propertyCount === task.propertyCount)
            ?.codecs.find((codec) => codec.name === task.codec);
        if (!Number.isFinite(measured?.outputBytes)) {
            return { ...task, error: "memory sample skipped: codec could not encode this dataset", peakRssDeltaBytes: null };
        }
        const result = await sampleRssTask(
            task.codec, task.profile, task.targetBytes, task.propertyCount,
            task.phase, COSON_PATH, COSON_PATH
        );
        const row = {
            ...task,
            ...result
        };
        if (index % 36 === 35) {
            process.stdout.write(`memory samples completed: ${index + 1}/${tasks.length}\n`);
        }
        return row;
    });

    buildPairwiseReport(rows, memoryRows);
    const sourceAtEnd = await sourceMetadata();
    if (sourceAtEnd.cosonHash !== source.cosonHash)
        throw new Error("Source changed during the benchmark; refusing to publish results");
    const metadata = {
        ...source,
        timestamp: RUN_STARTED_AT,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        heapLimit: process.execArgv.find((argument) => argument.startsWith("--max-old-space-size="))
            ? `${process.execArgv.find((argument) => argument.startsWith("--max-old-space-size=")).split("=")[1]} MiB`
            : "Node default"
    };
    if (process.env.COSON_BENCH_INTERNAL === "1") {
        process.stdout.write(`RAW_RESULT:${JSON.stringify({ metadata, rows, memoryRows })}\n`);
    } else {
        const report = renderReport(metadata, rows, memoryRows, await runAdditionalFidelity());
        await writeFile(REPORT_PATH, report);
        process.stdout.write(`Saved concise report: ${REPORT_PATH}\n`);
        process.stdout.write(`Report size: ${Buffer.byteLength(report)} bytes; lines: ${report.split("\n").length}\n`);
    }
}

async function runPartitionedBenchmark() {
    const allRows = [];
    const allMemoryRows = [];
    let metadata = null;
    const expectedSource = await sourceMetadata();

    for (const sizeKiB of [10, 50, 100]) {
        const childEnv = { ...process.env, COSON_BENCH_INTERNAL: "1", COSON_BENCH_SIZES: String(sizeKiB) };
        delete childEnv.COSON_BENCH_PROPERTIES;
        delete childEnv.COSON_BENCH_PROFILES;
        delete childEnv.COSON_BENCH_PROGRESS;
        delete childEnv.COSON_BENCH_DEBUG;
        delete childEnv.COSON_BENCH_REPORT;

        const output = await new Promise((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
                cwd: HERE,
                env: childEnv,
                stdio: ["ignore", "pipe", "inherit"]
            });
            let stdout = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.on("error", rejectPromise);
            child.on("close", (code) => {
                if (code !== 0) rejectPromise(new Error(`Benchmark worker for ${sizeKiB} KiB exited ${code ?? `via ${child.signalCode}`}`));
                else resolvePromise(stdout);
            });
        });

        const resultLine = output.split("\n").find((line) => line.startsWith("RAW_RESULT:"));
        if (!resultLine) throw new Error(`Benchmark worker for ${sizeKiB} KiB returned no results`);
        const result = JSON.parse(resultLine.slice("RAW_RESULT:".length));
        if (result.metadata.cosonHash !== expectedSource.cosonHash)
            throw new Error(`Source hashes changed in the ${sizeKiB} KiB worker`);
        metadata ??= result.metadata;
        allRows.push(...result.rows);
        allMemoryRows.push(...result.memoryRows);
        process.stdout.write(`completed size partition: ${sizeKiB} KiB (${allRows.length}/${PROFILES.length * TARGETS.length * PROPERTY_COUNTS.length} datasets)\n`);
    }

    const sourceAtEnd = await sourceMetadata();
    if (sourceAtEnd.cosonHash !== expectedSource.cosonHash)
        throw new Error("Source changed during the benchmark; refusing to publish results");
    metadata = { ...metadata, ...expectedSource, timestamp: RUN_STARTED_AT };
    const extraFidelity = await runAdditionalFidelity();
    const report = renderReport(metadata, allRows, allMemoryRows, extraFidelity);
    await writeFile(REPORT_PATH, report);
    process.stdout.write(`Saved concise report: ${REPORT_PATH}\n`);
    process.stdout.write(`Report size: ${Buffer.byteLength(report)} bytes; lines: ${report.split("\n").length}\n`);
}

async function main() {
    if (process.env.COSON_BENCH_INTERNAL === "1" || process.env.COSON_BENCH_SIZES ||
        process.env.COSON_BENCH_PROPERTIES || process.env.COSON_BENCH_PROFILES) {
        return runSingleBenchmark();
    }
    return runPartitionedBenchmark();
}

if (process.argv[2] === "--memory") {
    await runMemoryWorker(process.argv);
} else {
    await main();
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

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
    : join(HERE, `decode-reconstruction-v6-latest.md`);
const textEncoder = new TextEncoder();
const MiB = 1024 ** 2;

async function sourceMetadata() {
    const source = await readFile(COSON_PATH);
    return {
        v6Hash: createHash("sha256").update(source).digest("hex")
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

function codecByName(name, v2, v3) {
    return { name: "CoSON V6", encode: v3.encode, decode: v3.decode };
}

function codecs(v2, v3) {
    return [codecByName("CoSON V6", v2, v3)];
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


const MODES = [
    { key: "full", label: "decode(payload)", decode: (codec, bytes) => codec.decode(bytes) },
    { key: "raw", label: "decode(payload, { reconstruct: false })", decode: (codec, bytes) => codec.decode(bytes, { reconstruct: false }) }
];

function setImmediatePromise() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function runMemoryWorker(args) {
    const [, , , payloadPath, modeKey] = args;
    const coson = await import(pathToFileURL(COSON_PATH).href);
    const mode = MODES.find((item) => item.key === modeKey);
    if (!mode) throw new Error(`Unknown decode mode: ${modeKey}`);
    const payload = await readFile(payloadPath);
    const decode = () => mode.decode(coson, payload);

    for (let run = 0; run < WARMUPS; run++) {
        for (let index = 0; index < BATCH; index++) decode();
        gc();
    }

    let frames = Array.from({ length: BATCH }, () => Uint8Array.from(payload));
    gc();
    const baselineRss = readVmRss(process.pid) ?? process.memoryUsage().rss;
    process.stdout.write(`READY ${JSON.stringify({ baselineRss })}\n`);
    await new Promise((resolve) => process.stdin.once("data", resolve));

    for (let run = 0; run < RUNS; run++) {
        gc();
        const decoded = frames.map((frame) => mode.decode(coson, frame));
        gc();
        await setImmediatePromise();
        decoded.length = 0;
    }
    process.stdout.write("PEAK_DONE\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    frames = null;
    gc();

    const heapSamples = [];
    const externalSamples = [];
    const arrayBufferSamples = [];
    for (let run = 0; run < RUNS; run++) {
        gc();
        const before = memUsage();
        const inputFrames = Array.from({ length: BATCH }, () => Uint8Array.from(payload));
        gc();
        const decoded = inputFrames.map((frame) => mode.decode(coson, frame));
        inputFrames.length = 0;
        gc();
        const after = memUsage();
        heapSamples.push((after.heap - before.heap) / BATCH);
        externalSamples.push((after.external - before.external) / BATCH);
        arrayBufferSamples.push((after.arrayBuffers - before.arrayBuffers) / BATCH);
        decoded.length = 0;
        gc();
    }
    const heap = median(heapSamples);
    const external = median(externalSamples);
    process.stdout.write("RESULT " + JSON.stringify({
        retainedHeapBytesPerOperation: heap,
        retainedExternalBytesPerOperation: external,
        retainedArrayBufferBytesPerOperation: median(arrayBufferSamples),
        retainedTotalBytesPerOperation: heap + external
    }) + "\n");
}

function sampleMemoryTask(payloadPath, modeKey) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--memory", payloadPath, modeKey], {
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let baselineRss = 0;
        let peakRss = 0;
        let result = null;
        let sampler = null;
        let ready = false;
        let peakDone = false;
        const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
        const sample = () => {
            const current = readVmRss(child.pid);
            if (current != null) peakRss = Math.max(peakRss, current);
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            let newline;
            while ((newline = stdout.indexOf("\n")) >= 0) {
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                if (line.startsWith("READY ")) {
                    baselineRss = JSON.parse(line.slice(6)).baselineRss;
                    peakRss = baselineRss;
                    ready = true;
                    sampler = setInterval(sample, 1);
                    child.stdin.write("GO\n");
                } else if (line === "PEAK_DONE") {
                    sample();
                    peakDone = true;
                    clearInterval(sampler);
                    sampler = null;
                    child.stdin.write("CONT\n");
                } else if (line.startsWith("RESULT ")) {
                    result = JSON.parse(line.slice(7));
                    child.stdin.end();
                }
            }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => rejectPromise(error));
        child.on("close", (code) => {
            clearTimeout(timeout);
            if (sampler) clearInterval(sampler);
            if (code !== 0 || !ready || !peakDone || !result) {
                rejectPromise(new Error(stderr || `Memory worker failed (${code})`));
                return;
            }
            resolvePromise({ ...result, peakRssDeltaBytes: Math.max(0, peakRss - baselineRss) });
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

function overhead(full, raw) {
    if (!Number.isFinite(full) || !Number.isFinite(raw)) return { absolute: null, percent: null };
    return { absolute: full - raw, percent: raw === 0 ? null : ((full - raw) / raw) * 100 };
}

function signed(value, digits = 4) {
    if (!Number.isFinite(value)) return "n/a";
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function fmtMiB(bytes) {
    return Number.isFinite(bytes) ? (bytes / MiB).toFixed(2) : "n/a";
}

function renderReport(metadata, rows, memoryRows) {
    const lines = [
        "# CoSON V6 Decode Reconstruction Cost",
        "",
        `Benchmark UTC: ${metadata.timestamp}`,
        `Source SHA-256: ${metadata.v6Hash}`,
        `Environment: Node ${metadata.node}; ${metadata.platform}/${metadata.arch}; ${metadata.heapLimit}; exposed GC.`,
        `Method: ${WARMUPS} warmup batches, ${RUNS} measured batches, ${BATCH} operations per batch. Latency is median of five batch averages. Memory workers are isolated by dataset and decode mode; RSS is sampled every 1 ms.`,
        "",
        "Every pair uses the same encoded frame bytes. One untimed encode creates each fixture payload; encoding is excluded from all measurements. Dataset matrix: 10/50/100 KiB, 20/50/100 properties, JSON, Extended, and Mixed binary.",
        "",
        "Reconstruction overhead = decode(payload) minus decode(payload, { reconstruct: false }); percentage uses the no-reconstruction result as baseline. Positive means full reconstruction costs more; negative means it is faster or uses less memory. Retained total is heap + external. ArrayBuffer is shown separately as a subset of external and is not added again.",
        "",
        "## Decode latency by profile and size",
        "",
        "Each cell aggregates the three property counts by median. Overhead is the median paired difference across those property counts.",
        "",
        "| Profile | KiB | Reconstruct ms/op | No reconstruction ms/op | Absolute overhead ms/op | Overhead % |",
        "|---|---:|---:|---:|---:|---:|"
    ];
    for (const profile of PROFILES) for (const target of TARGETS) {
        const group = rows.filter((row) => row.profile === profile && row.targetBytes === target);
        const full = group.map((row) => row.fullDecodeMs);
        const raw = group.map((row) => row.rawDecodeMs);
        const abs = group.map((row, i) => full[i] - raw[i]);
        const pct = group.map((row, i) => overhead(full[i], raw[i]).percent);
        lines.push(`| ${profile} | ${target / 1024} | ${ms(median(full))} | ${ms(median(raw))} | ${signed(median(abs))} | ${signed(median(pct), 1)}% |`);
    }

    lines.push("", "## Decode memory by profile and size", "", "Peak RSS uses isolated worker increases. Retained columns report heap / external / ArrayBuffer bytes per operation; ArrayBuffer is part of external.", "", "| Profile | KiB | Peak RSS full / raw MiB | Peak overhead MiB / % | Retained total full / raw B/op | Retained overhead B/op / % | Retained AB full / raw B/op |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const profile of PROFILES) for (const target of TARGETS) {
        const group = rows.filter((row) => row.profile === profile && row.targetBytes === target);
        const getMem = (row, mode, key) => memoryRows.find((item) => item.profile === row.profile && item.targetBytes === target && item.propertyCount === row.propertyCount && item.mode === mode)?.[key];
        const peakFull = group.map((row) => getMem(row, "full", "peakRssDeltaBytes"));
        const peakRaw = group.map((row) => getMem(row, "raw", "peakRssDeltaBytes"));
        const peakOverhead = group.map((row, i) => peakFull[i] - peakRaw[i]);
        const peakPercent = group.map((row, i) => overhead(peakFull[i], peakRaw[i]).percent);
        const retainedFull = group.map((row) => getMem(row, "full", "retainedTotalBytesPerOperation"));
        const retainedRaw = group.map((row) => getMem(row, "raw", "retainedTotalBytesPerOperation"));
        const retainedOverhead = group.map((row, i) => retainedFull[i] - retainedRaw[i]);
        const retainedPercent = group.map((row, i) => overhead(retainedFull[i], retainedRaw[i]).percent);
        const abFull = group.map((row) => getMem(row, "full", "retainedArrayBufferBytesPerOperation"));
        const abRaw = group.map((row) => getMem(row, "raw", "retainedArrayBufferBytesPerOperation"));
        lines.push(`| ${profile} | ${target / 1024} | ${fmtMiB(median(peakFull))} / ${fmtMiB(median(peakRaw))} | ${signed(median(peakOverhead) / MiB, 3)} / ${signed(median(peakPercent), 1)}% | ${Math.round(median(retainedFull))} / ${Math.round(median(retainedRaw))} | ${signed(median(retainedOverhead), 1)} / ${signed(median(retainedPercent), 1)}% | ${Math.round(median(abFull))} / ${Math.round(median(abRaw))} |`);
    }

    lines.push("", "## Full reconstruction fidelity", "", "`decode(payload)` was compared with the original object; no-reconstruction output is an intermediate representation and is not expected to restore native types.", "", "| Profile | Exact round trips |", "|---|---:|");
    for (const profile of PROFILES) {
        const group = rows.filter((row) => row.profile === profile);
        lines.push(`| ${profile} | ${group.filter((row) => row.fullLossless).length}/${group.length} |`);
    }
    lines.push("", "## Limits", "", "RSS sampling can miss peaks shorter than 1 ms. Memory figures are Node.js estimates; external memory includes ArrayBuffer backing. The ArrayBuffer column is informational and not additive.", "");
    return lines.join("\n");
}

async function runDecodeBenchmark() {
    if (!globalThis.gc) throw new Error("Run with node --expose-gc");
    const source = await sourceMetadata();
    const coson = await import(pathToFileURL(COSON_PATH).href);
    const fixtureDir = await mkdtemp(join(tmpdir(), "coson-v6-decode-"));
    const rows = [];
    const memoryTasks = [];
    try {
        for (const profile of PROFILES) for (const targetBytes of TARGETS) for (const propertyCount of PROPERTY_COUNTS) {
            const dataset = makeDataset(profile, targetBytes, propertyCount);
            const payload = coson.encode(dataset.value);
            const framePath = join(fixtureDir, `${profile.replaceAll(" ", "-")}-${targetBytes}-${propertyCount}.bin`);
            await writeFile(framePath, bytesOf(payload));
            const fullDecode = (bytes) => coson.decode(bytes);
            const rawDecode = (bytes) => coson.decode(bytes, { reconstruct: false });
            const fullLossless = fidelity(fullDecode(payload), dataset.value).lossless;
            const fullSamples = [];
            const rawSamples = [];
            const funcs = [fullDecode, rawDecode];
            for (let run = 0; run < WARMUPS; run++) {
                for (const decode of funcs) {
                    for (let i = 0; i < BATCH; i++) decode(payload);
                    gc();
                }
            }
            for (let run = 0; run < RUNS; run++) {
                const order = run % 2 === 0 ? [[fullDecode, fullSamples], [rawDecode, rawSamples]] : [[rawDecode, rawSamples], [fullDecode, fullSamples]];
                for (const [decode, samples] of order) {
                    gc();
                    const start = performance.now();
                    for (let i = 0; i < BATCH; i++) decode(payload);
                    samples.push((performance.now() - start) / BATCH);
                }
            }
            rows.push({ profile, targetBytes, actualBytes: dataset.actualBytes, propertyCount, payloadBytes: bytesOf(payload).byteLength,
                fullDecodeMs: median(fullSamples), rawDecodeMs: median(rawSamples), fullLossless });
            for (const mode of MODES) memoryTasks.push({ profile, targetBytes, propertyCount, framePath, mode: mode.key });
        }
        const memoryRows = await mapLimit(memoryTasks, MEMORY_CONCURRENCY, async (task, index) => {
            const result = await sampleMemoryTask(task.framePath, task.mode);
            const row = { ...task, ...result };
            delete row.framePath;
            if (index % 18 === 17) process.stdout.write(`decode memory tasks completed: ${index + 1}/${memoryTasks.length}\n`);
            return row;
        });
        const sourceAtEnd = await sourceMetadata();
        if (source.v6Hash !== sourceAtEnd.v6Hash) throw new Error("CoSON source changed during benchmark");
        const report = renderReport({ ...source, timestamp: RUN_STARTED_AT, node: process.version, platform: process.platform, arch: process.arch,
            heapLimit: process.execArgv.find((item) => item.startsWith("--max-old-space-size="))?.split("=")[1] + " MiB" || "Node default" }, rows, memoryRows);
        await writeFile(REPORT_PATH, report);
        process.stdout.write(`Saved concise report: ${REPORT_PATH}\n`);
        process.stdout.write(`Report size: ${Buffer.byteLength(report)} bytes; lines: ${report.split("\n").length}\n`);
    } finally {
        await rm(fixtureDir, { recursive: true, force: true });
    }
}

if (process.argv[2] === "--memory") await runMemoryWorker(process.argv);
else await runDecodeBenchmark();

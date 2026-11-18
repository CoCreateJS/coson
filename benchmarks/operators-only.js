import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SOURCE = join(ROOT, "src/index.js");
const REPORT = join(HERE, "operators-only-latest.md");
const SIZES = [10, 50, 100].map((size) => size * 1024);
const PROFILE_NAMES = ["JSON", "Extended", "Mixed binary"];
const PROPERTIES = 50;
const WARMUPS = 3;
const RUNS = 5;
const BATCH = 100;
const encoder = new TextEncoder();

function gc() {
    if (typeof globalThis.gc !== "function")
        throw new Error("Run Node with --expose-gc");
    globalThis.gc();
}

function sampleBytes(length, seed = 1) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed * 17 + 11) & 255;
    return bytes;
}

function makeDataset(profile, target) {
    const value = {};
    for (let i = 0; i < PROPERTIES; i++) {
        const key = `field${String(i).padStart(3, "0")}`;
        if (i === 0) value[key] = { id: "usr-102", active: true, tags: ["editor", "reviewer"] };
        else if (i === 1) value[key] = [{ name: "theme", value: "dark" }, { name: "pinned", value: false }];
        else if (profile === "Extended") {
            switch (i % 9) {
                case 0: value[key] = new Date(1794966471263 + i); break;
                case 1: value[key] = BigInt(i) ** 7n; break;
                case 2: value[key] = new Map([["index", i], ["active", true]]); break;
                case 3: value[key] = new Set(["tag", i]); break;
                case 4: value[key] = Object.assign(new RegExp(`item${i}`, "gi"), { lastIndex: i % 3 }); break;
                case 5: value[key] = NaN; break;
                case 6: value[key] = Infinity; break;
                case 7: value[key] = -Infinity; break;
                default: value[key] = -0;
            }
        } else {
            value[key] = i % 4 === 0 ? i * 17 : i % 4 === 1 ? i % 2 === 0 : "";
        }
    }

    if (profile === "Mixed binary") {
        const bytes = Math.floor(target * 0.2 / 3);
        value.field002 = sampleBytes(bytes, 1).buffer;
        value.field003 = sampleBytes(bytes, 2);
        const aligned = Math.floor(bytes / 2) * 2;
        value.field004 = new Uint16Array(sampleBytes(aligned, 3).buffer);
    }

    // Fill existing string fields to keep key count fixed and documents near target size.
    const keys = Object.keys(value).filter((key) => typeof value[key] === "string");
    const textTarget = profile === "Mixed binary" ? target * 0.8 : target;
    const current = encoder.encode(JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof Date) return item.getTime();
        if (item instanceof Map) return [...item];
        if (item instanceof Set) return [...item];
        if (item instanceof RegExp) return [item.source, item.flags, item.lastIndex];
        if (typeof item === "number" && !Number.isFinite(item)) return String(item);
        if (Object.is(item, -0)) return "-0";
        if (item instanceof ArrayBuffer) return { binaryBytes: item.byteLength };
        if (ArrayBuffer.isView(item)) return { binaryBytes: item.byteLength };
        return item;
    })).byteLength;
    let remain = Math.max(0, Math.floor(textTarget - current));
    for (let i = 0; i < keys.length; i++) {
        const part = Math.floor(remain / (keys.length - i));
        value[keys[i]] += "x".repeat(part);
        remain -= part;
    }
    if (!keys.length) value.content = "x".repeat(remain);

    const logicalSize = encoder.encode(JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof Map) return [...item];
        if (item instanceof Set) return [...item];
        if (item instanceof RegExp) return [item.source, item.flags, item.lastIndex];
        if (item instanceof ArrayBuffer) return { binaryBytes: item.byteLength };
        if (ArrayBuffer.isView(item)) return { binaryBytes: item.byteLength };
        return item;
    })).byteLength + (profile === "Mixed binary" ? target * 0.2 : 0);

    return { value, logicalSize };
}

function bytes(value) {
    return value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function median(numbers) {
    const ordered = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function measureTime(operation) {
    for (let i = 0; i < WARMUPS; i++) {
        for (let j = 0; j < BATCH; j++) operation();
        gc();
    }
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
        gc();
        const start = performance.now();
        for (let j = 0; j < BATCH; j++) operation();
        samples.push((performance.now() - start) / BATCH);
    }
    return median(samples);
}

function memorySnapshot() {
    const { heapUsed, external, arrayBuffers } = process.memoryUsage();
    return { heapUsed, external, arrayBuffers: arrayBuffers ?? 0 };
}

function measureRetained(operation) {
    const samples = [];
    for (let run = 0; run < RUNS; run++) {
        gc();
        const before = memorySnapshot();
        const output = Array.from({ length: BATCH }, operation);
        gc();
        const after = memorySnapshot();
        samples.push({
            heap: (after.heapUsed - before.heapUsed) / BATCH,
            external: (after.external - before.external) / BATCH,
            arrayBuffers: (after.arrayBuffers - before.arrayBuffers) / BATCH
        });
        output.length = 0;
    }
    gc();
    return Object.fromEntries(["heap", "external", "arrayBuffers"].map((key) => [
        key,
        median(samples.map((sample) => sample[key]))
    ]));
}

function format(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

async function main() {
    const started = new Date().toISOString();
    const source = await readFile(SOURCE);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const { encode, decode } = await import(pathToFileURL(SOURCE).href);
    const results = [];

    for (const profile of PROFILE_NAMES) {
        for (const size of SIZES) {
            const { value, logicalSize } = makeDataset(profile, size);
            const originalFrame = encode(value, { operators: true });
            const prepared = decode(originalFrame, { operators: false });
            const forwardedFrame = encode(prepared, { operators: false });
            const nativeRoundTrip = decode(originalFrame, { operators: true });
            const forwardedRoundTrip = decode(forwardedFrame, { operators: true });
            const roundTripOk = isDeepStrictEqual(nativeRoundTrip, value) &&
                isDeepStrictEqual(forwardedRoundTrip, value);
            const inputUnchanged = Buffer.from(bytes(encode(value, { operators: true })))
                .equals(Buffer.from(bytes(originalFrame)));
            const bytesIdentical = Buffer.from(bytes(originalFrame)).equals(Buffer.from(bytes(forwardedFrame)));

            const phases = {
                "encode native": () => encode(value, { operators: true }),
                "decode native": () => decode(originalFrame, { operators: true }),
                "decode preserve": () => decode(originalFrame, { operators: false }),
                "encode prepared": () => encode(prepared, { operators: false }),
                "forward decode+encode": () => encode(decode(originalFrame, { operators: false }), { operators: false })
            };
            const row = {
                profile,
                size,
                actualKiB: logicalSize / 1024,
                sourceBytes: bytes(originalFrame).byteLength,
                forwardedBytes: bytes(forwardedFrame).byteLength,
                roundTripOk,
                inputUnchanged,
                bytesIdentical,
                metrics: {}
            };

            for (const [name, operation] of Object.entries(phases)) {
                row.metrics[name] = {
                    ms: measureTime(operation),
                    retained: measureRetained(operation)
                };
            }
            results.push(row);
            process.stdout.write(`completed ${profile} ${size / 1024} KiB\n`);
        }
    }

    const after = await readFile(SOURCE);
    if (createHash("sha256").update(after).digest("hex") !== sourceHash)
        throw new Error("CoSON source changed during benchmark");

    const bySize = SIZES.map((size) => {
        const group = results.filter((item) => item.size === size);
        const metricNames = Object.keys(group[0].metrics);
        return { size, group, metricNames };
    });
    const lines = [
        "# CoSON Operator Processing Benchmark",
        "",
        `Benchmark UTC: ${started}`,
        `Source SHA-256: ${sourceHash}`,
        `Environment: Node ${process.version}; ${process.platform}/${process.arch}; exposed GC; heap limit ${Math.round(requireHeapLimit() / 1024 / 1024)} MiB.`,
        `Method: ${WARMUPS} warmup batches, ${RUNS} measured batches, ${BATCH} operations per batch. Latency is the median of batch averages. Retained memory is the median post-GC delta per operation; ArrayBuffer bytes are shown as a subset of external memory, not added to it. Run with: node --expose-gc --max-old-space-size=256 benchmarks/operators-only.js.`,
        "Workload: 50 properties per document; JSON, Extended and Mixed binary profiles at target sizes 10, 50 and 100 KiB. No competitor codecs were run.",
        "",
        "## Round-trip and framing fidelity",
        "",
        "| Profile | Target KiB | Actual approx KiB | Native frame B | Repacked frame B | Native + forwarded lossless | Input unchanged | Byte-identical frame |",
        "|---|---:|---:|---:|---:|---|---|---|"
    ];
    for (const row of results) {
        lines.push(`| ${row.profile} | ${row.size / 1024} | ${row.actualKiB.toFixed(1)} | ${row.sourceBytes} | ${row.forwardedBytes} | ${row.roundTripOk ? "yes" : "NO"} | ${row.inputUnchanged ? "yes" : "NO"} | ${row.bytesIdentical ? "yes" : "no"} |`);
    }
    for (const { size, group, metricNames } of bySize) {
        lines.push("", `## Latency at ${size / 1024} KiB`, "", "Median across three profiles; ms/op.", "", "| Operation | Median ms/op |", "|---|---:|");
        for (const name of metricNames) {
            lines.push(`| ${name} | ${format(median(group.map((row) => row.metrics[name].ms)))} |`);
        }
    }
    lines.push("", "## Retained memory", "", "Median across all nine datasets. Heap and external are reported separately; ArrayBuffer is a subset of external.", "", "| Operation | Heap B/op | External B/op | ArrayBuffer B/op |", "|---|---:|---:|---:|");
    const metricNames = Object.keys(results[0].metrics);
    for (const name of metricNames) {
        const phase = results.map((row) => row.metrics[name].retained);
        lines.push(`| ${name} | ${Math.round(median(phase.map((item) => item.heap)))} | ${Math.round(median(phase.map((item) => item.external)))} | ${Math.round(median(phase.map((item) => item.arrayBuffers)))} |`);
    }
    lines.push(
        "",
        "## Interpretation and limits",
        "",
        "The `decode preserve` and `encode prepared` rows measure the two operators-disabled stages. `forward decode+encode` measures their combined intermediate transport path. Native round-trip and forwarded round-trip fidelity are verified separately with Node's strict deep comparison.",
        "",
        "This run reports retained post-GC memory only; it does not measure peak RSS or transient peak heap. RSS sampling is intentionally omitted because this focused runner executes in one process. Results are Node-specific and synthetic; the byte-identical column checks the current deterministic fixtures and is not a general wire-compatibility guarantee.",
        ""
    );
    await writeFile(REPORT, lines.join("\n"));
    process.stdout.write(`Saved ${REPORT} (${lines.length} lines)\n`);
}

function requireHeapLimit() {
    const value = process.execArgv.find((arg) => arg.startsWith("--max-old-space-size="));
    return value ? Number(value.split("=")[1]) * 1024 * 1024 : v8HeapLimit();
}

function v8HeapLimit() {
    return process.memoryUsage().heapTotal;
}

await main();

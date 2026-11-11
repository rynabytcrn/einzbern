// SPDX-License-Identifier: Apache-2.0
// Synthetic/reproducible inputs only. The baseline files are never changed.
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [repository, library, specPath, queryIndexText, observe = "0"] = process.argv.slice(2);
const root = resolve(repository);
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const query = spec.queries[Number(queryIndexText)];
if (typeof query !== "string" || !["cli", "hook"].includes(spec.entry)) throw new Error("Invalid entry sample");
process.env.EINZBERN_RECALL_OBSERVATION = observe;
process.env.EINZBERN_HOST = spec.host ?? "claude-code";
delete process.env.USER_PROMPT;

// Hook currentInstant has no public --at flag. Pin its clock in both builds;
// performance.now and process CPU retain their real clocks.
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length === 0 ? [spec.at] : args)); }
  static now() { return NativeDate.parse(spec.at); }
};

const metrics = { materializations: 0, authorityHead: null, segmentReads: [], loadedSources: [] };
const key = Symbol.for("einzbern.performance.entry");
globalThis[key] = metrics;
const originalOpen = fs.open;
fs.open = async function(path, ...args) {
  const handle = await originalOpen.call(this, path, ...args);
  if (/[/\\]akasha[/\\].*\.ndjson$/u.test(String(path))) {
    const read = handle.readFile.bind(handle);
    handle.readFile = async (...options) => {
      const bytes = await read(...options);
      metrics.segmentReads.push({ file: relative(library, String(path)), bytes: Buffer.byteLength(bytes) });
      return bytes;
    };
  }
  return handle;
};
syncBuiltinESMExports();

function begin() {
  metrics.loadedMemory = process.memoryUsage();
  metrics.operationStartedMs = performance.now();
  metrics.operationCpuStart = process.cpuUsage();
}
function end() {
  metrics.operationElapsedMs = performance.now() - metrics.operationStartedMs;
  metrics.operationCpu = process.cpuUsage(metrics.operationCpuStart);
}
metrics.begin = begin;
metrics.end = end;

// Identical, request-local probes on the two builds count the public complete
// materialization and time the real CLI parser/output/error entry. No baseline
// source, output file, policy, cache contract or retrieval behavior is patched.
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.startsWith(pathToFileURL(`${root}/`).href) || loaded.source == null) return loaded;
  let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  metrics.loadedSources.push({ file: relative(root, fileURLToPath(url)), sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source) });
  const probe = "globalThis[Symbol.for('einzbern.performance.entry')]";
  if (url.endsWith("/packages/core/src/workspace.js")) {
    if (!source.includes("export async function materializeLibrary(")) throw new Error("Missing materializeLibrary probe boundary");
    source = source.replace("export async function materializeLibrary(", "async function performanceMaterializeLibrary(");
    source += `\nexport async function materializeLibrary(...args) { const probe = ${probe}; probe.materializations += 1; const state = await performanceMaterializeLibrary(...args); probe.authorityHead = state.headEventHash; return state; }\n`;
  }
  if (spec.entry === "cli" && url.endsWith("/packages/cli/src/index.js")) {
    if (!source.includes("export async function runCli(")) throw new Error("Missing runCli probe boundary");
    source = source.replace("export async function runCli(", "async function performanceRunCli(");
    source += `\nexport async function runCli(...args) { const probe = ${probe}; probe.begin(); try { return await performanceRunCli(...args); } finally { probe.end(); } }\n`;
  }
  return { ...loaded, source };
} });

let output = "";
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  if (typeof encoding === "function") encoding();
  else if (typeof callback === "function") callback();
  return true;
};
let error = null;
try {
  if (spec.entry === "cli") {
    const entry = join(root, "scripts/einzbern.mjs");
    process.argv = [process.execPath, entry, "recall", "--workspace", resolve(library), "--at", spec.at, "--query", query, "--allow-trailing", "true", ...(spec.cliArguments ?? [])];
    await import(pathToFileURL(entry).href);
  } else {
    const { runHookEvent } = await import(pathToFileURL(join(root, "scripts/einzbern-hook.mjs")).href);
    begin();
    try {
      output = await runHookEvent({ event: spec.event ?? "user-prompt-submit", payload: { prompt: query }, libraryPath: resolve(library), cwd: spec.projectPath }) ?? "";
    } finally { end(); }
  }
} catch (caught) {
  error = { reasonCode: caught.reasonCode ?? null, message: caught.message };
  process.exitCode = 1;
}
process.stdout.write = write;
function reportCheckpoint() {
  return { elapsedMs: performance.now(), usage: process.resourceUsage(), memory: process.memoryUsage() };
}
// Keep operation-complete memory beside Node's pre-report resource snapshot.
// The reporter's allocations and the full-process system peak stay separate.
const beforeReport = reportCheckpoint();
const usage = beforeReport.usage;
// Source paths need deterministic ordering, without initializing locale data in
// the measured process solely to prepare its benchmark inventory.
const loadedSources = metrics.loadedSources.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
const afterSort = reportCheckpoint();
const encodedReport = `${JSON.stringify({
  entry: spec.entry, observe: observe === "1", at: spec.at, query,
  authorityHead: metrics.authorityHead,
  semanticSha256: createHash("sha256").update(output).digest("hex"),
  output, error, exitCode: process.exitCode ?? 0,
  operationElapsedMs: metrics.operationElapsedMs,
  operationCpuMicros: metrics.operationCpu === undefined ? null : metrics.operationCpu.user + metrics.operationCpu.system,
  processCpuMicros: usage.userCPUTime + usage.systemCPUTime,
  maxRss: usage.maxRSS, maxRssUnit: "KiB (Node process.resourceUsage().maxRSS)",
  logicalEventBytes: metrics.segmentReads.reduce((total, read) => total + read.bytes, 0),
  segmentReads: metrics.segmentReads.length, reads: metrics.segmentReads,
  materializations: metrics.materializations,
  loadedMemory: metrics.loadedMemory, completedMemory: beforeReport.memory,
  loadedSourceBytes: loadedSources.reduce((total, file) => total + file.bytes, 0),
  loadedSourceSha256: createHash("sha256").update(JSON.stringify(loadedSources)).digest("hex"),
  osIoBytes: null,
})}\n`;
const afterEncoding = reportCheckpoint();
write(encodedReport);
const afterWriteCall = reportCheckpoint();
process.once("beforeExit", () => {
  const beforeExit = reportCheckpoint();
  process.stderr.write(`${JSON.stringify({ schemaVersion: "einzbern.performance.reporter.v1",
    beforeReport, afterSort, afterEncoding, afterWriteCall, beforeExit,
    reportBytes: Buffer.byteLength(encodedReport),
  })}\n`);
});

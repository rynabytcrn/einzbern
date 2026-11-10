// SPDX-License-Identifier: Apache-2.0
// New process per sample. Run with the same library bytes, fixed --at and device
// policy; baseline must be an independently preserved unmodified build.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
const [repository, library, mode, observe = "0"] = process.argv.slice(2);
const root = resolve(repository);
let logicalEventBytes = 0, segmentReads = 0;
let authorityHead = null;
const originalOpen = fs.open;
fs.open = async function(path, ...args) {
  const handle = await originalOpen.call(this, path, ...args);
  if (/[/\\]akasha[/\\].*\.ndjson$/u.test(String(path))) {
    const read = handle.readFile.bind(handle);
    handle.readFile = async (...options) => { const bytes = await read(...options); logicalEventBytes += Buffer.byteLength(bytes); segmentReads += 1; return bytes; };
  }
  return handle;
};
syncBuiltinESMExports();
const load = file => import(pathToFileURL(join(root, "dist/build/packages/core/src", `${file}.js`)).href);
const { materializeLibrary } = await load("workspace");
const { effectiveProjectState } = await load("project-chain");
const { readRecallCards, recallInputsFromState } = await load("recall-inputs");
const { recall, recallDocuments } = await load("recall");
const authorityApi = mode === "candidate" ? await load("recall-authority") : null;
const observer = observe === "1" ? await load("recall-observation") : null;
const start = performance.now(), cpu = process.cpuUsage();
const operation = async () => {
  const read = authorityApi ? await authorityApi.readRecallAuthority(library) : { state: await materializeLibrary(library) };
  authorityHead = read.state.headEventHash;
  const state = await effectiveProjectState(read.state);
  const cards = await readRecallCards(library, { at: "2026-11-10T15:00:00Z", allowTrailing: true, status: "valid" }, read.authority);
  return ["Recall performance", "TCRN-CROSS-INIT-090", "nonexistent-zxy-needle"].map(query => ({ cards, result: recall({ cacheKey: state.metadata.workspaceId, checkpoint: `${state.headEventHash}:${cards.digest}`, documents: () => recallDocuments(recallInputsFromState(state, cards.cards)), query, tau: 0 }) }));
};
const measured = observer ? await observer.withRecallObservation(operation) : { value: await operation() };
const used = process.cpuUsage(cpu);
console.log(JSON.stringify({ mode, observe, authorityHead, elapsedMs: performance.now() - start, cpuMicros: used.user + used.system, maxRss: process.resourceUsage().maxRSS, logicalEventBytes, segmentReads, semanticSha256: createHash("sha256").update(JSON.stringify(measured.value)).digest("hex"), ...(measured.observation ? { observation: measured.observation } : {}) }));

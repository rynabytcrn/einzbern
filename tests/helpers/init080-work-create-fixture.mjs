// SPDX-License-Identifier: Apache-2.0
// INIT-080: same persisted fixture, one device, public operations; no external baseline dependency.
import "./device-home.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvents, createProject, createWorkDelta, initializeLibrary, materializeWorkspaceFromGenesis } from "../../dist/build/packages/core/src/index.js";
import { rootPortableIdentity } from "../../dist/build/packages/core/src/root-identity.js";
import { canonicalSha256 } from "../../dist/build/packages/protocol/src/index.js";
import { withWorkspacePerfInstrumentation } from "../../dist/build/packages/core/src/workspace-perf-instrumentation.js";

export const AT = "2026-10-01T00:00:00Z";
export const input = (projectId, externalKey, patch = {}) => ({ projectId, externalKey, kind: "Initiative", parentId: null, status: "planned", title: externalKey, occurredAt: AT, ...patch });
export const wrap = (delta, legacy) => legacy ? (state) => delta(state) : delta;
export const append = (fx, inputs, options = {}) => appendEvents(fx.root, inputs.map((value) => wrap(createWorkDelta(value), fx.legacy)), { occurredAt: AT, ...options });

export function comparable(state) {
  const result = structuredClone(state);
  if (result.library) {
    const root = result.library.libraryRoot;
    // These runtime-derived relocation fields necessarily differ between cloned paths.
    // Verify their relationship before normalizing; do not drop any stored identity/data.
    for (const descriptor of result.metadata.roots) {
      if (descriptor.kind !== "workspace") continue;
      assert.equal(descriptor.path, root);
      assert.equal(descriptor.canonicalPath, root);
      assert.equal(descriptor.portableIdentity, rootPortableIdentity(root));
      descriptor.path = "<same-fixture>";
      descriptor.canonicalPath = "<same-fixture>";
      descriptor.portableIdentity = "<same-fixture>";
    }
    result.library.libraryRoot = "<same-fixture>";
  }
  return result;
}

export async function authoritativeBytes(root) {
  const result = {};
  const walk = async (relative) => {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else result[name] = (await readFile(join(root, name))).toString("base64");
    }
  };
  result["manifest.json"] = (await readFile(join(root, "manifest.json"))).toString("base64");
  await walk("akasha");
  return result;
}

export function errorRecord(error) {
  if (error?.name === "AssertionError") throw error;
  return { name: error?.name, reasonCode: error?.reasonCode, message: error?.message, memberIndex: error?.memberIndex, memberPhase: error?.memberPhase, details: error?.details };
}

export async function pair(context, run, { seed, atomic = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-init080-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  await initializeLibrary({ root: source, createdAt: AT });
  let state = await createProject(source, { externalKey: "INIT080-P", name: "Fixture", occurredAt: AT });
  const projectId = state.projects[0].id;
  if (seed) await seed({ root: source, projectId, state });
  state = await materializeWorkspaceFromGenesis(source);
  const results = [];
  for (const legacy of [false, true]) {
    const root = join(base, legacy ? "legacy" : "fast");
    await cp(source, root, { recursive: true });
    const before = await authoritativeBytes(root);
    const fx = { base, root, projectId, state: comparable(state), legacy, trace: [] };
    const { result: outcome, metrics } = await withWorkspacePerfInstrumentation(async () => {
      try { return { ok: true, state: await run(fx) }; }
      catch (error) { return { ok: false, error: errorRecord(error) }; }
    });
    const bytes = await authoritativeBytes(root);
    const replay = await materializeWorkspaceFromGenesis(root);
    if (outcome.ok) assert.deepEqual(comparable(outcome.state), comparable(replay), "successful output equals fresh genesis replay");
    else if (atomic) assert.deepEqual(bytes, before, "rejection leaves authoritative manifest and streams byte-identical");
    results.push({ ...outcome, ...(outcome.ok ? { state: comparable(outcome.state) } : {}), metrics, trace: fx.trace, replay: comparable(replay), bytes });
  }
  const [fast, legacy] = results;
  assert.equal(fast.ok, legacy.ok);
  assert.deepEqual(fast.error, legacy.error, "reason, first member and phase match legacy");
  assert.deepEqual(fast.trace, legacy.trace, "observable caller effects match legacy");
  assert.deepEqual(fast.replay, legacy.replay, "complete states match across cloned fixtures");
  assert.deepEqual(fast.bytes, legacy.bytes, "authoritative persisted bytes match");
  assert.equal(canonicalSha256(fast.replay.work), canonicalSha256(legacy.replay.work), "canonical work digest matches");
  return { fast, legacy };
}

export function fastCounts(metrics, n, initial = 0) {
  assert.equal(metrics.writeCreateFullValidation, 1);
  assert.equal(metrics.writeCreateFullRecordsVisited, initial + 1);
  assert.equal(metrics.writeCreateClosureValidation, n - 1);
  assert.equal(metrics.writeCreateTerminalValidation, 1);
  assert.equal(metrics.writeCreateTerminalRecordsVisited, initial + n);
}
export function legacyCounts(metrics, n, initial = 0) {
  assert.equal(metrics.writeCreateFullValidation, n);
  assert.equal(metrics.writeCreateFullRecordsVisited, n * initial + n * (n + 1) / 2);
  assert.equal(metrics.writeCreateClosureValidation, 0);
  assert.equal(metrics.writeCreateTerminalValidation, 0);
}

export async function correctiveProbe({ repo, mode, destination, source, keep = false }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const assert = (await import("node:assert/strict")).default;
  const AT = "2026-10-01T00:00:00Z";
  assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);
  const base = await fs.mkdtemp(path.join(destination ?? os.tmpdir(), "init080-correction-"));
  const home = path.join(base, "device"), root = path.join(base, "library");
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "device.json"), JSON.stringify({ createdAt: AT, deviceId: "d".repeat(32), displayName: "pinned", schemaVersion: "einzbern.device.v1" }) + "\n");
  process.env.EINZBERN_HOME = home;
  const api = await import(`${repo}/dist/build/packages/core/src/index.js`);
  const workspace = await import(`${repo}/dist/build/packages/core/src/workspace.js`);
  const protocol = await import(`${repo}/dist/build/packages/protocol/src/index.js`);
  const perf = await import(`${repo}/dist/build/packages/core/src/workspace-perf-instrumentation.js`);
  if (source) await fs.cp(source, root, { recursive: true });
  else {
    await api.initializeLibrary({ root, createdAt: AT });
    await api.createProject(root, { externalKey: "PROBE-P", name: "Probe", occurredAt: AT });
    await api.admitTemplateInWorkspace(root, { template: api.defaultWorkContentTemplate("Initiative"), ownerId: "owner:fixture", occurredAt: AT });
  }
  if (mode === "prepare") return { root, base };
  if (mode === "boolean") await api.admitTemplateInWorkspace(root, { template: { schemaVersion: "tcrn.template.v1", id: "probe.boolean", version: 1, appliesTo: ["Initiative"], headings: ["Goal", "Acceptance Criteria", "References"], acceptanceHeadings: ["Acceptance Criteria"], referenceHeadings: ["References"], couplings: [] }, ownerId: "owner:fixture", occurredAt: AT });
  const state = await api.materializeWorkspaceFromGenesis(root);
  const values = ["PROBE-A", "PROBE-B"].map((externalKey) => ({ projectId: state.projects[0].id, externalKey, kind: "Initiative", parentId: null, status: "planned", title: "original", occurredAt: AT }));
  const inheritedBuffer = mode.startsWith("inherited-buffer-");
  const typed = inheritedBuffer || ["lock-alias", "deferred-alias", "shared-alias", "lock-wait", "typed-success", "freeze"].includes(mode);
  if (typed) for (const value of values) { value.content = api.workContentDraft("Initiative"); value.templateAdmission = state.templates[0].receipt; }
  if (mode === "boolean") for (const value of values) { value.templateAdmission = state.templates.find((entry) => entry.template.id === "probe.boolean").receipt; value.scope = "## Goal\nExercise references.\n## Acceptance Criteria\n- References validate.\n## References\nattachment:fixture"; }
  if (mode === "shared-alias") values[1].content.details = values[0].content.details;
  if (mode === "invalid-order") values[1].externalKey = "PROBE-A";
  const bytes = async () => {
    const out = { "manifest.json": (await fs.readFile(path.join(root, "manifest.json"))).toString("base64") };
    const walk = async (relative) => { for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const name = path.join(relative, entry.name); if (entry.isDirectory()) await walk(name); else out[name] = (await fs.readFile(path.join(root, name))).toString("base64"); } };
    await walk("akasha"); return out;
  };
  const before = await bytes(); let callbacks = 0, hookCalls = 0, wasPendingAtMutation = null;
  const restore = [];
  const replace = (owner, key, replacement) => { const descriptor = Object.getOwnPropertyDescriptor(owner, key); Object.defineProperty(owner, key, { ...descriptor, value: replacement }); restore.push(() => Object.defineProperty(owner, key, descriptor)); };
  const mutate = () => { callbacks += 1; values[1].title = "mutated during first member"; };
  const originalString = String;
  const recordA = (value) => value !== null && typeof value === "object" && value.externalKey === "PROBE-A";
  if (mode === "string-intrinsic") { const original = String.prototype.toUpperCase; replace(String.prototype, "toUpperCase", function (...args) { if (originalString(this) === "PROBE-A") mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "regexp") { const original = RegExp.prototype.exec; replace(RegExp.prototype, "exec", function (...args) { if (args[0] === "PROBE-A") mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "reflection") { const original = Object.keys; replace(Object, "keys", function (...args) { if (recordA(args[0])) mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "iterator") { const owner = Object.getPrototypeOf([][Symbol.iterator]()); const original = owner.next; replace(owner, "next", function (...args) { const value = Reflect.apply(original, this, args); if (recordA(value.value)) mutate(); return value; }); }
  if (mode === "map") { const original = Map.prototype.get; replace(Map.prototype, "get", function (...args) { if (args[0] === "Initiative") mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "weakset") { const original = WeakSet.prototype.add; replace(WeakSet.prototype, "add", function (...args) { if (recordA(args[0])) mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "json") { const original = JSON.stringify; replace(JSON, "stringify", function (...args) { if (args[0] === "PROBE-A") mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "number") { const original = Number.isSafeInteger; replace(Number, "isSafeInteger", function (...args) { if (args[0] === 1) callbacks += 1; return Reflect.apply(original, this, args); }); }
  if (mode === "date") { const original = Date.prototype.toISOString; replace(Date.prototype, "toISOString", function (...args) { callbacks += 1; return Reflect.apply(original, this, args); }); }
  if (mode === "buffer") { const original = Buffer.byteLength; replace(Buffer, "byteLength", function (...args) { if (typeof args[0] === "string" && args[0].includes("PROBE-A")) mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "hash") { const owner = Object.getPrototypeOf(crypto.createHash("sha256")); const original = owner.update; replace(owner, "update", function (...args) { if (typeof args[0] === "string" && args[0].includes("PROBE-A")) mutate(); return Reflect.apply(original, this, args); }); }
  if (mode === "freeze") { const original = Object.freeze; replace(Object, "freeze", function (...args) { callbacks += 1; return Reflect.apply(original, this, args); }); }
  if (mode === "store") { const original = AsyncLocalStorage.prototype.getStore; replace(AsyncLocalStorage.prototype, "getStore", function (...args) { callbacks += 1; return Reflect.apply(original, this, args); }); }
  if (mode === "boolean") { const original = Boolean; const replacement = function (...args) { callbacks += 1; return Reflect.apply(original, this, args); }; replacement.prototype = original.prototype; Object.setPrototypeOf(replacement, original); replace(globalThis, "Boolean", replacement); }
  if (mode === "string-owner") { const original = String; const replacement = function (...args) { callbacks += 1; return Reflect.apply(original, this, args); }; replacement.prototype = original.prototype; Object.setPrototypeOf(replacement, original); replace(globalThis, "String", replacement); }
  if (inheritedBuffer) {
    // Source boundary: truncateUtf8 reads length; Buffer.subarray reads buffer and
    // byteOffset. Patch only the actual fixed Buffer prototype chain, in this child.
    const intermediate = Object.getPrototypeOf(Buffer.prototype);
    const owner = Object.getPrototypeOf(intermediate);
    const key = mode.endsWith("byteOffset") ? "byteOffset" : mode.endsWith("buffer") ? "buffer" : "length";
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    delete values[1].content; delete values[1].templateAdmission;
    values[1].goal = key === "length" ? "E1TRIGGER" : "E1TRIGGER" + "x".repeat(512);
    const replacement = { ...descriptor, get() {
      const result = Reflect.apply(descriptor.get, this, []);
      if (this[0] === 69 && this[1] === 49 && this[2] === 84) {
        callbacks += 1; values[0].content.constraints.push(undefined);
      }
      return result;
    } };
    if (mode.endsWith("shadow")) {
      const previous = Object.getOwnPropertyDescriptor(intermediate, key);
      Object.defineProperty(intermediate, key, replacement);
      restore.push(() => previous ? Object.defineProperty(intermediate, key, previous) : delete intermediate[key]);
    } else if (mode.endsWith("reparent")) {
      const inserted = Object.create(owner);
      Object.defineProperty(inserted, key, replacement);
      Object.setPrototypeOf(intermediate, inserted);
      restore.push(() => Object.setPrototypeOf(intermediate, owner));
    } else {
      Object.defineProperty(owner, key, replacement);
      restore.push(() => Object.defineProperty(owner, key, descriptor));
    }
    if (mode.endsWith("batch")) values.push({ ...values[1], externalKey: "PROBE-C", goal: "not evaluated" });
  }
  const options = { occurredAt: AT };
  if (["lock-alias", "deferred-alias", "shared-alias"].includes(mode)) options.insideWriteLockForTest = async () => { hookCalls += 1; values[0].content.details.boundary = "mutated after preparation"; };
  let outcome, metrics, lockMetrics; let preparationObservation = null;
  try {
    const measured = await perf.withWorkspacePerfInstrumentation(async () => {
      try {
        let result;
        const invoke = () => mode === "deferred-alias" || mode === "typed-success" || mode === "inherited-buffer-length-batch"
          ? api.applyWorkBatch(root, { schemaVersion: "tcrn.work-batch.v1", members: values.map((value) => ({ ...value, verb: "work-create" })) }, options)
          : api.appendEvents(root, values.map(api.createWorkDelta), options);
        if (mode === "lock-wait") {
          let ready, release;
          const entered = new Promise((resolve) => { ready = resolve; });
          const unlocked = new Promise((resolve) => { release = resolve; });
          const holder = workspace.withWorkspaceWriteLock(root, async () => { ready(); await unlocked; });
          await entered; let settled = false;
          // Return the pending promise as data, not as the instrumentation operation's
          // result: the child retains its AsyncLocalStorage context and metrics stay live.
          const observed = await perf.withWorkspacePerfInstrumentation(async () => ({ pending: invoke() }));
          lockMetrics = observed.metrics;
          const pending = observed.result.pending;
          pending.then(() => { settled = true; }, () => { settled = true; });
          let observationError;
          try {
            if (Object.hasOwn(lockMetrics, "writeCreateTerminalValidation")) {
              const deadline = Date.now() + 10_000;
              while (lockMetrics.writeCreateTerminalValidation < 1) {
                assert.ok(Date.now() < deadline, "terminal validation was not observed before the fixture deadline");
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              preparationObservation = "live-terminal-counter";
            } else {
              // Historical995 has no write counter. Its separate external observation is
              // explicitly timing-limited; a different outcome remains a real failure.
              await new Promise((resolve) => setTimeout(resolve, 300));
              preparationObservation = "historical-timed-wait-no-write-counter";
            }
            wasPendingAtMutation = !settled;
            values[0].content.details.boundary = "mutated after preparation";
          } catch (error) { observationError = error; }
          finally { release(); await holder; }
          if (observationError) { await pending.catch(() => {}); throw observationError; }
          result = await pending;
        } else result = await invoke();
        return { ok: true, work: result.work, events: result.events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload })) };
      } catch (error) { return { ok: false, error: { name: error.name, reasonCode: error.reasonCode, message: error.message, memberIndex: error.memberIndex, memberPhase: error.memberPhase } }; }
    });
    outcome = measured.result; metrics = lockMetrics ?? measured.metrics;
  } finally { for (const reset of restore.reverse()) reset(); }
  const after = await bytes(); const replay = await api.materializeWorkspaceFromGenesis(root);
  const result = { mode, repo, base, callbacks, hookCalls, wasPendingAtMutation, preparationObservation, outcome, metrics, atomicBytesUnchanged: JSON.stringify(before) === JSON.stringify(after), authoritativeBytes: after, replay: { work: replay.work, events: replay.events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload })) }, workDigest: protocol.canonicalSha256(replay.work) };
  if (keep) { await fs.writeFile(path.join(base, "before.json"), JSON.stringify(before, null, 2)); await fs.writeFile(path.join(base, "after.json"), JSON.stringify(after, null, 2)); await fs.writeFile(path.join(base, "result.json"), JSON.stringify(result, null, 2)); }
  else await fs.rm(base, { recursive: true, force: true });
  return result;
}

// Self-contained for isolated candidate tests and separate actual995 differential evidence.
export async function singletonProbe({ repo, mode, destination, source, keep = false }) {
  const fs = await import("node:fs/promises"), path = await import("node:path"), os = await import("node:os");
  const assert = (await import("node:assert/strict")).default;
  const api = await import(`${repo}/dist/build/packages/core/src/index.js`);
  const perf = await import(`${repo}/dist/build/packages/core/src/workspace-perf-instrumentation.js`);
  const { rootPortableIdentity } = await import(`${repo}/dist/build/packages/core/src/root-identity.js`);
  const { canonicalSha256 } = await import(`${repo}/dist/build/packages/protocol/src/index.js`);
  assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);
  const AT = "2026-10-01T00:00:00Z";
  const base = await fs.mkdtemp(path.join(destination ?? os.tmpdir(), "init080-singleton-"));
  const root = path.join(base, "library"), home = path.join(base, "device");
  await fs.mkdir(home); process.env.EINZBERN_HOME = home;
  await fs.writeFile(path.join(home, "device.json"), JSON.stringify({ createdAt: AT, deviceId: "d".repeat(32), displayName: "pinned", schemaVersion: "einzbern.device.v1" }) + "\n");
  if (source) await fs.cp(source, root, { recursive: true });
  else { await api.initializeLibrary({ root, createdAt: AT }); await api.createProject(root, { externalKey: "SINGLE-P", name: "Singleton", occurredAt: AT }); }
  if (mode === "prepare") return { root, base };
  const initial = await api.materializeWorkspaceFromGenesis(root);
  const value = { projectId: initial.projects[0].id, externalKey: "SINGLE-A", kind: "Initiative", parentId: null, status: "planned", title: "Singleton", occurredAt: AT };
  if (mode.endsWith("seeded")) for (let i = 0; i < 3; i += 1) await api.createWork(root, { ...value, externalKey: `SEED-${i}` });
  if (mode.endsWith("actor")) await api.appendEvents(root, [(state) => ({ payload: { operation: api.ACTOR_ATTESTATION_ENABLE_OPERATION, record: api.buildActorAttestationEnableRecord() }, projects: state.projects, work: state.work })], { occurredAt: AT, actorId: "owner:fixture" });
  const bytes = async () => {
    const result = { "manifest.json": (await fs.readFile(path.join(root, "manifest.json"))).toString("base64") };
    const walk = async (rel) => { for (const entry of (await fs.readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const name = path.join(rel, entry.name); if (entry.isDirectory()) await walk(name); else result[name] = (await fs.readFile(path.join(root, name))).toString("base64"); } };
    await walk("akasha"); return result;
  };
  const comparable = (state) => {
    const result = structuredClone(state);
    if (result.library) {
      assert.equal(result.library.libraryRoot, root);
      for (const descriptor of result.metadata.roots) if (descriptor.kind === "workspace") {
        assert.equal(descriptor.path, root); assert.equal(descriptor.canonicalPath, root); assert.equal(descriptor.portableIdentity, rootPortableIdentity(root));
        descriptor.path = "<same-fixture>"; descriptor.canonicalPath = "<same-fixture>"; descriptor.portableIdentity = "<same-fixture>";
      }
      result.library.libraryRoot = "<same-fixture>";
    }
    return result;
  };
  const before = await bytes(), trace = [];
  if (mode.endsWith("invalid")) value.externalKey = "invalid key";
  if (mode === "input-accessor") Object.defineProperty(value, "title", { enumerable: true, get() { trace.push("input:title"); return "Getter title"; } });
  const options = { occurredAt: AT };
  if (mode === "options-accessor") Object.defineProperty(options, "occurredAt", { enumerable: true, get() { trace.push("options:occurredAt"); return AT; } });
  if (mode === "event") options.occurredAt = "invalid instant";
  if (mode === "event-indexed") { let reads = 0; Object.defineProperty(options, "occurredAt", { enumerable: true, get() { reads += 1; trace.push(`event-at:${reads}`); return reads >= 3 ? "invalid instant" : AT; } }); }
  const delta = api.createWorkDelta(value); let builders = [delta];
  if (mode === "index-accessor") Object.defineProperty(builders, "0", { enumerable: true, get() { trace.push("index:0"); return delta; } });
  if (mode === "proxy-array") builders = new Proxy(builders, { get(target, key, receiver) { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); }, ownKeys(target) { trace.push("ownKeys"); return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); } });
  if (mode === "custom-entries") builders.entries = function* () { trace.push("entries"); yield [0, delta]; };
  if (mode === "custom-prototype") Object.setPrototypeOf(builders, Object.create(Array.prototype));
  if (mode === "empty") builders = [];
  const measured = await perf.withWorkspacePerfInstrumentation(async () => {
    try {
      const state = mode.startsWith("batch")
        ? await api.applyWorkBatch(root, { schemaVersion: "tcrn.work-batch.v1", members: mode === "batch-empty" ? [] : [{ ...value, verb: "work-create" }] }, options)
        : mode.startsWith("public") ? await api.createWork(root, value) : await api.appendEvents(root, builders, options);
      return { ok: true, state: comparable(state) };
    } catch (error) {
      if (error.name === "AssertionError") throw error;
      return { ok: false, error: { name: error.name, reasonCode: error.reasonCode, message: error.message, memberIndex: error.memberIndex, memberPhase: error.memberPhase, details: error.details } };
    }
  });
  const after = await bytes(), replay = comparable(await api.materializeWorkspaceFromGenesis(root));
  if (measured.result.ok) assert.deepEqual(measured.result.state, replay, "complete successful state equals genesis replay");
  else assert.deepEqual(after, before, "refusal leaves authoritative bytes unchanged");
  const result = { mode, base, outcome: measured.result, trace, metrics: measured.metrics, replay, digest: canonicalSha256(replay), authoritativeBytes: after, atomicBytesUnchanged: JSON.stringify(before) === JSON.stringify(after) };
  if (keep) await fs.writeFile(path.join(base, "result.json"), JSON.stringify(result, null, 2)); else await fs.rm(base, { recursive: true, force: true });
  return result;
}

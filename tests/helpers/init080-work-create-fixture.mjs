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

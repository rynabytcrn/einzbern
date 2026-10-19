// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initializeLibrary, createProject, declareChainIdentity, materializeWorkspaceFromGenesis, readDevice, registerLibrary,
  configureStorageLocation, consolidateStorage, defaultSharedLibraryPath, readStorageLocation } from "../dist/build/packages/core/src/index.js";
import { runtimeTransportReceiptPath } from "../dist/build/packages/core/src/runtime-transport.js";
import { libraryTreeDigests } from "../dist/build/packages/core/src/workspace-snapshot.js";
const at = "2026-10-19T16:00:00Z";
const decision = "minutes:000000000000000000000001#D1";
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-ether-")));
  const before = process.env.EINZBERN_HOME;
  const home = join(root, "device"); process.env.EINZBERN_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.EINZBERN_HOME; else process.env.EINZBERN_HOME = before; await rm(root, { recursive: true, force: true }); });
  const from = join(root, "chosen parent", "Einzbern"), to = join(root, "chosen parent", "Ether"), projectPath = join(root, "source");
  await mkdir(projectPath);
  await initializeLibrary({ root: from, createdAt: at });
  const state = await createProject(from, { externalKey: "ALPHA", name: "Alpha", occurredAt: at });
  await declareChainIdentity(from, { role: "shared", coordinationLibraryId: state.metadata.workspaceId }, { occurredAt: at });
  await registerLibrary({ projectPath, projectId: state.projects[0].id, libraryPath: from, registeredAt: at, gitRemote: null });
  const device = await readDevice(home), runtimeRoot = join(root, "chosen parent", "Einzbern-runtime"), runtime = join(runtimeRoot, device.deviceId);
  await mkdir(join(home, "cache"), { recursive: true }); await writeFile(join(home, "cache", "gate-evidence.log"), "original evidence bytes");
  await configureStorageLocation(home, from, runtime, at, decision, true);
  return { root, home, from, to, runtimeRoot, runtime, device };
}
test("Ether can live under a user-chosen local parent; defaults use its name without project subdirectories", () => {
  const home = join(tmpdir(), "custom-device", ".einzbern");
  assert.equal(defaultSharedLibraryPath(home), join(dirname(home), "Ether"));
});
test("one Ether retains native history and evidence, isolates runtime, retires both old roots and resumes", async t => {
  const f = await fixture(t), before = await materializeWorkspaceFromGenesis(f.from);
  await mkdir(f.to); await writeFile(join(f.to, ".DS_Store"), "finder metadata");
  const plan = await consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision);
  assert.equal(plan.reasonCode, "STORAGE_CONSOLIDATION_PLAN_READY");
  assert.deepEqual(await readdir(f.to), [".DS_Store"]);
  const result = await consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true);
  assert.equal(result.reasonCode, "STORAGE_CONSOLIDATED");
  const after = await materializeWorkspaceFromGenesis(f.to);
  assert.equal(after.headEventHash, before.headEventHash);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual((await readdir(dirname(f.to))).sort(), ["Ether"]);
  const pointer = readStorageLocation(f.home);
  assert.equal(pointer.library, f.to);
  assert.equal(pointer.runtime, join(f.to, ".einzbern", f.device.deviceId));
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  const files = await libraryTreeDigests(f.to);
  assert.equal(files.some(file => file.path.startsWith(".einzbern/")), false, "runtime is excluded from library snapshots");
  assert.equal((await consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true)).resumed, true);
});
test("an occupied destination and a runtime root shared with another device are refused", async t => {
  const f = await fixture(t);
  await mkdir(f.to); await writeFile(join(f.to, "unique"), "keep");
  await assert.rejects(consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true));
  assert.equal(await readFile(join(f.to, "unique"), "utf8"), "keep");
  assert.equal(readStorageLocation(f.home).library, f.from);
  await mkdir(join(f.runtimeRoot, "another-device"));
  await assert.rejects(consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision), /unowned/);
});
test("a completed earlier runtime relocation can move again, and a busy migration is recoverable", async t => {
  const f = await fixture(t);
  await mkdir(join(f.runtime, "locks"), { recursive: true }); await writeFile(join(f.runtime, "locks", "busy"), "held");
  await assert.rejects(consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true), /BUSY/);
  await unlink(join(f.runtime, "locks", "busy"));
  const result = await consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true);
  assert.equal(result.completed, true);
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
});

test("cross-device runtime copy preserves evidence and resumes an interrupted retirement", async t => {
  const f = await fixture(t), target = join(f.root, "External selected parent", "Ether", ".einzbern", f.device.deviceId);
  await writeFile(join(f.runtime, "cache", "a"), "alpha");
  await writeFile(join(f.runtime, "cache", "b"), "beta");
  const options = { forceCopyForTest: true, publicationStepForTest: phase => { if (phase === "retiring") throw new Error("interrupted after verified copy"); } };
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, options), /interrupted/);
  assert.equal(await readFile(join(target, "cache", "a"), "utf8"), "alpha");
  await configureStorageLocation(f.home, f.from, target, at, decision, true, { forceCopyForTest: true });
  assert.equal(await readFile(join(f.home, "cache", "a"), "utf8"), "alpha");
  assert.equal(await readFile(join(f.home, "cache", "b"), "utf8"), "beta");
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
});

test("cross-device recovery refuses a changed verified destination and preserves the source", async t => {
  const f = await fixture(t), target = join(f.root, "External chosen parent", "Ether", ".einzbern", f.device.deviceId);
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, {
    forceCopyForTest: true, publicationStepForTest: async phase => {
      if (phase === "verified") { await writeFile(join(target, "cache", "gate-evidence.log"), "unique later edit"); throw new Error("interrupted before retirement"); }
    },
  }), /interrupted/);
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, { forceCopyForTest: true }), /destination changed/);
  assert.equal(await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  assert.equal(await readFile(join(target, "cache", "gate-evidence.log"), "utf8"), "unique later edit");
});

test("a completed consolidation does not prevent a later explicit change of parent", async t => {
  const f = await fixture(t);
  await consolidateStorage(f.home, f.from, f.to, f.runtimeRoot, at, decision, true);
  const next = join(f.root, "Next selected parent", "Ether");
  await consolidateStorage(f.home, f.to, next, join(f.to, ".einzbern"), "2026-10-19T16:01:00Z", decision, true);
  assert.equal(readStorageLocation(f.home).library, next);
  await assert.rejects(readFile(join(f.to, "manifest.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
});

test("malformed runtime receipt paths refuse without changing original or landed evidence", async t => {
  const f = await fixture(t), target = join(f.root, "External parent", "Ether", ".einzbern", f.device.deviceId);
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, {
    forceCopyForTest: true, publicationStepForTest: phase => { if (phase === "verified") throw new Error("interrupted"); },
  }), /interrupted/);
  const path = runtimeTransportReceiptPath(f.home, join(f.runtime, "cache"), join(target, "cache"), at);
  const receipt = JSON.parse(await readFile(path, "utf8")); receipt.entries[0].path = "../../outside";
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, { forceCopyForTest: true }), /receipt path/);
  assert.equal(await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  assert.equal(await readFile(join(target, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
});

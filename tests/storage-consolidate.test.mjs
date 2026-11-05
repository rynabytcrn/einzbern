// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  return { root, home, from, to, runtimeRoot, runtime, device, projectId: state.projects[0].id };
}

async function projectHostFiles(projectRoot) {
  return {
    claude: await readFile(join(projectRoot, ".claude", "settings.local.json"), "utf8").catch(() => null),
    codex: await readFile(join(projectRoot, ".codex", "config.toml"), "utf8").catch(() => null),
  };
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

test("storage relocation preflights every registered project before migration writes", async t => {
  const f = await fixture(t), projectA = join(f.root, "source"), projectB = join(f.root, "registered-project-b");
  const target = join(f.root, "relocated-runtime", f.device.deviceId);
  const hostBefore = await projectHostFiles(projectA);
  const pointerBefore = await readFile(join(f.home, "storage-location.json"), "utf8");
  const relocationBefore = await readFile(join(f.home, "storage-relocation.json"), "utf8");
  const forwardingBefore = await readlink(join(f.home, "cache"));
  const runtimeEntriesBefore = await readdir(f.runtime);
  const evidenceBefore = await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8");
  await mkdir(projectB);
  await registerLibrary({ projectPath: projectB, projectId: f.projectId, libraryPath: f.from, registeredAt: at, gitRemote: null }, f.home);
  await rename(projectB, `${projectB}-retained`);

  const missingProject = (error) => error?.reasonCode === "HOST_WRITABLE_ROOTS_PROJECT_NOT_FOUND" && error.message.includes(projectB);
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, false), missingProject);
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true), missingProject);

  assert.equal(await readFile(join(f.home, "storage-location.json"), "utf8"), pointerBefore, "the storage pointer was not rewritten");
  assert.equal(await readFile(join(f.home, "storage-relocation.json"), "utf8"), relocationBefore, "no migration receipt was written");
  assert.equal(await readlink(join(f.home, "cache")), forwardingBefore, "home forwarding remains unchanged");
  assert.deepEqual(await readdir(f.runtime), runtimeEntriesBefore, "the source runtime was not moved");
  assert.equal(await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8"), evidenceBefore);
  assert.deepEqual(await projectHostFiles(projectA), hostBefore, "project A was not wired before project B was checked");
  await assert.rejects(realpath(target), { code: "ENOENT" }, "the target runtime was not created");
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

test("cross-device runtime interruption reports actual progress and resumes without copying evidence twice", async t => {
  const f = await fixture(t), target = join(f.root, "External selected parent", "Ether", ".einzbern", f.device.deviceId);
  const projectRoot = join(f.root, "source"), hostBefore = await projectHostFiles(projectRoot);
  const receiptPath = runtimeTransportReceiptPath(f.home, join(f.runtime, "cache"), join(target, "cache"), at);
  const options = { forceCopyForTest: true, publicationStepForTest: phase => { if (phase === "retiring") throw new Error("interrupted after verified copy"); } };
  let interruption;
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, options), error => {
    interruption = error;
    return /interrupted after verified copy/u.test(error.message);
  });
  const progress = JSON.parse(interruption.details.storageProgress);
  const persisted = JSON.parse(await readFile(join(f.home, "storage-relocation.json"), "utf8"));
  assert.deepEqual(persisted.progress, progress, "the error and durable partial receipt agree");
  assert.deepEqual([progress.stage, progress.activeArea, progress.storagePointer.status], ["runtime", "cache", "source"]);
  assert.deepEqual(progress.completedAreas, []);
  assert.equal(progress.activeTransportReceipt, persisted.progress.runtimeAreas[0].receiptPath);
  assert.deepEqual([progress.runtimeAreas[0].source, progress.runtimeAreas[0].destination, progress.runtimeAreas[0].receiptPhase], ["directory", "directory", "verified"]);
  const transport = JSON.parse(await readFile(receiptPath, "utf8"));
  const sourceEntries = progress.runtimeAreas[0].sourceEntries;
  assert.deepEqual([sourceEntries.state, sourceEntries.expected], ["observed", transport.entries.length]);
  assert.ok(sourceEntries.retired > 0, "the receipt reports source entries already retired");
  assert.equal(sourceEntries.remaining + sourceEntries.retired, sourceEntries.expected);
  assert.equal(readStorageLocation(f.home).runtime, f.runtime);
  const sourceEvidence = await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (sourceEvidence === null) assert.ok(sourceEntries.retired > 0, "the source receipt reports why the legacy path no longer has the file");
  else assert.equal(sourceEvidence, "original evidence bytes");
  assert.equal(await readFile(join(target, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  assert.ok((await readdir(join(target, "cache"))).includes("gate-evidence.log"));
  assert.deepEqual(await projectHostFiles(projectRoot), hostBefore, "project wiring has not started before runtime publication");
  assert.deepEqual(progress.hostWiring.map(project => project.state), ["matches-before"]);

  await configureStorageLocation(f.home, f.from, target, "2026-10-19T16:00:30Z", decision, true, { forceCopyForTest: true });
  assert.equal(readStorageLocation(f.home).runtime, target);
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  assert.equal(await realpath(join(f.runtime, "cache")), join(target, "cache"), "the old path forwards to the single landed copy");
  assert.ok((await readdir(join(target, "cache"))).includes("gate-evidence.log"));
  const completedTransport = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(completedTransport.phase, "complete");
  assert.equal(completedTransport.entries.filter(entry => entry.path === "gate-evidence.log").length, 1);
  const claudeRoots = JSON.parse((await projectHostFiles(projectRoot)).claude).permissions.additionalDirectories.map(path => resolve(projectRoot, path));
  assert.ok(claudeRoots.includes(f.from));
  assert.ok(claudeRoots.includes(target));
  assert.ok(!claudeRoots.includes(f.runtime));
  assert.equal(JSON.parse(await readFile(join(f.home, "storage-relocation.json"), "utf8")).progress.stage, "complete");
});

test("storage recovery after publishing the pointer keeps the original transport and replaces stale host roots", async t => {
  const f = await fixture(t), target = join(f.root, "new runtime", f.device.deviceId);
  const project = join(f.root, "source"), codexFile = join(project, ".codex", "config.toml");
  const hostBefore = await projectHostFiles(project);
  const relocationFile = join(f.home, "storage-relocation.json");
  const transportPath = runtimeTransportReceiptPath(f.home, join(f.runtime, "cache"), join(target, "cache"), at);
  const evidenceFile = join(target, "cache", "gate-evidence.log");
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, {
    forceCopyForTest: true,
    publicationStepForTest: async phase => {
      if (phase === "verified") await writeFile(codexFile, `${hostBefore.codex}# concurrent user edit\n`);
    },
  }), error => {
    assert.equal(error.reasonCode, "HOST_WRITABLE_ROOTS_CONCURRENT_MODIFICATION");
    const progress = JSON.parse(error.details.storageProgress);
    assert.deepEqual([progress.stage, progress.storagePointer.status], ["project-wiring", "target"]);
    return true;
  });
  const interrupted = JSON.parse(await readFile(relocationFile, "utf8"));
  const transport = await readFile(transportPath, "utf8");
  const evidenceStat = await stat(evidenceFile);
  assert.equal(JSON.parse(transport).phase, "complete");
  assert.equal(readStorageLocation(f.home).runtime, target);

  await writeFile(codexFile, hostBefore.codex);
  await configureStorageLocation(f.home, f.from, target, "2026-10-19T16:01:00Z", decision, true, { forceCopyForTest: true });

  const recovered = JSON.parse(await readFile(relocationFile, "utf8"));
  assert.deepEqual([recovered.from, recovered.to], [interrupted.from, interrupted.to]);
  assert.deepEqual([resolve(f.home, recovered.from), resolve(f.home, recovered.to)], [f.runtime, target]);
  assert.deepEqual(recovered.progress.completedAreas, interrupted.progress.completedAreas);
  assert.deepEqual(recovered.progress.runtimeAreas, interrupted.progress.runtimeAreas);
  assert.equal(recovered.progress.stage, "complete");
  assert.equal(await readFile(transportPath, "utf8"), transport);
  assert.equal((await stat(evidenceFile)).ino, evidenceStat.ino);
  assert.equal(await realpath(join(f.runtime, "cache", "gate-evidence.log")), evidenceFile);
  assert.equal(await readFile(join(f.home, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  const hostAfter = await projectHostFiles(project);
  assert.deepEqual(JSON.parse(hostAfter.claude).permissions.additionalDirectories.map(path => resolve(project, path)).sort(), [f.from, target].sort());
  assert.ok(hostAfter.codex.includes(JSON.stringify(relative(join(project, ".codex"), target))));
  assert.ok(!hostAfter.codex.includes(JSON.stringify(relative(join(project, ".codex"), f.runtime))));
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
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(JSON.stringify(receipt).includes(f.root), false, "transport records use device-relative paths");
  receipt.entries[0].path = "../../outside";
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(configureStorageLocation(f.home, f.from, target, at, decision, true, { forceCopyForTest: true }), /receipt path/);
  assert.equal(await readFile(join(f.runtime, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
  assert.equal(await readFile(join(target, "cache", "gate-evidence.log"), "utf8"), "original evidence bytes");
});


test("storage repair converts intact legacy absolute forwarding links without moving data", async t => {
  const f = await fixture(t), target = join(f.root, "Portable parent", "Ether", ".einzbern", f.device.deviceId);
  await configureStorageLocation(f.home, f.from, target, at, decision, true);
  const link = join(f.home, "cache");
  await unlink(link); await symlink(join(target, "cache"), link, "dir");
  assert.equal(isAbsolute(await readlink(link)), true);
  await configureStorageLocation(f.home, f.from, target, at, decision, true);
  assert.equal(isAbsolute(await readlink(link)), false);
  assert.equal(await readFile(join(link, "gate-evidence.log"), "utf8"), "original evidence bytes");
});

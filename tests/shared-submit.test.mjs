// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLibrary, createProject, createWork, materializeWorkspaceFromGenesis } from "../dist/build/packages/core/src/workspace.js";
import { captureKnowledgeUnit, initializeKnowledgeStore, listKnowledgeMetadata, readKnowledgeBody, readKnowledgeStoreMarker, validateKnowledgeStore } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dotDigest } from "../dist/build/packages/core/src/dot-execution.js";
import { planSharedSubmit, validateSharedBaseline, validateSharedSubmitAdvisory, SHARED_SUBMIT_RESERVED_ROOT } from "../dist/build/packages/core/src/shared-submit.js";
const sha = text => createHash("sha256").update(text).digest("hex");
const libraryId = `library:${"a".repeat(24)}`;
const at = minute => `2026-10-20T05:${String(minute).padStart(2, "0")}:00Z`;
function baseline(time = at(0)) {
  const inventory = [{ path: "akasha/device/manifest.json", kind: "file", bytes: 2, sha256: sha("{}") }, { path: "crest/card", kind: "file", bytes: 4, sha256: sha("card") }, { path: "config/project.json", kind: "file", bytes: 2, sha256: sha("{}") }];
  return { schemaVersion: "tcrn.shared-baseline.v1", libraryId, format: 1, minEngine: "3.1.0", canonicalRootRef: "fixture:canonical", completeInventoryRef: "fixture:complete-inventory", completeInventoryDigest: dotDigest(inventory), requiredRoots: ["akasha", "crest", "config"], includedRoots: ["akasha", "crest", "config"], exclusionsWithReasons: [{ path: "artifacts/coordination", reason: "dynamic advisory, not canonical event authority" }], inventory, archiveWitness: null, sourceVersion: 1, head: "a".repeat(64), versionVector: { device: "b".repeat(64) }, capturedAt: at(0), refreshedAt: time, coverageStatus: "complete", atomicSnapshot: false };
}
function fixture() {
  const base = baseline(); const fresh = baseline(at(2)); const digest = dotDigest(fresh);
  return { schemaVersion: "tcrn.shared-submit.v1", operationId: "fixture:operation", libraryId, actor: "agent:fixture", deviceStreamIdentityRef: "fixture:device", workRefs: [{ workId: "work:fixture", revisionBinding: { kind: "revision", workRevision: 1, scopeDigest: "c".repeat(64) } }], baseBaseline: base, refreshedBaseline: fresh, localWorkCompletedAt: at(1), semanticChangePlanDigest: "d".repeat(64), engineReceipts: [{ verb: "work-annotate", actor: "agent:fixture", intentDigest: "d".repeat(64), baseDigest: dotDigest(base), status: "applied", receiptRef: "fixture:engine-receipt", readbackRef: "fixture:local-readback" }], merge: { kind: "engine-reapply", refreshedBaselineDigest: digest, semanticChangePlanDigest: "d".repeat(64), engineOutputMembers: [{ exactPath: "akasha/device/00000001.ndjson", bytes: Buffer.byteLength("fixture-event\n"), sha256: sha("fixture-event\n"), kind: "segment" }, { exactPath: "akasha/device/manifest.json", bytes: Buffer.byteLength("fixture-manifest"), sha256: sha("fixture-manifest"), kind: "manifest" }], receiptRef: "fixture:reapply", readbackRef: "fixture:reapply-readback", status: "verified", observedAt: at(2) }, writerHandoff: { libraryId, operationId: "fixture:operation", status: "confirmed", writerScopeRefs: ["fixture:all-known-writers"], evidenceRef: "fixture:handoff", baselineDigest: digest, observedAt: at(2) }, advisory: { schemaVersion: "tcrn.shared-submit-advisory.v1", libraryId, operationId: "fixture:operation", holder: { actor: "agent:fixture", environmentRef: "fixture:environment" }, state: "submitting", baseDigest: digest, handoffEvidenceRef: "fixture:handoff", observedAt: at(2), updatedAt: at(2), previousDigest: "e".repeat(64), releaseEvidenceRef: null }, publicationMembers: [], remoteReadbacks: [], replay: null, release: null, lastError: null };
}
function publish(f, kind, text, minute) {
  const member = { exactPath: `akasha/device/${kind === "segment" ? "00000001.ndjson" : "manifest.json"}`, providerId: `fixture:${kind}-id`, parentId: "fixture:parent-id", bytes: Buffer.byteLength(text), sha256: sha(text), kind, actualReceipt: `fixture:${kind}-receipt`, publishedAt: at(minute) };
  return { ...f, publicationMembers: [...f.publicationMembers, member], remoteReadbacks: [...f.remoteReadbacks, { exactPath: member.exactPath, providerId: member.providerId, parentId: member.parentId, contentBase64: Buffer.from(text).toString("base64"), observedAt: at(minute + 1), evidenceRef: `fixture:${kind}-readback` }] };
}
test("DOT-E03 incremental baseline requires complete inventory, closure and explicit raw links", () => {
  assert.equal(validateSharedBaseline(baseline()).atomicSnapshot, false);
  assert.throws(() => validateSharedBaseline({ ...baseline(), completeInventoryDigest: "f".repeat(64) }));
  assert.throws(() => validateSharedBaseline({ ...baseline(), includedRoots: ["akasha"] }));
  const b = baseline(); b.inventory.push({ path: "crest/link", kind: "link-raw", bytes: 4, sha256: sha("dest") }); b.completeInventoryDigest = dotDigest(b.inventory);
  assert.throws(() => validateSharedBaseline(b), /link representation/u);
});
test("DOT-E03 occupied waits, unknown or absent advisory is not free, and no lease/fencing fields exist", () => {
  const f = fixture();
  assert.equal(planSharedSubmit({ ...f, writerHandoff: { ...f.writerHandoff, status: "occupied" } }).status, "waiting");
  assert.equal(planSharedSubmit({ ...f, writerHandoff: null }).status, "pending");
  assert.equal(planSharedSubmit({ ...f, advisory: null }).reasonCodes[0], "ADVISORY_UNKNOWN");
  assert.throws(() => validateSharedSubmitAdvisory({ ...f.advisory, leaseExpiresAt: at(30) }));
  assert.equal(SHARED_SUBMIT_RESERVED_ROOT.relativePath, "artifacts/coordination/shared-submit");
});
test("DOT-E03 freshness and engine reapplication do not permit event splicing", () => {
  const f = fixture();
  assert.equal(planSharedSubmit({ ...f, refreshedBaseline: null }).status, "pending");
  assert.equal(planSharedSubmit({ ...f, refreshedBaseline: baseline() }).reasonCodes[0], "REFRESH_STALE_OR_INCOMPATIBLE");
  assert.equal(planSharedSubmit({ ...f, merge: { ...f.merge, kind: "splice-events" } }).reasonCodes[0], "SUPPORTED_REPLAY_OR_REAPPLICATION_REQUIRED");
  assert.equal(planSharedSubmit({ ...f, engineReceipts: [{ ...f.engineReceipts[0], status: "unknown" }] }).status, "pending");
});
test("DOT-E03 segments are read back before manifest; remote byte corruption is rejected", () => {
  const f = fixture(); assert.equal(planSharedSubmit(f).phase, "publishing-segments");
  const segment = publish(f, "segment", "fixture-event\n", 3);
  assert.equal(planSharedSubmit(segment).phase, "segments-verified");
  assert.equal(planSharedSubmit({ ...segment, remoteReadbacks: [] }).phase, "publishing-segments");
  assert.throws(() => planSharedSubmit({ ...segment, remoteReadbacks: [{ ...segment.remoteReadbacks[0], contentBase64: Buffer.from("corrupt").toString("base64") }] }), /mismatch/u);
  const earlyManifest = publish(segment, "manifest", "fixture-manifest", 3);
  assert.equal(planSharedSubmit(earlyManifest).reasonCodes[0], "MANIFEST_PUBLISHED_BEFORE_SEGMENT_VERIFICATION");
});
test("DOT-E03 local/remote/replay/release remain separate, and release unknown stays pending", () => {
  const remote = publish(publish(fixture(), "segment", "fixture-event\n", 3), "manifest", "fixture-manifest", 5);
  assert.equal(planSharedSubmit(remote).phase, "remote-verified");
  const replayed = { ...remote, replay: { libraryId, operationId: remote.operationId, status: "verified", receiptRef: "fixture:independent-replay", readbackRefs: ["fixture:work-readback"], memberSetDigest: dotDigest(remote.publicationMembers), observedAt: at(7) } };
  assert.equal(planSharedSubmit(replayed).status, "pending-release");
  const release = { status: "observed", evidenceRef: "fixture:release", operationId: remote.operationId, observedAt: at(8) };
  const complete = { ...replayed, release, advisory: { ...remote.advisory, state: "released", releaseEvidenceRef: release.evidenceRef, updatedAt: at(8) } };
  assert.equal(planSharedSubmit(complete).status, "complete");
  assert.equal(planSharedSubmit({ ...complete, release: { ...release, status: "unknown" } }).status, "pending-release");
});
test("DOT-E03 duplicate/conflicting publication identities and wrong parent refuse", () => {
  const f = publish(fixture(), "segment", "fixture-event\n", 3);
  assert.throws(() => planSharedSubmit({ ...f, publicationMembers: [...f.publicationMembers, f.publicationMembers[0]] }), /duplicate/u);
  assert.throws(() => planSharedSubmit({ ...f, remoteReadbacks: [{ ...f.remoteReadbacks[0], parentId: "fixture:wrong-parent" }] }), /mismatch/u);
});
test("DOT-E03 unknown publication requires querying before retry; different writer is never evicted by age", () => {
  const f = fixture();
  const uncertain = planSharedSubmit({ ...f, lastError: { phase: "publishing-segments", message: "fixture:timeout", outcome: "unknown" } });
  assert.equal(uncertain.status, "pending"); assert.match(uncertain.next, /query/u);
  assert.equal(planSharedSubmit({ ...f, advisory: { ...f.advisory, operationId: "fixture:other-operation", observedAt: "2020-01-01T00:00:00Z" } }).status, "waiting");
});

test("DOT-E03 duplicate actual publication return is idempotent and conflict bytes are retained", async () => {
  const { appendSharedPublicationMember } = await import("../dist/build/packages/core/src/shared-submit.js");
  const f = publish(fixture(), "segment", "fixture-event\n", 3); const member = f.publicationMembers[0];
  const duplicate = appendSharedPublicationMember(f.publicationMembers, member); assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.members.length, 1);
  const conflict = appendSharedPublicationMember(f.publicationMembers, { ...member, sha256: "f".repeat(64) }); assert.equal(conflict.status, "conflict"); assert.equal(conflict.conflictingReturn.sha256, "f".repeat(64)); assert.equal(conflict.members[0].sha256, member.sha256);
});

test("J13 actual refresh, merge, handoff and publication must be causally ordered", () => {
  const remote = publish(publish(fixture(), "segment", "fixture-event\n", 3), "manifest", "fixture-manifest", 5);
  const release = { status: "observed", evidenceRef: "fixture:release", operationId: remote.operationId, observedAt: at(8) };
  const complete = { ...remote, replay: { libraryId, operationId: remote.operationId, status: "verified", receiptRef: "fixture:replay", readbackRefs: ["fixture:work"], memberSetDigest: dotDigest(remote.publicationMembers), observedAt: at(7) }, release, advisory: { ...remote.advisory, state: "released", releaseEvidenceRef: release.evidenceRef, updatedAt: at(8) } };
  assert.equal(planSharedSubmit(complete).status, "complete");
  const fresh = baseline(at(9)); const digest = dotDigest(fresh);
  const changed = { ...complete, refreshedBaseline: fresh, merge: { ...complete.merge, refreshedBaselineDigest: digest }, writerHandoff: { ...complete.writerHandoff, baselineDigest: digest }, advisory: { ...complete.advisory, baseDigest: digest } };
  assert.equal(planSharedSubmit(changed).reasonCodes[0], "MERGE_PREDATES_REFRESH");
  assert.equal(planSharedSubmit({ ...complete, merge: { ...complete.merge, observedAt: null } }).reasonCodes[0], "MERGE_TIME_UNKNOWN");
  assert.equal(planSharedSubmit({ ...complete, writerHandoff: { ...complete.writerHandoff, observedAt: null } }).reasonCodes[0], "HANDOFF_TIME_UNKNOWN");
  assert.equal(planSharedSubmit({ ...complete, writerHandoff: { ...complete.writerHandoff, observedAt: at(1) } }).reasonCodes[0], "HANDOFF_PREDATES_MERGE");
});

const legacyKnowledgeId = `knowledge:${"a".repeat(24)}`;
const legacyMetadataPath = `crest/metadata/${legacyKnowledgeId}.json`;
function bindFixtureInventories(f) {
  for (const b of [f.baseBaseline, f.refreshedBaseline]) b.completeInventoryDigest = dotDigest(b.inventory);
  f.engineReceipts = f.engineReceipts.map(receipt => ({ ...receipt, baseDigest: dotDigest(f.baseBaseline) }));
  const digest = dotDigest(f.refreshedBaseline);
  f.merge.refreshedBaselineDigest = digest; f.writerHandoff.baselineDigest = digest; f.advisory.baseDigest = digest;
  return f;
}
function preservedLegacyFixture() {
  const f = fixture();
  const archive = `artifacts/consolidation/workspace-${"b".repeat(24)}`;
  const old = [
    "crest/store.json", legacyMetadataPath, `crest/bodies/${legacyKnowledgeId}.body`,
    "artifacts/consolidation/index.json", `${archive}/source.json`, `${archive}/crest/store.json`,
    `${archive}/crest/metadata/${legacyKnowledgeId}.json`,
  ].map(path => ({ path, bytes: 2, sha256: sha("{}"), kind: "file" }));
  for (const b of [f.baseBaseline, f.refreshedBaseline]) {
    b.requiredRoots.push("artifacts"); b.includedRoots.push("artifacts");
    b.inventory.push(...structuredClone(old));
  }
  return bindFixtureInventories(f);
}

test("legacy knowledge is a complete unchanged baseline observation, not a new filename permission", () => {
  const f = preservedLegacyFixture();
  const before = JSON.stringify(f);
  assert.equal(validateSharedBaseline(f.baseBaseline).inventory.length, 10);
  assert.equal(validateSharedBaseline(f.refreshedBaseline, f.baseBaseline).inventory.length, 10);
  assert.equal(planSharedSubmit(f).phase, "publishing-segments");
  assert.equal(JSON.stringify(f), before, "assessment never renames, changes or drops historical bytes/evidence");
  const output = { exactPath: legacyMetadataPath, bytes: 2, sha256: sha("{}"), kind: "segment" };
  f.merge.engineOutputMembers.push(output);
  assert.throws(() => planSharedSubmit(f), /unsafe relative path/u, "even an unchanged legacy file cannot become a publication write");
});

test("legacy compatibility binds exact initial library, root, path, size, digest and kind", () => {
  const cases = [
    f => { f.refreshedBaseline.inventory.find(item => item.path === legacyMetadataPath).sha256 = sha("new bytes"); },
    f => { f.refreshedBaseline.inventory.find(item => item.path === legacyMetadataPath).bytes++; },
    f => { f.refreshedBaseline.inventory = f.refreshedBaseline.inventory.filter(item => item.path !== legacyMetadataPath); },
    f => { f.refreshedBaseline.inventory.find(item => item.path === legacyMetadataPath).path = legacyMetadataPath.replace("knowledge:", "knowledge-"); },
    f => { f.refreshedBaseline.inventory.push({ path: `crest/metadata/knowledge:${"c".repeat(24)}.json`, bytes: 2, sha256: sha("{}"), kind: "file" }); },
  ];
  for (const change of cases) {
    const f = preservedLegacyFixture(); change(f); bindFixtureInventories(f);
    assert.throws(() => planSharedSubmit(f), /legacy knowledge inventory must remain unchanged/u);
  }
  for (const field of ["libraryId", "canonicalRootRef"]) {
    const f = preservedLegacyFixture();
    f.refreshedBaseline[field] = field === "libraryId" ? `workspace:${"d".repeat(24)}` : "fixture:different-canonical-root";
    bindFixtureInventories(f);
    assert.throws(() => planSharedSubmit(f), /same library and canonical root/u);
  }
  const f = preservedLegacyFixture();
  const legacy = f.refreshedBaseline.inventory.find(item => item.path === legacyMetadataPath);
  legacy.kind = "link-raw"; legacy.linkRepresentation = "unfollowed fixture";
  bindFixtureInventories(f);
  assert.throws(() => planSharedSubmit(f), /ordinary file/u);
});

test("legacy allowlist rejects traversal, drive/scheme colons, wrong layouts and incomplete archive closure", () => {
  for (const bad of [
    `elsewhere/${legacyKnowledgeId}.json`, `crest/metadata/${legacyKnowledgeId}.json/extra`,
    `crest/metadata/${legacyKnowledgeId}.body`, `crest/bodies/${legacyKnowledgeId}.json`,
    `crest/metadata/knowledge:${"A".repeat(24)}.json`, `crest/metadata/knowledge:${"a".repeat(23)}.json`,
    `crest/metadata/../${legacyKnowledgeId}.json`, `crest\\metadata\\${legacyKnowledgeId}.json`,
    `C:/crest/metadata/${legacyKnowledgeId}.json`, `https:/crest/metadata/${legacyKnowledgeId}.json`,
    `artifacts/consolidation/arbitrary/crest/metadata/${legacyKnowledgeId}.json`,
    `crest/metadata/${legacyKnowledgeId}.json:stream`,
  ]) {
    const f = preservedLegacyFixture(); f.baseBaseline.inventory.find(item => item.path === legacyMetadataPath).path = bad;
    f.baseBaseline.completeInventoryDigest = dotDigest(f.baseBaseline.inventory);
    assert.throws(() => validateSharedBaseline(f.baseBaseline), /unsafe relative path/u, bad);
  }
  for (const missing of ["crest/store.json", "artifacts/consolidation/index.json", `artifacts/consolidation/workspace-${"b".repeat(24)}/source.json`]) {
    const f = preservedLegacyFixture(); f.baseBaseline.inventory = f.baseBaseline.inventory.filter(item => item.path !== missing);
    f.baseBaseline.completeInventoryDigest = dotDigest(f.baseBaseline.inventory);
    assert.throws(() => validateSharedBaseline(f.baseBaseline), /closure evidence/u);
  }
  const f = preservedLegacyFixture(); f.baseBaseline.includedRoots = ["akasha", "config", "artifacts"]; f.baseBaseline.requiredRoots = ["akasha", "config", "artifacts"];
  assert.throws(() => validateSharedBaseline(f.baseBaseline), /included ordinary file/u);
});

test("new output paths remain bounded ASCII portable components with no case aliases", () => {
  for (const bad of [
    `akasha/device/${legacyKnowledgeId}.ndjson`, "akasha/device/file?.ndjson", "akasha/device/file%.ndjson",
    "akasha/device/é.ndjson", "akasha/device/a b.ndjson", "akasha/device/CON.ndjson", "akasha/device/com1.json", "akasha/device/end.",
    `akasha/device/${"a".repeat(122)}.ndjson`, `akasha/${"a".repeat(110)}/${"b".repeat(110)}/${"c".repeat(30)}.ndjson`,
  ]) {
    const f = preservedLegacyFixture(); f.merge.engineOutputMembers[0].exactPath = bad;
    assert.throws(() => planSharedSubmit(f), /unsafe relative path|nonportable new output path/u, bad);
  }
  const f = preservedLegacyFixture();
  f.merge.engineOutputMembers[0].exactPath = `akasha/device/${"a".repeat(121)}.ndjson`;
  assert.equal(planSharedSubmit(f).phase, "publishing-segments");
  const alias = preservedLegacyFixture(); alias.merge.engineOutputMembers[1].exactPath = "AKASHA/device/manifest.json";
  assert.throws(() => planSharedSubmit(alias), /aliases an existing path/u);
  const duplicate = preservedLegacyFixture(); duplicate.merge.engineOutputMembers.push({ ...duplicate.merge.engineOutputMembers[0], exactPath: "AKASHA/device/00000001.ndjson" });
  assert.throws(() => planSharedSubmit(duplicate), /invalid engine output/u);
});

test("old inventory remains readable through successful new segment/manifest publication and complete-copy proof", () => {
  const f = preservedLegacyFixture();
  const remote = publish(publish(f, "segment", "fixture-event\n", 3), "manifest", "fixture-manifest", 5);
  const release = { status: "observed", evidenceRef: "fixture:release", operationId: remote.operationId, observedAt: at(8) };
  const complete = { ...remote, replay: { libraryId, operationId: remote.operationId, status: "verified", receiptRef: "fixture:complete-copy-with-old-inventory", readbackRefs: ["fixture:legacy-and-new-records"], memberSetDigest: dotDigest(remote.publicationMembers), observedAt: at(7) }, release, advisory: { ...remote.advisory, state: "released", releaseEvidenceRef: release.evidenceRef, updatedAt: at(8) } };
  assert.equal(planSharedSubmit(complete).status, "complete");
  assert.equal(validateSharedBaseline(structuredClone(complete.refreshedBaseline), complete.baseBaseline).inventory.some(item => item.path === legacyMetadataPath), true);
  const colonWrite = { ...complete.publicationMembers[0], exactPath: `akasha/device/${legacyKnowledgeId}.ndjson` };
  assert.throws(() => planSharedSubmit({ ...complete, publicationMembers: [colonWrite, complete.publicationMembers[1]] }), /unsafe relative path/u);
});


// A synthetic old-engine layout, not a production rename or migration. The established
// knowledge fixture contract stores the same card bytes as a pre-event-stream engine did.
async function legacyLibraryFixture(root, instant) {
  await initializeLibrary({ root, createdAt: instant });
  const state = await createProject(root, { externalKey: "PORTABLE-LEGACY", name: "Legacy compatibility fixture", occurredAt: instant });
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  const capture = { occurredAt: instant, externalKey: "LEGACY-CARD", subject: "Copper fixture calibration", summary: "Historical calibration evidence", snippet: "Preserve old physical bytes", tags: ["fixture"], accountableOwnerId: "owner:fixture", body: "The original copper measurement remains unchanged.", coexist: true };
  await captureKnowledgeUnit(root, capture);
  const all = await listKnowledgeMetadata(root, { at: instant, selection: "all" });
  const marker = await readKnowledgeStoreMarker(root);
  const crest = join(root, "crest"), [device] = await readdir(join(crest, "events"));
  const stream = join(crest, "events", device), bodies = new Map();
  for (const name of await readdir(stream)) if (name.endsWith(".body")) bodies.set(name.slice(9, -5), await readFile(join(stream, name)));
  await mkdir(join(crest, "metadata")); await mkdir(join(crest, "bodies"));
  for (const record of all.records) {
    await writeFile(join(crest, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(crest, "bodies", `${record.id}.body`), bodies.get(record.bodySha256));
  }
  const store = join(crest, "store.json");
  await writeFile(store, canonicalJson({ ...JSON.parse(await readFile(store, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(crest, "events"), { recursive: true });
  return { projectId: state.projects[0].id, oldCard: all.records[0], capture };
}
async function libraryInventory(root) {
  const inventory = [];
  const walk = async (relative = "") => {
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path);
      else {
        assert.ok(item.isFile(), "fixture inventory contains ordinary files only");
        const bytes = await readFile(join(root, path));
        inventory.push({ path, bytes: bytes.length, sha256: sha(bytes), kind: "file" });
      }
    }
  };
  await walk(); return inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

test("real engine keeps legacy bytes/readback intact while adding portable knowledge events and ordinary work", async t => {
  const root = await mkdtemp(join(tmpdir(), "shared-submit-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "library"), instant = "2026-10-25T00:00:00Z";
  const f = await legacyLibraryFixture(workspace, instant);
  const before = await libraryInventory(workspace);
  const oldPaths = before.filter(item => item.path.includes(":"));
  assert.equal(oldPaths.length, 2);
  assert.equal((await validateKnowledgeStore(workspace)).records, 1);
  const oldBody = await readKnowledgeBody(workspace, f.oldCard.id, { at: instant });
  await captureKnowledgeUnit(workspace, { ...f.capture, externalKey: "PORTABLE-NEW-CARD", subject: "Nickel fixture stability", summary: "New independent sample", snippet: "New event uses portable path", body: "A new nickel measurement uses an event-stream record." });
  await createWork(workspace, { occurredAt: "2026-10-25T00:00:01Z", externalKey: "PRESERVED-LEGACY-WORK", projectId: f.projectId, kind: "Initiative", parentId: null, title: "Ordinary work remains writable" });
  const after = await libraryInventory(workspace);
  for (const prior of oldPaths) assert.deepEqual(after.find(item => item.path === prior.path), prior, "old names and exact bytes are preserved");
  assert.deepEqual(await readKnowledgeBody(workspace, f.oldCard.id, { at: instant }), oldBody);
  assert.equal((await validateKnowledgeStore(workspace)).records, 2);
  assert.equal((await listKnowledgeMetadata(workspace, { at: instant, selection: "all" })).records.length, 2);
  const outputs = after.filter(item => !before.some(prior => prior.path === item.path && prior.sha256 === item.sha256));
  assert.ok(outputs.some(item => /^crest\/events\/[a-f0-9]{32}\/[0-9]{8}-[a-f0-9]{64}\.json$/u.test(item.path)));
  for (const item of outputs) { assert.match(item.path, /^[A-Za-z0-9._/-]+$/u); assert.ok(item.path.length <= 240); assert.ok(item.path.split("/").every(part => part.length <= 128)); }
  const state = await materializeWorkspaceFromGenesis(workspace);
  assert.equal(state.work.length, 1);
  const base = { ...baseline(), libraryId: state.metadata.workspaceId, requiredRoots: ["akasha", "crest", "config", "artifacts"], includedRoots: ["akasha", "crest", "config", "artifacts"], exclusionsWithReasons: [], inventory: before, completeInventoryDigest: dotDigest(before) };
  const fresh = { ...base, inventory: after, completeInventoryDigest: dotDigest(after) };
  assert.equal(validateSharedBaseline(fresh, base).inventory.length, after.length);
});


test("new output rejects component-case aliases and known link/file ancestor boundaries without rewriting old inventory", () => {
  for (const path of ["akasha/DEVICE/00000001.ndjson", "AKASHA/device/00000001.ndjson"]) {
    const f = preservedLegacyFixture(); f.merge.engineOutputMembers[0].exactPath = path;
    assert.throws(() => planSharedSubmit(f), /aliases an existing path/u);
  }
  const planned = preservedLegacyFixture();
  planned.merge.engineOutputMembers = [{ ...planned.merge.engineOutputMembers[0], exactPath: "akasha/other/00000001.ndjson" }, { ...planned.merge.engineOutputMembers[1], exactPath: "akasha/OTHER/manifest.json" }];
  assert.throws(() => planSharedSubmit(planned), /aliases an existing path/u);
  for (const linkPath of ["akasha/device", "akasha/device/manifest.json"]) {
    const f = preservedLegacyFixture();
    for (const b of [f.baseBaseline, f.refreshedBaseline]) {
      b.inventory = b.inventory.filter(item => item.path !== linkPath);
      b.inventory.push({ path: linkPath, bytes: 4, sha256: sha("dest"), kind: "link-raw", linkRepresentation: "dest" });
    }
    bindFixtureInventories(f);
    const before = JSON.stringify(f.baseBaseline);
    assert.equal(validateSharedBaseline(f.baseBaseline).inventory.some(item => item.path === linkPath), true, "existing raw link remains observable");
    assert.throws(() => planSharedSubmit(f), /inventoried link/u);
    assert.equal(JSON.stringify(f.baseBaseline), before);
  }
  const ancestor = preservedLegacyFixture();
  for (const b of [ancestor.baseBaseline, ancestor.refreshedBaseline]) b.inventory.push({ path: "akasha/device", bytes: 2, sha256: sha("{}"), kind: "file" });
  bindFixtureInventories(ancestor);
  assert.throws(() => planSharedSubmit(ancestor), /file\/directory boundary/u);
});

// SPDX-License-Identifier: Apache-2.0

import { testDeviceHome } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SnapshotError,
  WORKSPACE_RELOCATION_ENTRY_VERSION,
  acquireFileLock,
  activeBinding,
  createKnowledgeUnit,
  createProject,
  createSnapshotManifest,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
  lockPath,
  listKnowledgeMetadata,
  materializeWorkspace,
  migrateKnowledgeBodies,
  rebaseKnowledgeStore,
  validateKnowledgeStore,
  validateWorkspace,
  verifySnapshotManifest,
  LEGACY_CONTROL_DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { SEGMENTED_BODY_FILE_LIMIT } from "../dist/build/packages/core/src/store-backend.js";
import { rootPortableIdentity } from "../dist/build/packages/core/src/root-identity.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

// TCRN-CROSS-STORY-469: the witness covers a library's whole tree.
async function workspaceFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-")));
  const workspace = join(base, "workspace");
  const initialized = await initializeLibrary({ root: workspace, createdAt: instant(0) });
  await createProject(workspace, { externalKey: "PROJ-ALPHA", name: "Alpha", occurredAt: instant(2) });
  await createProject(workspace, { externalKey: "PROJ-BETA", name: "Beta", occurredAt: instant(3) });
  return {
    base,
    workspace,
    libraryId: initialized.metadata.workspaceId,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// createSnapshotManifest takes the engine write lock itself (TCRN-CROSS-STORY-467 R1); the
// helper keeps the call sites' shape.
async function manifestUnderLock(workspace, second, action) {
  void workspace;
  void second;
  return action();
}

async function listTree(root) {
  const entries = [];
  const walk = async (directory, base) => {
    const dirents = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const dirent of dirents) {
      const relative = base === "" ? dirent.name : `${base}/${dirent.name}`;
      const full = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        entries.push(`d ${relative}`);
        await walk(full, relative);
      } else {
        const stats = await lstat(full);
        entries.push(`f ${relative} ${stats.size}`);
      }
    }
  };
  await walk(root, "");
  return entries;
}

async function invokeCli(args) {
  let output = "";
  return runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
}

test("WSF-2 case 1: snapshot-manifest is byte-identical across two runs on an unchanged workspace", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const [first, second] = await manifestUnderLock(fixture.workspace, 4, async () => [
    await createSnapshotManifest(fixture.workspace),
    await createSnapshotManifest(fixture.workspace),
  ]);
  assert.equal(first, second, "two consecutive manifests must be byte-identical");
});

test("WSF-2 case 2: snapshot-manifest waits for a writer holding the lock, then quiesces and completes", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  // The write lock of a library lives in this device's directory.
  const holder = await acquireFileLock(lockPath(fixture.libraryId, testDeviceHome));
  let released = false;
  const pending = invokeCli(["snapshot-manifest", "--workspace", fixture.workspace, "--at", instant(5)]);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  released = true;
  await holder.release();
  const outcome = await pending;
  assert.equal(released, true);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

test("WSF-2 case 3: quarantine residue inside the library fails closed with SNAPSHOT_RESIDUE_PRESENT", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  // A knowledge release quarantine left behind in crest/ by a crashed session.
  await mkdir(join(fixture.workspace, "crest", "released-deadbeef"));
  await manifestUnderLock(fixture.workspace, 4, async () => {
    await assert.rejects(
      createSnapshotManifest(fixture.workspace),
      (error) => error instanceof SnapshotError && error.reasonCode === "SNAPSHOT_RESIDUE_PRESENT" && error.message.includes("crest/released-deadbeef"),
    );
  });
});

test("WSF-2 case 4: a manifest covers the library tree and leaves out the knowledge mutation claim", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  await writeFile(join(fixture.workspace, "crest", "mutation.claim"), "{}\n");
  const manifest = await manifestUnderLock(fixture.workspace, 4, () => createSnapshotManifest(fixture.workspace));
  const parsed = JSON.parse(manifest);
  const paths = parsed.files.map((entry) => entry.path);
  assert.ok(paths.length > 0, "the manifest lists library files");
  assert.ok(paths.includes("manifest.json"), "the manifest includes the library manifest");
  assert.ok(paths.some((path) => /^akasha\/[a-f0-9]{32}\/manifest\.json$/u.test(path)), "the manifest includes the stream manifest");
  assert.ok(paths.some((path) => /^akasha\/[a-f0-9]{32}\/[0-9a-f]{8}\.ndjson$/u.test(path)), "the manifest includes event segments");
  for (const path of paths) {
    // The write lock lives in the device directory, never in the library.
    assert.equal(path.endsWith(".lock"), false, `no lock is library content: ${path}`);
    assert.notEqual(path, "crest/mutation.claim", "an in-flight claim is not backup content");
  }
  assert.equal(parsed.validate.workspace, "valid");
  assert.equal(parsed.validate.knowledge, "absent");
});

test("WSF-2 case 5: the manifest validates against workspace-snapshot-manifest-v1.schema.json", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-snapshot-manifest-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const manifest = await manifestUnderLock(fixture.workspace, 4, () => createSnapshotManifest(fixture.workspace));
  assert.equal(validate(JSON.parse(manifest)), true, JSON.stringify(validate.errors));
});

// An older engine's metadata/body layout, prepared only inside this fixture. The
// current candidate migrates its bodies through the existing backend into one
// valid segment past 1 MiB; every card is still read and validated by the store.
async function largeKnowledgeBodySegment(fixture) {
  const workspace = fixture.workspace;
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const body = "x".repeat(8_192);
  await createKnowledgeUnit(workspace, {
    occurredAt: instant(4), externalKey: "SNAPSHOT-BODY-SEED", scope: "workspace", projectId: null, roleScopes: [],
    category: "implementation", kind: "fact", tags: ["snapshot"], subject: "Snapshot body seed", summary: "A body", snippet: "A body",
    accountableOwnerId: "owner:snapshot", sourceReferences: [], sourceDigest: null, linkedWorkIds: [], linkedDecisionIds: [],
    linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", body,
  });
  const [seed] = (await listKnowledgeMetadata(workspace, { at: instant(4), selection: "all", limit: 10 })).records;
  const marker = await readKnowledgeStoreMarker(workspace);
  const crest = join(workspace, "crest");
  await mkdir(join(crest, "metadata"));
  await mkdir(join(crest, "bodies"));
  for (let ordinal = 0; ordinal < 160; ordinal += 1) {
    const externalKey = `SNAPSHOT-BODY-${ordinal}`;
    const id = deriveStableId("knowledge", externalKey);
    await writeFile(join(crest, "metadata", `${id}.json`), canonicalJson({ ...seed, id, externalKey, subject: `Snapshot body ${ordinal}` }));
    await writeFile(join(crest, "bodies", `${id}.body`), body);
  }
  const markerPath = join(crest, "store.json");
  await writeFile(markerPath, canonicalJson({ ...JSON.parse(await readFile(markerPath, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rename(join(crest, "events"), join(fixture.base, "donor-knowledge-events"));
  await migrateKnowledgeBodies(workspace, 4 * 1_048_576);
  await validateKnowledgeStore(workspace);
  return "crest/bodies/000001.ndjson";
}

test("STORY-515: CLI snapshots read the complete declared knowledge segment past 1 MiB and detect its last covered byte", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const relativePath = await largeKnowledgeBodySegment(fixture);
  const bytes = await readFile(join(fixture.workspace, relativePath));
  assert.ok(bytes.length > 1_048_576 && bytes.length < SEGMENTED_BODY_FILE_LIMIT);
  const generated = await invokeCli(["snapshot-manifest", "--workspace", fixture.workspace, "--at", instant(5)]);
  assert.equal(generated.ok, true, generated.reasonCode);
  const manifest = JSON.parse(generated.output);
  const entry = manifest.files.find((file) => file.path === relativePath);
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  const receipt = join(fixture.base, "manifest.json");
  await writeFile(receipt, generated.output);
  const verified = await invokeCli(["snapshot-verify", "--root", fixture.workspace, "--manifest", receipt]);
  assert.equal(verified.ok, true, verified.reasonCode);
  assert.equal(JSON.parse(verified.output).reasonCode, "SNAPSHOT_VERIFIED");
  const copy = join(fixture.base, "copy");
  await cp(fixture.workspace, copy, { recursive: true });
  const handle = await open(join(copy, relativePath), "r+");
  try { await handle.write(Buffer.from("!"), 0, 1, bytes.length - 2); } finally { await handle.close(); }
  assert.equal((await invokeCli(["snapshot-verify", "--root", copy, "--manifest", receipt])).reasonCode, "SNAPSHOT_MISMATCH");
});

test("STORY-515: only declared body segments get their backend limit; overflow and declaration drift still refuse", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const relativePath = await largeKnowledgeBodySegment(fixture);
  const manifest = await createSnapshotManifest(fixture.workspace);
  for (const relative of ["crest/bodies/000002.ndjson", "crest/bodies/other.ndjson", "akasha/other/00000001.ndjson"]) {
    const copy = join(fixture.base, `unknown-${relative.replaceAll("/", "-")}`);
    await cp(fixture.workspace, copy, { recursive: true });
    await mkdir(dirname(join(copy, relative)), { recursive: true });
    await writeFile(join(copy, relative), "x");
    await truncate(join(copy, relative), 1_048_577);
    await assert.rejects(verifySnapshotManifest(copy, manifest), { reasonCode: "SNAPSHOT_MISMATCH" });
  }
  const overflow = join(fixture.base, "body-overflow");
  await cp(fixture.workspace, overflow, { recursive: true });
  // The runtime limit is the safe-integer domain; no filesystem can truthfully create
  // MAX_SAFE_INTEGER + 1 bytes. Put that unrepresentable declaration in the copied
  // body manifest instead, so the downstream snapshot checker must refuse its format.
  const bodyManifestPath = "crest/bodies/manifest.json";
  const bodyManifestFile = join(overflow, bodyManifestPath);
  const bodyManifest = JSON.parse(await readFile(bodyManifestFile, "utf8"));
  const declaredSegment = bodyManifest.segments.find((entry) => `crest/bodies/${entry.name}` === relativePath);
  assert.ok(declaredSegment, "the actual segment is declared by the body manifest");
  declaredSegment.bytes = Number.MAX_SAFE_INTEGER + 1;
  await writeFile(bodyManifestFile, `${JSON.stringify(bodyManifest)}\n`);
  const overflowBefore = await listTree(overflow);
  await assert.rejects(verifySnapshotManifest(overflow, manifest),
    (error) => error instanceof SnapshotError && error.reasonCode === "SNAPSHOT_MISMATCH" && error.message.includes(bodyManifestPath));
  assert.deepEqual(await listTree(overflow), overflowBefore, "format refusal writes nothing");
  const drift = join(fixture.base, "body-length-drift");
  await cp(fixture.workspace, drift, { recursive: true });
  const path = join(drift, relativePath);
  await truncate(path, (await lstat(path)).size - 1);
  await assert.rejects(verifySnapshotManifest(drift, manifest), { reasonCode: "SNAPSHOT_MISMATCH" });
});

test("WSF-2 case 6: the witness writes nothing — the whole tree is byte-stable across a manifest", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  await manifestUnderLock(fixture.workspace, 4, async () => {
    const before = await listTree(fixture.base);
    await createSnapshotManifest(fixture.workspace);
    const after = await listTree(fixture.base);
    assert.deepEqual(after, before, "createSnapshotManifest must not write to the filesystem");
  });
});

test("WSF-2 case 7: snapshot-verify fails SNAPSHOT_MISMATCH naming a tampered segment", async (t) => {
  const fixture = await workspaceFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLock(fixture.workspace, 4, () => createSnapshotManifest(fixture.workspace));
  const target = join(fixture.base, "restore-copy");
  await cp(fixture.workspace, target, { recursive: true });
  // A clean copy verifies.
  assert.deepEqual(await verifySnapshotManifest(target, manifest), {
    schemaVersion: "tcrn.workspace-snapshot-verify.v1",
    reasonCode: "SNAPSHOT_VERIFIED",
    files: JSON.parse(manifest).files.length,
  });
  // Flip one byte of a copied event segment.
  const [deviceId] = await readdir(join(target, "akasha"));
  const segmentPath = `akasha/${deviceId}/00000001.ndjson`;
  const segment = join(target, segmentPath);
  const bytes = await readFile(segment);
  bytes[0] = bytes[0] === 0x20 ? 0x21 : 0x20;
  await writeFile(segment, bytes);
  await assert.rejects(
    verifySnapshotManifest(target, manifest),
    (error) => error instanceof SnapshotError && error.reasonCode === "SNAPSHOT_MISMATCH" && error.message.includes(segmentPath),
  );
});

// WSF-3: a library carrying BOTH stores — its akasha streams advanced past project+work
// and an initialized knowledge store in crest/ with one unit bound to the current head.
// The round-trip and doctrine cases below all restore the whole library (or deliberately
// break lockstep) from this state.
function knowledgeInput({ projectId, workId }) {
  return {
    occurredAt: instant(5),
    externalKey: "KNOWLEDGE-BK-ROUNDTRIP",
    scope: "project",
    projectId,
    roleScopes: [],
    category: "implementation",
    kind: "guide",
    tags: ["backup", "workflow"],
    subject: "Backup round-trip subject",
    summary: "Backup round-trip summary",
    snippet: "Backup round-trip snippet",
    accountableOwnerId: deriveStableId("owner", "BK-ROUNDTRIP-OWNER"),
    sourceReferences: ["evidence://fixture/bk-roundtrip"],
    sourceDigest: canonicalSha256({ key: "BK-ROUNDTRIP", source: "current" }),
    linkedWorkIds: [workId],
    linkedDecisionIds: [deriveStableId("decision", "BK-ROUNDTRIP-DECISION")],
    linkedGateIds: [deriveStableId("gate", "BK-ROUNDTRIP-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "BK-ROUNDTRIP-EVIDENCE")],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: instant(4),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Backup round-trip body",
  };
}

async function roundTripFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-rt-")));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  let projectId;
  let workId;
  const withProject = await createProject(workspace, { externalKey: "PROJ-ALPHA", name: "Alpha", occurredAt: instant(2) });
  projectId = withProject.projects[0].id;
  const withWork = await createWork(workspace, { occurredAt: instant(3), projectId, externalKey: "WORK-ALPHA", kind: "Initiative", parentId: null, status: "active" });
  workId = withWork.work[0].id;
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await createKnowledgeUnit(workspace, knowledgeInput({ projectId, workId }));
  return {
    base,
    workspace,
    projectId,
    workId,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("WSF-3 case 8: snapshot then wipe then restore round-trips the whole library byte-identically", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLock(fixture.workspace, 10, () => createSnapshotManifest(fixture.workspace));
  assert.equal(JSON.parse(manifest).validate.knowledge, "valid", "the manifest embeds a valid knowledge store");
  const copy = join(fixture.base, "snapshot-copy");
  await cp(fixture.workspace, copy, { recursive: true });
  // Wipe the live library entirely, then restore it from the copy in place.
  await rm(fixture.workspace, { recursive: true, force: true });
  await cp(copy, fixture.workspace, { recursive: true });
  // The restored copy verifies byte-for-byte against the manifest receipt.
  assert.equal((await verifySnapshotManifest(fixture.workspace, manifest)).reasonCode, "SNAPSHOT_VERIFIED");
  // Both stores validate green after restore, and the workspace head is unchanged.
  const state = await validateWorkspace(fixture.workspace);
  assert.equal(state.headEventHash, JSON.parse(manifest).headEventHash);
  assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  // Byte-identity: a fresh manifest of the restored tree equals the original,
  // proving the per-file sha256 set, head hash, and version all round-tripped.
  const remanifest = await manifestUnderLock(fixture.workspace, 11, () => createSnapshotManifest(fixture.workspace));
  assert.equal(remanifest, manifest, "the restored tree re-manifests byte-identically");
});

// TCRN-CROSS-SUB-414 (MIN-235 D7): what binds the knowledge store to the chain is no longer a
// high water store.json holds -- nothing but initialization writes it, and a rebase writes nothing
// -- but the chain position each card's event names: every chain stream's head the write was
// checked against. A store newer than its chain is one holding a card written against chain events
// the chain no longer has, and validate refuses it, naming the card.
test("WSF-3 case 9: partial restore leaving a newer knowledge store fails KNOWLEDGE_HIGH_WATER_MISMATCH", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  // Save only the chain portion (state A): the akasha streams.
  const backup = join(fixture.base, "akasha-backup");
  await cp(join(fixture.workspace, "akasha"), backup, { recursive: true });
  // Advance the head, then write a card against the new head, so the knowledge store is strictly
  // NEWER than the saved chain state. A rebase no longer makes it so: it re-binds nothing.
  await createProject(fixture.workspace, { externalKey: "PROJ-GAMMA", name: "Gamma", occurredAt: instant(8) });
  const manifest = await readFile(join(fixture.workspace, "crest", "store.json"));
  await rebaseKnowledgeStore(fixture.workspace, { at: instant(9) });
  assert.deepEqual(await readFile(join(fixture.workspace, "crest", "store.json")), manifest, "the rebase wrote nothing");
  const newer = await createKnowledgeUnit(fixture.workspace, {
    ...knowledgeInput({ projectId: fixture.projectId, workId: fixture.workId }),
    occurredAt: instant(9), externalKey: "KNOWLEDGE-BK-NEWER", subject: "Written against the advanced head", tags: ["backup", "newer"],
  });
  assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID", "before the restore the chain holds every card");
  // Partial restore: return only the streams to state A, keep the newer store.
  await rm(join(fixture.workspace, "akasha"), { recursive: true, force: true });
  await cp(backup, join(fixture.workspace, "akasha"), { recursive: true });
  await assert.rejects(
    validateKnowledgeStore(fixture.workspace),
    (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH" && error.details.awaitingChain.map((entry) => entry.id).join() === newer.id,
  );
});

// The old layout bound its roots, so a control tree restored to another path failed
// WORKSPACE_SCHEMA_INVALID. A library binds no path (TCRN-CROSS-STORY-469): restored anywhere,
// it verifies against its receipt and reads to the same head.
test("WSF-3 case 10: a library restored to a different path verifies and reads the same head", async (t) => {
  const fixture = await roundTripFixture();
  t.after(() => fixture.close());
  const manifest = await manifestUnderLock(fixture.workspace, 10, () => createSnapshotManifest(fixture.workspace));
  const alternate = await realpath(await mkdtemp(join(tmpdir(), "tcrn-bk-alt-")));
  t.after(() => rm(alternate, { recursive: true, force: true }));
  const relocated = join(alternate, "workspace");
  await cp(fixture.workspace, relocated, { recursive: true });
  assert.equal((await verifySnapshotManifest(relocated, manifest)).reasonCode, "SNAPSHOT_VERIFIED");
  const state = await validateWorkspace(relocated);
  assert.equal(state.headEventHash, JSON.parse(manifest).headEventHash);
  assert.equal((await validateKnowledgeStore(relocated)).reasonCode, "KNOWLEDGE_STORE_VALID");
});

// WSF-4: the git tier-2 guidance doc prescribes a .gitignore for a workspace-root
// git repo. Its fenced `gitignore` block must name exactly the SDC-9 residue
// taxonomy the snapshot witness excludes/fails-closed on, plus the two store-local
// claim classes (knowledge released-*, artifact restore.claim / released-restore-*)
// whose commit would resurrect a bricked store on clone. This array is kept
// ADJACENT to the WSF-2 exclusion list documented in workspace-snapshot.ts so the
// doc and the engine constants drift together loudly. Hermetic: no git is invoked.
const GITIGNORE_EXPECTED = [
  `${LEGACY_CONTROL_DIRECTORY}/lease/`,
  `${LEGACY_CONTROL_DIRECTORY}/lease-recovery.claim`,
  `${LEGACY_CONTROL_DIRECTORY}/knowledge/mutation.claim`,
  `${LEGACY_CONTROL_DIRECTORY}/knowledge/released-*`,
  `${LEGACY_CONTROL_DIRECTORY}/artifacts/restore.claim`,
  `${LEGACY_CONTROL_DIRECTORY}/artifacts/released-restore-*`,
  `${LEGACY_CONTROL_DIRECTORY}/stale-lease-*/`,
  `${LEGACY_CONTROL_DIRECTORY}/released-*`,
  `${LEGACY_CONTROL_DIRECTORY}/attempt-owned-*`,
  `${LEGACY_CONTROL_DIRECTORY}/**/.tmp-*`,
];

test("WSF-4 case 11: backup-git-tier.md prescribes the exact SDC-9 residue .gitignore", async () => {
  const doc = await readFile(new URL("../docs/architecture/backup-git-tier.md", import.meta.url), "utf8");
  const fence = doc.match(/```gitignore\n([\s\S]*?)```/u);
  assert.ok(fence, "the doc must carry a fenced gitignore block");
  // The doc writes the old-layout control directory as <control>; substituted, the block is
  // the exact .gitignore residue fence.
  const lines = fence[1].split("\n").map((line) => line.trim().replaceAll("<control>", LEGACY_CONTROL_DIRECTORY)).filter((line) => line !== "" && !line.startsWith("#"));
  // The block is exactly the SDC-9 taxonomy — no more, no fewer patterns.
  assert.deepEqual(lines, GITIGNORE_EXPECTED, "the gitignore fence must match the SDC-9 residue taxonomy exactly");
  // Targeted invariants the verifier corrections require, stated independently of order:
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/lease/`), "must ignore the lease directory");
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/lease-recovery.claim`), "must ignore the recovery claim");
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/knowledge/mutation.claim`), "must ignore the knowledge mutation claim");
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/knowledge/released-*`), "must ignore the knowledge release quarantine");
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/artifacts/restore.claim`), "must ignore the artifact restore claim");
  assert.ok(lines.includes(`${LEGACY_CONTROL_DIRECTORY}/artifacts/released-restore-*`), "must ignore the artifact restore quarantine");
  assert.ok(lines.some((line) => line.includes(".tmp-")), "must ignore atomic-write temporaries");
  // The doc downgrades git to witness-only: it must route restores through the copy
  // runbook and carry the quiesce-before-working-tree-ops and headEventHash-message conventions.
  assert.ok(/backup-restore-runbook\.md/u.test(doc), "the doc cross-links the copy restore runbook");
  assert.ok(/[Qq]uiesce/u.test(doc), "the doc carries the quiesce-before-git-working-tree-ops warning");
  assert.ok(/headEventHash/u.test(doc), "the doc states the commit-message-carries-headEventHash convention");
});

// ---------------------------------------------------------------------------
// WSR-1 L: the relocation LEDGER PARSE, the part of the ledger reader that outlived its
// verbs and its admission.
//
// TCRN-CROSS-STORY-358 retired packages/core/src/workspace-relocation.ts and the five
// relocation-* verbs; the switch to libraries (TCRN-CROSS-STORY-469) retired the admission
// that refused reads at a vacated, not-yet-adopted or foreign address (the old L1..L5 proved
// it): an old-layout workspace now reads wherever it sits. What remains in
// packages/core/src/workspace.ts is the parse inside validateMetadata -- a `relocations`
// array in workspace.json is still checked entry by entry -- and activeBinding, which still
// names the root the knowledge store is bound to. The ledger is a JSON document, so it is
// written here by hand into the frozen old-layout fixture and read back through status.
// ---------------------------------------------------------------------------

const LEDGER_ROOT_KINDS = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
const LEDGER_ACTOR = "actor:relocation-operator";
const LEDGER_BASIS = Object.freeze({ controlManifestSha256: "a".repeat(64), headEventHash: "b".repeat(64), version: 3 });

// The five-root array in the ledger's own shape. `base` is a realpath, so path and
// canonicalPath are the same string and portableIdentity is derived exactly the way
// the reader re-derives it.
function ledgerRoots(sideRoots) {
  return LEDGER_ROOT_KINDS.map((kind) => ({
    kind,
    path: sideRoots[kind],
    canonicalPath: sideRoots[kind],
    portableIdentity: rootPortableIdentity(sideRoots[kind]),
  }));
}

// The id a ledger entry names itself by: a digest of its own content, which the parse
// re-derives. Nothing writes a ledger any more, so the engine keeps the derivation private.
function relocationIdOf({ workspaceId, sequence, from, to, basis }) {
  return `relocation:${canonicalSha256({ schemaVersion: "tcrn.workspace-relocation-identity.v1", workspaceId, sequence, from, to, basis }).slice(0, 24)}`;
}

// The frozen old-layout workspace with real, canonical roots (the fixture's own are
// placeholders), plus a vacated entry and its adopted completion, both derived rather than
// transcribed: the completion restates the hop byte for byte.
async function ledgerFixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-wsrl-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const side = async (name) => {
    const roots = {};
    for (const kind of LEDGER_ROOT_KINDS) {
      const path = join(base, name, kind);
      await mkdir(path, { recursive: true });
      roots[kind] = path;
    }
    return roots;
  };
  const source = await side("A");
  const target = await side("B");
  const { root, control } = await restoreLegacyFixture(base, "legacy");
  const metadataPath = join(control, "workspace.json");
  const metadata = { ...JSON.parse(await readFile(metadataPath, "utf8")), roots: ledgerRoots(source) };
  const write = (value) => writeFile(metadataPath, canonicalJson(value));
  await write(metadata);
  const from = metadata.roots;
  const to = ledgerRoots(target);
  const vacated = {
    schemaVersion: WORKSPACE_RELOCATION_ENTRY_VERSION,
    sequence: 1,
    relocationId: relocationIdOf({ workspaceId: metadata.workspaceId, sequence: 1, from, to, basis: LEDGER_BASIS }),
    stage: "vacated",
    at: instant(9),
    from,
    to,
    basis: LEDGER_BASIS,
    authority: { actorId: LEDGER_ACTOR, authorityFileSha256: "c".repeat(64) },
  };
  const adopted = { ...vacated, sequence: 2, stage: "adopted", at: instant(11) };
  return { base, root, metadata, write, hop: { vacated, adopted } };
}

test("WSR-1 L6: a ledger entry must name itself, and a completion must restate its hop", async (t) => {
  const { base, root, metadata, write, hop } = await ledgerFixture(t);
  // With no ledger the binding IS `roots`.
  assert.deepEqual(activeBinding((await materializeWorkspace(root)).metadata), metadata.roots);
  const elsewhere = join(base, "elsewhere-l6");
  const displaced = (roots) => roots.map((entry, index) => (index === 2
    ? { kind: entry.kind, path: elsewhere, canonicalPath: elsewhere, portableIdentity: rootPortableIdentity(elsewhere) }
    : entry));
  // (a) tamper WITHOUT recomputing the id. This is the cheapest detector of naive
  // or accidental ledger corruption.
  await write({ ...metadata, relocations: [{ ...hop.vacated, to: displaced(hop.vacated.to) }] });
  const naive = await invokeCli(["status", "--workspace", root]);
  assert.equal(naive.ok, false);
  assert.equal(naive.reasonCode, "WORKSPACE_RELOCATION_LEDGER_INVALID");
  // (b) a completion that does not restate its hop. The id check does not run on a
  // completion entry, so this reaches the restatement rule and nothing else.
  await write({ ...metadata, relocations: [hop.vacated, { ...hop.adopted, to: displaced(hop.adopted.to) }] });
  const restated = await invokeCli(["status", "--workspace", root]);
  assert.equal(restated.ok, false);
  assert.equal(restated.reasonCode, "WORKSPACE_RELOCATION_LEDGER_INVALID");
  // Both sides differ: the untampered ledger reads clean, and the binding in force is the
  // last adopted `to`, while `roots` is never rewritten.
  await write({ ...metadata, relocations: [hop.vacated, hop.adopted] });
  assert.equal((await invokeCli(["status", "--workspace", root])).ok, true);
  const adoptedMetadata = (await materializeWorkspace(root)).metadata;
  assert.deepEqual(activeBinding(adoptedMetadata), hop.adopted.to);
  assert.notDeepEqual(activeBinding(adoptedMetadata), adoptedMetadata.roots);
});

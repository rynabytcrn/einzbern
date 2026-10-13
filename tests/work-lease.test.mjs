// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-528 (MIN-256): work leases. SUB-456: a lease is a record of the library's lease
// collection, keyed by the work item's id and scoped to its project; a claim by the holder renews
// it, a claim is refused while another actor's unexpired lease binds the item, an item above it or
// an item below it, and whether a lease runs is judged against the write's --at. The holder releases
// at any time, another actor needs force while it runs, and config/project.json never shows one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyWorkBatch,
  configProjectionStatus,
  createProject,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
} from "../dist/build/packages/core/src/index.js";
import { CONFIG_RECORD_COLLECTIONS, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { projectConfigPath } from "../dist/build/packages/core/src/library-config.js";
import {
  WORK_LEASE_TTL_DEFAULT,
  activeLease,
  claimWork,
  parseLeaseTtl,
  releaseWork,
  workLease,
  workLeaseView,
} from "../dist/build/packages/core/src/work-lease.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";

const A = "agent:alpha";
const B = "agent:bravo";
const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
/** The instant `minutes` and `seconds` after 08:00 UTC on 2026-10-14. */
const at = (minutes = 0, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString().replace(".000Z", "Z");

const STORY_SCOPE = [
  "## Goal",
  "为谁:the operator. 目的锚:STORY-528. 符合性判据:one writer per Story. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 the work lease.",
  "", "## Acceptance Criteria", "GIVEN a lease WHEN another actor writes THEN the write is refused",
  "", "## Business Background", "实测 two sessions wrote one Story.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- Claim a Story before working on it.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the lease collection.",
].join("\n");

/** A library with one project and INIT > EPIC > STORY > SUB, and a SIBLING Story under the Epic. */
async function library(context, key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-work-lease-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "library");
  await initializeLibrary({ root, createdAt: at(-10) });
  const project = await createProject(root, { occurredAt: at(-9), externalKey: `${key}-P`, name: key });
  const projectId = project.projects[0].id;
  const keys = { initiative: `${key}-INIT`, epic: `${key}-EPIC`, story: `${key}-STORY`, sibling: `${key}-SIBLING`, subtask: `${key}-SUB` };
  await applyWorkBatch(root, {
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-create", projectId, externalKey: keys.initiative, kind: "Initiative", parentId: null, status: "active", title: keys.initiative },
      { verb: "work-create", projectId, externalKey: keys.epic, kind: "Epic", parentExternalKey: keys.initiative, status: "active", title: keys.epic },
      { verb: "work-create", projectId, externalKey: keys.story, kind: "Story", parentExternalKey: keys.epic, status: "planned", scope: STORY_SCOPE, title: keys.story },
      { verb: "work-create", projectId, externalKey: keys.sibling, kind: "Story", parentExternalKey: keys.epic, status: "planned", scope: STORY_SCOPE, title: keys.sibling },
      { verb: "work-create", projectId, externalKey: keys.subtask, kind: "Subtask", parentExternalKey: keys.story, status: "planned", title: keys.subtask },
    ],
  }, { occurredAt: at(-8) });
  const ids = Object.fromEntries(Object.entries(keys).map(([name, externalKey]) => [name, deriveStableId("work", externalKey)]));
  return { base, root, projectId, ids };
}

/** Assert that `operation` is refused with WORK_LEASED naming A's lease on `leasedWorkId`, running until `expiresAt`. */
async function refusedAsLeased(operation, { leasedWorkId, holder = A, expiresAt = at(120) }) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.reasonCode, "WORK_LEASED", error.message);
    assert.deepEqual({ holder: error.details.holder, expiresAt: error.details.expiresAt, leasedWorkId: error.details.leasedWorkId }, { holder, expiresAt, leasedWorkId });
    return true;
  });
}

const leaseRecords = (state) => state.configRecords.filter((record) => record.collection === "lease");

test("528 SUB-456: --ttl is <n>m or <n>h, 2h when left out, from one minute to 24 hours", () => {
  assert.equal(WORK_LEASE_TTL_DEFAULT, "2h");
  assert.equal(parseLeaseTtl(undefined), 120);
  for (const [text, minutes] of [["1m", 1], ["90m", 90], ["2h", 120], ["24h", 1440], ["1440m", 1440]]) {
    assert.equal(parseLeaseTtl(text), minutes, text);
  }
  for (const text of ["0m", "0h", "1441m", "25h", "2d", "", "02h", "1.5h", "h", "-1h", " 2h", "2H", "120"]) {
    assert.throws(() => parseLeaseTtl(text), { reasonCode: "WORK_LEASE_TTL_INVALID" }, JSON.stringify(text));
  }
  assert.ok(CONFIG_RECORD_COLLECTIONS.includes("lease"), "lease is a collection of the closed table");
});

test("528 SUB-456: a claim records the lease on the item, scoped to its project; the holder's claim renews it", async (context) => {
  const f = await library(context, "LEASE-CLAIM");
  const claimed = await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  assert.deepEqual(leaseRecords(claimed), [
    { collection: "lease", key: f.ids.story, projectId: f.projectId, value: { holder: A, claimedAt: at(0), expiresAt: at(120) } },
  ], "two hours when --ttl is left out");
  assert.deepEqual(workLease(claimed, f.ids.story), { workId: f.ids.story, holder: A, claimedAt: at(0), expiresAt: at(120) });
  assert.equal(workLease(claimed, f.ids.epic), null, "the lease is the item's own, not its parent's");

  const renewed = await claimWork(f.root, { id: f.ids.story, actorId: A, ttl: "30m", occurredAt: at(100) });
  assert.deepEqual(leaseRecords(renewed).map((record) => record.value), [{ holder: A, claimedAt: at(100), expiresAt: at(130) }], "one record, renewed from the new claim");

  // An --at with an offset is the same instant; the lease reads in UTC.
  const offset = await claimWork(f.root, { id: f.ids.sibling, actorId: B, ttl: "1m", occurredAt: "2026-10-14T11:45:30.5+02:00" });
  assert.deepEqual(workLease(offset, f.ids.sibling), { workId: f.ids.sibling, holder: B, claimedAt: "2026-10-14T09:45:30.5Z", expiresAt: "2026-10-14T09:46:30.5Z" });

  const live = await materializeWorkspace(f.root);
  assert.deepEqual(leaseRecords(live), leaseRecords(offset), "the leases replay from the events");
  assert.deepEqual(await materializeWorkspaceFromGenesis(f.root), live, "the genesis replay matches the live materialization");
});

test("528 SUB-456: another actor's unexpired lease on the item, above it or below it refuses a claim", async (context) => {
  const f = await library(context, "LEASE-FAMILY");
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  const before = await materializeWorkspace(f.root);
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.story, actorId: B, occurredAt: at(1) }), { leasedWorkId: f.ids.story });
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.epic, actorId: B, occurredAt: at(2) }), { leasedWorkId: f.ids.story });
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.initiative, actorId: B, occurredAt: at(3) }), { leasedWorkId: f.ids.story });
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.subtask, actorId: B, occurredAt: at(4) }), { leasedWorkId: f.ids.story });
  const after = await materializeWorkspace(f.root);
  assert.equal(after.version, before.version, "a refused claim writes nothing");
  assert.equal(after.headEventHash, before.headEventHash);

  // A sibling is not of the family, and the holder's own leases never stand in each other's way.
  await claimWork(f.root, { id: f.ids.sibling, actorId: B, occurredAt: at(5) });
  await claimWork(f.root, { id: f.ids.subtask, actorId: A, occurredAt: at(6) });
  const held = await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(7) });
  assert.deepEqual(leaseRecords(held).map((record) => [record.key, record.value.holder]).sort(), [
    [f.ids.sibling, B], [f.ids.story, A], [f.ids.subtask, A],
  ].sort());
  // B's lease below the Epic now stands in A's way too.
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.epic, actorId: A, occurredAt: at(8) }), { leasedWorkId: f.ids.sibling, holder: B, expiresAt: at(125) });
  await assert.rejects(() => claimWork(f.root, { id: deriveStableId("work", "LEASE-NONE"), actorId: A, occurredAt: at(9) }), { reasonCode: "WORKSPACE_INPUT_INVALID" });
  await assert.rejects(() => claimWork(f.root, { id: f.ids.story, actorId: "alpha", occurredAt: at(9) }), { reasonCode: "ACTOR_ID_INVALID" });
});

test("528 SUB-456: a lease that has run out by the write's --at binds no one, so another actor's claim succeeds", async (context) => {
  const f = await library(context, "LEASE-EXPIRY");
  await claimWork(f.root, { id: f.ids.story, actorId: A, ttl: "1h", occurredAt: at(0) });
  await refusedAsLeased(() => claimWork(f.root, { id: f.ids.subtask, actorId: B, occurredAt: at(59, 59) }), { leasedWorkId: f.ids.story, expiresAt: at(60) });
  const taken = await claimWork(f.root, { id: f.ids.story, actorId: B, occurredAt: at(60) });
  assert.deepEqual(workLease(taken, f.ids.story), { workId: f.ids.story, holder: B, claimedAt: at(60), expiresAt: at(180) }, "the lease runs up to, not through, its expiresAt");

  // activeLease: the item's own, else the nearest above; a lease below binds nothing above it.
  assert.deepEqual(activeLease(taken, f.ids.subtask, at(61)), { workId: f.ids.story, holder: B, claimedAt: at(60), expiresAt: at(180) });
  assert.equal(activeLease(taken, f.ids.epic, at(61)), null);
  assert.equal(activeLease(taken, f.ids.subtask, at(180)), null, "judged against the instant asked about");
  assert.deepEqual(workLeaseView(taken, f.ids.story, at(179)), { holder: B, claimedAt: at(60), expiresAt: at(180), active: true });
  assert.deepEqual(workLeaseView(taken, f.ids.story, at(180)), { holder: B, claimedAt: at(60), expiresAt: at(180), active: false });
  assert.equal(workLeaseView(taken, f.ids.epic, at(61)), null);
});

test("528 SUB-456: the holder releases at any time; another actor needs force while the lease runs", async (context) => {
  const f = await library(context, "LEASE-RELEASE");
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  await refusedAsLeased(() => releaseWork(f.root, { id: f.ids.story, actorId: B, occurredAt: at(1) }), { leasedWorkId: f.ids.story });
  const forced = await releaseWork(f.root, { id: f.ids.story, actorId: B, force: true, occurredAt: at(2) });
  assert.equal(workLease(forced, f.ids.story), null, "a forced release removes the record");
  await assert.rejects(() => releaseWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(3) }), { reasonCode: "WORK_LEASE_NOT_FOUND" });

  await claimWork(f.root, { id: f.ids.story, actorId: A, ttl: "1m", occurredAt: at(4) });
  const own = await releaseWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(4, 30) });
  assert.equal(workLease(own, f.ids.story), null, "the holder releases its own lease");

  await claimWork(f.root, { id: f.ids.story, actorId: A, ttl: "1m", occurredAt: at(6) });
  const cleared = await releaseWork(f.root, { id: f.ids.story, actorId: B, occurredAt: at(8) });
  assert.equal(workLease(cleared, f.ids.story), null, "a lease that has run out binds no one, so anyone may clear it");

  const operations = (await materializeWorkspace(f.root)).events
    .filter((event) => event.payload.record?.collection === "lease")
    .map((event) => event.payload.operation);
  assert.deepEqual(operations, ["config.record.set", "config.record.removed", "config.record.set", "config.record.removed", "config.record.set", "config.record.removed"], "one event a claim, one a release");
});

test("528 SUB-456: a lease record is a work id's {holder, claimedAt, expiresAt}, scoped to a project, on write and on replay", async (context) => {
  const f = await library(context, "LEASE-SHAPE");
  const valid = { holder: A, claimedAt: at(0), expiresAt: at(60) };
  for (const value of [
    { holder: A, claimedAt: at(0) },
    { ...valid, note: "a field a lease does not hold" },
    { ...valid, holder: "alpha" },
    { ...valid, expiresAt: at(0) },
    { ...valid, expiresAt: at(24 * 60, 1) },
    { ...valid, claimedAt: "yesterday" },
  ]) {
    await assert.rejects(() => setConfigRecord(f.root, { collection: "lease", key: f.ids.story, projectId: f.projectId, value, occurredAt: at(1) }), (error) => {
      assert.equal(error.reasonCode, "CONFIG_RECORD_VALUE_INVALID", JSON.stringify(value));
      assert.equal(error.details.refusedBy, "WORK_LEASE_INVALID");
      return true;
    });
  }
  await assert.rejects(() => setConfigRecord(f.root, { collection: "lease", key: "links", projectId: f.projectId, value: valid, occurredAt: at(1) }), { reasonCode: "CONFIG_RECORD_VALUE_INVALID" });
  await assert.rejects(() => setConfigRecord(f.root, { collection: "lease", key: f.ids.story, value: valid, occurredAt: at(1) }), { reasonCode: "CONFIG_RECORD_VALUE_INVALID" }, "a lease is project scoped");

  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(2) });
  await forgeOwnStream(f.root, (events) => [
    ...events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload, clock: event.clock })),
    { occurredAt: at(3), payload: { operation: "config.record.set", record: { collection: "lease", key: f.ids.sibling, value: valid } } },
    { occurredAt: at(3), payload: { operation: "config.record.set", record: { collection: "lease", key: f.ids.subtask, projectId: f.projectId, value: { ...valid, expiresAt: at(0) } } } },
  ]);
  const state = await materializeWorkspace(f.root);
  assert.deepEqual(leaseRecords(state).map((record) => record.key), [f.ids.story], "the refused events leave the leases as they were");
  assert.deepEqual(state.library.rejectedEvents.map((entry) => [entry.recordId, entry.reasonCode, entry.detail.split(":")[0]]), [
    [f.ids.sibling, "WORKSPACE_EVENT_CORRUPT", "CONFIG_RECORD_EVENT_INVALID"],
    [f.ids.subtask, "WORKSPACE_EVENT_CORRUPT", "CONFIG_RECORD_VALUE_INVALID"],
  ]);
});

test("528 SUB-456: config/project.json leaves leases out, so a claim and a release leave its bytes as they were", async (context) => {
  const f = await library(context, "LEASE-PROJECTION");
  const claimedOnly = await claimWork(f.root, { id: f.ids.sibling, actorId: A, occurredAt: at(0) });
  assert.equal(await configProjectionStatus(f.root, claimedOnly.settings, claimedOnly.configRecords), "current", "a library whose only records are leases has nothing to project");
  await releaseWork(f.root, { id: f.ids.sibling, actorId: A, occurredAt: at(1) });

  const variable = { type: "string", value: "tokens", description: "" };
  await setConfigRecord(f.root, { collection: "variable", key: "design", projectId: f.projectId, value: variable, occurredAt: at(2) });
  const path = projectConfigPath(f.root);
  const before = await readFile(path, "utf8");
  const claimed = await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(3) });
  assert.equal(await readFile(path, "utf8"), before, "a claim writes no projection");
  assert.equal(await configProjectionStatus(f.root, claimed.settings, claimed.configRecords), "current", "and the projection still matches the records it shows");

  // A projection written while the lease is held shows the same records as one written without it.
  await setConfigRecord(f.root, { collection: "variable", key: "design", projectId: f.projectId, value: variable, occurredAt: at(4) });
  const during = await readFile(path, "utf8");
  const { versionVector: _before, ...shownBefore } = JSON.parse(before);
  const { versionVector: _during, ...shownDuring } = JSON.parse(during);
  assert.deepEqual(shownDuring, shownBefore);
  assert.equal(during.includes("\"lease\""), false, "no lease in the projection");
  const released = await releaseWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(5) });
  assert.equal(await readFile(path, "utf8"), during, "a release writes no projection either");
  assert.equal(await configProjectionStatus(f.root, released.settings, released.configRecords), "current");
});

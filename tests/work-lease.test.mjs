// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-528 (MIN-256): work leases. SUB-456: a lease is a record of the library's lease
// collection, keyed by the work item's id and scoped to its project; a claim by the holder renews
// it, a claim is refused while another actor's unexpired lease binds the item, an item above it or
// an item below it, and whether a lease runs is judged against the write's --at. The holder releases
// at any time, another actor needs force while it runs, and config/project.json never shows one.
// SUB-457: a transition or an annotation under another actor's unexpired lease -- on the item or
// above it -- is refused with WORK_LEASED naming the holder and when the lease runs out.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  annotateWork,
  configProjectionStatus,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  transitionWork,
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
import { A, B, at, leaseLibrary as library, leaseRecords } from "./helpers/work-lease-fixture.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));

/** Assert that `operation` is refused with WORK_LEASED naming A's lease on `leasedWorkId`, running until `expiresAt`. */
async function refusedAsLeased(operation, { leasedWorkId, holder = A, expiresAt = at(120) }) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.reasonCode, "WORK_LEASED", error.message);
    assert.deepEqual({ holder: error.details.holder, expiresAt: error.details.expiresAt, leasedWorkId: error.details.leasedWorkId }, { holder, expiresAt, leasedWorkId });
    return true;
  });
}

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

test("528 SUB-457 GWT1, GWT2: under A's lease B's transition is refused with the holder and expiresAt, and A's own goes through", async (context) => {
  const f = await library(context, "LEASE-TRANSITION");
  await claimWork(f.root, { id: f.ids.story, actorId: A, ttl: "2h", occurredAt: at(0) });
  const before = await materializeWorkspace(f.root);
  await refusedAsLeased(() => transitionWork(f.root, { id: f.ids.story, status: "ready", actorId: B, occurredAt: at(1) }), { leasedWorkId: f.ids.story });
  await refusedAsLeased(() => transitionWork(f.root, { id: f.ids.story, status: "ready", occurredAt: at(2) }), { leasedWorkId: f.ids.story });
  await refusedAsLeased(() => transitionWork(f.root, { id: f.ids.subtask, status: "ready", actorId: B, occurredAt: at(3) }), { leasedWorkId: f.ids.story });
  const after = await materializeWorkspace(f.root);
  assert.equal(after.version, before.version, "a refused write writes nothing");
  assert.equal(after.headEventHash, before.headEventHash);

  const moved = await transitionWork(f.root, { id: f.ids.story, status: "ready", actorId: A, occurredAt: at(4) });
  assert.equal(moved.work.find((record) => record.id === f.ids.story).status, "ready", "the holder writes");
  assert.deepEqual(workLease(moved, f.ids.story), { workId: f.ids.story, holder: A, claimedAt: at(0), expiresAt: at(120) }, "and the write leaves the lease as it was");
  const epic = await transitionWork(f.root, { id: f.ids.epic, status: "blocked", actorId: B, occurredAt: at(5) });
  assert.equal(epic.work.find((record) => record.id === f.ids.epic).status, "blocked", "a lease below an item does not hold the item");
  const later = await transitionWork(f.root, { id: f.ids.story, status: "active", actorId: B, occurredAt: at(120) });
  assert.equal(later.work.find((record) => record.id === f.ids.story).status, "active", "once the lease has run out by the write's --at, another actor writes");
});

test("528 SUB-457 GWT4: under A's lease on an Epic, B's annotation of a Story below it is refused", async (context) => {
  const f = await library(context, "LEASE-ANNOTATE");
  await claimWork(f.root, { id: f.ids.epic, actorId: A, occurredAt: at(0) });
  await refusedAsLeased(() => annotateWork(f.root, { id: f.ids.story, summary: "B was here", actorId: B, occurredAt: at(1) }), { leasedWorkId: f.ids.epic });
  await refusedAsLeased(() => annotateWork(f.root, { id: f.ids.subtask, summary: "B was here", actorId: B, occurredAt: at(2) }), { leasedWorkId: f.ids.epic });
  await refusedAsLeased(() => annotateWork(f.root, { id: f.ids.sibling, summary: "nobody was here", occurredAt: at(3) }), { leasedWorkId: f.ids.epic });
  const annotated = await annotateWork(f.root, { id: f.ids.story, summary: "A was here", actorId: A, occurredAt: at(4) });
  assert.equal(annotated.work.find((record) => record.id === f.ids.story).summary, "A was here");
  const above = await annotateWork(f.root, { id: f.ids.initiative, summary: "B above the lease", actorId: B, occurredAt: at(5) });
  assert.equal(above.work.find((record) => record.id === f.ids.initiative).summary, "B above the lease");
});

test("528 SUB-457 GWT6: without a lease a transition and an annotation write what they wrote before", async (context) => {
  const f = await library(context, "LEASE-NONE");
  const before = await materializeWorkspace(f.root);
  await transitionWork(f.root, { id: f.ids.story, status: "ready", actorId: B, occurredAt: at(1) });
  await annotateWork(f.root, { id: f.ids.story, summary: "no lease", occurredAt: at(2) });
  const after = await materializeWorkspace(f.root);
  const appended = after.events.slice(before.events.length).map((event) => event.payload);
  assert.deepEqual(appended.map((payload) => [payload.operation, Object.keys(payload).sort().join(",")]), [
    ["work.updated", "operation,record"],
    ["work.annotated", "operation,record"],
  ], "the same events, nothing added for leases");
  assert.deepEqual(leaseRecords(after), []);
  assert.deepEqual(await materializeWorkspaceFromGenesis(f.root), after);

  // A lease that has run out is no lease.
  await claimWork(f.root, { id: f.ids.sibling, actorId: A, ttl: "1m", occurredAt: at(3) });
  const moved = await transitionWork(f.root, { id: f.ids.sibling, status: "ready", actorId: B, occurredAt: at(4) });
  assert.equal(moved.work.find((record) => record.id === f.ids.sibling).status, "ready");
});

test("528 SUB-457: the CLI prints the holder, expiresAt and leased item of a refused work-transition and work-annotate", async (context) => {
  const f = await library(context, "LEASE-CLI-OUT");
  await claimWork(f.root, { id: f.ids.epic, actorId: A, occurredAt: at(0) });
  for (const args of [
    ["work-transition", "--workspace", f.root, "--at", at(1), "--id", f.ids.story, "--status", "ready", "--actor", B],
    ["work-annotate", "--workspace", f.root, "--at", at(2), "--id", f.ids.story, "--summary", "B was here", "--actor", B],
    ["work-annotate", "--workspace", f.root, "--at", at(3), "--id", f.ids.story, "--summary", "nobody was here"],
  ]) {
    const failure = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8" }).then(() => null, (error) => error);
    assert.notEqual(failure, null, `${args.join(" ")} is refused`);
    const output = JSON.parse(failure.stderr.trim().split("\n").at(-1));
    assert.deepEqual(
      { ok: output.ok, reasonCode: output.reasonCode, workId: output.workId, holder: output.holder, expiresAt: output.expiresAt, leasedWorkId: output.leasedWorkId },
      { ok: false, reasonCode: "WORK_LEASED", workId: f.ids.story, holder: A, expiresAt: at(120), leasedWorkId: f.ids.epic },
    );
  }
});

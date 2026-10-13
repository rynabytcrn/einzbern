// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-458): work-claim and work-release, and the lease that
// work-show and work-list show. GWT1 to GWT4 through the CLI, the CLI part of GWT5, the catalog
// entries, and --force for Atelier only (MODEL_WRITE_REFUSED otherwise; MIN-256 R1 Q7).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";
import { A, B, leaseLibrary } from "./helpers/work-lease-fixture.mjs";

// work-show and work-list judge whether a lease runs by this machine's clock as they read
// (MIN-256 R1 Q6), so these instants are taken from it: at(0) is this test run's present second.
const base = Math.floor(Date.now() / 1000) * 1000;
const at = (minutes = 0, seconds = 0) => new Date(base + minutes * 60_000 + seconds * 1000).toISOString().replace(".000Z", "Z");

async function run(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(argv) {
  try {
    await run(argv);
  } catch (error) {
    return error;
  }
  throw new Error(`${argv.join(" ")} was expected to be refused`);
}

const leasedBy = (error) => ({ reasonCode: error.reasonCode, holder: error.details?.holder, expiresAt: error.details?.expiresAt, leasedWorkId: error.details?.leasedWorkId });

test("528 SUB-458: work-claim and work-release are cataloged writes with their flags, and --help answers for them", async () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => Object.fromEntries(entry(name).flags.map((flag) => [flag.name, [flag.required, flag.valueKind]]));
  assert.deepEqual(flags("work-claim"), { workspace: [false, "string"], at: [true, "instant"], id: [true, "string"], actor: [true, "string"], ttl: [false, "string"] });
  assert.deepEqual(flags("work-release"), { workspace: [false, "string"], at: [true, "instant"], id: [true, "string"], actor: [true, "string"], force: [false, "boolean"] });
  for (const name of ["work-claim", "work-release"]) {
    assert.equal(entry(name).mutates, true, `${name} writes`);
    assert.equal(entry(name).availability, "cli");
    const help = await run([name, "--help"]);
    assert.deepEqual(help.commands.map((command) => command.name), [name]);
    assert.equal((await refusal([name])).reasonCode, "CLI_ARGUMENT_MISSING");
  }
});

test("528 SUB-458 GWT1 to GWT3 through the CLI: B's transition and claim are refused under A's lease, A's go through, and B claims once it has run out", async (context) => {
  const f = await leaseLibrary(context, "LEASE-CLI", at);
  const ws = ["--workspace", f.root];
  const claimed = await run(["work-claim", ...ws, "--at", at(0), "--id", f.ids.story, "--actor", A, "--ttl", "2h"]);
  assert.equal(claimed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(claimed.record.id, f.ids.story);
  assert.deepEqual(claimed.lease, { holder: A, claimedAt: at(0), expiresAt: at(120), active: true });

  const expected = { reasonCode: "WORK_LEASED", holder: A, expiresAt: at(120), leasedWorkId: f.ids.story };
  assert.deepEqual(leasedBy(await refusal(["work-transition", ...ws, "--at", at(1), "--id", f.ids.story, "--status", "ready", "--actor", B])), expected);
  assert.deepEqual(leasedBy(await refusal(["work-transition", ...ws, "--at", at(1), "--id", f.ids.story, "--status", "ready"])), expected, "a write that names no actor is another actor's");
  assert.deepEqual(leasedBy(await refusal(["work-claim", ...ws, "--at", at(2), "--id", f.ids.subtask, "--actor", B])), expected);

  const moved = await run(["work-transition", ...ws, "--at", at(3), "--id", f.ids.story, "--status", "ready", "--actor", A]);
  assert.equal(moved.record.status, "ready", "the holder's own transition goes through");
  const renewed = await run(["work-claim", ...ws, "--at", at(4), "--id", f.ids.story, "--actor", A, "--ttl", "90m"]);
  assert.deepEqual(renewed.lease, { holder: A, claimedAt: at(4), expiresAt: at(94), active: true }, "the holder's claim renews the lease");

  const taken = await run(["work-claim", ...ws, "--at", at(94), "--id", f.ids.story, "--actor", B, "--ttl", "30m"]);
  assert.deepEqual(taken.lease, { holder: B, claimedAt: at(94), expiresAt: at(124), active: true }, "once the lease has run out by --at, B claims");
  assert.equal((await refusal(["work-claim", ...ws, "--at", at(95), "--id", f.ids.sibling, "--actor", A, "--ttl", "3d"])).reasonCode, "WORK_LEASE_TTL_INVALID");
  assert.equal((await refusal(["work-claim", ...ws, "--at", at(95), "--id", f.ids.sibling, "--actor", "alpha"])).reasonCode, "ACTOR_ID_INVALID");
});

test("528 SUB-458 GWT4 and GWT5 through the CLI: an Epic's lease holds the Stories below it, and work-show and work-list show each record's lease", async (context) => {
  const f = await leaseLibrary(context, "LEASE-CLI-SHOW", at);
  const ws = ["--workspace", f.root];
  await run(["work-claim", ...ws, "--at", at(0), "--id", f.ids.epic, "--actor", A]);
  assert.deepEqual(leasedBy(await refusal(["work-annotate", ...ws, "--at", at(1), "--id", f.ids.story, "--summary", "B was here", "--actor", B])), {
    reasonCode: "WORK_LEASED", holder: A, expiresAt: at(120), leasedWorkId: f.ids.epic,
  });
  // A lease that ran out before this read shows as not active.
  await run(["work-claim", ...ws, "--at", at(-180), "--id", f.ids.sibling, "--actor", A, "--ttl", "1h"]);

  const epic = await run(["work-show", ...ws, "--id", f.ids.epic]);
  assert.deepEqual(epic.lease, { holder: A, claimedAt: at(0), expiresAt: at(120), active: true });
  assert.deepEqual((await run(["work-show", ...ws, "--id", f.ids.sibling])).lease, { holder: A, claimedAt: at(-180), expiresAt: at(-120), active: false });
  assert.equal((await run(["work-show", ...ws, "--id", f.ids.story])).lease, null, "a record below a lease holds none of its own");

  const listed = await run(["work-list", ...ws]);
  assert.equal(listed.records.every((record) => Object.hasOwn(record, "lease")), true, "every record carries lease");
  assert.deepEqual(Object.fromEntries(listed.records.map((record) => [record.id, record.lease === null ? null : [record.lease.holder, record.lease.active]])), {
    [f.ids.initiative]: null,
    [f.ids.epic]: [A, true],
    [f.ids.story]: null,
    [f.ids.sibling]: [A, false],
    [f.ids.subtask]: null,
  });
  const searched = await run(["work-list", ...ws, "--search", "LEASE-CLI-SHOW-EPIC"]);
  assert.deepEqual(searched.records.map((record) => [record.id, record.lease?.holder ?? null]), [[f.ids.epic, A]]);
});

test("528 SUB-458: work-release frees the holder's lease, needs --force for another actor's, and --force runs for Atelier only", async (context) => {
  const f = await leaseLibrary(context, "LEASE-CLI-RELEASE", at);
  const ws = ["--workspace", f.root];
  await run(["work-claim", ...ws, "--at", at(0), "--id", f.ids.epic, "--actor", A]);
  const version = (await run(["work-show", ...ws, "--id", f.ids.epic])).version;

  await withSurface(undefined, async () => {
    assert.deepEqual(leasedBy(await refusal(["work-release", ...ws, "--at", at(1), "--id", f.ids.epic, "--actor", B])), {
      reasonCode: "WORK_LEASED", holder: A, expiresAt: at(120), leasedWorkId: f.ids.epic,
    });
    const forcedByModel = await refusal(["work-release", ...ws, "--at", at(2), "--id", f.ids.epic, "--actor", B, "--force", "true"]);
    assert.equal(forcedByModel.reasonCode, "MODEL_WRITE_REFUSED");
    assert.deepEqual(forcedByModel.details, { workId: f.ids.epic, remedy: "change it in Atelier" });
    assert.equal((await refusal(["work-release", ...ws, "--at", at(2), "--id", f.ids.epic, "--actor", B, "--force", "yes"])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  });
  assert.equal((await run(["work-show", ...ws, "--id", f.ids.epic])).version, version, "the refusals wrote nothing");

  const forced = await withSurface(ATELIER_SURFACE, () => run(["work-release", ...ws, "--at", at(3), "--id", f.ids.epic, "--actor", "agent:test-portal", "--force", "true"]));
  assert.equal(forced.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(forced.record.id, f.ids.epic);
  assert.equal(forced.lease, null);
  assert.equal((await run(["work-show", ...ws, "--id", f.ids.epic])).lease, null, "after a forced release work-show shows no lease");

  await run(["work-claim", ...ws, "--at", at(4), "--id", f.ids.story, "--actor", A]);
  const own = await withSurface(undefined, () => run(["work-release", ...ws, "--at", at(5), "--id", f.ids.story, "--actor", A]));
  assert.equal(own.lease, null, "the holder releases without --force");
  assert.equal((await refusal(["work-release", ...ws, "--at", at(6), "--id", f.ids.story, "--actor", A])).reasonCode, "WORK_LEASE_NOT_FOUND");
});

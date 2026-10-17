// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-300, slice 3. Recording N facts costs one act.
//
// Measured on the same machine, same records: forty single verbs take 1,651 ms with forty
// leases and forty CAS decisions; one batch of forty takes 51 ms with one of each. That
// ratio is the ceremony this platform's own audit called backwards, and filing four
// knowledge cards on 2026-08-19 paid sixteen round trips for it.
//
// The criteria below are mostly not about speed. They are about the two things a batch can
// get wrong in ways a fast implementation would hide: writing part of itself, and blaming
// the wrong member.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyWorkBatch,
  createProject,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second = 0) => `2026-08-19T18:00:${String(second).padStart(2, "0")}Z`;

const STORY_SCOPE = [
  "## Goal",
  "为谁:the operator. 目的锚:STORY-300. 符合性判据:one batch, one receipt. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 the batch primitive.",
  "", "## Acceptance Criteria", "GIVEN a batch WHEN it runs THEN all members land or none do",
  "", "## Business Background", "实测 sixteen round trips for four cards.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- Record several facts as one act.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the batch primitive.",
].join("\n");

async function workspace(key) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300b-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: at(0) });
  const root = join(base, "workspace");
  let state = await createProject(root, { occurredAt: at(1), externalKey: `${key}-P`, name: key });
  return { base, root, projectId: state.projects[0].id, version: state.version };
}

const apply = async (fixture, members, second = 2) => {
  return await applyWorkBatch(fixture.root, { schemaVersion: "tcrn.work-batch.v1", members }, {
    occurredAt: at(second),
  });
};

const refusal = async (fixture, members, second = 2) => {
  try {
    await apply(fixture, members, second);
    return null;
  } catch (error) {
    return { reasonCode: error?.reasonCode, payload: JSON.parse(error.message) };
  }
};

// Red leg: drop the accumulated-state threading from transitionWork's admission and
// member 2 reads a workspace where member 1's record does not exist -- failing
// indistinguishably from the record genuinely not existing, which is the state this slice
// was blocked on. Two levels of parent reference, because a Story must hang under a parent
// and without parentExternalKey the commonest batch there is cannot be expressed.
test("STORY-300: heterogeneous members act on what earlier members created, by external key", async () => {
  const fixture = await workspace("BATCH-OK");
  try {
    const state = await apply(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INIT-1", kind: "Initiative", parentId: null, status: "active", title: "B-INIT-1" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-EPIC-1", kind: "Epic", parentExternalKey: "B-INIT-1", status: "active", title: "B-EPIC-1" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-STORY-1", kind: "Story", parentExternalKey: "B-EPIC-1", status: "planned", scope: STORY_SCOPE, title: "B-STORY-1" },
      { verb: "work-transition", externalKey: "B-STORY-1", status: "ready" },
      { verb: "work-annotate", externalKey: "B-STORY-1", scope: `${STORY_SCOPE}\n\n附注:batched.` },
    ]);
    assert.equal(state.version, fixture.version + 5, "five members, five events, one act");
    const story = state.work.find((record) => record.id === deriveStableId("work", "B-STORY-1"));
    assert.equal(story.status, "ready", "the transition saw the record its predecessor created");
    assert.equal(story.revision, 3, "created, transitioned and annotated within the batch");
    assert.equal(story.parentId, deriveStableId("work", "B-EPIC-1"), "and the parent reference resolved by key");
    assert.deepEqual(await materializeWorkspaceFromGenesis(fixture.root), state, "the public genesis replay matches the live materialization");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: let appendEvents write what it has when a later member throws, and a batch
// leaves a partial subtree on an append-only chain -- which cannot be taken back.
test("STORY-300: a member failing mid-batch leaves the chain exactly where it was", async () => {
  const fixture = await workspace("BATCH-ATOMIC");
  try {
    const before = await materializeWorkspace(fixture.root);
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-9", kind: "Initiative", parentId: null, status: "planned", title: "B-INC-9" },
      { verb: "work-transition", externalKey: "B-INC-9", status: "done" },
      { verb: "work-annotate", externalKey: "B-INC-9", scope: "never reached" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    const after = await materializeWorkspace(fixture.root);
    assert.equal(after.version, before.version, "nothing was written");
    assert.equal(after.headEventHash, before.headEventHash, "and the head did not move");
    assert.equal(after.work.length, before.work.length);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The distinction the acceptance criterion asks for, and it must be structural rather
// than a difference in wording. Red leg: report every member after the failure as failed
// and three members are called invalid when one was judged and two were never looked at.
test("STORY-300: the member that failed is named with its rule; the rest are unevaluated, not invalid", async () => {
  const fixture = await workspace("BATCH-BLAME");
  try {
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-8", kind: "Initiative", parentId: null, status: "planned", title: "B-INC-8" },
      { verb: "work-transition", externalKey: "B-INC-8", status: "done" },
      { verb: "work-annotate", externalKey: "B-INC-8", scope: "never reached" },
      { verb: "work-annotate", externalKey: "B-INC-8", scope: "also never reached" },
    ]);
    assert.equal(result.payload.stage, "apply");
    assert.equal(result.payload.failed.index, 1);
    assert.equal(result.payload.failed.verb, "work-transition");
    // The member's OWN reason code, not a generic one. It was being swallowed by an
    // instanceof check that does not hold across separately built module graphs, which
    // turned every member failure into WORKSPACE_ERROR.
    assert.equal(result.payload.failed.reasonCode, "INVALID_TRANSITION");
    assert.equal(result.payload.failed.detail, "planned:done");
    assert.deepEqual(result.payload.notEvaluated, [2, 3], "the members after it were never judged");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Shape failures belong to the members that earned them, so every one is reported at once
// rather than one per round trip -- which is the ceremony this slice exists to remove,
// reappearing inside the refusal path. Red leg: return on the first shape problem.
test("STORY-300: every shape problem is reported together, before any state is consulted", async () => {
  const fixture = await workspace("BATCH-SHAPE");
  try {
    const result = await refusal(fixture, [
      { verb: "work-invent", id: "work:x" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-S-1", kind: "Nonsense", title: "B-S-1" },
      { verb: "work-transition", externalKey: "B-S-1", status: "sideways" },
      { verb: "work-annotate", externalKey: "B-S-1" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-S-2", kind: "Story", title: "B-S-2" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.stage, "shape", "no state was consulted");
    assert.deepEqual([...new Set(result.payload.problems.map((problem) => problem.index))], [0, 1, 2, 3, 4],
      "all five members are judged, not just the first to fail");
    const rules = new Set(result.payload.problems.map((problem) => problem.rule));
    for (const rule of ["verb-known", "kind-known", "status-known", "advisory-required", "story-fields-required"]) {
      assert.ok(rules.has(rule), `${rule} is reported`);
    }
    assert.equal(result.payload.notEvaluated, undefined, "nothing is consequential when nothing was applied");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: derive the reference from externalKey even when id is present, and an explicit
// id is silently replaced by a derivation that may name a different record entirely.
test("STORY-300: an explicit id wins over a derivable one", async () => {
  const fixture = await workspace("BATCH-REF");
  try {
    const state = await apply(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-7", kind: "Initiative", parentId: null, status: "planned", title: "B-INC-7" },
      // id names B-INC-7; externalKey names something that does not exist. If the key won,
      // this would fail -- so passing proves the id was used.
      { verb: "work-transition", id: deriveStableId("work", "B-INC-7"), externalKey: "B-ABSENT", status: "ready" },
    ]);
    const record = state.work.find((entry) => entry.id === deriveStableId("work", "B-INC-7"));
    assert.equal(record.status, "ready");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: accept an empty or foreign document and a caller gets a receipt for an act that
// never described anything.
test("STORY-300: a batch that is not a batch is refused before anything else happens", async () => {
  const fixture = await workspace("BATCH-DOC");
  try {
    for (const document of [null, [], { members: [] }, { schemaVersion: "tcrn.work-batch.v1" }, { schemaVersion: "other", members: [{}] }]) {
      await assert.rejects(
        () => applyWorkBatch(fixture.root, document, { occurredAt: at(2) }),
        (error) => error?.reasonCode === "WORK_BATCH_MALFORMED", JSON.stringify(document));
    }
    const nullFile = join(fixture.base, "null-batch.json");
    await writeFile(nullFile, "null\n");
    const before = await materializeWorkspace(fixture.root);
    await assert.rejects(runCli(["work-batch", "--workspace", fixture.root, "--at", at(2), "--from-file", nullFile], { write() { assert.fail("malformed batch must not emit a success receipt"); } }), { reasonCode: "WORK_BATCH_MALFORMED" });
    assert.equal((await materializeWorkspace(fixture.root)).headEventHash, before.headEventHash);
    // An empty members array is malformed rather than a no-op: a batch of nothing is a
    // caller mistake, and answering it with a receipt would say an act occurred.
    await assert.rejects(
      () => applyWorkBatch(fixture.root, { schemaVersion: "tcrn.work-batch.v1", members: [] }, { occurredAt: at(3) }),
      (error) => error?.reasonCode === "WORK_BATCH_MALFORMED");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The hazard a batch introduces is a crash between its writes. In a library a batch is one append
// to this device's stream, and the stream manifest is replaced only after every segment byte of
// the batch is durable, so a crash anywhere before that leaves the manifest of the chain before the
// batch: a legal prefix, never a torn batch. The next append cuts the dead writer's bytes off.
test("STORY-300: a batch spanning segments writes ascending, and every crash window is a legal prefix", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300seg-")));
  try {
    await initializeLibrary({ root: join(base, "workspace"), createdAt: at(0) });
    const root = join(base, "workspace");
    await setWorkspaceSetting(root, { key: "storage.segmentBytes", value: "4096", occurredAt: at(1) });
    const seeded = await createProject(root, { occurredAt: at(1), externalKey: "SEG-P", name: "Seg" });
    const stream = join(root, "akasha", (await readdir(join(root, "akasha")))[0]);
    const beforeBatch = await readFile(join(stream, "manifest.json"), "utf8");
    const members = Array.from({ length: 14 }, (_, index) => ({
      verb: "work-create", projectId: seeded.projects[0].id, externalKey: `SEG-${index}`,
      kind: "Initiative", parentId: null, status: "planned", title: `SEG-${index} ${"y".repeat(400)}`,
    }));
    const full = await applyWorkBatch(root, { schemaVersion: "tcrn.work-batch.v1", members }, {
      occurredAt: at(2),
    });
    const segments = JSON.parse(await readFile(join(stream, "manifest.json"), "utf8")).segments.map((segment) => segment.name);
    assert.ok(segments.length > 1, "the batch must actually span segments or this asserts nothing");
    assert.deepEqual(segments, [...segments].sort(), "segments are named in ascending order");
    assert.equal((await materializeWorkspace(root)).version, full.version, "the whole batch replays");

    // Every crash window before the commit point leaves the previous stream manifest in place, with
    // any number of the batch's bytes on disk after it: the chain reads as it was before the batch.
    await writeFile(join(stream, "manifest.json"), beforeBatch);
    const replayed = await materializeWorkspace(root);
    assert.equal(replayed.version, full.version - members.length, "the batch is absent as a whole, never in part");
    assert.equal(replayed.work.length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The attribution the batch reports comes from appendEvents, because it is the only thing
// that knows the index. Red leg: count completed closures from outside instead -- the
// counter advances after the closure returns, while actor injection and event
// construction run afterwards and throw too, so a failure there is blamed on the member
// after the one that caused it, a pre-loop failure blames member zero, and a last-member
// failure escapes unattributed.
test("STORY-300: the last member can fail, and it is attributed like any other", async () => {
  const fixture = await workspace("BATCH-LAST");
  try {
    const result = await refusal(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-6", kind: "Initiative", parentId: null, status: "planned", title: "B-INC-6" },
      { verb: "work-transition", externalKey: "B-INC-6", status: "ready" },
      { verb: "work-transition", externalKey: "B-INC-6", status: "planned" },
    ]);
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.failed.index, 2, "the last member is attributed, not swallowed");
    assert.equal(result.payload.failed.reasonCode, "INVALID_TRANSITION");
    assert.deepEqual(result.payload.notEvaluated, [], "nothing followed it");
    assert.equal(result.payload.failed.phase, "delta", "and the stage that refused it is named");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: attribute a pre-loop failure to a member and an unreadable clock value -- which no
// member caused -- is reported as member zero's fault. (The CAS mismatch this case used to
// provoke went with the expected-version input, TCRN-CROSS-STORY-467 R1.)
test("STORY-300: a failure before any member ran blames no member", async () => {
  const fixture = await workspace("BATCH-PRELOOP");
  try {
    await assert.rejects(
      () => applyWorkBatch(fixture.root, {
        schemaVersion: "tcrn.work-batch.v1",
        members: [{ verb: "work-create", projectId: fixture.projectId, externalKey: "B-INC-5", kind: "Initiative", parentId: null, status: "planned", title: "B-INC-5" }],
      }, { occurredAt: "2026-08-19 18:00:02" }),
      (error) => error?.reasonCode === "TIMESTAMP_INVALID" && error.memberIndex === undefined,
      "an unreadable instant is the batch's failure, not a member's",
    );
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// TCRN-CROSS-STORY-472 R4: the batch format carries a member's relations in one object,
// {blockedBy, implements, supersedes, fixes, decidedIn}, and a member may relate to what an
// earlier member created. Red leg: drop the relations from deltaFor and the stored extension is
// absent while the batch still reports success.
test("STORY-472: a work-create member carries relations, resolved against what earlier members created", async () => {
  const fixture = await workspace("BATCH-RELATIONS");
  try {
    const state = await apply(fixture, [
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-REL-1", kind: "Initiative", parentId: null, status: "active", title: "B-REL-1" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "B-REL-2", kind: "Initiative", parentId: null, status: "active", title: "B-REL-2",
        relations: { blockedBy: [deriveStableId("work", "B-REL-1")], decidedIn: ["minutes:c8953141f2d862c26ff3db46"] } },
    ]);
    const second = state.work.find((record) => record.id === deriveStableId("work", "B-REL-2"));
    assert.deepEqual(second.extensions["advisory:relations"], { required: false, value: { blockedBy: [deriveStableId("work", "B-REL-1")] } });
    assert.deepEqual(second.extensions["advisory:decided-by"], { required: false, value: ["minutes:c8953141f2d862c26ff3db46"] });
    assert.deepEqual(await materializeWorkspaceFromGenesis(fixture.root), state, "the public genesis replay matches the live materialization");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});


test("batch carries involved-project state through ordered create and annotation", async context => {
  const f = await workspace("BATCH-PROJECTS");
  context.after(() => rm(f.base, { recursive: true, force: true }));
  const reference = { libraryId: "library:" + "a".repeat(24), projectId: "project:" + "b".repeat(24) };
  await apply(f, [
    { verb: "work-create", projectId: f.projectId, externalKey: "BATCH-PROJECTS-INIT", kind: "Initiative", title: "Projects", involvedProjects: { state: "undecided", targets: [] } },
    { verb: "work-annotate", externalKey: "BATCH-PROJECTS-INIT", expectedRevision: 1, involvedProjects: { state: "selected", targets: [reference, reference] } },
  ]);
  const state = await materializeWorkspaceFromGenesis(f.root);
  assert.deepEqual(state.work[0].involvedProjects, { state: "selected", targets: [reference] });
});

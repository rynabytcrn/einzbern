// SPDX-License-Identifier: Apache-2.0
// Ordinary sequential offline copies: new writes must not silently follow an old stream alias.
import { asPinnedDevice } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvents, appendToOwnStream, createLibrary, createProject, createWork, deleteProject, createWorkDelta, materializeLibrary,
  materializeWorkspaceFromGenesis, openLibrary, recoverWorkspace, streamDirectory, transitionWork, transitionWorkDelta, updateProject,
} from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const A = { deviceId: "a".repeat(32), displayName: "desk" };
const B = { deviceId: "b".repeat(32), displayName: "laptop" };
const originalId = deriveStableId("work", "KEYS-500");
const aliasId = deriveStableId("work", "KEYS-501");

test("post-merge write refuses an original ID redirected on this device before appending", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "einzbern-alias-write-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const desk = await createLibrary(join(base, "desk", ".ether"), { createdAt: "2026-09-26T00:00:00Z", projectName: "Merge" });
  let tick = 0;
  const at = () => new Date(Date.UTC(2026, 8, 26, 0, 0, ++tick)).toISOString();
  const write = async (library, device, build) => {
    const state = await materializeLibrary(library);
    const occurredAt = at();
    const delta = build(state, occurredAt);
    await appendToOwnStream(library, device, [{ occurredAt, payload: delta.payload }], { home: join(base, device.deviceId) });
  };
  const projectId = deriveStableId("project", "KEYS");
  await write(desk, A, (_state, occurredAt) => ({ payload: { operation: "project.created", record: {
    schemaVersion: "tcrn.project.v1", id: projectId, externalKey: "KEYS", name: "KEYS", revision: 1, updatedAt: occurredAt, tombstone: false,
  } } }));
  const laptopRoot = join(base, "laptop", ".ether");
  await cp(desk.root, laptopRoot, { recursive: true });
  const laptop = await openLibrary(laptopRoot);
  const create = (state, occurredAt) => createWorkDelta({ projectId, externalKey: "KEYS-500", kind: "Initiative", parentId: null, status: "planned", occurredAt })(state);
  await write(desk, A, create);
  await write(laptop, B, create);
  // Transfer only the desk stream after both independent creates have completed.
  await rm(streamDirectory(laptop.root, A.deviceId), { recursive: true, force: true });
  await cp(streamDirectory(desk.root, A.deviceId), streamDirectory(laptop.root, A.deviceId), { recursive: true });
  await asPinnedDevice(async () => {
    const before = await recoverWorkspace(laptop.root);
    assert.deepEqual((await materializeLibrary(laptop)).work, before.work, "snapshot-resumed state agrees before the write");
    assert.equal(before.library.aliases.length, 1);
    assert.equal(before.library.aliases[0].aliasId, aliasId);
    await assert.rejects(async () => {
      const returned = await transitionWork(laptop.root, { id: originalId, status: "ready", occurredAt: at() });
      const replayed = await materializeWorkspaceFromGenesis(laptop.root);
      const statuses = (state) => [originalId, aliasId].map((id) => ({ id, status: state.work.find((entry) => entry.id === id)?.status }));
      t.diagnostic(`Successful return: ${JSON.stringify(statuses(returned))}`);
      t.diagnostic(`Genesis replay: ${JSON.stringify(statuses(replayed))}`);
      t.diagnostic(`Replay rejection count: ${replayed.library.rejectedEvents.length}`);
    }, { reasonCode: "WORKSPACE_INPUT_INVALID" });
    await assert.rejects(createWork(laptop.root, { projectId, externalKey: "CHILD-1", kind: "Epic", parentId: originalId, status: "planned", occurredAt: at() }), (error) => {
      assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
      assert.equal(error.details.field, "parentId");
      return true;
    });
    const batchAt = at();
    await assert.rejects(appendEvents(laptop.root, [
      createWorkDelta({ projectId, externalKey: "BATCH-1", kind: "Initiative", parentId: null, status: "planned", occurredAt: batchAt }),
      transitionWorkDelta({ id: originalId, status: "ready", occurredAt: batchAt }),
    ], { occurredAt: batchAt }), (error) => {
      assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
      assert.equal(error.memberIndex, 1);
      assert.equal(error.memberPhase, "delta");
      return true;
    });
    const after = await materializeWorkspaceFromGenesis(laptop.root);
    assert.equal(after.headEventHash, before.headEventHash, "refusal appends no event");
    assert.deepEqual(after.work, before.work);
    assert.deepEqual(after.library.versionVector, before.library.versionVector);
    const aliasReturned = await transitionWork(laptop.root, { id: aliasId, status: "ready", occurredAt: at() });
    const aliasReplay = await materializeWorkspaceFromGenesis(laptop.root);
    assert.deepEqual(aliasReturned.work, aliasReplay.work, "explicit alias writes retain their target on replay");
    assert.equal(aliasReplay.work.find((entry) => entry.id === originalId).status, "planned");
    assert.equal(aliasReplay.work.find((entry) => entry.id === aliasId).status, "ready");
    assert.deepEqual((await materializeLibrary(laptop)).work, aliasReplay.work);

  }, B.deviceId);
  await asPinnedDevice(async () => {
    const returned = await transitionWork(laptop.root, { id: originalId, status: "ready", occurredAt: at() });
    const replayed = await materializeWorkspaceFromGenesis(laptop.root);
    assert.deepEqual(returned.work, replayed.work, "winner stream still writes the original key");
    assert.equal(replayed.work.find((entry) => entry.id === originalId).status, "ready");
    assert.equal(replayed.library.rejectedEvents.length, 0);
  }, A.deviceId);
});

test("post-merge work creation refuses a project ID redirected on its own stream", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "einzbern-project-alias-write-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const desk = await createLibrary(join(base, "desk", ".ether"), { createdAt: "2026-09-26T00:00:00Z", projectName: "Merge" });
  const laptopRoot = join(base, "laptop", ".ether");
  await cp(desk.root, laptopRoot, { recursive: true });
  const laptop = await openLibrary(laptopRoot);
  const projectId = deriveStableId("project", "PROJECT-1");
  const occurredAt = "2026-09-26T00:00:01Z";
  const payload = { operation: "project.created", record: {
    schemaVersion: "tcrn.project.v1", id: projectId, externalKey: "PROJECT-1", name: "Project", revision: 1, updatedAt: occurredAt, tombstone: false,
  } };
  await appendToOwnStream(desk, A, [{ occurredAt, payload }], { home: join(base, "home-a") });
  await appendToOwnStream(laptop, B, [{ occurredAt, payload }], { home: join(base, "home-b") });
  await cp(streamDirectory(desk.root, A.deviceId), streamDirectory(laptop.root, A.deviceId), { recursive: true });
  await asPinnedDevice(async () => {
    const before = await materializeLibrary(laptop);
    const alias = before.library.aliases[0];
    assert.equal(alias.id, projectId);
    await assert.rejects(updateProject(laptop.root, { id: projectId, name: "New name", occurredAt: "2026-09-26T00:00:02Z" }), (error) => {
      assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
      assert.equal(error.details.field, "id");
      return true;
    });
    const input = { projectId, externalKey: "WORK-1", kind: "Initiative", parentId: null, status: "planned", occurredAt: "2026-09-26T00:00:02Z" };
    await assert.rejects(createWork(laptop.root, input), (error) => {
      assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
      assert.equal(error.details.field, "projectId");
      assert.equal(error.details.aliasId, alias.aliasId);
      return true;
    });
    assert.equal((await materializeWorkspaceFromGenesis(laptop.root)).headEventHash, before.headEventHash);
    const returned = await createWork(laptop.root, { ...input, projectId: alias.aliasId });
    const replayed = await materializeWorkspaceFromGenesis(laptop.root);
    assert.deepEqual(returned.work, replayed.work);
    assert.equal(replayed.work[0].projectId, alias.aliasId);
  }, B.deviceId);
});

test("rejected offline colliding create still guards its unpublished stream redirect", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "einzbern-rejected-alias-write-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const desk = await createLibrary(join(base, "desk", ".ether"), { createdAt: "2026-09-26T00:00:00Z", projectName: "Merge" });
  let tick = 0;
  const at = () => new Date(Date.UTC(2026, 8, 26, 0, 0, ++tick)).toISOString();
  const retiredProject = deriveStableId("project", "RETIRED");
  const retainedProject = deriveStableId("project", "RETAINED");
  await asPinnedDevice(async () => {
    await createProject(desk.root, { externalKey: "RETIRED", name: "Retired", occurredAt: at() });
    await createProject(desk.root, { externalKey: "RETAINED", name: "Retained", occurredAt: at() });
  }, A.deviceId);
  const laptopRoot = join(base, "laptop", ".ether");
  await cp(desk.root, laptopRoot, { recursive: true });
  const laptop = await openLibrary(laptopRoot);
  const create = (root, projectId, externalKey) => createWork(root, { projectId, externalKey, kind: "Initiative", parentId: null, status: "planned", occurredAt: at() });
  await asPinnedDevice(async () => {
    await create(desk.root, retainedProject, "KEYS-500");
    await deleteProject(desk.root, { id: retiredProject, occurredAt: at() });
  }, A.deviceId);
  await asPinnedDevice(async () => {
    // Both intervening writes are valid offline and place the colliding create after the
    // other device's project deletion in deterministic merge order, without any races.
    await create(laptop.root, retainedProject, "FILLER-1");
    await create(laptop.root, retainedProject, "FILLER-2");
    await create(laptop.root, retiredProject, "KEYS-500");
  }, B.deviceId);
  await rm(streamDirectory(laptop.root, A.deviceId), { recursive: true, force: true });
  await cp(streamDirectory(desk.root, A.deviceId), streamDirectory(laptop.root, A.deviceId), { recursive: true });
  await asPinnedDevice(async () => {
    const before = await recoverWorkspace(laptop.root);
    assert.equal(before.library.aliases.length, 0, "rejected creates do not publish an alias");
    assert.equal(before.library.rejectedEvents.length, 1);
    assert.equal(before.library.rejectedEvents[0].operation, "work.created");
    assert.equal(before.library.rejectedEvents[0].deviceId, B.deviceId);
    assert.equal(before.work.find((entry) => entry.id === originalId).projectId, retainedProject);
    assert.ok(!before.work.some((entry) => entry.id === aliasId));
    await assert.rejects(transitionWork(laptop.root, { id: originalId, status: "ready", occurredAt: at() }), (error) => {
      assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
      assert.equal(error.details.field, "id");
      assert.equal(error.details.aliasId, aliasId);
      return true;
    });
    const replayed = await materializeWorkspaceFromGenesis(laptop.root);
    assert.equal(replayed.headEventHash, before.headEventHash);
    assert.deepEqual(replayed.work, before.work);
    assert.deepEqual(replayed.library.versionVector, before.library.versionVector);
  }, B.deviceId);
});

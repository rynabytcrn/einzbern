// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  FILE_LOCK_SCHEMA_VERSION,
  WORKSPACE_WRITE_LOCK_FILE,
  WorkspaceError,
  applyWorkspaceMigration,
  assertSupportedWorkspaceFilesystem,
  assertWorkspaceRecordCount,
  assertWorkspaceRelativePath,
  createProject,
  createWorkspaceArchive,
  createWork,
  deleteProject,
  deleteWork,
  exportWorkspace,
  initializeWorkspace,
  materializeWorkspace,
  planWorkspaceMigration,
  recoverWorkspace,
  transitionWork,
  updateProject,
  validateWorkspace,
  LEGACY_CONTROL_DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import * as publicCore from "../dist/build/packages/core/src/index.js";
import { appendHistoricalAttestationEnable } from "./helpers/workspace-fixture.mjs";
import {
  canonicalJson,
  canonicalSha256,
  createEvent,
  deriveStableId,
  PROTOCOL_LIMITS,
  ProtocolError,
} from "../dist/build/packages/protocol/src/index.js";

const STORY_SCOPE = [
  "【Goal】为谁改变什么=engine fixture；目的锚=STORY-209；符合性判据=命令可复跑；判定人=Owner。",
  "【Requirements】现象与证据=fixture 命令；修复项=实现 fixture。",
  "【Acceptance Criteria】GIVEN fixture WHEN 执行 THEN 通过。",
  "【Business Background】证据=测试需要真实 Story。",
  "【Preconditions】无——原因：测试已初始化工作区。",
  "【Assumptions】无——原因：不改变协议。",
  "【Use Cases & Examples】无——原因：只覆盖引擎。",
  "【Feature Toggle & Setting】无——原因：无运行时开关。",
  "【Permissions】测试执行方。",
  "【Implementation Notes】决策点及裁定状态=fixture planned。",
].join("\n");

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;

async function workspaceFixture(options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p3-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({
    roots,
    externalKey: options.externalKey ?? "WORKSPACE-ALPHA",
    createdAt: instant(0),
    segmentEventLimit: options.segmentEventLimit ?? 2,
  });
  return {
    base,
    roots,
    workspace,
    state,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function expectedStreamId(metadata) {
  return `stream:${canonicalSha256({
    schemaVersion: "tcrn.workspace-stream-identity.v1",
    workspaceId: metadata.workspaceId,
    createdAt: metadata.createdAt,
  }).slice(0, 24)}`;
}

function expectedEventId(streamId, sequence) {
  return `event:${canonicalSha256({
    schemaVersion: "tcrn.workspace-event-identity.v1",
    streamId,
    sequence,
  }).slice(0, 24)}`;
}

async function rewriteEventChain(workspace, transform, identity = {}) {
  const control = join(workspace, LEGACY_CONTROL_DIRECTORY);
  const metadata = JSON.parse(await readFile(join(control, "workspace.json"), "utf8"));
  const eventsRoot = join(control, "events");
  const names = (await readdir(eventsRoot)).filter((name) => /^\d{6}\.json$/u.test(name)).sort();
  const original = [];
  for (const name of names) {
    original.push(...JSON.parse(await readFile(join(eventsRoot, name), "utf8")));
  }
  const specifications = transform(structuredClone(original));
  const streamId = identity.streamId ?? expectedStreamId(metadata);
  const rebuilt = [];
  for (const [index, specification] of specifications.entries()) {
    const sequence = index + 1;
    rebuilt.push(createEvent({
      id: identity.eventIdFor?.(streamId, sequence) ?? expectedEventId(streamId, sequence),
      streamId,
      sequence,
      occurredAt: specification.occurredAt,
      priorHash: rebuilt.at(-1)?.eventHash ?? null,
      payload: specification.payload,
    }));
  }
  for (const name of names) {
    await rm(join(eventsRoot, name));
  }
  for (let offset = 0; offset < rebuilt.length; offset += metadata.segmentEventLimit) {
    const segment = rebuilt.slice(offset, offset + metadata.segmentEventLimit);
    const index = Math.floor(offset / metadata.segmentEventLimit) + 1;
    await writeFile(join(eventsRoot, `${String(index).padStart(6, "0")}.json`), canonicalJson(segment));
  }
  return rebuilt;
}

async function createProjectHistory(fixture, update = false, remove = false) {
  let state = await createProject(fixture.workspace, {
    occurredAt: instant(1), externalKey: "PROJECT-FORGED", name: "Forged",
  });
  if (update) {
    state = await updateProject(fixture.workspace, {
      occurredAt: instant(2), id: state.projects[0].id, name: "Updated",
    });
  }
  if (remove) {
    state = await deleteProject(fixture.workspace, {
      occurredAt: instant(2), id: state.projects[0].id,
    });
  }
  return state;
}

function expectReason(reasonCode, operation) {
  assert.throws(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

async function expectReasonAsync(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

test("Workspace metadata schema, five-root initialization, CLI readback, and standalone boundary are exact", async () => {
  const fixture = await workspaceFixture();
  try {
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-v1.schema.json", import.meta.url), "utf8"));
    const metadata = JSON.parse(await readFile(join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "workspace.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    assert.equal(ajv.validate(schema, metadata), true, JSON.stringify(ajv.errors));
    assert.equal(fixture.state.version, 0);
    assert.equal((await validateWorkspace(fixture.workspace)).metadata.workspaceId, fixture.state.metadata.workspaceId);

    let output = "";
    await runCli(["status", "--workspace", fixture.workspace], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    output = "";
    await runCli([
      "project-create",
      "--workspace", fixture.workspace,
      "--at", instant(1),
      "--external-key", "PROJECT-CLI",
      "--name", "CLI Project",
    ], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).version, 1);
    await expectReasonAsync("CLI_ARGUMENT_DUPLICATE", () => runCli(
      ["status", "--workspace", fixture.workspace, "--workspace", fixture.workspace],
      { write() {} },
    ));
    await expectReasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli(
      ["status", "--workspace", fixture.workspace, "--remote", "true"],
      { write() {} },
    ));

    for (const path of ["../packages/core/package.json", "../packages/cli/package.json"]) {
      const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
      assert.deepEqual(manifest.dependencies ?? {}, {});
    }
  } finally {
    await fixture.close();
  }
});

test("Workspace root entries have exact Ajv/runtime field and type parity", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/workspace-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const mutations = [
    (metadata) => { metadata.roots[0].extraAuthority = true; },
    (metadata) => { delete metadata.roots[0].canonicalPath; },
    (metadata) => { metadata.roots[0].path = 7; },
    (metadata) => { metadata.roots[0] = "framework"; },
  ];
  for (const mutate of mutations) {
    const fixture = await workspaceFixture();
    try {
      const metadataPath = join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "workspace.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      mutate(metadata);
      assert.equal(ajv.validate(schema, metadata), false);
      await writeFile(metadataPath, canonicalJson(metadata));
      await expectReasonAsync("WORKSPACE_SCHEMA_INVALID", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
});

test("project CRUD and Initiative-Epic-Story-Subtask operations materialize deterministically", async () => {
  const fixture = await workspaceFixture();
  try {
    let state = await createProject(fixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-ALPHA", name: "Alpha",
    });
    const projectId = state.projects[0].id;
    state = await createWork(fixture.workspace, {
      occurredAt: instant(2), projectId, externalKey: "INITIATIVE-ONE", kind: "Initiative", parentId: null,
    });
    const initiativeId = state.work.find((record) => record.kind === "Initiative").id;
    state = await createWork(fixture.workspace, {
      occurredAt: instant(3), projectId, externalKey: "EPIC-ONE", kind: "Epic", parentId: initiativeId,
    });
    const epicId = state.work.find((record) => record.kind === "Epic").id;
    state = await createWork(fixture.workspace, {
      occurredAt: instant(4), projectId, externalKey: "STORY-ONE", kind: "Story", parentId: epicId, scope: STORY_SCOPE,
    });
    const storyId = state.work.find((record) => record.kind === "Story").id;
    state = await createWork(fixture.workspace, {
      occurredAt: instant(5), projectId, externalKey: "SUBTASK-ONE", kind: "Subtask", parentId: storyId,
    });
    state = await transitionWork(fixture.workspace, {
      occurredAt: instant(6), id: initiativeId, status: "ready",
    });
    state = await updateProject(fixture.workspace, {
      occurredAt: instant(7), id: projectId, name: "Alpha Updated",
    });
    const subtaskId = state.work.find((record) => record.kind === "Subtask").id;
    state = await deleteWork(fixture.workspace, {
      occurredAt: instant(8), id: subtaskId,
    });
    state = await createProject(fixture.workspace, {
      occurredAt: instant(9), externalKey: "PROJECT-EMPTY", name: "Empty",
    });
    const emptyProjectId = state.projects.find((record) => record.externalKey === "PROJECT-EMPTY").id;
    state = await deleteProject(fixture.workspace, {
      occurredAt: instant(10), id: emptyProjectId,
    });
    assert.equal(state.version, 10);
    assert.deepEqual(state.work.map((record) => record.kind), ["Initiative", "Epic", "Story", "Subtask"]);
    assert.equal(state.projects.find((record) => record.id === projectId).revision, 2);
    await expectReasonAsync("GRAPH_PARENT_KIND_INVALID", () => createWork(fixture.workspace, {
      occurredAt: instant(11), projectId, externalKey: "BAD-EPIC", kind: "Epic", parentId: storyId,
    }));
    const status = await readFile(join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "views", "STATUS.md"), "utf8");
    assert.match(status, /Work records: 3/u);
    assert.equal(await exportWorkspace(fixture.workspace), await exportWorkspace(fixture.workspace));
    assert.deepEqual(await createWorkspaceArchive(fixture.workspace), await createWorkspaceArchive(fixture.workspace));
    assert.equal((await exportWorkspace(fixture.workspace)).includes(fixture.base), false);
  } finally {
    await fixture.close();
  }
});

test("WSB-1: mutation responses carry the created/mutated record identity", async () => {
  const fixture = await workspaceFixture();
  try {
    const run = async (args) => {
      let output = "";
      await runCli(args, { write: (value) => { output += value; } });
      return JSON.parse(output);
    };
    const ws = ["--workspace", fixture.workspace];
    const projectCreate = await run(["project-create", ...ws, "--at", instant(1), "--external-key", "PROJECT-B1", "--name", "B1"]);
    assert.equal(projectCreate.record.id, deriveStableId("project", "PROJECT-B1"));
    assert.equal(projectCreate.record.revision, 1);
    assert.equal(projectCreate.record.tombstone, false);
    // pre-existing envelope keys remain present
    assert.equal(projectCreate.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    assert.equal(projectCreate.version, 1);
    assert.equal(typeof projectCreate.headEventHash, "string");
    const projectId = projectCreate.record.id;
    const workCreate = await run(["work-create", "--title", "record-title", ...ws, "--at", instant(2), "--project-id", projectId, "--external-key", "INIT-B1", "--kind", "Initiative"]);
    assert.equal(workCreate.record.id, deriveStableId("work", "INIT-B1"));
    assert.deepEqual({ kind: workCreate.record.kind, status: workCreate.record.status, projectId: workCreate.record.projectId, parentId: workCreate.record.parentId, revision: workCreate.record.revision, tombstone: workCreate.record.tombstone },
      { kind: "Initiative", status: "planned", projectId, parentId: null, revision: 1, tombstone: false });
    const workId = workCreate.record.id;
    const transitioned = await run(["work-transition", ...ws, "--at", instant(3), "--id", workId, "--status", "ready"]);
    assert.equal(transitioned.record.status, "ready");
    assert.equal(transitioned.record.revision, 2);
    const deleted = await run(["work-delete", ...ws, "--at", instant(4), "--id", workId]);
    assert.equal(deleted.record.tombstone, true);
    // byte-identical repeat on a fresh fixture
    const other = await workspaceFixture();
    try {
      let a = "";
      await runCli(["project-create", "--workspace", other.workspace, "--at", instant(1), "--external-key", "PROJECT-B1", "--name", "B1"], { write: (value) => { a += value; } });
      let b = "";
      await runCli(["project-create", "--workspace", fixture.workspace, "--at", instant(5), "--external-key", "PROJECT-B1B", "--name", "B1"], { write: (value) => { b += value; } });
      assert.notEqual(a, b);
      assert.equal(JSON.parse(a).record.id, deriveStableId("project", "PROJECT-B1"));
    } finally {
      await other.close();
    }
  } finally {
    await fixture.close();
  }
});

test("WSB-4: work-create --parent-id '-' yields a null parent byte-identical to omitting the flag", async () => {
  const createRoot = async (fixture, parentFlag) => {
    let projectOut = "";
    await runCli(["project-create", "--workspace", fixture.workspace, "--at", instant(1), "--external-key", "PROJECT-B4", "--name", "B4"], { write: (value) => { projectOut += value; } });
    const projectId = JSON.parse(projectOut).record.id;
    let workOut = "";
    await runCli([
      "work-create", "--title", "record-title", "--workspace", fixture.workspace, "--at", instant(2),
      "--project-id", projectId, "--external-key", "INIT-B4", "--kind", "Initiative", ...parentFlag,
    ], { write: (value) => { workOut += value; } });
    return JSON.parse(workOut);
  };
  const dashFixture = await workspaceFixture();
  const omitFixture = await workspaceFixture();
  try {
    const dash = await createRoot(dashFixture, ["--parent-id", "-"]);
    const omit = await createRoot(omitFixture, []);
    assert.equal(dash.record.parentId, null);
    // '-' is the explicit null spelling; omitting the flag is the historical null. Both are byte-identical.
    assert.deepEqual(dash.record, omit.record);
    assert.equal(dash.headEventHash, omit.headEventHash);
  } finally {
    await dashFixture.close();
    await omitFixture.close();
  }
});

test("WSB-8: --flag=value representability round-trips literal values and invalid enum flags fail closed naming flag=value", async () => {
  const fixture = await workspaceFixture();
  try {
    const run = async (args) => {
      let output = "";
      await runCli(args, { write: (value) => { output += value; } });
      return JSON.parse(output);
    };
    const ws = ["--workspace", fixture.workspace];
    // A --name whose value begins with "--" is unrepresentable in the two-token form
    // (the value would be rejected as a flag) but is expressible via the attached =
    // form and round-trips byte-exactly onto disk.
    const created = await run(["project-create", ...ws, "--at", instant(1), "--external-key", "PROJECT-B8", "--name=--leading-dashes"]);
    assert.equal(created.version, 1);
    const afterCreate = await materializeWorkspace(fixture.workspace);
    assert.equal(afterCreate.projects.find((entry) => entry.id === created.record.id).name, "--leading-dashes");
    // Split on the FIRST "=" only: a value carrying further "=" is preserved verbatim.
    const updated = await run(["project-update", ...ws, "--at", instant(2), "--id", created.record.id, "--name=a=b=c"]);
    const afterUpdate = await materializeWorkspace(fixture.workspace);
    assert.equal(afterUpdate.projects.find((entry) => entry.id === updated.record.id).name, "a=b=c");
    // A duplicate flag across the attached and two-token spellings still fails closed.
    await expectReasonAsync("CLI_ARGUMENT_DUPLICATE", () => runCli(
      ["status", `--workspace=${fixture.workspace}`, "--workspace", fixture.workspace],
      { write() {} },
    ));
    // An invalid enum on a mutation verb fails at the CLI boundary naming flag=value
    // (CLI_ARGUMENT_MALFORMED), never as an opaque core RECORD_MALFORMED on the id.
    await assert.rejects(
      () => runCli(
        ["work-create", "--title", "record-title", ...ws, "--at", instant(3), "--project-id", created.record.id, "--external-key", "INIT-B8", "--kind", "Task"],
        { write() {} },
      ),
      (error) => error?.reasonCode === "CLI_ARGUMENT_MALFORMED" && error?.message === "kind=Task",
      "invalid --kind names flag=value and is not RECORD_MALFORMED",
    );
    // A bare flag with no following value still fails CLI_ARGUMENT_MALFORMED.
    await expectReasonAsync("CLI_ARGUMENT_MALFORMED", () => runCli(
      ["status", "--workspace"],
      { write() {} },
    ));
  } finally {
    await fixture.close();
  }
});

test("WSA-1: every mutation returns state identical to a fresh materialize (single-replay pipeline)", async () => {
  const fixture = await workspaceFixture();
  try {
    const projection = (state) => ({ version: state.version, headEventHash: state.headEventHash, projects: state.projects, work: state.work });
    const assertFresh = async (returned) => {
      const fresh = await materializeWorkspace(fixture.workspace);
      assert.deepEqual(projection(returned), projection(fresh), "returned state must equal a fresh materialize");
    };
    let state = await createProject(fixture.workspace, { occurredAt: instant(1), externalKey: "PROJECT-ALPHA", name: "Alpha" });
    await assertFresh(state);
    const projectId = state.projects[0].id;
    state = await createWork(fixture.workspace, { occurredAt: instant(2), projectId, externalKey: "INITIATIVE-ONE", kind: "Initiative", parentId: null });
    await assertFresh(state);
    const initiativeId = state.work.find((record) => record.kind === "Initiative").id;
    state = await createWork(fixture.workspace, { occurredAt: instant(3), projectId, externalKey: "EPIC-ONE", kind: "Epic", parentId: initiativeId });
    await assertFresh(state);
    const epicId = state.work.find((record) => record.kind === "Epic").id;
    state = await transitionWork(fixture.workspace, { occurredAt: instant(4), id: epicId, status: "ready" });
    await assertFresh(state);
    state = await updateProject(fixture.workspace, { occurredAt: instant(5), id: projectId, name: "Alpha Two" });
    await assertFresh(state);
    state = await deleteWork(fixture.workspace, { occurredAt: instant(6), id: epicId });
    await assertFresh(state);
    state = await deleteWork(fixture.workspace, { occurredAt: instant(7), id: initiativeId });
    await assertFresh(state);
    state = await deleteProject(fixture.workspace, { occurredAt: instant(8), id: projectId });
    await assertFresh(state);
    assert.equal(state.version, 8);
  } finally {
    await fixture.close();
  }
});

test("WSA-2: a 400-record deep-hierarchy build completes and exports deterministically", async () => {
  // Under the pre-WSA-2 per-event full-graph validation this build was O(n^3) and
  // exceeded the test-controller timeout. It must now simply finish.
  const fixture = await workspaceFixture();
  try {
    const at = (n) => new Date(Date.UTC(2026, 6, 11, 0, 0, 0) + n * 1000).toISOString().replace(/\.000Z$/u, "Z");
    let version = 0;
    let state = await createProject(fixture.workspace, { occurredAt: at(version), externalKey: "PROJECT-DEEP", name: "Deep" });
    version += 1;
    const projectId = state.projects[0].id;
    const chains = 100;
    for (let i = 0; i < chains; i += 1) {
      state = await createWork(fixture.workspace, { occurredAt: at(version), projectId, externalKey: `INITIATIVE-${i}`, kind: "Initiative", parentId: null });
      const initiativeId = state.work.find((record) => record.externalKey === `INITIATIVE-${i}`).id;
      version += 1;
      state = await createWork(fixture.workspace, { occurredAt: at(version), projectId, externalKey: `EPIC-${i}`, kind: "Epic", parentId: initiativeId });
      const epicId = state.work.find((record) => record.externalKey === `EPIC-${i}`).id;
      version += 1;
      state = await createWork(fixture.workspace, { occurredAt: at(version), projectId, externalKey: `STORY-${i}`, kind: "Story", parentId: epicId, scope: STORY_SCOPE });
      const storyId = state.work.find((record) => record.externalKey === `STORY-${i}`).id;
      version += 1;
      state = await createWork(fixture.workspace, { occurredAt: at(version), projectId, externalKey: `SUBTASK-${i}`, kind: "Subtask", parentId: storyId });
      version += 1;
    }
    assert.equal(state.version, 1 + chains * 4);
    assert.equal(state.work.length, chains * 4);
    assert.equal(await exportWorkspace(fixture.workspace), await exportWorkspace(fixture.workspace));
  } finally {
    await fixture.close();
  }
});

test("single-writer lock, stale-lock recovery, and atomic crash points fail closed", async () => {
  const fixture = await workspaceFixture();
  try {
    // TCRN-CROSS-STORY-467 R1: a write lock left by a holder that is gone is broken, and the
    // write proceeds and releases it.
    const lockPath = join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, WORKSPACE_WRITE_LOCK_FILE);
    await writeFile(lockPath, `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: 2_147_483_000, token: "b".repeat(32), hostname: hostname(), createdAt: "2000-01-01T00:00:00Z" })}\n`);
    await createProject(fixture.workspace, { occurredAt: instant(3), externalKey: "PROJECT-AFTER-STALE", name: "After stale" });
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }

  const cases = JSON.parse(await readFile(new URL("../packages/core/fixtures/p3-cases.json", import.meta.url), "utf8"));
  for (const fault of cases.faultCases) {
    const crashFixture = await workspaceFixture();
    try {
      await expectReasonAsync(fault.expectedReasonCode, () => createProject(crashFixture.workspace, {
        occurredAt: instant(2),
        externalKey: `PROJECT-${fault.id.toUpperCase()}`,
        name: fault.id,
        crashAt: fault.id,
      }));
      assert.equal((await materializeWorkspace(crashFixture.workspace)).version, fault.committed ? 1 : 0);
      if (fault.committed) {
        await expectReasonAsync("WORKSPACE_VIEW_STALE", () => validateWorkspace(crashFixture.workspace));
        assert.equal((await recoverWorkspace(crashFixture.workspace)).version, 1);
      } else {
        assert.equal((await validateWorkspace(crashFixture.workspace)).version, 0);
      }
    } finally {
      await crashFixture.close();
    }
  }
});

test("two concurrent mutations are serialised by the write lock and both land in order", async () => {
  const fixture = await workspaceFixture();
  try {
    let lockEntered;
    const entered = new Promise((resolve) => { lockEntered = resolve; });
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const first = createProject(fixture.workspace, {
      occurredAt: instant(2),
      externalKey: "PROJECT-CONCURRENT-ALPHA",
      name: "Concurrent Alpha",
      async insideWriteLockForTest() {
        lockEntered();
        await barrier;
      },
    });
    await entered;
    // The second writer starts while the first holds the lock; it waits rather than
    // failing, and builds its delta against the state the first one left.
    const second = createProject(fixture.workspace, {
      occurredAt: instant(2),
      externalKey: "PROJECT-CONCURRENT-BETA",
      name: "Concurrent Beta",
    });
    releaseBarrier();
    const [alpha, beta] = await Promise.all([first, second]);
    assert.equal(alpha.version, 1);
    assert.equal(beta.version, 2);
    const state = await materializeWorkspace(fixture.workspace);
    assert.deepEqual(state.events.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(state.projects.filter((record) => !record.tombstone).map((record) => record.externalKey).sort(), [
      "PROJECT-CONCURRENT-ALPHA",
      "PROJECT-CONCURRENT-BETA",
    ]);
    assert.equal((await validateWorkspace(fixture.workspace)).version, 2);
  } finally {
    await fixture.close();
  }
});

test("segment rotation and replay, truncation, reordering, corruption, gap, and special-entry attacks are rejected", async () => {
  const fixture = await workspaceFixture({ segmentEventLimit: 2 });
  try {
    let state = await createProject(fixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-SEGMENT", name: "Segment",
    });
    const projectId = state.projects[0].id;
    state = await createWork(fixture.workspace, {
      occurredAt: instant(2), projectId, externalKey: "INITIATIVE-SEGMENT", kind: "Initiative", parentId: null,
    });
    const initiativeId = state.work[0].id;
    await createWork(fixture.workspace, {
      occurredAt: instant(3), projectId, externalKey: "EPIC-SEGMENT", kind: "Epic", parentId: initiativeId,
    });
    const eventsRoot = join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "events");
    const firstPath = join(eventsRoot, "000001.json");
    const secondPath = join(eventsRoot, "000002.json");
    const firstText = await readFile(firstPath, "utf8");
    const secondText = await readFile(secondPath, "utf8");
    const first = JSON.parse(firstText);

    await writeFile(firstPath, "{");
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([first[0], first[0]]));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([...first].reverse()));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await writeFile(firstPath, canonicalJson([first[0], { ...first[1], eventHash: "0".repeat(64) }]));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await writeFile(firstPath, firstText);

    await rename(secondPath, join(eventsRoot, "000003.json"));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await rename(join(eventsRoot, "000003.json"), secondPath);

    await mkdir(join(eventsRoot, "special-entry"));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    await rm(join(eventsRoot, "special-entry"), { recursive: true });
    assert.equal((await validateWorkspace(fixture.workspace)).version, 3);
    assert.equal(secondText, await readFile(secondPath, "utf8"));
  } finally {
    await fixture.close();
  }
});

test("event admission rejects unknown operations, lifecycle forgery, resurrection, and invalid relationships", async () => {
  const scenarios = [
    {
      prepare: (fixture) => createProjectHistory(fixture, true, false),
      mutate(events) {
        events[1].payload.operation = "project.archived";
        return events;
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, false, true),
      mutate(events) {
        const deleted = structuredClone(events[1]);
        deleted.occurredAt = instant(3);
        deleted.payload.record.revision = 3;
        return [...events, deleted];
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, false, true),
      mutate(events) {
        const resurrected = structuredClone(events[1]);
        resurrected.occurredAt = instant(3);
        resurrected.payload.operation = "project.updated";
        resurrected.payload.record.revision = 3;
        resurrected.payload.record.tombstone = false;
        resurrected.payload.record.updatedAt = instant(3);
        return [...events, resurrected];
      },
    },
    {
      prepare: (fixture) => createProjectHistory(fixture, true, false),
      mutate(events) {
        events[1].payload.record.revision = 99;
        return events;
      },
    },
  ];
  for (const scenario of scenarios) {
    const fixture = await workspaceFixture();
    try {
      await scenario.prepare(fixture);
      await rewriteEventChain(fixture.workspace, scenario.mutate);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  for (const operation of ["project.updated", "project.deleted"]) {
    const absentFixture = await workspaceFixture();
    try {
      const externalKey = "PROJECT-ABSENT";
      await rewriteEventChain(absentFixture.workspace, () => [{
        occurredAt: instant(1),
        payload: {
          operation,
          record: {
            schemaVersion: "tcrn.project.v1",
            id: deriveStableId("project", externalKey),
            externalKey,
            name: "Absent",
            revision: 1,
            updatedAt: instant(1),
            tombstone: operation === "project.deleted",
          },
        },
      }]);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(absentFixture.workspace));
    } finally {
      await absentFixture.close();
    }
  }

  const workFixture = await workspaceFixture();
  try {
    let state = await createProject(workFixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-WORK-FORGE", name: "Work Forge",
    });
    state = await createWork(workFixture.workspace, {
      occurredAt: instant(2),
      projectId: state.projects[0].id,
      externalKey: "INITIATIVE-WORK-FORGE",
      kind: "Initiative",
      parentId: null,
    });
    await transitionWork(workFixture.workspace, {
      occurredAt: instant(3), id: state.work[0].id, status: "ready",
    });
    await rewriteEventChain(workFixture.workspace, (events) => {
      events[2].payload.operation = "work.archived";
      return events;
    });
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(workFixture.workspace));
  } finally {
    await workFixture.close();
  }

  const relationshipFixture = await workspaceFixture();
  try {
    let state = await createProject(relationshipFixture.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-RELATIONSHIP", name: "Relationship",
    });
    await createWork(relationshipFixture.workspace, {
      occurredAt: instant(2),
      projectId: state.projects[0].id,
      externalKey: "INITIATIVE-RELATIONSHIP",
      kind: "Initiative",
      parentId: null,
    });
    await rewriteEventChain(relationshipFixture.workspace, (events) => {
      events[1].payload.record.projectId = "project:missing";
      return events;
    });
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(relationshipFixture.workspace));
  } finally {
    await relationshipFixture.close();
  }

  const absentWorkFixture = await workspaceFixture();
  try {
    const state = await createProjectHistory(absentWorkFixture, false, false);
    const externalKey = "INITIATIVE-ABSENT";
    await rewriteEventChain(absentWorkFixture.workspace, (events) => [...events, {
      occurredAt: instant(2),
      payload: {
        operation: "work.updated",
        record: {
          schemaVersion: "tcrn.work.v1",
          id: deriveStableId("work", externalKey),
          externalKey,
          projectId: state.projects[0].id,
          kind: "Initiative",
          parentId: null,
          status: "ready",
          revision: 1,
          updatedAt: instant(2),
          tombstone: false,
          extensions: {},
        },
      },
    }]);
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(absentWorkFixture.workspace));
  } finally {
    await absentWorkFixture.close();
  }
});

test("event stream and event IDs are bound to canonical Workspace metadata", async () => {
  const source = await workspaceFixture({ externalKey: "WORKSPACE-SOURCE" });
  const target = await workspaceFixture({ externalKey: "WORKSPACE-TARGET" });
  try {
    await createProjectHistory(source, false, false);
    const sourceSegment = join(source.workspace, LEGACY_CONTROL_DIRECTORY, "events", "000001.json");
    const targetSegment = join(target.workspace, LEGACY_CONTROL_DIRECTORY, "events", "000001.json");
    await writeFile(targetSegment, await readFile(sourceSegment));
    await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(target.workspace));
  } finally {
    await source.close();
    await target.close();
  }

  for (const identity of [
    { streamId: "stream:wrong" },
    { eventIdFor: () => "event:wrong" },
  ]) {
    const fixture = await workspaceFixture();
    try {
      await createProjectHistory(fixture, false, false);
      await rewriteEventChain(fixture.workspace, (events) => events, identity);
      await expectReasonAsync("WORKSPACE_EVENT_CORRUPT", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
});

test("path, link, Unicode, size, record, filesystem, and migration boundaries have stable failures", async () => {
  expectReason("WORKSPACE_PATH_ESCAPE", () => assertWorkspaceRelativePath("../escape"));
  expectReason("WORKSPACE_PATH_ESCAPE", () => assertWorkspaceRelativePath("a\\b"));
  // TCRN-CROSS-INC-224: derived from the constant rather than typed, because this
  // assertion hard-coded 10,001 and so broke on a change that was correct. 10,001 is now
  // a legal chain length -- the lifetime bound and the per-document shape bound stopped
  // sharing a number -- and that behavioural change is asserted beside the refusal.
  assert.doesNotThrow(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxRecords + 1));
  expectReason("WORKSPACE_RECORD_LIMIT", () => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents + 1));
  await expectReasonAsync("WORKSPACE_FILESYSTEM_UNSUPPORTED", () => assertSupportedWorkspaceFilesystem(tmpdir(), 0x7fffffff));

  const malformed = await workspaceFixture();
  try {
    await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => createProject(malformed.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-UNICODE", name: "\ud800",
    }));
    await expectReasonAsync("WORKSPACE_INPUT_OVERSIZED", () => createProject(malformed.workspace, {
      occurredAt: instant(1), externalKey: "PROJECT-LARGE", name: "x".repeat(513),
    }));
    const plan = await planWorkspaceMigration(malformed.workspace, 1);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.applyAvailable, false);
    assert.equal(plan.rollback, "restore-exact-pre-migration-backup-then-validate");
    assert.equal(plan.postValidation, "validate-exact-target-schema-and-full-event-chain");
    await expectReasonAsync("WORKSPACE_MIGRATION_DOWNGRADE", () => planWorkspaceMigration(malformed.workspace, 0));
    const upgrade = await planWorkspaceMigration(malformed.workspace, 2);
    assert.equal(upgrade.fromVersion, 1);
    assert.equal(upgrade.toVersion, 2);
    await expectReasonAsync("WORKSPACE_MIGRATION_APPLY_UNAVAILABLE", () => applyWorkspaceMigration());
  } finally {
    await malformed.close();
  }

  for (const linkKind of ["symlink", "hardlink"]) {
    const fixture = await workspaceFixture();
    try {
      const metadata = join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "workspace.json");
      const backup = join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, `workspace-${linkKind}.json`);
      await rename(metadata, backup);
      if (linkKind === "symlink") {
        await symlink(backup, metadata);
      } else {
        await link(backup, metadata);
      }
      await expectReasonAsync("WORKSPACE_PATH_INVALID", () => materializeWorkspace(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  const future = await workspaceFixture();
  try {
    const metadataPath = join(future.workspace, LEGACY_CONTROL_DIRECTORY, "workspace.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, canonicalJson({ ...metadata, storageVersion: 3, minimumStorageVersion: 1, maximumStorageVersion: 3 }));
    await expectReasonAsync("WORKSPACE_MIGRATION_FUTURE", () => materializeWorkspace(future.workspace));
  } finally {
    await future.close();
  }
});

test("derived ordering, readback hashes, and export bytes remain deterministic across 64 permutations", async () => {
  const fixture = await workspaceFixture();
  try {
    let seeded = fixture.state;
    for (const [index, key] of ["PROJECT-Z", "PROJECT-A", "PROJECT-M"].entries()) {
      seeded = await createProject(fixture.workspace, {
        occurredAt: instant(index + 1), externalKey: key, name: key,
      });
    }
    assert.deepEqual(seeded.projects.map((record) => record.externalKey), ["PROJECT-A", "PROJECT-M", "PROJECT-Z"]);
    const state = await validateWorkspace(fixture.workspace);
    const expected = canonicalSha256(state.projects);
    let seed = 113;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const shuffled = [...state.projects];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        seed = (seed * 48271) % 2147483647;
        const target = seed % (index + 1);
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
      }
      shuffled.sort((left, right) => Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)));
      assert.equal(canonicalSha256(shuffled), expected);
    }
    const readback = JSON.parse(await readFile(join(fixture.workspace, LEGACY_CONTROL_DIRECTORY, "views", "readback.json"), "utf8"));
    assert.equal(readback.authority, "derived-rebuildable");
    assert.equal(typeof readback.graphDigest, "string");
  } finally {
    await fixture.close();
  }
});

async function readEventPayloads(workspace) {
  const eventsRoot = join(workspace, LEGACY_CONTROL_DIRECTORY, "events");
  const names = (await readdir(eventsRoot)).filter((name) => /^\d{6}\.json$/u.test(name)).sort();
  const events = [];
  for (const name of names) {
    events.push(...JSON.parse(await readFile(join(eventsRoot, name), "utf8")));
  }
  return events.map((event) => event.payload);
}

test("WSE-3: --actor threads through the mutation verbs into the appended event payload, fail-closed after the historical enable event", async () => {
  const fixture = await workspaceFixture({ externalKey: "WORKSPACE-WSE3" });
  try {
    const ws = ["--workspace", fixture.workspace];
    const run = async (args) => {
      let output = "";
      await runCli(args, { write: (value) => { output += value; } });
      return JSON.parse(output);
    };
    // The attestation.actor.enabled event is the boundary (sequence >= enabledAtSequence),
    // so the enabling event itself carries a valid actor and every later mutation must too.
    // Its verb is retired (TCRN-CROSS-STORY-467 R2); the event is history a chain can carry.
    const enabled = await appendHistoricalAttestationEnable(fixture.workspace, { occurredAt: instant(1), actorId: "owner:release-gate" });
    assert.equal(enabled.attestationEnabledAtSequence, 1);
    // Happy path: a mutation on an enabled workspace with a valid --actor succeeds and
    // the actor string joins the hashed event payload (acceptance criterion 1).
    const projectCreate = await run(["project-create", ...ws, "--at", instant(2), "--external-key", "PROJECT-WSE3", "--name", "WSE3", "--actor", "agent:builder-7"]);
    assert.equal(projectCreate.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    const projectId = projectCreate.record.id;
    await run(["work-create", "--title", "record-title", ...ws, "--at", instant(3), "--project-id", projectId, "--external-key", "INIT-WSE3", "--kind", "Initiative", "--actor", "owner:release-gate"]);
    const payloads = await readEventPayloads(fixture.workspace);
    assert.deepEqual(payloads.map((payload) => payload.operation), [
      "attestation.actor.enabled", "project.created", "work.created",
    ]);
    assert.deepEqual(payloads.map((payload) => payload.actor), [
      "owner:release-gate", "agent:builder-7", "owner:release-gate",
    ]);
    // Fail-closed: the engine (WSE-2), not the CLI, requires the actor once enabled —
    // omitting --actor surfaces WORKSPACE_ACTOR_REQUIRED, not a CLI missing-argument.
    await expectReasonAsync("WORKSPACE_ACTOR_REQUIRED", () => runCli(
      ["project-create", ...ws, "--at", instant(4), "--external-key", "PROJECT-WSE3B", "--name", "WSE3B"],
      { write: () => {} },
    ));
    // A supplied actor with an unlisted prefix is rejected by the engine's vocabulary
    // (WORKSPACE_ACTOR_INVALID) — the CLI never duplicates the allowlist.
    await expectReasonAsync("WORKSPACE_ACTOR_INVALID", () => runCli(
      ["project-create", ...ws, "--at", instant(4), "--external-key", "PROJECT-WSE3B", "--name", "WSE3B", "--actor", "role:nope"],
      { write: () => {} },
    ));
    // --actor stays unknown on read/non-mutation verbs (no sweep leakage): the flag
    // grammar rejects it exactly as before this package.
    await expectReasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli(
      ["project-list", ...ws, "--actor", "owner:release-gate"],
      { write: () => {} },
    ));
  } finally {
    await fixture.close();
  }
});

test("WSE-3: legacy mutations without --actor on a non-enabled workspace never write an actor key (byte-identical to rc.4)", async () => {
  const fixture = await workspaceFixture({ externalKey: "WORKSPACE-WSE3-LEGACY" });
  try {
    const ws = ["--workspace", fixture.workspace];
    let output = "";
    await runCli(["project-create", ...ws, "--at", instant(1), "--external-key", "PROJECT-LEGACY", "--name", "Legacy"], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "WORKSPACE_COMMAND_COMPLETED");
    // A supplied --actor before enablement is a no-op: no actor field enters the payload.
    await runCli(["work-create", "--title", "record-title", ...ws, "--at", instant(2), "--project-id", JSON.parse(output).record.id, "--external-key", "INIT-LEGACY", "--kind", "Initiative", "--actor", "owner:release-gate"], { write: () => {} });
    const payloads = await readEventPayloads(fixture.workspace);
    assert.deepEqual(payloads.map((payload) => payload.operation), ["project.created", "work.created"]);
    for (const payload of payloads) {
      assert.equal(Object.hasOwn(payload, "actor"), false, "no actor key before attestation is enabled");
    }
  } finally {
    await fixture.close();
  }
});

test("WSA-3 (create side): a done Initiative may not acquire a new live child, while a live Initiative may", async () => {
  const fixture = await workspaceFixture({ externalKey: "WORKSPACE-WSA3C" });
  try {
    let state = await createProject(fixture.workspace, { occurredAt: instant(1), externalKey: "PROJECT-WSA3C", name: "WSA3C" });
    const projectId = state.projects[0].id;
    // Two Initiatives: one will be closed, one stays live. The rule must tell them apart.
    state = await createWork(fixture.workspace, { occurredAt: instant(2), projectId, externalKey: "INIT-WSA3C-CLOSED", kind: "Initiative", parentId: null });
    const closedInitiative = state.work.find((record) => record.externalKey === "INIT-WSA3C-CLOSED").id;
    state = await createWork(fixture.workspace, { occurredAt: instant(3), projectId, externalKey: "INIT-WSA3C-LIVE", kind: "Initiative", parentId: null });
    const liveInitiative = state.work.find((record) => record.externalKey === "INIT-WSA3C-LIVE").id;
    // Close the first one legally: it has no descendants, so the transition-side rule permits it.
    state = await transitionWork(fixture.workspace, { occurredAt: instant(4), id: closedInitiative, status: "ready" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(5), id: closedInitiative, status: "active" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(6), id: closedInitiative, status: "done" });

    await assert.rejects(
      createWork(fixture.workspace, { occurredAt: instant(7), projectId, externalKey: "EPIC-WSA3C-REOPEN", kind: "Epic", parentId: closedInitiative }),
      (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /it is already done/u.test(String(error?.message)),
      "adding live work under a done Initiative must be refused"
    );

    // The other side of the predicate: the identical create under a live Initiative is accepted,
    // so the rule discriminates on the parent's state rather than refusing every child.
    state = await createWork(fixture.workspace, { occurredAt: instant(7), projectId, externalKey: "EPIC-WSA3C-OK", kind: "Epic", parentId: liveInitiative });
    assert.equal(state.work.find((record) => record.externalKey === "EPIC-WSA3C-OK").parentId, liveInitiative);
  } finally {
    await fixture.close();
  }
});

test("WSA-3: closing an Initiative to done with live non-terminal descendants is refused; terminalising first lets it close", async () => {
  const fixture = await workspaceFixture({ externalKey: "WORKSPACE-WSA3" });
  try {
    let state = await createProject(fixture.workspace, { occurredAt: instant(1), externalKey: "PROJECT-WSA3", name: "WSA3" });
    const projectId = state.projects[0].id;
    state = await createWork(fixture.workspace, { occurredAt: instant(2), projectId, externalKey: "INIT-WSA3", kind: "Initiative", parentId: null });
    const initiativeId = state.work.find((record) => record.kind === "Initiative").id;
    state = await createWork(fixture.workspace, { occurredAt: instant(3), projectId, externalKey: "EPIC-WSA3", kind: "Epic", parentId: initiativeId });
    const epicId = state.work.find((record) => record.kind === "Epic").id;
    // Bring the INIT to active so done is a legal status-machine transition; WSA-3 must then refuse it while the Epic is live.
    state = await transitionWork(fixture.workspace, { occurredAt: instant(4), id: initiativeId, status: "ready" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(5), id: initiativeId, status: "active" });

    await assert.rejects(
      transitionWork(fixture.workspace, { occurredAt: instant(6), id: initiativeId, status: "done" }),
      (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /still holds live non-terminal work/u.test(String(error?.message)),
      "closing an active INIT with a live descendant must be refused"
    );

    // Terminalise the Epic (ready -> active -> done), then the INIT can close.
    state = await transitionWork(fixture.workspace, { occurredAt: instant(6), id: epicId, status: "ready" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(7), id: epicId, status: "active" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(8), id: epicId, status: "done" });
    state = await transitionWork(fixture.workspace, { occurredAt: instant(9), id: initiativeId, status: "done" });
    assert.equal(state.work.find((record) => record.id === initiativeId).status, "done");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-STORY-359: verifyP3 retired with the rest of the phase verbs and it was the
// only reader of these six fixture counts. Re-hung here, in the file that drives the
// corpus, so the fixture cannot silently shrink away from the cases it claims to carry.
test("STORY-359 the p3 fixture declares the corpus sizes verifyP3 used to pin", async () => {
  const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p3-cases.json", import.meta.url), "utf8"));
  assert.equal(fixture.schemaVersion, "tcrn.p3-file-engine-cases.v1");
  assert.equal(fixture.faultCases.length, 4);
  assert.equal(fixture.leaseFaultCases.length, 1);
  assert.equal(fixture.schemaParityCases.length, 4);
  assert.equal(fixture.concurrencyCases.length, 4);
  assert.ok(fixture.negativeCases.length >= 53, String(fixture.negativeCases.length));
  assert.equal(fixture.migrationCases.length, 3);
  assert.ok(fixture.propertyPermutations >= 64, String(fixture.propertyPermutations));
});

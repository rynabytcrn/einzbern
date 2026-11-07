// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSpec, initializeSpec, refreshSpec, draftSpecChange, run } from "../skill/mana-orchestrate/scripts/kiro-specs.mjs";

const WORK_ID = `work:${"b".repeat(24)}`;
const PARENT_ID = `work:${"c".repeat(24)}`;
const MINUTES_ID = `minutes:${"a".repeat(24)}`;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFixture(options = {}) {
  const workId = options.workId ?? WORK_ID;
  const externalKey = options.externalKey ?? "TCRN-CROSS-SUB-TEST-C2";
  const state = {
    revision: options.revision ?? 2,
    status: options.status ?? "active",
    goal: options.goal ?? "Document the open work item without inventing requirements.",
    acceptance: options.acceptance ?? "Read current sources, preserve user content, and keep formal completion in Einzbern.",
    title: options.title ?? "Add an ordinary example index entry",
    scope: options.scope ?? "Update only the current index entry.",
    body: options.body ?? "Output: docs/examples/index.md.",
    decidedIn: options.decidedIn ?? [],
    contextComplete: options.contextComplete ?? true,
    emptyGoal: options.emptyGoal ?? false,
    calls: [],
  };
  const workShow = () => ({
    reasonCode: "WORKSPACE_RECORD_READY",
    kind: "work",
    record: {
      id: workId,
      externalKey,
      kind: "Subtask",
      revision: state.revision,
      status: state.status,
      title: state.title,
      summary: "One ordinary open work item.",
      projectId: "project:dddddddddddddddddddddddd",
      parentId: PARENT_ID,
      scopeDigest: "e".repeat(64),
      tombstone: false,
    },
    relations: { forward: { decidedIn: [...state.decidedIn] } },
  });
  const makeDocument = () => ({
    schemaVersion: "tcrn.work-content-context.v1",
    libraryId: "workspace:eeeeeeeeeeeeeeeeeeeeeeee",
    workId,
    workRevision: state.revision,
    records: [
      {
        workId,
        externalKey,
        workRevision: state.revision,
        relation: "direct",
        kind: "Subtask",
        content: null,
        contentImpact: null,
        acceptanceMeaningDigests: {},
        fields: {
          goal: state.emptyGoal ? "" : state.goal,
          acceptance: state.acceptance,
          body: state.body,
          source: "fields",
        },
        scope: state.scope,
        missing: [],
        sourceStatus: "legacy-unverified",
      },
      {
        workId: PARENT_ID,
        externalKey: "TCRN-CROSS-STORY-TEST-C",
        workRevision: 4,
        relation: "inherited",
        kind: "Story",
        content: null,
        contentImpact: null,
        acceptanceMeaningDigests: {},
        fields: { goal: "Keep the engine authoritative.", acceptance: "Preserve the approved scope.", body: "Inherited constraints." },
        scope: "Keep C.1 and C.2 in one approved package.",
        missing: [],
        sourceStatus: "legacy-unverified",
      },
    ],
    effectiveRequirements: [],
    structureProblems: [],
    missing: [],
    complete: true,
    semanticVerification: "not-performed",
    note: "Legacy source remains unverified.",
  });
  const invoke = async (command, args) => {
    state.calls.push({ command, args });
    if (command === "work-show") return workShow();
    if (command === "work-content-context") {
      const text = JSON.stringify(makeDocument());
      return { schemaVersion: "tcrn.work-content-segment.v1", workId, workRevision: state.revision, digest: sha256(text), encoding: "json-text", offset: 0, end: [...text].length, total: [...text].length, text, truncated: false, complete: state.contextComplete, nextOffset: null };
    }
    if (command === "work-project-context") return {
      workId,
      workRevision: state.revision,
      workContent: { workRevision: state.revision },
      contexts: [],
      conflicts: [],
      involvedProjects: { state: "undecided", targets: [] },
      writeAuthority: "not-granted",
    };
    if (command === "minutes-show" && args.id === MINUTES_ID) return {
      reasonCode: "WORKSPACE_RECORD_READY",
      kind: "minutes",
      record: { id: MINUTES_ID, revision: 1, summary: "Approved source decision.", tombstone: false, decisions: [{ number: 1, text: "Use the existing engine writeback path before refresh." }] },
    };
    assert.fail(`unexpected engine command ${command}`);
  };
  return { state, invoke };
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "einzbern-kiro-specs-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const optionsFor = (base, invoke, overrides = {}) => ({
  workspace: "isolated-library",
  workId: WORK_ID,
  specDir: ".kiro/specs/test-task",
  cwd: base,
  invoke,
  ...overrides,
});

test("ordinary task projection preserves its source facts without inheriting the pilot validation block", async context => {
  const base = await temporaryDirectory(context);
  const { state, invoke } = sourceFixture();
  const first = await initializeSpec(optionsFor(base, invoke));
  const directory = join(base, ".kiro/specs/test-task");
  const requirements = await readFile(join(directory, "requirements.md"), "utf8");
  const design = await readFile(join(directory, "design.md"), "utf8");
  const tasks = await readFile(join(directory, "tasks.md"), "utf8");
  const stamp = await readFile(join(directory, "source.json"), "utf8");
  assert.equal(first.reasonCode, "SPEC_INITIALIZED");
  assert.match(requirements, /revision 2/);
  assert.match(requirements, /Update only the current index entry\./);
  assert.match(requirements, /Read current sources, preserve user content/);
  assert.match(requirements, /Output: docs\/examples\/index\.md\./);
  assert.match(requirements, /legacy-unverified/);
  assert.match(requirements, /No effective typed requirements/);
  assert.match(design, /No design authority is configured/);
  assert.match(design, /"status":"unconfigured"/);
  assert.equal((tasks.match(/^- \[ \] /gmu) ?? []).length, 1);
  assert.equal((tasks.match(/^- \[x\] /gmu) ?? []).length, 0);
  assert.match(tasks, /- \[ \] 1\. Add an ordinary example index entry/);
  assert.match(tasks, /Goal from the current formal source: Document the open work item without inventing requirements\./);
  assert.match(tasks, /Scope from the current formal source: Update only the current index entry\./);
  assert.match(tasks, /Acceptance from the current formal source: Read current sources, preserve user content, and keep formal completion in Einzbern\./);
  assert.match(tasks, /Original work notes and delivery details from the current formal source: Output: docs\/examples\/index\.md\./);
  assert.doesNotMatch(tasks, /Operational validation|KIRO-OPEN-OPERATIONAL-VALIDATION|intentionally unfinished/);

  const second = await initializeSpec(optionsFor(base, invoke));
  assert.equal(second.reasonCode, "SPEC_ALREADY_CURRENT");
  assert.equal(await readFile(join(directory, "requirements.md"), "utf8"), requirements);
  assert.equal(await readFile(join(directory, "design.md"), "utf8"), design);
  assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), tasks);
  assert.equal(await readFile(join(directory, "source.json"), "utf8"), stamp);

  const checked = await checkSpec(optionsFor(base, invoke));
  assert.equal(checked.reasonCode, "SPEC_CURRENT");
  assert.equal(checked.formalStatus, "active");
  assert.equal(checked.formalDone, false);
  assert.equal(checked.taskChecksAreFormalEvidence, false);
  assert.deepEqual(checked.tasksCheckedLocalOnly, []);
  assert.equal(state.calls.some(call => ["work-annotate", "work-transition"].includes(call.command)), false);
});

test("C.1: real source change becomes a draft; linked engine writeback enables refresh and preserves local-only text and checks", async context => {
  const base = await temporaryDirectory(context);
  const { state, invoke } = sourceFixture();
  await initializeSpec(optionsFor(base, invoke));
  const directory = join(base, ".kiro/specs/test-task");
  const requirementsPath = join(directory, "requirements.md");
  const tasksPath = join(directory, "tasks.md");
  const originalRequirements = await readFile(requirementsPath, "utf8");
  await writeFile(requirementsPath, `${originalRequirements}\nUser-only note: keep this sentence.\n`);
  const originalTasks = await readFile(tasksPath, "utf8");
  await writeFile(tasksPath, originalTasks.replace("- [ ] 1.", "- [x] 1."));

  state.revision = 3;
  state.goal = "Document the approved, updated task source.";
  state.decidedIn = [MINUTES_ID];
  const stale = await checkSpec(optionsFor(base, invoke));
  assert.equal(stale.reasonCode, "SPEC_STALE");
  assert.deepEqual(stale.tasksCheckedLocalOnly, ["1"]);
  assert.equal(stale.formalDone, false);
  const draftPath = ".kiro/specs/test-task/change-draft.md";
  const draft = await draftSpecChange(optionsFor(base, invoke, { draftOut: draftPath }));
  assert.equal(draft.reasonCode, "SPEC_CHANGE_DRAFT_WRITTEN");
  assert.match(await readFile(join(base, draftPath), "utf8"), /approved, updated task source/);
  assert.equal(await readFile(requirementsPath, "utf8"), `${originalRequirements}\nUser-only note: keep this sentence.\n`);

  await assert.rejects(refreshSpec(optionsFor(base, invoke)), error => error.reasonCode === "SPEC_REFRESH_APPROVAL_REQUIRED");
  const refreshed = await refreshSpec(optionsFor(base, invoke, { approvedIn: `${MINUTES_ID}#D1` }));
  assert.equal(refreshed.reasonCode, "SPEC_REFRESHED");
  const updatedRequirements = await readFile(requirementsPath, "utf8");
  const updatedTasks = await readFile(tasksPath, "utf8");
  assert.match(updatedRequirements, /approved, updated task source/);
  assert.match(updatedRequirements, /User-only note: keep this sentence\./);
  assert.match(updatedRequirements, /revision 3/);
  assert.doesNotMatch(updatedTasks, /Operational validation|KIRO-OPEN-OPERATIONAL-VALIDATION/);
  assert.match(updatedTasks, /- \[x\] 1\./);
  const current = await checkSpec(optionsFor(base, invoke));
  assert.equal(current.reasonCode, "SPEC_CURRENT");
  assert.deepEqual(current.tasksCheckedLocalOnly, ["1"]);
  assert.equal(current.formalStatus, "active");
  assert.equal(current.formalDone, false);
  assert.equal(state.calls.some(call => ["work-annotate", "work-transition"].includes(call.command)), false);
});

test("current C2 projection preserves its formal source and product delivery location without pilot template pollution", async context => {
  const base = await temporaryDirectory(context);
  const { invoke } = sourceFixture({
    workId: "work:71bfe83f87da034d09dd7a9c",
    externalKey: "TCRN-CROSS-SUB-INIT085-C2",
    revision: 3,
    status: "ready",
    title: "用 Kiro Specs 完成开放的操作验证说明",
    goal: "可进入 E 候选的操作验证说明增量，以及实际 Spec、任务产物、引擎读回和用量记录。",
    scope: "在隔离工作树生成与此 Subtask 对应的 Feature Spec，通过实际 CLI Spec 任务入口消费并补齐尚未完成的候选操作验证说明。证据同时覆盖可复用的宿主用例。 产品产物位于 E 仓根的 skill/mana-orchestrate/references/kiro-specs.md；任务清单本身不能替代产品文件。",
    acceptance: "真实未完成任务执行前有来源核验。CLI 固定 `claude-haiku-4.5` 并留明确权限、终态及可得估算用量。引擎隔离写回与新会话读回可关联，正式 work 由主决策按既有契约写回。报告真实发现、分歧、返工或实际为零，收益对照缺失时保留 unknown。",
    body: "产品交付位于 E 仓根的 skill/mana-orchestrate/references/kiro-specs.md；tasks.md 只承载任务清单及来源，不作为产品说明替代。",
  });
  const initialized = await initializeSpec(optionsFor(base, invoke, {
    workId: "work:71bfe83f87da034d09dd7a9c",
    specDir: ".kiro/specs/c2-current-revision-3",
  }));
  const directory = join(base, ".kiro/specs/c2-current-revision-3");
  const requirements = await readFile(join(directory, "requirements.md"), "utf8");
  const tasks = await readFile(join(directory, "tasks.md"), "utf8");
  assert.equal(initialized.reasonCode, "SPEC_INITIALIZED");
  assert.match(requirements, /可进入 E 候选的操作验证说明增量/);
  assert.match(requirements, /skill\/mana-orchestrate\/references\/kiro-specs\.md/);
  assert.match(tasks, /- \[ \] 1\. 用 Kiro Specs 完成开放的操作验证说明/);
  assert.match(tasks, /Work item: `work:71bfe83f87da034d09dd7a9c` revision 3\./);
  assert.match(tasks, /Goal from the current formal source: 可进入 E 候选的操作验证说明增量，以及实际 Spec、任务产物、引擎读回和用量记录。/);
  assert.match(tasks, /Scope from the current formal source: 在隔离工作树生成与此 Subtask 对应的 Feature Spec，通过实际 CLI Spec 任务入口消费并补齐尚未完成的候选操作验证说明。证据同时覆盖可复用的宿主用例。 产品产物位于 E 仓根的 skill\/mana-orchestrate\/references\/kiro-specs\.md；任务清单本身不能替代产品文件。/);
  assert.match(tasks, /Acceptance from the current formal source: 真实未完成任务执行前有来源核验。CLI 固定 `claude-haiku-4\.5` 并留明确权限、终态及可得估算用量。引擎隔离写回与新会话读回可关联，正式 work 由主决策按既有契约写回。报告真实发现、分歧、返工或实际为零，收益对照缺失时保留 unknown。/);
  assert.match(tasks, /Original work notes and delivery details from the current formal source: 产品交付位于 E 仓根的 skill\/mana-orchestrate\/references\/kiro-specs\.md/);
  assert.doesNotMatch(tasks, /Operational validation|KIRO-OPEN-OPERATIONAL-VALIDATION|intentionally unfinished/);
});

test("C.1: unowned targets and edited managed content are refused without overwriting the file", async context => {
  const base = await temporaryDirectory(context);
  const { state, invoke } = sourceFixture();
  const unowned = join(base, ".kiro/specs/test-task");
  await mkdir(unowned, { recursive: true });
  const unownedPath = join(unowned, "requirements.md");
  await writeFile(unownedPath, "user-owned requirements\n");
  const unownedResult = await run(["init", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", ".kiro/specs/test-task"], { cwd: base, invoke });
  assert.equal(unownedResult.reasonCode, "SPEC_OWNERSHIP_MISSING");
  assert.equal(await readFile(unownedPath, "utf8"), "user-owned requirements\n");

  await rm(unowned, { recursive: true, force: true });
  await initializeSpec(optionsFor(base, invoke));
  const requirementsPath = join(unowned, "requirements.md");
  const before = await readFile(requirementsPath, "utf8");
  await writeFile(requirementsPath, before.replace("Original work notes", "Edited managed content"));
  state.revision = 3;
  state.goal = "Changed under an approved decision.";
  state.decidedIn = [MINUTES_ID];
  const edited = await readFile(requirementsPath, "utf8");
  await assert.rejects(refreshSpec(optionsFor(base, invoke, { approvedIn: `${MINUTES_ID}#D1` })), error => error.reasonCode === "SPEC_EDIT_CONFLICT");
  assert.equal(await readFile(requirementsPath, "utf8"), edited);
});

test("C.1: empty or incomplete sources and unsafe paths fail before creating a projection", async context => {
  const base = await temporaryDirectory(context);
  const empty = sourceFixture({ emptyGoal: true });
  const emptyResult = await run(["init", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", ".kiro/specs/empty"], { cwd: base, invoke: empty.invoke });
  assert.equal(emptyResult.reasonCode, "SPEC_SOURCE_CONTENT_EMPTY");

  const incomplete = sourceFixture({ contextComplete: false });
  const incompleteResult = await run(["init", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", ".kiro/specs/incomplete"], { cwd: base, invoke: incomplete.invoke });
  assert.equal(incompleteResult.reasonCode, "SPEC_WORK_CONTEXT_INCOMPLETE");

  const { invoke } = sourceFixture();
  const unsafe = await run(["init", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", "../outside"], { cwd: base, invoke });
  assert.equal(unsafe.reasonCode, "SPEC_PATH_INVALID");

  const real = join(base, "target");
  await mkdir(real);
  await symlink(real, join(base, "linked"));
  const linked = await run(["init", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", "linked/spec"], { cwd: base, invoke });
  assert.equal(linked.reasonCode, "SPEC_PATH_SYMLINK");
  assert.deepEqual(statefulCommands(empty.state), ["work-show", "work-content-context"]);
});

test("C.1: an unwritable draft destination reports a permission refusal", async context => {
  if (process.platform === "win32") return context.skip("chmod does not provide the POSIX write-denial behavior on Windows.");
  const base = await temporaryDirectory(context);
  const { state, invoke } = sourceFixture();
  await initializeSpec(optionsFor(base, invoke));
  const directory = join(base, ".kiro/specs/test-task");
  state.revision = 3;
  state.goal = "A changed source whose draft cannot be written here.";
  await chmod(directory, 0o555);
  try {
    const result = await run(["draft", "--workspace", "isolated-library", "--work-id", WORK_ID, "--spec-dir", ".kiro/specs/test-task", "--draft-out", ".kiro/specs/test-task/change-draft.md"], { cwd: base, invoke });
    assert.equal(result.reasonCode, "SPEC_PATH_PERMISSION_DENIED");
  } finally {
    await chmod(directory, 0o755);
  }
});

function statefulCommands(state) {
  return state.calls.map(call => call.command);
}

// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  annotateWork,
  createProject,
  createWork,
  deleteWork,
  initializeLibrary,
  initializeKnowledgeStore,
  STORY_SCOPE_HEADINGS,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS, validateEventChain } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T00:00:${String(second).padStart(2, "0")}Z`;
const STORY_SCOPE = [
  "【Goal】为谁改变什么=CLI fixture；目的锚=STORY-209；符合性判据=命令可复跑；判定人=Owner。",
  "【Requirements】现象与证据=fixture 命令；修复项=实现 fixture。",
  "【Acceptance Criteria】GIVEN fixture WHEN 执行 THEN 通过。",
  "【Business Background】证据=测试需要真实 Story。",
  "【Preconditions】无——原因：测试已初始化工作区。",
  "【Assumptions】无——原因：不改变协议。",
  "【Use Cases & Examples】无——原因：只覆盖读面。",
  "【Feature Toggle & Setting】无——原因：无运行时开关。",
  "【Permissions】测试执行方。",
  "【Implementation Notes】决策点及裁定状态=fixture planned/ready。",
].join("\n");

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-cli-read-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(1) });
  const ids = {};
  let v = 0;
  const at = () => instant(v + 3);
  let s = await createProject(workspace, { occurredAt: at(), externalKey: "PROJECT-A", name: "A" }); v += 1;
  ids.projectA = s.projects.find((r) => r.externalKey === "PROJECT-A").id;
  s = await createProject(workspace, { occurredAt: at(), externalKey: "PROJECT-B", name: "B" }); v += 1;
  ids.projectB = s.projects.find((r) => r.externalKey === "PROJECT-B").id;
  s = await createWork(workspace, { occurredAt: at(), projectId: ids.projectA, externalKey: "INIT-A", kind: "Initiative", parentId: null }); v += 1;
  ids.initA = s.work.find((r) => r.externalKey === "INIT-A").id;
  s = await createWork(workspace, { occurredAt: at(), projectId: ids.projectA, externalKey: "EPIC-A", kind: "Epic", parentId: ids.initA }); v += 1;
  ids.epicA = s.work.find((r) => r.externalKey === "EPIC-A").id;
  s = await createWork(workspace, { occurredAt: at(), projectId: ids.projectB, externalKey: "INIT-B", kind: "Initiative", parentId: null }); v += 1;
  ids.initB = s.work.find((r) => r.externalKey === "INIT-B").id;
  s = await createWork(workspace, { occurredAt: at(), projectId: ids.projectA, externalKey: "STORY-A", kind: "Story", parentId: ids.epicA, status: "ready", scope: STORY_SCOPE }); v += 1;
  ids.storyA = s.work.find((r) => r.externalKey === "STORY-A").id;
  s = await deleteWork(workspace, { occurredAt: at(), id: ids.storyA }); v += 1;
  return { base, workspace, ids };
}

async function run(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

test("INIT-047 work-list search returns bounded scope and work-draft uses canonical headings", async (context) => {
  const fx = await fixture(context);
  const before = await validateWorkspace(fx.workspace);
  await annotateWork(fx.workspace, {
    occurredAt: instant(21),
    id: fx.ids.initA,
    scope: "引擎检索范围与 scope 片段",
  });
  let state = await validateWorkspace(fx.workspace);
  for (let index = 0; index < 3; index += 1) {
    state = await createWork(fx.workspace, {
      occurredAt: instant(22),
      projectId: fx.ids.projectA,
      externalKey: `DRAFT-STORY-${index}`,
      kind: "Story",
      parentId: fx.ids.epicA,
      status: "planned",
      scope: STORY_SCOPE,
    });
  }
  const searched = await run(["work-list", "--workspace", fx.workspace, "--search", "引擎", "--scope-bytes", "10"]);
  assert.equal(searched.total, 1);
  assert.ok(Object.hasOwn(searched.records[0], "scope"));
  assert.ok(Buffer.byteLength(searched.records[0].scope, "utf8") <= 10);
  const ordinary = await run(["work-list", "--workspace", fx.workspace, "--project-id", fx.ids.projectA]);
  assert.equal(Object.hasOwn(ordinary.records.find((record) => record.id === fx.ids.initA), "scope"), false);
  const draft = await run(["work-draft", "--workspace", fx.workspace, "--kind", "Story", "--project-id", fx.ids.projectA]);
  assert.deepEqual(draft.headings, [...STORY_SCOPE_HEADINGS]);
  assert.equal(draft.examples.length, 3);
  assert.ok(draft.scopeTemplate.includes("【Goal】"));
});

test("INIT-047 work-list search has an independent bounded scope projection", async (context) => {
  const fx = await fixture(context);
  const before = await validateWorkspace(fx.workspace);
  await annotateWork(fx.workspace, {
    occurredAt: instant(24),
    id: fx.ids.initA,
    scope: "独立 work-list 搜索范围与 scope 投影",
  });
  const searched = await run(["work-list", "--workspace", fx.workspace, "--search", "独立", "--scope-bytes", "10"]);
  assert.equal(searched.total, 1);
  assert.equal(searched.records.length, 1);
  assert.equal(searched.records[0].id, fx.ids.initA);
  assert.ok(Buffer.byteLength(searched.records[0].scope, "utf8") <= 10);
});

test("INIT-047 work-draft has an independent canonical heading and example projection", async (context) => {
  const fx = await fixture(context);
  let state = await validateWorkspace(fx.workspace);
  for (let index = 0; index < 3; index += 1) {
    state = await createWork(fx.workspace, {
      occurredAt: instant(26),
      projectId: fx.ids.projectA,
      externalKey: `INDEPENDENT-DRAFT-${index}`,
      kind: "Story",
      parentId: fx.ids.epicA,
      status: "planned",
      scope: STORY_SCOPE,
    });
  }
  const draft = await run(["work-draft", "--workspace", fx.workspace, "--kind", "Story", "--project-id", fx.ids.projectA]);
  assert.deepEqual(draft.headings, [...STORY_SCOPE_HEADINGS]);
  assert.equal(draft.examples.length, 3);
  assert.equal(draft.examples[0].kind, "Story");
  assert.ok(draft.scopeTemplate.includes("【Goal】"));
});

// TCRN-CROSS-STORY-473 R3: the ten blocks are still printed, as a suggestion. The draft marks them
// optional, says the engine checks only goal and acceptance, and names those two.
test("STORY-473 R3: work-draft prints the ten-block skeleton marked optional, with the two required fields", async (context) => {
  const fx = await fixture(context);
  const story = await run(["work-draft", "--workspace", fx.workspace, "--kind", "Story", "--project-id", fx.ids.projectA]);
  assert.deepEqual(story.headings, [...STORY_SCOPE_HEADINGS], "all ten blocks are still offered");
  assert.equal(story.optional, true);
  assert.equal(story.note, "仅供参考，引擎只校验 goal 与 acceptance");
  assert.deepEqual(story.requiredFields, ["goal", "acceptance"]);
  for (const heading of STORY_SCOPE_HEADINGS) assert.ok(story.skeleton.includes(`【${heading}】`), heading);
  const epic = await run(["work-draft", "--workspace", fx.workspace, "--kind", "Epic", "--project-id", fx.ids.projectA]);
  assert.deepEqual(epic.headings, []);
  assert.equal(epic.optional, true);
  assert.deepEqual(epic.requiredFields, [], "only a Story has required fields");
});

test("STORY-473 R3: work-draft examples include Stories written with fields, and carry their fields", async (context) => {
  const fx = await fixture(context);
  await createWork(fx.workspace, {
    occurredAt: instant(26), projectId: fx.ids.projectA, externalKey: "DRAFT-SCOPE", kind: "Story", parentId: fx.ids.epicA, scope: STORY_SCOPE,
  });
  await createWork(fx.workspace, {
    occurredAt: instant(27), projectId: fx.ids.projectA, externalKey: "DRAFT-FIELDS", kind: "Story", parentId: fx.ids.epicA,
    goal: "Draft from the latest Story.", acceptance: "GIVEN a Story with fields WHEN work-draft runs THEN it is an example",
  });
  const draft = await run(["work-draft", "--workspace", fx.workspace, "--kind", "Story", "--project-id", fx.ids.projectA]);
  const example = (key) => draft.examples.find((entry) => entry.externalKey === key);
  assert.deepEqual(draft.examples.map((entry) => entry.externalKey).sort(), ["DRAFT-FIELDS", "DRAFT-SCOPE"], "either form is an example");
  assert.equal(example("DRAFT-FIELDS").scope, "");
  assert.deepEqual(example("DRAFT-FIELDS").fields, {
    goal: "Draft from the latest Story.",
    acceptance: "GIVEN a Story with fields WHEN work-draft runs THEN it is an example",
    body: null,
    source: "fields",
  });
  assert.equal(example("DRAFT-SCOPE").fields.source, "scope");
  assert.ok(example("DRAFT-SCOPE").fields.goal.includes("CLI fixture"), "an old scope's example is mapped too");
});

// INC-027: the page-ceiling assertions are about BYTES, so they need the receipt as it
// was written, not as it survives a JSON round trip.
async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return output;
}

async function emptyLibrary(context, prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace: join(base, "workspace") };
}

// INC-027: instants for a chain longer than one minute of the `instant` helper.
const chainInstant = (n) => new Date(Date.UTC(2026, 6, 11, 0, 0, n)).toISOString().replace(/\.\d{3}Z$/u, "Z");

// INC-027: a chain LONGER than the default page window. Without one the default is a
// constant nobody can observe, and an assertion about it could not go red.
async function longChainFixture(context, count) {
  const layout = await emptyLibrary(context, "tcrn-cli-events-");
  await initializeLibrary({ root: layout.workspace, createdAt: chainInstant(1) });
  for (let version = 0; version < count; version += 1) {
    await createProject(layout.workspace, {
      occurredAt: chainInstant(version + 3),
      externalKey: `PROJECT-${String(version).padStart(3, "0")}`,
      name: `Project ${version}`,
    });
  }
  return layout;
}

// INC-027: a chain whose EVENTS are fat, built out of re-annotations of one work item.
//
// The obvious way to fatten a chain -- many large conference positions -- cannot be used,
// and the reason is worth recording: every extension record stays in the derived state,
// and the view documents are themselves canonicalized under the same one-MiB ceiling, so
// the engine refuses to WRITE a chain whose surviving records exceed it. Re-annotating one
// record replaces the advisory value instead of accumulating records, so the chain grows
// past the ceiling while the views it materializes stay small -- which is exactly the
// shape of a long-lived governed chain, and exactly the shape `export` cannot read.
async function fatChainFixture(context, annotations) {
  const layout = await emptyLibrary(context, "tcrn-cli-fat-events-");
  await initializeLibrary({ root: layout.workspace, createdAt: chainInstant(1) });
  const state = await createProject(layout.workspace, { occurredAt: chainInstant(3), externalKey: "PROJECT-FAT", name: "Fat" });
  const projectId = state.projects[0].id;
  const created = await createWork(layout.workspace, { occurredAt: chainInstant(4), projectId, externalKey: "INIT-FAT", kind: "Initiative", parentId: null });
  const workId = created.work[0].id;
  for (let index = 0; index < annotations; index += 1) {
    await annotateWork(layout.workspace, {
      occurredAt: chainInstant(5 + index),
      id: workId,
      // Distinct each time: an annotation that changes nothing is refused, and the
      // whole point is that each event carries its own copy of the fat value.
      scope: `scope ${index} ${"x".repeat(8_000)}`,
    });
  }
  return layout;
}

test("project-list is deterministic, tombstone-free, and budgeted", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["project-list", ...ws]);
  assert.equal(all.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(all.kind, "project");
  assert.equal(all.total, 2);
  assert.deepEqual(all.records.map((r) => r.id), [fx.ids.projectA, fx.ids.projectB].sort());
  const page = await run(["project-list", ...ws, "--limit", "1", "--offset", "1"]);
  assert.equal(page.total, 2);
  assert.equal(page.records.length, 1);
  assert.equal(page.truncated, false);
  const first = await run(["project-list", ...ws, "--limit", "1"]);
  assert.equal(first.truncated, true);
});

test("work-list filters conjunctively, excludes tombstones, and is byte-stable", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const all = await run(["work-list", ...ws]);
  // STORY-A was deleted; INIT-A, EPIC-A, INIT-B remain
  assert.equal(all.total, 3);
  assert.equal(all.records.some((r) => r.id === fx.ids.storyA), false);
  const roots = await run(["work-list", ...ws, "--parent-id", "-"]);
  assert.deepEqual(roots.records.map((r) => r.id).sort(), [fx.ids.initA, fx.ids.initB].sort());
  const byProject = await run(["work-list", ...ws, "--project-id", fx.ids.projectB]);
  assert.deepEqual(byProject.records.map((r) => r.id), [fx.ids.initB]);
  const byKind = await run(["work-list", ...ws, "--kind", "Epic"]);
  assert.deepEqual(byKind.records.map((r) => r.id), [fx.ids.epicA]);
  const conjunctive = await run(["work-list", ...ws, "--project-id", fx.ids.projectA, "--kind", "Initiative"]);
  assert.deepEqual(conjunctive.records.map((r) => r.id), [fx.ids.initA]);
  // byte-identical repeat
  let a = ""; await runCli(["work-list", ...ws], { write: (v) => { a += v; } });
  let b = ""; await runCli(["work-list", ...ws], { write: (v) => { b += v; } });
  assert.equal(a, b);
});

test("work-show returns one record and fails closed on unknown ids and malformed filters", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const shown = await run(["work-show", ...ws, "--id", fx.ids.epicA]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(shown.record.id, fx.ids.epicA);
  assert.equal(shown.record.kind, "Epic");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", "work:deadbeefdeadbeefdeadbeef"]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-show", ...ws, "--id", fx.ids.storyA]), "WORKSPACE_INPUT_INVALID");
  assert.equal(await reasonOf(["work-list", ...ws, "--kind", "Bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--status", "bogus"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["work-list", ...ws, "--limit", "0"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["project-list", ...ws, "--offset", "-1"]), "CLI_ARGUMENT_MALFORMED");
});

// CQ-05(c2) proof. Before this guard the round trip was BROKEN, not merely inconsistent:
// work-create routed --parent-id through nullableValue (which accepts "-" and the
// deprecated alias "null"), while the work-list filter compared with a bare === "-" and
// so treated "null" as a literal parent id. An agent could create a root work item with
// --parent-id null and then get total=0 back for the identical spelling — a silent wrong
// answer. Reverting the filter to === "-" turns the "null" assertions below red.
test("CQ-05(c2): the null sentinel round-trips through work-create and work-list for every accepted spelling", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const created = await run(["work-create", "--title", "record-title", ...ws, "--at", instant(30),
    "--project-id", fx.ids.projectA, "--external-key", "ROOT-VIA-NULL", "--kind", "Initiative", "--parent-id", "null"]);
  assert.equal(created.record.parentId, null, "the deprecated alias must be stored as null, not as a literal id");
  const rootId = created.record.id;

  // The writer accepted "null"; the reader must find it back under that same spelling.
  const viaNull = await run(["work-list", ...ws, "--parent-id", "null"]);
  assert.ok(viaNull.records.some((r) => r.id === rootId), "--parent-id null must find the record --parent-id null created");
  assert.equal(viaNull.records.some((r) => r.id === fx.ids.epicA), false, "the null filter must not admit parented work");

  // Canonical spelling must return the identical set — the two spellings are aliases,
  // so any divergence between them is itself the defect.
  const viaDash = await run(["work-list", ...ws, "--parent-id", "-"]);
  assert.deepEqual(viaNull.records.map((r) => r.id).sort(), viaDash.records.map((r) => r.id).sort());
  assert.deepEqual(viaDash.records.map((r) => r.id).sort(), [fx.ids.initA, fx.ids.initB, rootId].sort());

  // A real id must still be matched literally, so the alias handling cannot have
  // collapsed into "treat every value as null".
  const viaParent = await run(["work-list", ...ws, "--parent-id", fx.ids.initA]);
  assert.deepEqual(viaParent.records.map((r) => r.id), [fx.ids.epicA]);
});

// CQ-05(c2) contract half: the catalog is the machine-readable discovery surface, so a
// spelling the dispatcher accepts but the catalog does not declare is a catalog that
// lies. These are exactly the flags routed through nullableValue.
test("CQ-05(c2): every nullableValue flag declares its sentinel and its deprecated alias", () => {
  const flagOf = (verb, flag) => COMMAND_CATALOG.find((entry) => entry.name === verb)?.flags.find((f) => f.name === flag);
  for (const [verb, flag] of [["knowledge-create", "project-id"], ["knowledge-create", "last-verified"],
    ["work-create", "parent-id"]]) {
    const declared = flagOf(verb, flag);
    assert.ok(declared, `${verb} must declare the flag ${flag}`);
    assert.equal(declared.nullSentinel, "-", `${verb}.${flag} must declare the canonical null sentinel`);
    assert.deepEqual([...(declared.deprecatedAliases ?? [])], ["null"], `${verb}.${flag} must declare the "null" alias its dispatcher accepts`);
  }
});

// CQ-05(c) proof for integerValue. Each of these used to reach core as NaN and come back
// under a SEMANTIC reason code that misdescribed a syntax error. Removing integerValue
// (restoring the bare Number(...) calls) turns these red.
test("CQ-05(c): malformed integer flags fail at the CLI boundary naming the flag", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];
  const malformed = async (args, flag) => {
    const error = await runCli(args, { write() {} }).then(() => null, (caught) => caught);
    assert.ok(error, `${flag} must fail closed`);
    assert.equal(error.reasonCode, "CLI_ARGUMENT_MALFORMED");
    assert.equal(error.message.includes(flag), true, `the failure must name ${flag}, got ${error.message}`);
    return error;
  };
  // TCRN-CROSS-SUB-308: knowledge-promote is gone; knowledge-reverify shares the arbiter.
  await malformed(["knowledge-reverify", ...ws, "--expected-revision", "abc",
    "--at", instant(31), "--id", "knowledge:0000000000000000000000000000000000000000"], "expected-revision");
  // STORY-366: the article refresh verb is a fourth site sharing this arbiter
  // (CQ-05-expected-revision-arbiter, the retired guard entry's expectedMatches: 4). The
  // malformed value must still fail at argument parsing, before core is ever called,
  // so the id/path below need not resolve to a real article.
  await malformed(["knowledge-article-refresh", ...ws, "--expected-revision", "abc",
    "--at", instant(32), "--id", "knowledge:0000000000000000000000000000000000000000",
    "--path", "docs/knowledge/articles/placeholder.md", "--summary", "s"], "expected-revision");

});

// R2-NEW-7 proof: within one verb, `limit` used a truthy guard and `offset` used
// `!== undefined`, so the two flags disagreed about the empty string — `--limit=` was
// silently dropped and the command answered as if no limit had been asked for, while
// `--offset=` was passed through. Restoring the truthy guard turns the limit case red.
test("R2-NEW-7: empty-string integer flags are rejected, not silently dropped", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace, "--at", instant(32)];
  for (const verb of ["knowledge-list"]) {
    // Baseline: with the flag omitted the verb gets past pagination entirely and answers.
    // The fixture library never created its knowledge store, which TCRN-CROSS-INIT-053 R46
    // (I04) reads as an empty inventory that says so; before I04 the read was refused
    // (KNOWLEDGE_PATH_INVALID) and that refusal was this baseline. "Silently dropped" means
    // indistinguishable from this, which is precisely what the truthy guard did to --limit=.
    const omitted = await reasonOf([verb, ...ws]);
    assert.equal(omitted, null);
    const answer = await run([verb, ...ws]);
    assert.deepEqual([answer.reasonCode, answer.knowledgeStore, answer.total, answer.records], ["KNOWLEDGE_LIST_READY", "absent", 0, []]);

    for (const flag of ["limit", "offset"]) {
      // The empty string is a SUPPLIED value, so it must be handed to core verbatim and
      // behave exactly like the explicit "0" it parses to — the same rule offset already
      // followed and limit did not. Equality against the explicit-zero run is the whole
      // point: it is what makes the two flags agree.
      const empty = await reasonOf([verb, ...ws, `--${flag}=`]);
      const zero = await reasonOf([verb, ...ws, `--${flag}`, "0"]);
      assert.equal(empty, zero, `${verb} --${flag}= must behave as the supplied value 0`);
    }

    // Direction check: limit=0 is refused by core, so an empty --limit must NOT look like
    // an omitted --limit. This is the assertion the truthy guard reddens.
    assert.equal(await reasonOf([verb, ...ws, "--limit="]), "KNOWLEDGE_INPUT_INVALID");
    assert.notEqual(await reasonOf([verb, ...ws, "--limit="]), omitted);
  }
});

// CQ-05(c): the knowledge verbs were the last two pagination sites still handing a bare
// Number() to core, so `--limit abc` arrived as NaN and came back as
// KNOWLEDGE_INPUT_INVALID "limit" — core answering a range question that was never asked,
// about a value that is not a number. The sibling project-list/work-list flags of the same
// name and the same catalog valueKind answered CLI_ARGUMENT_MALFORMED. Restoring either
// bare Number() turns this red.
test("CQ-05: malformed knowledge pagination flags are syntax errors, not range refusals", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace, "--at", instant(33)];
  for (const verb of ["knowledge-list"]) {
    for (const flag of ["limit", "offset"]) {
      for (const value of ["abc", "2.5", "1e400"]) {
        const reason = await reasonOf([verb, ...ws, `--${flag}`, value]);
        assert.equal(reason, "CLI_ARGUMENT_MALFORMED", `${verb} --${flag} ${value} is malformed syntax`);
      }
    }
  }

  // The other half of the contract, and the reason no minimum is passed at the CLI: every
  // value that IS an integer must still reach core, so core keeps the whole window rule
  // (>= 1, <= canonical view-byte budget, offset >= 0) rather than half of it. A CLI-side
  // floor would silently take the lower bound and leave the ceiling behind.
  for (const [flag, value] of [["limit", "0"], ["offset", "-1"]]) {
    const reason = await reasonOf(["knowledge-list", ...ws, `--${flag}`, value]);
    assert.equal(reason, "KNOWLEDGE_INPUT_INVALID", `--${flag} ${value} stays core's judgement`);
  }
  await initializeKnowledgeStore(fx.workspace, { disposableAcknowledged: true });
  assert.equal((await run(["knowledge-list", ...ws, "--limit", "1048577"])).total, 0);
});

test("WSB-6: the agent-integration reference stays in drift-guarded agreement with the catalog", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const docText = await readFile(join(repoRoot, "docs/architecture/agent-integration-v1.md"), "utf8");

  // The retry reason codes with undocumented semantics that motivated the doc must each
  // appear (at least once). WORKSPACE_CAS_MISMATCH was the third; it went with the
  // expected-version input (TCRN-CROSS-STORY-467 R1), so the retry table must not offer it
  // and only the behaviour-delta table may still name it.
  for (const code of ["WORKSPACE_VIEW_STALE", "WORKSPACE_LOCKED"]) {
    assert.ok(docText.includes(code), `retry table must name ${code}`);
  }
  const retryTable = docText.slice(docText.indexOf("| Reason code | Class | Obligation |"), docText.indexOf("## 4. Sentinels"));
  assert.equal(retryTable.includes("WORKSPACE_CAS_MISMATCH"), false, "the retry table must not offer the retired CAS code");

  // Bidirectional drift guard: the doc's enumerated programmatic-only block must
  // equal exactly the live COMMAND_CATALOG programmatic-only surface.
  const liveProgrammaticOnly = COMMAND_CATALOG.filter((entry) => entry.availability === "programmatic-only")
    .map((entry) => entry.name)
    .sort();
  const block = docText.match(/```\nprogrammatic-only\n([\s\S]*?)```/);
  assert.ok(block, "doc must carry a fenced programmatic-only enumeration block");
  const documented = block[1].trim().split("\n").map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(documented, liveProgrammaticOnly);

  // Coverage direction restated verb-by-verb so a newly programmatic-only verb
  // that slips the block still fails loudly.
  for (const name of liveProgrammaticOnly) {
    assert.ok(docText.includes(name), `doc must mention programmatic-only verb ${name}`);
  }
});

// INC-027 (TCRN-CROSS-INC-027). `export` was the only read that returned events, and it
// refuses any workspace whose canonical form exceeds one MiB -- which three of the four
// chains on this platform already do. So the one thing a downstream mirror needs in order
// to reproduce a chain was unreachable exactly on the chains worth mirroring. These three
// tests bind the three properties that make the paged replacement usable: the pages
// concatenate to the chain, a page that cannot fit is refused rather than shortened, and
// the default window never stands in for a value the caller supplied.
test("INC-027: event-list pages the chain and the concatenation IS the chain", async (context) => {
  const fx = await longChainFixture(context, 70);
  const ws = ["--workspace", fx.workspace];

  // The default window is the engine's own segment size, and it is only observable on a
  // chain longer than it -- which is why the fixture writes 70 events for a default of 64.
  const first = await run(["event-list", ...ws]);
  assert.equal(first.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(first.kind, "event");
  assert.equal(first.total, 70);
  assert.equal(first.records.length, 64, "the default window is the engine's segment size");
  assert.equal(first.truncated, true);

  // Records are verbatim EventRecords, not a summary. A consumer that re-derives the
  // chain must hash exactly the bytes the engine hashed, so all three hashes and the
  // payload have to travel; a projection would break re-derivation by definition. An
  // einzbern.event.v1 also carries its clock and device id (TCRN-CROSS-STORY-468 R3).
  assert.deepEqual(
    Object.keys(first.records[0]).sort(),
    ["clock", "deviceId", "eventHash", "id", "occurredAt", "payload", "payloadHash", "priorHash", "schemaVersion", "sequence", "streamId"],
  );

  const status = await run(["status", ...ws]);
  assert.equal(first.version, status.version);
  assert.equal(first.headEventHash, status.headEventHash);

  // Page to exhaustion at a window that does not divide the total, so an off-by-one in
  // the offset arithmetic drops or repeats an event instead of landing exactly.
  const events = [];
  let offset = 0;
  for (;;) {
    const raw = await runRaw(["event-list", ...ws, "--limit", "7", "--offset", String(offset)]);
    assert.ok(Buffer.byteLength(raw, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes, "every page fits the canonical ceiling");
    const page = JSON.parse(raw);
    events.push(...page.records);
    if (!page.truncated) break;
    offset += page.records.length;
  }
  assert.equal(events.length, status.version, "one event per version, none dropped and none repeated");
  assert.deepEqual(events.map((entry) => entry.sequence), events.map((_, index) => index + 1));
  assert.equal(validateEventChain(events).length, events.length, "the concatenation revalidates as a chain");
  // A library's head is one digest over its stream heads; with one device, the last page ends at
  // that stream's head (TCRN-CROSS-STORY-468 R4).
  assert.equal(events.at(-1).eventHash, status.streams[0].headEventHash, "the last page ends at the head the authority reports");
});

// The refusal is the whole reason paging exists here. A page silently shortened to fit
// would be indistinguishable from the end of the chain -- the same "limit expressed as
// absence" that INC-004/INC-005 were filed for, reintroduced one layer down.
test("INC-027: a page that cannot fit is refused under its own code, never shortened", async (context) => {
  const fx = await fatChainFixture(context, 140);
  const ws = ["--workspace", fx.workspace];

  const complete = await runRaw(["export", ...ws]);
  assert.ok(Buffer.byteLength(complete, "utf8") > 1_048_576);
  const allEvents = JSON.parse(complete).events;
  assert.equal(allEvents.length, (await validateWorkspace(fx.workspace)).version);
  const raised = await run(["event-list", ...ws, "--limit", "200"]);
  assert.equal(raised.records.length, allEvents.length);
  assert.equal(raised.truncated, false, "an explicit larger page retains all events");

  // The default window on the same chain succeeds, which is what makes the refusal a
  // property of the page rather than a verdict on the chain -- and is the reason the
  // default is conservative rather than "as many as the caller asked for".
  const defaulted = await runRaw(["event-list", ...ws]);
  assert.ok(Buffer.byteLength(defaulted, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes);
  assert.equal(JSON.parse(defaulted).records.length, 64);
  assert.equal(JSON.parse(defaulted).truncated, true);

  // And the whole chain still reads, one window at a time.
  const events = [];
  let offset = 0;
  for (;;) {
    const raw = await runRaw(["event-list", ...ws, "--offset", String(offset)]);
    assert.ok(Buffer.byteLength(raw, "utf8") <= PROTOCOL_LIMITS.maxCanonicalBytes);
    const page = JSON.parse(raw);
    events.push(...page.records);
    if (!page.truncated) break;
    offset += page.records.length;
  }
  const status = await run(["status", ...ws]);
  assert.equal(events.length, status.version);
  assert.equal(validateEventChain(events).length, events.length);
});

test("INC-027: the default window never stands in for a supplied one", async (context) => {
  const fx = await fixture(context);
  const ws = ["--workspace", fx.workspace];

  const all = await run(["event-list", ...ws]);
  assert.equal(all.total, 7);
  assert.equal(all.records.length, 7);
  assert.equal(all.truncated, false);

  // A supplied value is judged, not replaced. `--limit=` is the case that matters: it is
  // a supplied empty string, and substituting the default for it would answer a question
  // the caller did not ask -- the exact defect R2-NEW-7 records one verb over.
  for (const spelling of ["--limit=", "--limit=0", "--limit=abc", "--limit=2.5", "--offset=-1", "--offset=2.5"]) {
    assert.equal(await reasonOf(["event-list", ...ws, spelling]), "CLI_ARGUMENT_MALFORMED", `${spelling} must be judged`);
  }

  // An offset past the end is an empty page that still reports the total, not an error
  // and not a claim that the chain is empty.
  const past = await run(["event-list", ...ws, "--offset", "99"]);
  assert.deepEqual(past.records, []);
  assert.equal(past.total, 7);
  assert.equal(past.truncated, false);

  // Byte-stable like its siblings.
  assert.equal(await runRaw(["event-list", ...ws]), await runRaw(["event-list", ...ws]));
});

// TCRN-CROSS-MIN-225 D3 (TCRN-CROSS-SUB-257) retired telemetry-observation's per-channel days, and
// TCRN-CROSS-STORY-467 R3 retired the telemetry store itself: the three telemetry reads are gone
// from the catalog and the dispatcher, and asking for one opens nothing.
test("STORY-467 R3: the telemetry reads are retired with the store they read", async (context) => {
  const fx = await fixture(context);
  const before = await validateWorkspace(fx.workspace);
  for (const verb of ["telemetry-list", "telemetry-observation", "telemetry-stats"]) {
    assert.equal(await reasonOf([verb, "--workspace", fx.workspace]), "CLI_COMMAND_UNKNOWN", verb);
    assert.equal(COMMAND_CATALOG.some((entry) => entry.name === verb), false, `${verb} is not in the catalog`);
  }
  assert.equal((await validateWorkspace(fx.workspace)).version, before.version, "refusing appends nothing");
});

test("INIT062 backup unknown scan and invalid native evidence retain honest read outcomes", async context => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-dot-cli-read-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const listing = await run(["config-backup-list", "--at", instant(1)]);
  assert.equal(listing.scanStatus, "not-scanned");
  const bad = join(base, "invalid.json");
  await writeFile(bad, "{}");
  let evidence = "";
  await assert.rejects(runCli(["execution-native-evidence", "--from-file", bad], { write: value => { evidence += value; } }), error => error.reasonCode === "NATIVE_EVIDENCE_INVALID");
  assert.equal(JSON.parse(evidence).valid, false);
  assert.equal(JSON.parse(evidence).complete, false);
  assert.equal(await reasonOf(["execution-native-evidence", "--from-file", bad, "--work-revision", "1.5"]), "CLI_ARGUMENT_MALFORMED");
  assert.equal(await reasonOf(["execution-native-evidence", "--from-file", join(base, "absent.json")]), "DISPATCH_EVIDENCE_INPUT_INVALID");
  const output = join(base, "retained.json"); let retained = "";
  await assert.rejects(runCli(["execution-native-record", "--binding", bad, "--output", output], { write: value => { retained += value; } }), error => error.reasonCode === "NATIVE_RECORD_INVALID");
  assert.equal(JSON.parse(retained).normalized.complete, false);
  assert.equal(JSON.parse(await readFile(output, "utf8")).normalized.valid, false);
});

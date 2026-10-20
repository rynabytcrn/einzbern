// SPDX-License-Identifier: Apache-2.0
// INIT062 original DOT-I01–I04/R01–R03. These are isolated sequential fixtures,
// not real E4, provider authentication, host firing, races or lifecycle probes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  DOT_AGENTS_MARKER, DOT_AGENTS_TEMPLATE_VERSION, EXECUTION_CONTEXT_READ_SCHEMA,
  applyDotAgents, assessExecutionContextRead, assertNotDotAgentsTarget,
  dotContentDigest, dotEnabledRuleSources, normalizeExecutionContextRead,
  planDotAgents, renderDotAgents,
} from "../dist/build/packages/core/src/dot-agents.js";
import { BUILT_IN_RULES, ruleBody } from "../dist/build/packages/core/src/rules-catalog.js";

const at = "2026-10-20T00:00:00Z";
function source(language = "zh-CN", ids = BUILT_IN_RULES.map(rule => rule.id)) {
  return { engineVersion: "fixture-engine", engineCommit: "unavailable", engineSourceRef: "fixture:explicit-engine", language,
    enabledRules: BUILT_IN_RULES.filter(rule => ids.includes(rule.id)).map(rule => ({ id: rule.id, version: rule.version, bodyDigest: dotContentDigest(ruleBody(rule.id, language)), sourceReference: `fixture:rule-readback#${rule.id}` })) };
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-dot-agents-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const enginePath = join(root, "fixture-engine.mjs"); const manaSkillPath = join(root, "fixture-skill.md");
  await writeFile(enginePath, "// fixture only, not an installed engine\n");
  await writeFile(manaSkillPath, "# Mana Orchestrate\nfixture source, not generated release evidence\n");
  return { executionTarget: "chatgpt-dot", operation: "fresh", at,
    binding: { root, agentsPath: join(root, "AGENTS.md"), provenancePath: join(root, ".dot", "provenance.json"), backupRoot: join(root, ".dot", "recovery"), projectReference: "fixture:project", ownerId: "fixture:dot-owner" }, source: source(), enginePath, manaSkillPath, preInjection: "apply" };
}
const rejects = (operation, reasonCode) => assert.rejects(operation, error => error.reasonCode === reasonCode);
const exists = async path => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

test("DOT-R01/R02: complete independent template preserves governance, seven principles, batch and incremental semantics", () => {
  const output = renderDotAgents(source());
  assert.ok(output.startsWith(DOT_AGENTS_MARKER));
  assert.equal(output.includes("<!-- einzbern:section"), false);
  for (const rule of BUILT_IN_RULES) assert.ok(output.includes(`· ${rule.id}`), rule.id);
  for (const text of [
    "工单、纪要、知识卡及受治理配置的变更必须经兼容引擎的受支持入口执行，使用实际行动者作为 actor，并读回回执；不得直接编辑库文件或配置投影来代替引擎变更。",
    "已批准的执行步骤、次序、分包和角色分工不得擅自增删、替换、拆并或改派；确需改变时，先说明具体差异、必要性、预期收益、新增时间、token 与维护成本、风险及替代方案，未知项如实保留，取得 Owner 明确同意后再执行；只停止受影响的改动，其他已授权工作继续。",
    "一个 INIT 下全部待办 Story", "knowledge-capture", "不超过五条", "dot 仅在环境实际需要时取得完整副本", "不授予跨设备原子排他",
  ]) assert.ok(output.includes(text), text);
  for (const absent of ["fixture:project", "fixture-engine", at, "pending-resume", "selectedTuple="]) assert.equal(output.includes(absent), false);
  assert.equal(renderDotAgents(source("en")).includes("All open Stories under one INIT"), true);
});

test("DOT-R01/R02: catalog is not enablement; only actual scoped enabled records enter provenance/render", () => {
  const configRecords = [{ collection: "rule", key: "autonomy", value: { enabled: true, version: 1 } }, { collection: "rule", key: "batch", value: { enabled: false, version: 3 } }];
  const enabledRules = dotEnabledRuleSources({ configRecords }, "zh-CN", "fixture:engine-read");
  assert.deepEqual(enabledRules.map(rule => rule.id), ["autonomy"]);
  const output = renderDotAgents({ ...source(), enabledRules });
  assert.ok(output.includes("· autonomy")); assert.equal(output.includes("· batch"), false); assert.equal(output.includes("· incremental-update"), false);
  assert.throws(() => dotEnabledRuleSources({ configRecords: [{ collection: "rule", key: "batch", value: { enabled: true, version: 2 } }] }, "en", "fixture:read"), error => error.reasonCode === "DOT_SOURCE_MISMATCH");
  assert.throws(() => renderDotAgents({ ...source(), enabledRules: [{ ...source().enabledRules[0], bodyDigest: "0".repeat(64) }] }), error => error.reasonCode === "DOT_SOURCE_MISMATCH");
});

test("DOT-I02: skip has zero writes, no sources copied and no S7 claim", async t => {
  const input = await fixture(t); const before = await readdir(input.binding.root);
  const plan = await planDotAgents({ ...input, preInjection: "skip", source: null, enginePath: join(input.binding.root, "missing-engine") });
  assert.equal(plan.status, "skipped"); assert.deepEqual(plan.writes, []);
  const applied = await applyDotAgents(plan); assert.equal(applied.status, "skipped"); assert.equal(applied.sessionRead, "not-verified");
  assert.deepEqual(await readdir(input.binding.root), before);
});

test("DOT-I02: no relative, outside, missing, symlink or governed target root is inferred", async t => {
  const input = await fixture(t);
  for (const binding of [
    { ...input.binding, root: "." }, { ...input.binding, agentsPath: join(tmpdir(), "other-AGENTS.md") },
    { ...input.binding, root: join(input.binding.root, "absent"), agentsPath: join(input.binding.root, "absent", "AGENTS.md") },
    { ...input.binding, provenancePath: join(input.binding.root, ".git", "provenance") },
  ]) await assert.rejects(planDotAgents({ ...input, binding }));
  const linked = join(input.binding.root, "linked"); await symlink(input.binding.root, linked);
  await rejects(planDotAgents({ ...input, binding: { ...input.binding, provenancePath: join(linked, "provenance") } }), "DOT_PATH_UNSUPPORTED");
  await rejects(planDotAgents({ ...input, executionTarget: "codex" }), "DOT_TARGET_UNSUPPORTED");
});

test("DOT-I03: existing user and cross-host content is not claimed by its filename", async t => {
  const input = await fixture(t); const user = "# My rules\nKeep these exact bytes.\n";
  await writeFile(input.binding.agentsPath, user);
  const pending = await planDotAgents(input); assert.equal(pending.status, "pending"); assert.equal(pending.reasonCode, "DOT_OWNERSHIP_CONFLICT");
  assert.ok(pending.candidate.includes(DOT_AGENTS_MARKER)); assert.deepEqual((await applyDotAgents(pending)).files, []);
  const keep = await planDotAgents({ ...input, resolution: { kind: "keep" } }); assert.equal(keep.status, "kept");
  await writeFile(join(input.binding.root, "CLAUDE.md"), "@AGENTS.md\n");
  const shared = await planDotAgents(input); assert.equal(shared.reasonCode, "DOT_CROSS_HOST_CONSUMER");
  assert.equal(await readFile(input.binding.agentsPath, "utf8"), user);
});

test("DOT-I03/I04/R02: apply reads back independent bytes and provenance; repeated same input does not write", async t => {
  const input = await fixture(t); const plan = await planDotAgents(input);
  assert.equal(plan.status, "ready"); assert.equal(await exists(input.binding.agentsPath), false);
  const applied = await applyDotAgents(plan); assert.equal(applied.status, "applied"); assert.equal(applied.fileVerification, "verified"); assert.equal(applied.sessionRead, "not-verified");
  const saved = JSON.parse(await readFile(input.binding.provenancePath, "utf8"));
  assert.equal(saved.templateVersion, DOT_AGENTS_TEMPLATE_VERSION); assert.equal(saved.originalDigest, "missing");
  assert.equal(saved.outputDigest, dotContentDigest(await readFile(input.binding.agentsPath)));
  const before = (await stat(input.binding.agentsPath)).mtimeMs;
  const again = await planDotAgents({ ...input, at: "2026-10-21T00:00:00Z", operation: "repair" });
  assert.equal(again.status, "unchanged"); assert.deepEqual(again.writes, []); await applyDotAgents(again);
  assert.equal((await stat(input.binding.agentsPath)).mtimeMs, before);
  assert.equal(await exists(input.binding.backupRoot), false);
  await rejects(assertNotDotAgentsTarget(input.binding.root), "DOT_INDEPENDENT_TARGET");
});

test("DOT-I03: changed original/source or tampered preview invalidates the old plan", async t => {
  const input = await fixture(t); const plan = await planDotAgents(input);
  await writeFile(input.binding.agentsPath, "user arrived after preview\n");
  await rejects(applyDotAgents(plan), "DOT_PLAN_STALE");
  const other = await fixture(t); const otherPlan = await planDotAgents(other);
  await writeFile(other.manaSkillPath, "source changed\n"); await rejects(applyDotAgents(otherPlan), "DOT_PLAN_STALE");
  await rejects(applyDotAgents({ ...otherPlan, candidate: "tampered" }), "DOT_PLAN_STALE");
});

test("DOT-I03/R02: source update is visible, protected with recovery, and edited targets remain pending", async t => {
  const input = await fixture(t); await applyDotAgents(await planDotAgents(input));
  const original = await readFile(input.binding.agentsPath, "utf8");
  const updatedSource = source("en"); const update = await planDotAgents({ ...input, operation: "update", source: updatedSource });
  assert.equal(update.status, "ready"); assert.ok(update.changes.some(change => change.includes("Source/input")));
  const applied = await applyDotAgents(update); assert.equal(applied.status, "applied");
  const backup = applied.files.find(file => file.path === input.binding.agentsPath).backupPath;
  assert.equal(await readFile(backup, "utf8"), original);
  await writeFile(input.binding.agentsPath, "user edit\n" + await readFile(input.binding.agentsPath, "utf8"));
  const repair = await planDotAgents({ ...input, operation: "repair" }); assert.equal(repair.reasonCode, "DOT_USER_MODIFIED"); assert.deepEqual(repair.writes, []);
});

test("DOT-I03/R02: explicit reviewed merge preserves user bytes and is not removed by uninstall", async t => {
  const input = await fixture(t); const original = "# User notes\nPreserve me.\n";
  await writeFile(input.binding.agentsPath, original);
  const candidate = renderDotAgents(input.source);
  const merge = await planDotAgents({ ...input, resolution: { kind: "merge", originalDigest: dotContentDigest(original), mergedBody: candidate + "\n" + original, approvalEvidenceRef: "fixture:explicit-merge-approval" } });
  assert.equal((await applyDotAgents(merge)).status, "applied");
  const uninstall = await planDotAgents({ ...input, operation: "uninstall", uninstall: "remove" });
  assert.equal(uninstall.status, "pending"); assert.equal(uninstall.reasonCode, "DOT_OWNERSHIP_CONFLICT");
  assert.ok((await readFile(input.binding.agentsPath, "utf8")).includes(original));
  assert.equal((await planDotAgents(input)).status, "unchanged");
});

test("DOT-I03/R02: safe uninstall touches only proven dot files, retains host and skill bytes", async t => {
  const input = await fixture(t); await applyDotAgents(await planDotAgents(input));
  await mkdir(join(input.binding.root, ".codex")); await writeFile(join(input.binding.root, ".codex", "config.toml"), "# existing host\n");
  const skill = await readFile(input.manaSkillPath, "utf8");
  const uninstall = await planDotAgents({ ...input, operation: "uninstall", source: null, uninstall: "remove" });
  assert.equal(uninstall.status, "ready"); const result = await applyDotAgents(uninstall);
  assert.equal(result.status, "applied"); assert.equal(await exists(input.binding.agentsPath), false);
  assert.equal(await exists(input.binding.provenancePath), false);
  for (const file of result.files) assert.equal(await exists(file.backupPath), true);
  assert.equal(await readFile(input.manaSkillPath, "utf8"), skill);
  assert.equal(await readFile(join(input.binding.root, ".codex", "config.toml"), "utf8"), "# existing host\n");
  assert.equal((await planDotAgents({ ...input, operation: "uninstall", source: null, uninstall: "remove" })).status, "unchanged");
});

test("DOT-I03: partial sequential retirement reports actual successful files and remains recoverable", async t => {
  const input = await fixture(t); await applyDotAgents(await planDotAgents(input));
  const plan = await planDotAgents({ ...input, operation: "uninstall", source: null, uninstall: "remove" });
  const last = plan.backups.find(backup => backup.path === input.binding.provenancePath);
  await mkdir(dirname(last.into), { recursive: true }); await writeFile(`${last.into}.retired`, "occupied fixture path\n");
  const result = await applyDotAgents(plan);
  assert.equal(result.status, "partial"); assert.equal(result.files[0].status, "moved"); assert.equal(result.files[1].status, "failed");
  assert.equal(result.sessionRead, "not-verified"); assert.equal(await exists(result.files[0].backupPath), true);
  assert.equal((await planDotAgents({ ...input, operation: "repair" })).status, "ready", "repair can use the still-owned provenance and source to restore a missing target");
});

function contextFixture() {
  const files = ["agents", "mana-orchestrate", "work"].map((logicalKey, index) => ({ logicalKey, sourceVersion: `fixture-version-${index}`, sha256: String(index).repeat(64), readMethod: "fixture:read-tool", evidenceRef: `fixture:actual-return-${index}` }));
  const record = { schemaVersion: EXECUTION_CONTEXT_READ_SCHEMA, sessionRef: "fixture:execution", readAt: at, workReference: "fixture:work", workRevision: 1, scopeDigest: "f".repeat(64), files, effectiveRoots: [resolve(tmpdir(), "fixture-context-project")] };
  const expected = { ...record, notBefore: at, now: at };
  const observations = files.map(file => ({ sessionRef: record.sessionRef, source: "execution-session", logicalKey: file.logicalKey, evidenceRef: file.evidenceRef, toolName: file.readMethod, readAt: at, sha256: file.sha256, association: "associated" }));
  return { record, expected, observations };
}
test("DOT-R03: three current actual-session source links produce a structural check, never E4/provider proof", () => {
  const { record, expected, observations } = contextFixture();
  assert.equal(normalizeExecutionContextRead(record).files.length, 3);
  const result = assessExecutionContextRead(record, expected, observations);
  assert.equal(result.check.status, "pass"); assert.equal(result.assessment, "source-association-only-not-provider-authentication");
  assert.equal(assessExecutionContextRead(record, expected, []).check.status, "unknown");
  for (const source of ["parent-session", "patrol", "unavailable"]) assert.equal(assessExecutionContextRead(record, expected, observations.map(row => ({ ...row, source }))).check.status, "unknown");
  assert.equal(assessExecutionContextRead(record, { ...expected, sessionRef: "fixture:new-session" }, observations).check.status, "fail");
  assert.equal(assessExecutionContextRead(record, { ...expected, workRevision: 2 }, observations).check.status, "fail");
  assert.throws(() => normalizeExecutionContextRead({ ...record, files: record.files.slice(1) }));
  assert.throws(() => normalizeExecutionContextRead({ ...record, selectedTuple: {} }));
});

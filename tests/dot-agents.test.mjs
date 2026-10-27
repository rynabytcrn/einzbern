// SPDX-License-Identifier: Apache-2.0
// INIT062 original DOT-I01–I04/R01–R03. These are isolated sequential fixtures,
// not real E4, provider authentication, host firing, races or lifecycle probes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  DOT_AGENTS_MARKER, DOT_AGENTS_TEMPLATE_VERSION, EXECUTION_CONTEXT_READ_SCHEMA, DOT_EXTENSION_SOURCE_VARIABLE, readDotExtensionSource,
  applyDotAgents, assessExecutionContextRead, assertNotDotAgentsTarget,
  dotContentDigest, dotEnabledRuleSources, normalizeExecutionContextRead,
  planDotAgents, renderDotAgents,
} from "../dist/build/packages/core/src/dot-agents.js";
import { AUTONOMY_RESTRICTION_SCOPE_BODY, AUTONOMY_AUTHORIZATION_BODY, BRANCH_LIFECYCLE_BODY, BUILT_IN_RULES, ruleBody } from "../dist/build/packages/core/src/rules-catalog.js";

import { validateConfigBackupPayload } from "../dist/build/packages/core/src/config-backup.js";
import { variableExportDecision } from "../dist/build/packages/core/src/variables.js";

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

test("INIT-062 universal rule supplements are shared bilingual enabled-only dot consumers, not new permissions", async () => {
  for (const [language, suffix] of [["zh-CN", "zh"], ["en", "en"]]) {
    for (const id of ["autonomy", "residue-cleanup"]) {
      const selected = source(language, [id]);
      const output = renderDotAgents(selected);
      assert.equal(output.includes(AUTONOMY_AUTHORIZATION_BODY[suffix]), id === "autonomy");
      assert.equal(output.includes(BRANCH_LIFECYCLE_BODY[suffix]), id === "residue-cleanup");
      assert.equal(output.includes(suffix === "zh" ? "### Fork 贡献" : "### Fork contributions"), id === "residue-cleanup");
      const previous = await readFile(resolve(import.meta.dirname, "fixtures", "rules", `${id}-v1-rev1.${suffix}.md`), "utf8");
      assert.throws(() => renderDotAgents({ ...selected, enabledRules: [{ ...selected.enabledRules[0], bodyDigest: dotContentDigest(previous) }] }), error => error.reasonCode === "DOT_SOURCE_MISMATCH");
      assert.equal(renderDotAgents(selected), output, "same input is deterministic");
    }
    const empty = renderDotAgents(source(language, []));
    assert.equal(empty.includes(AUTONOMY_AUTHORIZATION_BODY[suffix]), false);
    assert.equal(empty.includes(BRANCH_LIFECYCLE_BODY[suffix]), false);
  }
});

test("MIN358 dot principle is sourced and selectable; disabled autonomy does not remain in common text", () => {
  for (const [language, key] of [["zh-CN", "zh"], ["en", "en"], ["ja", "en"], ["ko", "en"], ["fr", "en"]]) {
    const enabled = renderDotAgents(source(language, ["autonomy"]));
    assert.equal(enabled.split(AUTONOMY_RESTRICTION_SCOPE_BODY[key]).length - 1, 1);
    const disabled = renderDotAgents(source(language, BUILT_IN_RULES.filter(rule => rule.id !== "autonomy").map(rule => rule.id)));
    assert.equal(disabled.includes(AUTONOMY_RESTRICTION_SCOPE_BODY[key]), false);
    assert.equal(disabled.includes(AUTONOMY_AUTHORIZATION_BODY[key]), false);
    assert.ok(disabled.includes(key === "zh" ? "实际权限、安全要求" : "actual platform permissions"), "platform boundaries are not optional rule content");
    assert.ok(disabled.includes(BRANCH_LIFECYCLE_BODY[key]), "other selected principles retain independent scope");
  }
});

test("INIT068 authorized review completion: authorized review completion is dot-only, selectable and never new publication authority", () => {
  const clauses = {
    zh: ["dot 应直接完成 review/CI 暴露的缺陷修复、必要回归验证", "更新同一个已获授权的 PR", "不因新一轮 review、CI 失败或重复更新而再次要求 Owner 确认", "产品目标与已批准方案不变", "范围、目的地、权限、风险及对外影响无实质变化", "既有授权覆盖相应编辑、提交和推送", "review/CI 是问题证据，不是新的授权来源", "仅有观察、诊断或 review 意见并不授权修改或发布", "先说明具体差异并取得适用的 Owner 确认", "只暂停依赖该决定的动作", "用户明确限制、停止条件、平台逐次确认及真实拒绝继续有效", "不授予任意推送、新建 PR、合并、部署或发布权限"],
    en: ["dot should directly complete defects exposed by review/CI, necessary regression verification", "updates to the same authorized PR", "without asking the Owner again", "unchanged product goals and approved plans", "no material change in scope, destination, permissions, risk or external effects", "existing authorization covering the respective edits, commits and pushes", "Review/CI supplies issue evidence, not new authority", "observation, diagnosis or review comments alone do not authorize edits or publication", "obtain the applicable Owner confirmation before proceeding", "pause only actions dependent on that decision", "Explicit user limits, stopping conditions, platform-required per-action confirmations and actual denials remain effective", "no blanket permission to push, create another PR, merge, deploy or publish"],
  };
  for (const [language, key] of [["zh-CN", "zh"], ["en", "en"], ["ja", "en"], ["ko", "en"], ["fr", "en"]]) {
    const enabled = renderDotAgents(source(language, ["autonomy"]));
    const disabled = renderDotAgents(source(language, BUILT_IN_RULES.filter(rule => rule.id !== "autonomy").map(rule => rule.id)));
    for (const clause of clauses[key]) assert.ok(enabled.includes(clause), `${language}: ${clause}`);
    assert.equal(enabled.split(clauses[key][0]).length - 1, 1);
    assert.equal(disabled.includes(clauses[key][0]), false, "disabled autonomy grants no review-completion rule");
    for (const rule of BUILT_IN_RULES) assert.equal(rule.body[key].includes(clauses[key][0]), false, "generic hosts do not acquire the dot-only supplement");
    assert.ok(enabled.includes(key === "zh" ? "已批准的执行步骤、次序、分包和角色分工不得擅自" : "prohibit changing approved steps, order, packages or roles"), "approved execution governance remains intact");
  }
});

for (const [archiveName, sourceCommit] of [
  ["dot-autonomy-before-review", "3b16d5cbb5750838ee2ff3068e124c7fc8b95224"],
  ["dot-before-context-recovery", "f5ad507d65e52ef21e3fb275e32d05d8d01b4a5e"],
]) test(`${archiveName}: exact base-rendered prior template updates with recovery; altered ownership and user edits refuse`, async t => {
  const root = resolve(import.meta.dirname, "fixtures", "rules");
  const archive = JSON.parse(await readFile(join(root, `${archiveName}.json`), "utf8"));
  assert.equal(archive.sourceCommit, sourceCommit);
  for (const archived of archive.fixtures) {
    const original = await readFile(join(root, archived.file), "utf8");
    assert.equal(dotContentDigest(original), archived.sha256, "fixture was rendered by the verified base engine, not reconstructed from new text");
    const input = { ...await fixture(t), source: source(archived.language, ["autonomy"]) };
    const initial = await planDotAgents(input);
    const provenance = { ...initial.provenance, outputDigest: archived.sha256, readbackRef: `${input.binding.agentsPath}#sha256=${archived.sha256}` };
    await mkdir(dirname(input.binding.provenancePath), { recursive: true });
    await writeFile(input.binding.agentsPath, original);
    const save = value => writeFile(input.binding.provenancePath, JSON.stringify(value) + "\n");
    await save(provenance);
    const request = { ...input, operation: "update", source: { ...input.source, engineSourceRef: "fixture:review-completion-candidate" } };
    const plan = await planDotAgents(request);
    assert.equal(plan.status, "ready");
    assert.notEqual(plan.candidate, original);
    assert.equal(plan.candidate, renderDotAgents(request.source));
    for (const invalid of [
      { ...provenance, inputDigest: "0".repeat(64) },
      { ...provenance, targetPathBinding: { ...provenance.targetPathBinding, ownerId: "fixture:another-owner" } },
      { ...provenance, enabledRules: provenance.enabledRules.map(rule => ({ ...rule, bodyDigest: "0".repeat(64) })) },
      { ...provenance, outputDigest: dotContentDigest(original + "Unknown prior template.\n") },
    ]) {
      await save(invalid);
      const pending = await planDotAgents(request);
      assert.equal(pending.reasonCode, "DOT_OWNERSHIP_CONFLICT"); assert.deepEqual(pending.writes, []);
    }
    await save(provenance);
    await writeFile(input.binding.agentsPath, original + "User addition.\n");
    const edited = await planDotAgents(request);
    assert.equal(edited.reasonCode, "DOT_USER_MODIFIED"); assert.deepEqual(edited.writes, []);
    await writeFile(input.binding.agentsPath, original);
    const applied = await applyDotAgents(await planDotAgents(request));
    assert.equal(applied.status, "applied"); assert.equal(applied.fileVerification, "verified");
    assert.equal(applied.sessionRead, "not-verified");
    assert.equal(await readFile(applied.files.find(file => file.path === input.binding.agentsPath).backupPath, "utf8"), original);
    assert.equal(await readFile(input.binding.agentsPath, "utf8"), plan.candidate);
    assert.deepEqual(JSON.parse(await readFile(input.binding.provenancePath, "utf8")).enabledRules, input.source.enabledRules);
    const repeated = await planDotAgents(request);
    assert.equal(repeated.status, "unchanged"); assert.deepEqual(repeated.writes, []);
  }
});

// Synthetic source reconstruction without live enablement.
function extensionSource() {
  return { schemaVersion: "tcrn.dot-extension-source.v1", version: 1, sourceReference: "fixture:approved-source-v1", executionTarget: "chatgpt-dot",
    rules: [{ id: "local-review", body: "Keep original evidence. A check grants no permission.", sourceReference: "fixture:rule-v1" }],
    files: [
      { path: "dot-extensions/checker.mjs", kind: "checker", body: "export const checked = false;\n", sourceReference: "fixture:checker-v1" },
      { path: "dot-extensions/entry.md", kind: "entry", body: "Read checker.mjs only when the current task authorizes it.\n", sourceReference: "fixture:entry-v1" },
    ], entries: ["dot-extensions/entry.md"] };
}
function extensionRecord(manifest = extensionSource(), exports = []) {
  return { collection: "variable", key: DOT_EXTENSION_SOURCE_VARIABLE, value: { type: "string", value: JSON.stringify(manifest), description: "Private regeneration source", exports } };
}

test("INIT068 R19: existing private governed declaration restores blank output, entries and provenance without executing", async t => {
  const input = await fixture(t);
  const extensions = readDotExtensionSource({ configRecords: [extensionRecord()] });
  const request = { ...input, source: { ...input.source, extensions } };
  const plan = await planDotAgents(request);
  assert.equal(plan.status, "ready");
  assert.equal(plan.extensionFiles.length, 2);
  assert.ok(plan.candidate.includes("dot-extensions/entry.md"));
  assert.ok(plan.candidate.includes("not automatic execution"));
  const applied = await applyDotAgents(plan);
  assert.equal(applied.fileVerification, "verified");
  assert.equal(applied.sessionRead, "not-verified");
  for (const file of extensions.files) {
    assert.equal(await readFile(join(input.binding.root, file.path), "utf8"), file.body);
    assert.equal((await stat(join(input.binding.root, file.path))).mode & 0o111, 0);
  }
  const provenance = JSON.parse(await readFile(input.binding.provenancePath, "utf8"));
  assert.deepEqual(provenance.extensions, extensions);
  assert.equal(provenance.synchronized, undefined);
  const repeat = await planDotAgents({ ...request, operation: "repair" });
  assert.equal(repeat.status, "unchanged"); assert.deepEqual(repeat.writes, []);
  await rejects(planDotAgents({ ...input, operation: "repair" }), "DOT_SOURCE_MISMATCH");
  await rejects(planDotAgents({ ...request, source: { ...request.source, extensions: { ...extensions, rules: [] } } }), "DOT_SOURCE_MISMATCH");
});

test("INIT068 R19: absent, malformed, exported, duplicate, sensitive and generated sources are not recovered", () => {
  assert.equal(readDotExtensionSource({ configRecords: [] }), null);
  const malformed = extensionRecord(); malformed.value.value = "not json";
  // Deliberately synthetic credential-shaped input, built only when the test runs.
  const cases = [
    [malformed], [extensionRecord(undefined, ["agents"])], [extensionRecord(), extensionRecord()],
    [extensionRecord({ ...extensionSource(), schemaVersion: "unsupported" })],
    [extensionRecord({ ...extensionSource(), deviceIdentity: "must not be saved" })],
    [extensionRecord({ ...extensionSource(), entries: ["dot-extensions/missing.md"] })],
    [extensionRecord({ ...extensionSource(), files: [{ ...extensionSource().files[0], path: "dot-extensions/../AGENTS.md" }] })],
    [extensionRecord({ ...extensionSource(), rules: [{ id: "local", body: `${DOT_AGENTS_MARKER}\nGenerated`, sourceReference: "fixture:bad" }] })],
    [extensionRecord({ ...extensionSource(), rules: [{ id: "local", body: String.fromCharCode(103, 104, 112, 95) + "syntheticfixture".repeat(3), sourceReference: "fixture:bad" }] })],
  ];
  for (const configRecords of cases) assert.throws(() => readDotExtensionSource({ configRecords }), error => ["DOT_SOURCE_MISMATCH", "DOT_INPUT_INVALID", "DOT_PATH_UNBOUND", "DOT_SOURCE_SECRET_SHAPED"].includes(error.reasonCode));
});

test("INIT068 R19: user checker edits and stale plans remain protected, source version updates retain recovery", async t => {
  const input = await fixture(t); const extensions = extensionSource();
  const request = { ...input, source: { ...input.source, extensions } };
  const initial = await planDotAgents(request);
  await writeFile(join(input.binding.root, "unrelated.txt"), "leave intact");
  await applyDotAgents(initial);
  const checker = join(input.binding.root, extensions.files[0].path);
  await writeFile(checker, "user edit\n");
  const pending = await planDotAgents(request);
  assert.equal(pending.status, "pending"); assert.equal(pending.reasonCode, "DOT_USER_MODIFIED"); assert.deepEqual(pending.writes, []);
  await writeFile(checker, extensions.files[0].body);
  const next = { ...extensions, version: 2, sourceReference: "fixture:approved-source-v2", files: extensions.files.map(file => file.kind === "checker" ? { ...file, body: "export const checked = null;\n", sourceReference: "fixture:checker-v2" } : file) };
  const updated = await planDotAgents({ ...request, operation: "update", source: { ...request.source, extensions: next } });
  assert.equal(updated.status, "ready");
  const applied = await applyDotAgents(updated);
  const saved = applied.files.find(file => file.path === checker);
  assert.equal(await readFile(saved.backupPath, "utf8"), extensions.files[0].body);
  assert.equal(await readFile(join(input.binding.root, "unrelated.txt"), "utf8"), "leave intact");
});

test("INIT068 R20: enabled/disabled/versioned incremental source closes render and actual file readback without live activation", async t => {
  const input = await fixture(t);
  const configRecords = [{ collection: "rule", key: "incremental-update", value: { enabled: true, version: 1 } }, { collection: "rule", key: "autonomy", value: { enabled: true, version: 1 } }];
  const enabledRules = dotEnabledRuleSources({ configRecords }, "en", "fixture:scoped-rule-readback");
  const request = { ...input, source: { ...source("en", []), enabledRules } };
  await applyDotAgents(await planDotAgents(request));
  assert.ok((await readFile(input.binding.agentsPath, "utf8")).includes("· incremental-update"));
  configRecords[0].value.enabled = false;
  const disabled = { ...request, operation: "update", source: { ...request.source, enabledRules: dotEnabledRuleSources({ configRecords }, "en", "fixture:scoped-rule-readback") } };
  await applyDotAgents(await planDotAgents(disabled));
  const body = await readFile(input.binding.agentsPath, "utf8");
  assert.equal(body.includes("· incremental-update"), false); assert.ok(body.includes("· autonomy"));
  assert.equal((await planDotAgents(disabled)).status, "unchanged");
  assert.deepEqual(dotEnabledRuleSources({ configRecords: [] }, "en", "fixture:missing"), []);
  for (const version of [0, 2]) assert.throws(() => dotEnabledRuleSources({ configRecords: [{ collection: "rule", key: "incremental-update", value: { enabled: true, version } }] }, "en", "fixture:version"), error => error.reasonCode === "DOT_SOURCE_MISMATCH");
});

test("INIT068 R21: both hosts consume the exact optional privacy principle, never a hard-coded task identity", () => {
  for (const language of ["en", "zh-CN"]) {
    const body = ruleBody("privacy-publication", language);
    assert.ok(renderDotAgents(source(language, ["privacy-publication"])).includes(body));
    assert.equal(renderDotAgents(source(language, [])).includes(body), false);
    assert.equal(/fixture-contributor|fixture-owner/u.test(body), false);
  }
});

test("INIT068 R19: safe private declaration remains in the existing backup allowlist, not a generated projection", () => {
  const record = extensionRecord();
  const payload = { kind: "variable", name: record.key, declaration: record.value, source: "project-declaration" };
  assert.deepEqual(validateConfigBackupPayload(payload), payload);
  assert.equal(variableExportDecision(record.value, "agents"), "not-exported");
  assert.equal(variableExportDecision(record.value, "handoff"), "not-exported");
});

test("dot context recovery is task-scoped, permission-bound and separate from current proof", () => {
  const clauses = {
    zh: ["在断言基础设施不支持、要求用户重复既有决定或宣布阻塞前", "E/M 权威规则、仍有效的用户决定", "已决定」「已实施」「本次已验证", "巡检只提醒", "按需取相关节号或摘录", "不把整库、大段历史或运行状态塞进巡检 prompt", "单个接口失败，不等于产品能力不存在", "旧成功也不证明当前仍可用", "先尝试受支持的现有路径及安全恢复", "恢复敏感信息或新增访问须先获授权", "已确认未执行且现行规则允许", "一次有限重试", "不换工具、路径或身份规避拒绝", "保留原决定及来源", "拒绝/待定/未知状态", "只暂停依赖该阻点的工作", "已准备」，不是「共享落链完成", "shared-submit-plan / shared-submit-evidence", "字节读回、完整目的地 replay", "不另建持久状态或要求用户手填 JSON"],
    en: ["Before asserting infrastructure is unsupported", "asking the user to repeat a settled decision", "authoritative E/M rules, still-valid user decisions", "Distinguish decided, implemented and verified now", "Patrol only reminds", "sections/excerpts on demand", "without stuffing whole libraries", "one failed interface is not proof of a product limitation", "old success is not current capability proof", "try supported existing routes and safe recovery", "Sensitive recovery or new access requires prior authorization", "only one bounded retry", "material new relevant evidence, confirmed non-execution", "never change tools, paths or identity to evade it", "retain the original decision/source", "denied/pending/unknown status", "Pause only dependent work", "prepared, not shared completion", "shared-submit-plan / shared-submit-evidence", "byte readback, complete destination replay", "without new persistent state or user-authored JSON"],
  };
  for (const [language, key] of [["zh-CN", "zh"], ["en", "en"], ["ja", "en"], ["ko", "en"], ["fr", "en"]]) {
    for (const ids of [[], ["autonomy"]]) {
      const output = renderDotAgents(source(language, ids));
      for (const clause of clauses[key]) assert.ok(output.includes(clause), `${language}: ${clause}`);
      assert.equal(output.split(clauses[key][0]).length - 1, 1);
      assert.equal(output.includes("SubagentStop"), false, "dot discipline does not install the Codex-only collector");
    }
    for (const rule of BUILT_IN_RULES) assert.equal(rule.body[key].includes(clauses[key][0]), false, "traditional rule bodies stay unchanged");
  }
});

test("dot context recovery survives fresh generation and missing-file repair without a session-read claim", async t => {
  const input = await fixture(t);
  const installed = await applyDotAgents(await planDotAgents(input));
  assert.equal(installed.status, "applied");
  const expected = renderDotAgents(input.source);
  assert.ok(expected.includes("基础设施阻点前先恢复上下文"));
  await rm(input.binding.agentsPath);
  const repaired = await applyDotAgents(await planDotAgents({ ...input, operation: "repair" }));
  assert.equal(repaired.status, "applied"); assert.equal(repaired.sessionRead, "not-verified");
  assert.equal(await readFile(input.binding.agentsPath, "utf8"), expected);
  assert.equal((await planDotAgents({ ...input, operation: "repair" })).status, "unchanged");
});

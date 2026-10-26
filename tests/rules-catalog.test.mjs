// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-483 R1 (MIN-228 D3, MIN-229 D6): the four built-in Command Spell rules ship
// with the engine, each with its id, its version (batch processing at its third) and a Chinese
// and an English title and body. The original Chinese bodies retain the Owner's wording.
// Current fixtures explicitly include later supplements; every Chinese body equals its fixture
// byte for byte. So do the English bodies of design-authority and silent-reporting.
// INIT-053 R40: the Owner revised batch v3 (clause 7, "once" counts per round) and
// silent-reporting v1 (its last sentence, no report between rounds) at the same version. The
// Chinese fixtures are the Owner's archived revision; the English of the two additions is an
// agent's translation that awaits the Owner's correction, and its fixture follows the constant.
// INIT-053 R48 (MIN-242 D10, the Owner's fifth round): batch v3 gains clause 8 (knowledge is captured
// per round) at the same version; the Chinese fixture is the archive again, byte for byte, and the
// English of clause 8 is an agent's translation that awaits the Owner's correction.
// INIT-053 R52 (MIN-246 D11): batch v3 gains the merging of small rounds at the end of clause 6 and
// clause 9 (evidence is read in excerpts) at the same version; the Chinese fixture is the archive
// again, byte for byte, batch-v3-rev3 keeps the R48 text in both languages, and the English of both
// additions is an agent's translation that awaits the Owner's correction.
// TCRN-CROSS-STORY-540 (MIN-258 D3(c), MIN-259 D1): the Owner's two immediate rules join the catalog
// at v1, residue-cleanup and goal-writing; their Chinese fixtures are the Owner's wording, byte for
// byte, under the catalog's heading.
// TCRN-CROSS-STORY-541 (MIN-258 D3, MIN-259 D2): unattended-commands rises to v2, one sentence added
// to the end of clause 1; unattended-commands-v1 keeps the v1 text in both languages.
// INIT-062: autonomy and residue-cleanup retain their v1 original text in *-v1-rev1
// fixtures. Their current Chinese and English fixtures also contain agent-authored wording
// implementing the Owner's universal authorization-count and branch-lifecycle instructions.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AUTONOMY_RESTRICTION_SCOPE_BODY, AUTONOMY_AUTHORIZATION_BODY, BRANCH_LIFECYCLE_BODY, BUILT_IN_RULE_IDS, BUILT_IN_RULES, INCREMENTAL_UPDATE_DOT_BODY, builtInRule, ruleBody } from "../dist/build/packages/core/src/rules-catalog.js";

const fixtures = resolve(import.meta.dirname, "fixtures", "rules");
const LANGUAGES = ["zh", "en"];

// A path from the filesystem root that goes through at least one directory, a path from a drive
// letter, or a path from a home directory. A lone "/add-dir" is a host command a rule names, not
// a path.
const ABSOLUTE_PATH = /(?<![\w.~-])\/[\w.@-]+\/|\b[A-Za-z]:[\\/]|(?<![\w.-])~[\\/]/u;

function absolutePath(text) {
  return ABSOLUTE_PATH.exec(text)?.[0] ?? null;
}

test("the engine ships nine built-in rules at their versions, batch processing at v3", () => {
  assert.deepEqual(BUILT_IN_RULES.map((rule) => [rule.id, rule.version]), [
    ["autonomy", 1],
    ["batch", 3],
    ["unattended-commands", 2],
    ["silent-reporting", 1],
    ["design-authority", 1],
    ["residue-cleanup", 1],
    ["goal-writing", 1],
    ["incremental-update", 1],
    ["privacy-publication", 1],
  ]);
  assert.deepEqual([...BUILT_IN_RULE_IDS], BUILT_IN_RULES.map((rule) => rule.id));
  assert.equal(builtInRule("batch")?.version, 3);
  assert.equal(builtInRule("batch-processing"), null);
  assert.ok(Object.isFrozen(BUILT_IN_RULES));
  for (const rule of BUILT_IN_RULES) {
    assert.ok(Object.isFrozen(rule) && Object.isFrozen(rule.title) && Object.isFrozen(rule.body), rule.id);
  }
});

test("every rule has a Chinese and an English title and body, each body headed by its title and version", () => {
  for (const rule of BUILT_IN_RULES) {
    for (const language of LANGUAGES) {
      const title = rule.title[language];
      const body = rule.body[language];
      assert.ok(typeof title === "string" && title.trim() !== "", `${rule.id} ${language} title`);
      assert.ok(typeof body === "string" && body.trim() !== "", `${rule.id} ${language} body`);
      assert.equal(body.split("\n")[0], `## ${title} v${rule.version}`, `${rule.id} ${language} heading`);
      assert.ok(body.endsWith("\n") && !body.endsWith("\n\n"), `${rule.id} ${language} ends with one newline`);
    }
  }
});

test("no rule text names an absolute path", () => {
  // The detector is shown to find what it looks for before its silence is taken as an answer.
  for (const sample of [join(tmpdir(), "rules", "body.md"), join(homedir(), "rules"), "~/rules"]) {
    assert.notEqual(absolutePath(sample), null, `the detector misses ${sample}`);
  }
  assert.equal(absolutePath("add the directory with /add-dir first"), null);
  for (const rule of BUILT_IN_RULES) {
    for (const language of LANGUAGES) {
      assert.equal(absolutePath(rule.title[language]), null, `${rule.id} ${language} title`);
      assert.equal(absolutePath(rule.body[language]), null, `${rule.id} ${language} body`);
    }
  }
});

test("every current Chinese body and the archived English contracts match their explicit fixtures", async () => {
  // Historical bodies remain separately archived; current supplements have explicit fixtures.
  // The eighth source is asserted below without changing its contract.
  for (const rule of BUILT_IN_RULES.filter(rule => !["incremental-update", "privacy-publication"].includes(rule.id))) {
    assert.equal(rule.body.zh, await readFile(join(fixtures, `${rule.id}.zh.md`), "utf8"), rule.id);
  }
  assert.equal(builtInRule("design-authority")?.body.en, await readFile(join(fixtures, "design-authority.en.md"), "utf8"));
  assert.equal(builtInRule("silent-reporting")?.body.en, await readFile(join(fixtures, "silent-reporting.en.md"), "utf8"));
});

test("MIN291 D1: design authority is optional, but a configured conflict still stops dependent design work", () => {
  const rule = builtInRule("design-authority");
  assert.ok(rule);
  for (const [language, optional, conflict] of [
    ["zh", "设计权威是可选项", "已声明绑定冲突或无法解析时，停止依赖该权威的设计工作"],
    ["en", "A design authority is optional", "When declared bindings conflict or cannot resolve, stop design work that depends on that authority"],
  ]) {
    const body = rule.body[language];
    assert.ok(body.includes(optional), `${language}: a missing authority is explicitly optional`);
    assert.ok(body.includes(conflict), `${language}: an actually declared conflict remains blocking for dependent work`);
    assert.ok(body.includes(language === "zh" ? "继承值须显示来源" : "inherited values must identify their source"), `${language}: declared authority provenance remains visible`);
    assert.ok(body.includes(language === "zh" ? "生产文档或组件库发布成功" : "production documentation or component library is published successfully"), `${language}: production release dependency remains explicit`);
    assert.equal(/\b(?:Atelier|Einzbern)\b/u.test(body), false, `${language}: the generic rule names no product`);
  }
});

test("ruleBody gives the Chinese body when artifact.language is zh-CN and the English body otherwise", () => {
  for (const rule of BUILT_IN_RULES) {
    assert.equal(ruleBody(rule.id, "zh-CN"), rule.body.zh, rule.id);
    for (const language of ["en", "ja", "ko", "fr", null]) {
      assert.equal(ruleBody(rule.id, language), rule.body.en, `${rule.id} ${language}`);
    }
  }
  assert.throws(() => ruleBody("batch-processing", "zh-CN"), RangeError);
});

// The old bodies remain applicable to enabled v2 projects until an explicit upgrade. The Owner's
// revisions of v3 add clause 7 (INIT-053 R40), clause 8 (INIT-053 R48, MIN-242 D10), and the merging
// of small rounds at the end of clause 6 with clause 9 (INIT-053 R52, MIN-246 D11) to the six
// principles at the same version. Clause 6 is compared as it stood before its addition, the text
// batch-v3-rev3 keeps.
test("INIT-053 R1-R5, R40, R48, R52: v3 preserves the six principles in both languages, adds clauses 7, 8 and 9 and the end of clause 6, and adds communication and waiting", async () => {
  for (const language of LANGUAGES) {
    const previous = await readFile(join(fixtures, `batch-v2.${language}.md`), "utf8");
    const rev3 = await readFile(join(fixtures, `batch-v3-rev3.${language}.md`), "utf8");
    const current = builtInRule("batch").body[language].split("\n### Codex ")[0];
    const heading = language === "zh" ? "### 代理通信与等待" : "### Agent communication and waiting";
    const principles = current.split(heading)[0].split("\n");
    const clause6 = principles.filter((line) => line.startsWith("6. "));
    const clause7 = principles.filter((line) => line.startsWith("7. "));
    const clause8 = principles.filter((line) => line.startsWith("8. "));
    const clause9 = principles.filter((line) => line.startsWith("9. "));
    assert.equal(clause6.length, 1, `${language}: one clause 6`);
    assert.equal(clause7.length, 1, `${language}: one clause 7`);
    assert.equal(clause8.length, 1, `${language}: one clause 8`);
    assert.equal(clause9.length, 1, `${language}: one clause 9`);
    assert.equal(principles.indexOf(clause7[0]), principles.indexOf(clause6[0]) + 1, `${language}: clause 7 follows clause 6`);
    assert.equal(principles.indexOf(clause8[0]), principles.indexOf(clause7[0]) + 1, `${language}: clause 8 follows clause 7`);
    assert.equal(principles.indexOf(clause9[0]), principles.indexOf(clause8[0]) + 1, `${language}: clause 9 follows clause 8`);
    const clause6Before = rev3.split("\n").find((line) => line.startsWith("6. "));
    assert.ok(clause6[0].startsWith(clause6Before) && clause6[0].length > clause6Before.length, `${language}: clause 6 keeps its rev 3 text and adds to its end`);
    const clause6Addition = clause6[0].slice(clause6Before.length);
    const asBefore = (line) => (line === clause6[0] ? clause6Before : line);
    assert.equal(current.split("\n").filter((line) => line !== clause9[0]).map(asBefore).join("\n"), rev3, `${language}: R52 changes the end of clause 6 and adds clause 9, and nothing else`);
    assert.equal(principles.filter((line) => line !== clause7[0] && line !== clause8[0] && line !== clause9[0]).map(asBefore).join("\n").trimEnd(), previous.replace("v2", "v3").trimEnd());
    for (const fragment of language === "zh"
      ? ["「一次」按轮计", "不是整个会话只做一轮", "各做一遍", "不逐红重复", "下一轮的输入", "立即开下一轮", "goal 写明的终态", "只有 Owner 能做的决定", "不等 Owner 答复", "不换会话", "不汇报"]
      : ["\"Once\" counts per round", "not once for the whole session", "each done once", "not repeated for every red result", "input to the next round", "starts the next round at once", "end state written in the goal", "decisions only the Owner can make", "do not wait for the Owner's reply", "do not change sessions", "do not report"]) {
      assert.ok(clause7[0].includes(fragment), `${language} clause 7: ${fragment}`);
    }
    for (const fragment of language === "zh"
      ? ["知识采集按轮", "单名判断代理", "lessons.json", "subject、summary、snippet、body、tags", "来源证据路径", "本轮新确立的事实与教训", "不超过 5 条", "同一轮的链写", "knowledge-capture", "逐条落卡并读回", "被预算拒绝就记阻塞", "迁移后补写", "不依赖 Stop 钩子的标记行"]
      : ["Knowledge is captured per round", "one judgment agent", "lessons.json", "subject, summary, snippet, body, tags", "paths of its source evidence", "newly established in that round", "at most 5 entries", "same round's chain write", "knowledge-capture", "reads each one back", "budget refuses is recorded as blocked", "written after the migration", "does not rely on the Stop hook's marker lines"]) {
      assert.ok(clause8[0].includes(fragment), `${language} clause 8: ${fragment}`);
    }
    for (const fragment of language === "zh"
      ? ["小轮合并", "实施包不超过 2 个", "验收只有一片", "验收与判断由一个主力档代理一次完成", "仍按原格式写验收、判断与 lessons 三份文件", "下一轮的拆分文件", "不另派拆分代理", "验收两片以上的轮维持验收分片并行、判断单独、拆分单独", "没有实施包、只有链写或文档动作的轮", "不派拆分与验收代理", "主线程完成动作后派一个主力档代理读回并判断"]
      : ["Merging small rounds", "no more than 2 implementation packages", "only one acceptance slice", "one main-tier agent does acceptance and judgment in one pass", "three files of acceptance, judgment and lessons in their usual format", "next round's decomposition file", "no separate decomposition agent is dispatched", "two or more acceptance slices keeps acceptance split and run in parallel", "no implementation package, only chain writes or documentation actions", "no decomposition or acceptance agent", "one main-tier agent to read them back and judge"]) {
      assert.ok(clause6Addition.includes(fragment), `${language} end of clause 6: ${fragment}`);
    }
    for (const fragment of language === "zh"
      ? ["证据按摘录读", "治理代理与主线程", "派工指明的摘录文件、节号或行号范围", "不整读拆分、计划、判断、台账与 routing 文件", "工具输出先写进文件再按需读入", "每次不超过 200 行", "超过 32 KB 的文件不整读", "宿主的读取守卫会拒绝并给出改法"]
      : ["Evidence is read in excerpts", "Governance agents and the main thread", "excerpt files, section numbers or line ranges that the dispatch names", "decomposition, plan, judgment, ledger or routing files whole", "first written to a file and then read in as needed", "no more than 200 lines at a time", "larger than 32 KB is not read whole", "host's read guard refuses"]) {
      assert.ok(clause9[0].includes(fragment), `${language} clause 9: ${fragment}`);
    }
    const clauses = current.split(heading)[1];
    for (const fragment of language === "zh"
      ? ["普通进度", "完成时报告", "宿主完成通知", "send_message", "安全问题", "硬阻塞", "依赖或冲突", "事实澄清", "不回复纯确认", "不催问", "直接处理", "全体状态查询", "阻塞等待", "延长查询间隔", "等待上限", "用户中断", "独立可做"]
      : ["ordinary progress", "package is complete", "completion notification", "send_message", "safety issues", "hard blockers", "dependencies or conflicts", "factual clarification", "pure acknowledgments", "ordinary progress", "Act directly", "every agent's status", "blocking waits", "Lengthen query intervals", "wait limit", "user interruption", "independent work"]) {
      assert.ok(clauses.includes(fragment), `${language}: ${fragment}`);
    }
  }
});

// INIT-053 R40: the Owner's revision of silent-reporting v1 adds one sentence after the wake-up
// sentence, at the same version, so a round's end is not a moment to report.
test("INIT-053 R40: silent-reporting v1 ends with the sentence that no report falls between rounds, in both languages", () => {
  const rule = builtInRule("silent-reporting");
  assert.equal(rule.version, 1);
  assert.ok(rule.body.zh.endsWith("安排唤醒源不算汇报。一轮做完、下一轮开始之间不算这两种时刻，同样不汇报。\n"));
  assert.ok(rule.body.en.endsWith("Scheduling a wake-up does not count as a report. The time between finishing one round and starting the next is not one of these two moments, so no report is produced then either.\n"));
  for (const language of LANGUAGES) {
    assert.equal(rule.body[language].split("\n\n").length, 3, `${language}: heading and two paragraphs`);
  }
});

// TCRN-CROSS-STORY-540 (MIN-258 D3(c), MIN-259 D1): residue-cleanup v1 and goal-writing v1 follow
// design-authority. Each body is a heading, an opening paragraph and its numbered clauses, in both
// languages and clause for clause. The Chinese is the Owner's wording (the fixtures); the English of
// residue-cleanup is an agent's translation, and the three clauses of goal-writing are the English
// original of TCRN-CROSS-INC-225 "FIX, TYPE LEVEL" that the Owner adopted, without the last sentence
// of its clause 3, which the Chinese does not carry.
const INC_225_CLAUSES = Object.freeze([
  "1. A goal states a verifiable end state of work — a file exists, a suite is green, a record has landed. It never states authorization or agreement. Authorization is expressed in conversation and is not a goal clause; putting it in one creates a condition the working party cannot reach.",
  "2. Every goal carries a satisfiable escape clause: \"or: blocked on a decision only the Owner can make, and the blocking point has been stated\".",
  "3. On encountering a speech-act condition, the working party explains once, replies minimally thereafter, and names the single exit.",
]);

test("540 (MIN-259 D1): residue-cleanup v1 preserves its eight historical clauses plus the branch supplement, and goal-writing stays unchanged", async () => {
  assert.deepEqual(BUILT_IN_RULE_IDS.slice(4, 7), ["design-authority", "residue-cleanup", "goal-writing"]);
  const residue = builtInRule("residue-cleanup");
  const goal = builtInRule("goal-writing");
  assert.deepEqual([residue.version, { ...residue.title }], [1, { zh: "无效残余收尾原则", en: "Residue Cleanup Principle" }]);
  assert.deepEqual([goal.version, { ...goal.title }], [1, { zh: "目标书写契约", en: "Goal Writing Contract" }]);
  for (const [rule, count] of [[residue, 9], [goal, 3]]) {
    assert.equal(rule.body.zh, await readFile(join(fixtures, `${rule.id}.zh.md`), "utf8"), `${rule.id}: the current reviewed Chinese fixture, byte for byte`);
    for (const language of LANGUAGES) {
      const parts = rule.body[language].split("\n\n");
      assert.equal(parts.length, 3, `${rule.id} ${language}: the heading, the opening paragraph and the clauses`);
      const numbers = parts[2].trimEnd().split("\n").map((line) => line.slice(0, line.indexOf(". ") + 2));
      assert.deepEqual(numbers, Array.from({ length: count }, (_, index) => `${index + 1}. `), `${rule.id} ${language}: clauses 1 to ${count}`);
    }
  }
  const leads = {
    zh: ["创建者负责，主代理接续。", "按用途判定残余。", "结束即收尾，失败也收尾。", "证据与可重建副本分开。", "限定清理边界。", "工作树通过管理入口退出。", "容量与下一轮接续。", "核验实际结果，合并一次汇报。", "分支生命周期与收尾。"],
    en: ["The creator is responsible; the main agent takes over.", "Judge residue by its purpose.", "Clean up when work ends, and when it fails.", "Keep evidence apart from copies that can be rebuilt.", "Bound what is cleaned.", "Retire worktrees through their management entry.", "Capacity and the next round.", "Verify the actual result and report it once.", "Branch lifecycle and retirement."],
  };
  for (const language of LANGUAGES) {
    const clauses = residue.body[language].split("\n\n")[2].trimEnd().split("\n");
    assert.deepEqual(clauses.map((line) => /^\d\. \*\*([^*]+)\*\* \S/u.exec(line)?.[1] ?? null), leads[language], `residue-cleanup ${language}: each clause leads with its title in bold`);
  }
  for (const fragment of ["2026-10-05", "不另开规划轮、子代理或验收门", "`tmp`、`cache`、`test`", "`finally`", "`df`", "`du`"]) assert.ok(residue.body.zh.includes(fragment), `residue-cleanup zh: ${fragment}`);
  for (const fragment of ["2026-10-05", "opens no planning round, subagent or acceptance gate", "`tmp`, `cache` or `test`", "`finally`", "`df`", "`du`"]) assert.ok(residue.body.en.includes(fragment), `residue-cleanup en: ${fragment}`);
  assert.deepEqual(goal.body.en.split("\n\n")[2].trimEnd().split("\n"), INC_225_CLAUSES, "goal-writing en: the three clauses are INC-225's English, as the Owner adopted it");
  assert.equal(goal.body.en.includes("This is the behaviour that reduced this instance's cost"), false, "the last sentence of INC-225 clause 3 is not carried");
  assert.ok(goal.body.zh.includes("TCRN-CROSS-INC-225「FIX, TYPE LEVEL」") && goal.body.en.includes('TCRN-CROSS-INC-225 "FIX, TYPE LEVEL"'), "both name the Incident and its fix");
  for (const fragment of ["goal 只写可验证的工作终态", "可满足的退出分支", "言语行为条件"]) assert.ok(goal.body.zh.includes(fragment), `goal-writing zh: ${fragment}`);
});

// TCRN-CROSS-STORY-541 (MIN-258 D3, MIN-259 D2): unattended-commands v2 is v1 with one sentence at
// the end of clause 1. With the Owner's authorization, the trash-empty tool that ships with the skill
// empties the named trash directories under the session's scratch directory; each authorization
// covers one report of their paths and sizes. Every other line is v1's, in both languages.
test("541 (MIN-259 D2): unattended-commands v2 is v1 with its heading at v2 and one sentence at the end of clause 1, in both languages", async () => {
  const rule = builtInRule("unattended-commands");
  assert.equal(rule.version, 2);
  assert.equal(rule.body.zh, await readFile(join(fixtures, "unattended-commands.zh.md"), "utf8"));
  for (const language of LANGUAGES) {
    const before = (await readFile(join(fixtures, `unattended-commands-v1.${language}.md`), "utf8")).split("\n");
    const after = rule.body[language].split("\n");
    assert.equal(after.length, before.length, `${language}: no line is added or taken away`);
    const clause1 = after.findIndex((line) => line.startsWith("1. "));
    assert.deepEqual(after.map((_, index) => index).filter((index) => after[index] !== before[index]), [0, clause1], `${language}: only the heading and clause 1 change`);
    assert.equal(after[0], before[0].replace(/ v1$/u, " v2"), `${language}: the heading names v2`);
    assert.ok(after[clause1].startsWith(before[clause1]) && after[clause1].length > before[clause1].length, `${language}: clause 1 keeps its v1 text and adds to its end`);
    const added = after[clause1].slice(before[clause1].length);
    for (const fragment of language === "zh"
      ? ["经 Owner 授权后", "trash-empty", "点名的 trash 目录", "trash-<名>", "给定 scratch 根下", "不是符号链接", "先列计划再执行", "每次汇报列出路径与体积", "Owner 答复一次"]
      : ["With the Owner's authorization", "trash-empty", "named trash directories", "trash-<name>", "under the given scratch root", "not symbolic links", "lists its plan before it acts", "lists the paths and sizes", "answered once by the Owner"]) {
      assert.ok(added.includes(fragment), `${language} added sentence: ${fragment}`);
    }
  }
});


test("DOT-R01/R02 B5: incremental-update v1 distinguishes direct sync from necessary dot transport", () => {
  const rule = builtInRule("incremental-update");
  assert.equal(rule.version, 1);
  for (const [body, phrases] of [
    [rule.body.zh, ["完整有效基线", "一般同步目录宿主直接使用", "不增加无必要的下载或上传", "提交前刷新一次完整基线", "受支持的重放或重应用", "不授予跨设备原子排他", "一个 INIT 全部待办 Story"]],
    [INCREMENTAL_UPDATE_DOT_BODY.zh, ["dot 仅在环境实际需要时取得完整副本", "核对远端读回", "不按超时擅自接管", "实际行动者", "动态记录"]],
    [rule.body.en, ["complete, valid baseline", "without unnecessary downloads or uploads", "no atomic exclusion across devices", "all open Stories under one INIT"]],
    [INCREMENTAL_UPDATE_DOT_BODY.en, ["Only when its environment requires transport", "verify remote readback", "elapsed time never authorizes takeover"]],
  ]) for (const phrase of phrases) assert.ok(body.includes(phrase), phrase);
  assert.equal(rule.body.zh.includes("dot 仅在环境"), false);
  assert.ok(Object.isFrozen(INCREMENTAL_UPDATE_DOT_BODY));
});

test("INIT-062 universal supplements preserve v1 history, explicit user limits and safe branch retirement in both languages", async () => {
  for (const language of LANGUAGES) {
    for (const id of ["autonomy", "residue-cleanup"]) {
      const rule = builtInRule(id);
      const previous = await readFile(join(fixtures, `${id}-v1-rev1.${language}.md`), "utf8");
      assert.equal(rule.version, 1);
      assert.equal(rule.body[language], await readFile(join(fixtures, `${id}.${language}.md`), "utf8"));
      assert.ok(rule.body[language].startsWith(previous), `${id}: no historical sentence was removed`);
      assert.notEqual(rule.body[language], previous);
    }
    assert.ok(Object.isFrozen(AUTONOMY_AUTHORIZATION_BODY));
    assert.ok(Object.isFrozen(BRANCH_LIFECYCLE_BODY));
    assert.ok(builtInRule("autonomy").body[language].includes(AUTONOMY_AUTHORIZATION_BODY[language]));
    assert.ok(builtInRule("residue-cleanup").body[language].includes(BRANCH_LIFECYCLE_BODY[language]));
  }
  for (const text of ["模型自行拟定", "一般同意不等于明确施加", "只有用户在自己的指令中明确要求", "平台要求的逐次确认", "实质新增且相关的证据", "结果不明先读回核实", "无限重试、无限外部执行或发布许可"]) assert.ok(AUTONOMY_AUTHORIZATION_BODY.zh.includes(text), text);
  for (const text of ["model-authored plan", "General assent", "only when the user explicitly requests", "Platform-required confirmation for each action", "materially new and relevant evidence", "Read back an uncertain outcome", "unlimited retries, unlimited external execution or publication"]) assert.ok(AUTONOMY_AUTHORIZATION_BODY.en.includes(text), text);
  for (const text of ["每个新批开始、推送前及相关 PR 合并后", "不能把旧检查", "已证实可安全快进", "分支不再含目标中没有的独有提交", "没有活动 PR、运行或待执行 CI、工作树、后续交付或证据引用依赖", "必要历史、备份和失败证据已有可靠保留位置", "读回本地引用及适用的远端头", "squash 合并不单独证明", "默认、受保护、备份或恢复分支", "归属和状态不明", "不得按名称、年龄、ahead 数或通配符批量删分支", "不新增远端写入、合并、发布或永久删除权限"]) assert.ok(BRANCH_LIFECYCLE_BODY.zh.includes(text), text);
  for (const text of ["At the start of each new batch, before pushing and after a related PR merges", "no unique commits absent from that target", "no active PR, running or pending CI, worktree, later delivery or evidence reference", "backups and failure evidence", "Read back local refs and applicable remote heads", "a squash merge alone does not prove", "Default, protected, backup and recovery branches", "unknown ownership or status", "Do not delete branches in bulk", "no new permission for remote writes, merges, publication or permanent deletion"]) assert.ok(BRANCH_LIFECYCLE_BODY.en.includes(text), text);
});

test("MIN358 scoped-prohibition and governance persistence clauses extend selectable autonomy without new rules", async () => {
  assert.equal(BUILT_IN_RULES.filter(rule => rule.id !== "privacy-publication").length, 8); // INIT068 adds only its separately approved principle.
  for (const language of LANGUAGES) {
    assert.ok(builtInRule("autonomy").body[language].includes(AUTONOMY_RESTRICTION_SCOPE_BODY[language]));
    const previous = await readFile(join(fixtures, `autonomy-v1-rev2.${language}.md`), "utf8");
    assert.ok(previous.includes(AUTONOMY_AUTHORIZATION_BODY[language]));
    assert.equal(previous.includes(AUTONOMY_RESTRICTION_SCOPE_BODY[language]), false);
    for (const rule of BUILT_IN_RULES.filter(rule => rule.id !== "autonomy")) assert.equal(rule.body[language].includes(AUTONOMY_RESTRICTION_SCOPE_BODY[language]), false);
  }
  for (const phrase of ["explicitly approved", "scope, duration and release conditions", "General agreement", "permanent or cross-plan", "observed refusal", "destination is external storage", "Material changes", "cannot disable platform safety"]) assert.ok(AUTONOMY_RESTRICTION_SCOPE_BODY.en.includes(phrase), phrase);
});

test("INIT068 R21: common privacy principle covers authorized identity/minimization and preserves failure/permission boundaries", () => {
  const rule = builtInRule("privacy-publication");
  assert.equal(rule.version, 1);
  for (const clause of ["actual contributor", "noreply", "Git metadata", "candidate version", "preserve the original branch", "Never weaken gates", "without authorization", "grants no commit, push, PR, identity-rewrite", "not universal automatic approval"]) assert.ok(rule.body.en.includes(clause), clause);
  for (const clause of ["不得未经授权切换为 owner 或其他身份", "数据最小化", "Git 元数据", "保留原分支、提交及失败证据", "不弱化门", "不擅改远端历史", "不授予提交、推送、PR、身份重写"]) assert.ok(rule.body.zh.includes(clause), clause);
  assert.equal(/fixture-contributor|fixture-owner|users\.noreply\.github\.com/u.test(rule.body.en + rule.body.zh), false);
});


test("INIT076: Codex collector supplement preserves governance rounds without extending to dot", () => {
  const body = builtInRule("batch").body.en;
  for (const phrase of ["not other hosts or dot", "exactly one", "economy-tier collector", "exempt from the harness worker cap", "Reserve a real host slot", "capability-unavailable", "application attempt", "no-progress", "Parent receipt acknowledgement is not an exit prerequisite", "/goal or /loop", "legitimate M governance rounds", "never repurpose".replace("never", "Never")]) assert.ok(body.includes(phrase), phrase);
});

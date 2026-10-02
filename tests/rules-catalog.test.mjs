// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-483 R1 (MIN-228 D3, MIN-229 D6): the four built-in Command Spell rules ship
// with the engine, each with its id, its version (batch processing at its third) and a Chinese
// and an English title and body. The Chinese bodies are the Owner's final wording: the fixtures
// under tests/fixtures/rules/ are copies of the principle texts, and every Chinese body equals
// its copy byte for byte. So does the English body of silent-reporting, the one rule whose
// English text is final too.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BUILT_IN_RULE_IDS, BUILT_IN_RULES, builtInRule, ruleBody } from "../dist/build/packages/core/src/rules-catalog.js";

const fixtures = resolve(import.meta.dirname, "fixtures", "rules");
const LANGUAGES = ["zh", "en"];

// A path from the filesystem root that goes through at least one directory, a path from a drive
// letter, or a path from a home directory. A lone "/add-dir" is a host command a rule names, not
// a path.
const ABSOLUTE_PATH = /(?<![\w.~-])\/[\w.@-]+\/|\b[A-Za-z]:[\\/]|(?<![\w.-])~[\\/]/u;

function absolutePath(text) {
  return ABSOLUTE_PATH.exec(text)?.[0] ?? null;
}

test("the engine ships four built-in rules at their versions, batch processing at v3", () => {
  assert.deepEqual(BUILT_IN_RULES.map((rule) => [rule.id, rule.version]), [
    ["autonomy", 1],
    ["batch", 3],
    ["unattended-commands", 1],
    ["silent-reporting", 1],
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

test("every Chinese body is the Owner's final text word for word, and so is the English body of silent-reporting", async () => {
  for (const rule of BUILT_IN_RULES) {
    assert.equal(rule.body.zh, await readFile(join(fixtures, `${rule.id}.zh.md`), "utf8"), rule.id);
  }
  assert.equal(builtInRule("silent-reporting")?.body.en, await readFile(join(fixtures, "silent-reporting.en.md"), "utf8"));
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

// The old bodies remain applicable to enabled v2 projects until an explicit upgrade.
test("INIT-053 R1-R5: v3 preserves the six principles in both languages and adds communication and waiting", async () => {
  for (const language of LANGUAGES) {
    const previous = await readFile(join(fixtures, `batch-v2.${language}.md`), "utf8");
    const current = builtInRule("batch").body[language];
    const heading = language === "zh" ? "### 代理通信与等待" : "### Agent communication and waiting";
    assert.equal(current.split(heading)[0].trimEnd(), previous.replace("v2", "v3").trimEnd());
    const clauses = current.split(heading)[1];
    for (const fragment of language === "zh"
      ? ["普通进度", "完成时报告", "宿主完成通知", "send_message", "安全问题", "硬阻塞", "依赖或冲突", "事实澄清", "不回复纯确认", "不催问", "直接处理", "全体状态查询", "阻塞等待", "延长查询间隔", "等待上限", "用户中断", "独立可做"]
      : ["ordinary progress", "package is complete", "completion notification", "send_message", "safety issues", "hard blockers", "dependencies or conflicts", "factual clarification", "pure acknowledgments", "ordinary progress", "Act directly", "every agent's status", "blocking waits", "Lengthen query intervals", "wait limit", "user interruption", "independent work"]) {
      assert.ok(clauses.includes(fragment), `${language}: ${fragment}`);
    }
  }
});

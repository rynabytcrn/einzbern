// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-353 (TCRN-CROSS-STORY-487): keep the Wiki page set and navigation complete.

import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const wikiDirectory = new URL("../docs/wiki/", import.meta.url);
const topicPages = [
  "Glossary.md",
  "Install-Wizard.md",
  "Ether-Layout.md",
  "Managed-Sections-and-Command-Spell.md",
  "Variables.md",
  "Gates.md",
  "Atelier.md",
  "Multi-Device-and-Cloud.md",
  "Migrating-from-TCRN-Workflow.md",
  "CLI-Reference.md",
  "FAQ.md",
];
const historySections = [
  "Home",
  "README-如何发布",
  "仓库布局",
  "信任链与发版",
  "判据与门",
  "命令参考",
  "已知限制",
  "常见问答",
  "快速开始",
  "架构总览",
];

function markdownTargets(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function pageNameForTarget(target) {
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  assert.ok(withoutFragment.length > 0, `empty wiki target: ${target}`);
  assert.ok(!withoutFragment.startsWith("/"), `absolute wiki target: ${target}`);
  assert.ok(!withoutFragment.split("/").includes(".."), `escaping wiki target: ${target}`);
  return withoutFragment;
}

test("487-AC1: all eleven topic pages, Home, and the single History archive are present", async () => {
  assert.equal(topicPages.length, 11);
  for (const page of [...topicPages, "Home.md", "History.md", "_Sidebar.md"]) {
    await access(new URL(page, wikiDirectory));
  }

  const history = await readFile(new URL("History.md", wikiDirectory), "utf8");
  for (const section of historySections) {
    assert.ok(history.includes(`## ${section}\n`), `History contains the archived ${section} draft`);
  }
});

test("the Home and sidebar links resolve to checked-in Wiki pages", async () => {
  const pageNames = new Set((await readdir(wikiDirectory)).filter((name) => name.endsWith(".md")));
  const home = await readFile(new URL("Home.md", wikiDirectory), "utf8");
  const sidebar = await readFile(new URL("_Sidebar.md", wikiDirectory), "utf8");

  for (const target of markdownTargets(home)) {
    assert.ok(pageNames.has(pageNameForTarget(target)), `Home target resolves: ${target}`);
  }
  for (const page of [...topicPages, "History.md"]) {
    assert.ok(markdownTargets(home).some((target) => pageNameForTarget(target) === page), `Home links to ${page}`);
  }
  for (const target of markdownTargets(sidebar)) {
    assert.ok(pageNames.has(pageNameForTarget(target)), `sidebar target resolves: ${target}`);
  }
});

test("Wiki pages contain no absolute paths", async () => {
  const pageNames = (await readdir(wikiDirectory)).filter((name) => name.endsWith(".md"));
  const unixAbsolutePath = /(?:^|[\s"'`(])\/(?!\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/m;
  const windowsAbsolutePath = /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/])/m;

  for (const page of pageNames) {
    const markdown = await readFile(new URL(page, wikiDirectory), "utf8");
    assert.doesNotMatch(markdown, unixAbsolutePath, `${page} has no Unix absolute path`);
    assert.doesNotMatch(markdown, windowsAbsolutePath, `${page} has no Windows absolute path`);
    assert.doesNotMatch(markdown, /\bfile:\/\/\//i, `${page} has no file URL`);
  }
});

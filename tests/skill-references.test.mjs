// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-479 R2 (MIN-227 D24): the skill keeps its wizard text in six references, one
// per install-type task, and SKILL.md keeps only the navigation table. Each reference opens by
// saying it loads only for install-type tasks, names the setup mode and flags it drives (doctor.md
// its eight checks), asks one question list that both hosts share (TCRN-CROSS-STORY-480
// Assumptions), ends in a final confirmation, and names no local path and no version literal, so
// the copy installed on any device reads the same.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { BRAND } from "../dist/build/packages/core/src/names.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const referenceDirectory = join(repositoryRoot, "skill", BRAND.helper.id, "references");

// Each reference and the setup text that drives it; doctor.md drives the doctor verb and hands
// its fixes to repair.
const REFERENCES = Object.freeze({
  install: ["setup --mode fresh"],
  restore: ["setup --mode restore", "--restore <library path>"],
  update: ["setup --mode update", "--mode repair", "--rollback true", "--archive <local archive>"],
  migrate: ["setup --mode migrate", "--mapping <file>"],
  uninstall: ["setup --mode uninstall", "--managed-sections keep", "--managed-sections remove"],
  doctor: ["doctor --project <dir>", "setup --mode repair"],
});
const DOCTOR_CHECKS = Object.freeze(["engine-version", "hooks-present", "skill-copies", "registry", "library-format", "device-stream", "managed-sections", "cloud-flag"]);
const LOADING_RULE = "Load this reference only during an install-type task";
// Built from parts so that this file does not itself read as a local path.
const LOCAL_PATHS = Object.freeze([["", "Users", ""].join("/"), ["", "home", ""].join("/"), ["", "Users", ""].join("\\")]);
const VERSION_LITERAL = /\bv?\d+\.\d+(?:\.\d+)*\b/u;

function reference(name) {
  return readFile(join(referenceDirectory, `${name}.md`), "utf8");
}

function firstProse(text) {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#")) ?? "";
}

test("479-R2: the six install-type references are present", async () => {
  for (const name of Object.keys(REFERENCES)) {
    assert.ok((await reference(name)).trim().length > 0, `${name}.md is empty`);
  }
});

test("479-R2: each reference names its setup mode and flags, and doctor.md handles its eight checks", async () => {
  for (const [name, phrases] of Object.entries(REFERENCES)) {
    const text = await reference(name);
    for (const phrase of phrases) assert.ok(text.includes(phrase), `${name}.md does not name ${phrase}`);
  }
  const doctor = await reference("doctor");
  for (const check of DOCTOR_CHECKS) assert.ok(doctor.includes(`### ${check}\n`), `doctor.md has no handling for ${check}`);
});

test("479-R2: each reference opens by limiting itself to install-type tasks", async () => {
  for (const name of Object.keys(REFERENCES)) {
    assert.ok(firstProse(await reference(name)).startsWith(LOADING_RULE), `${name}.md does not open with the loading rule`);
  }
});

test("479-R2, 480 Assumptions: one question screen serves both hosts and ends in a final confirmation", async () => {
  for (const name of Object.keys(REFERENCES)) {
    const text = await reference(name);
    assert.match(text, /^## Questions \(one screen\)$/mu, `${name}.md has no question screen`);
    assert.ok(text.includes("AskUserQuestion") && text.includes("Codex"), `${name}.md does not say how each host asks`);
    assert.ok(text.includes("SETUP_PLAN_READY") && text.includes("--yes true"), `${name}.md has no final confirmation`);
  }
});

test("479-R2: no reference names a local path or a version literal", async () => {
  assert.match("engine 1.2.3", VERSION_LITERAL);
  assert.match("v0.9", VERSION_LITERAL);
  for (const name of Object.keys(REFERENCES)) {
    const text = await reference(name);
    for (const path of LOCAL_PATHS) assert.equal(text.includes(path), false, `${name}.md names a local path`);
    assert.doesNotMatch(text, VERSION_LITERAL, `${name}.md carries a version literal`);
  }
});

// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-466 R1, R5: one module owns every name, and the legacy alias table in
// CHANGELOG.md and docs/wiki/Glossary.md is that module's table, row for row.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ALIAS_TABLE_END_MARKER,
  ALIAS_TABLE_START_MARKER,
  BRAND,
  DIRECTORY,
  LEGACY_NAMES,
  SCHEMA_NAMESPACE,
  LEGACY_SCHEMA_NAMESPACE,
  isLegacySchemaVersion,
  renderLegacyAliasTable,
} from "../dist/build/packages/core/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

function markedBlock(text, label) {
  const start = text.indexOf(ALIAS_TABLE_START_MARKER);
  const end = text.indexOf(ALIAS_TABLE_END_MARKER);
  assert.ok(start !== -1 && end > start, `${label} carries the alias-table markers in order`);
  assert.equal(text.indexOf(ALIAS_TABLE_START_MARKER, start + 1), -1, `${label} carries one alias table`);
  return text
    .slice(start + ALIAS_TABLE_START_MARKER.length, end)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function rowCells(line) {
  return line
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

for (const [label, path] of [
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["docs/wiki/Glossary.md", "docs/wiki/Glossary.md"],
]) {
  test(`466-R5: the alias table in ${label} equals the names module, line for line`, async () => {
    const lines = markedBlock(await readFile(resolve(repositoryRoot, path), "utf8"), label);
    assert.deepEqual(lines, [...renderLegacyAliasTable()]);
    const rows = lines.slice(2).map(rowCells);
    assert.equal(rows.length, LEGACY_NAMES.length);
    rows.forEach((cells, index) => {
      const entry = LEGACY_NAMES[index];
      assert.equal(cells[0], `\`${entry.legacy}\``);
      assert.equal(cells[1], entry.current === null ? "（不改名、不迁移）" : `\`${entry.current}\``);
      assert.equal(cells[2], entry.note);
    });
  });
}

test("466-R1: the new names are the ones MIN-227 D1 fixed", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BRAND).map(([key, entry]) => [key, [entry.name, entry.id]])),
    {
      engine: ["Einzbern", "einzbern"],
      helper: ["Mana Orchestrate", "mana-orchestrate"],
      portal: ["Atelier", "atelier"],
      principles: ["Command Spell", "command-spell"],
    },
  );
  for (const entry of Object.values(BRAND)) {
    assert.ok(entry.plain.length > 0, `${entry.name} carries a plain explanation`);
  }
  assert.deepEqual(DIRECTORY, {
    library: ".ether",
    events: "akasha",
    knowledge: "crest",
    projectConfig: "config",
    artifacts: "artifacts",
    device: ".einzbern",
    cloudDefaultParent: "Ether",
  });
});

test("466-R2: tcrn.* is the legacy namespace and einzbern.* the namespace new writes use", () => {
  assert.equal(SCHEMA_NAMESPACE, "einzbern.");
  assert.equal(LEGACY_SCHEMA_NAMESPACE, "tcrn.");
  assert.equal(isLegacySchemaVersion("tcrn.event.v1"), true);
  assert.equal(isLegacySchemaVersion("einzbern.event.v1"), false);
});

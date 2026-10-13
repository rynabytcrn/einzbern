// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-350 (TCRN-CROSS-STORY-487): keep the checked-in Wiki page tied to the catalog.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { CLI_REFERENCE_PATH, renderCliReference } from "../scripts/wiki-cli-reference.mjs";

test("487-AC2: the Wiki CLI reference is generated from COMMAND_CATALOG", async () => {
  const page = await readFile(CLI_REFERENCE_PATH, "utf8");
  assert.equal(page, renderCliReference());

  for (const command of COMMAND_CATALOG) {
    assert.ok(page.includes(`## \`${command.name}\``), `${command.name} has a section`);
    assert.ok(page.includes(`- 可用范围：\`${command.availability}\`。`), `${command.name} shows availability`);
    assert.ok(page.includes(`- 是否写入：${command.mutates ? "是" : "否"}。`), `${command.name} shows whether it writes`);
    for (const flag of command.flags) {
      const required = flag.required ? "必填" : "可选";
      assert.ok(
        page.includes(`| \`--${flag.name}\` | ${required} | \`${flag.valueKind}\` |`),
        `${command.name} --${flag.name} shows requiredness and value kind`,
      );
      if (flag.valueShape !== undefined) {
        assert.ok(page.includes(`| \`--${flag.name}\` | ${required} | \`${flag.valueKind}\` | \`${flag.valueShape}\` |`), `${command.name} --${flag.name} shows how its value is written`);
      }
    }
  }
});

// TCRN-CROSS-STORY-526 (Q15; TCRN-CROSS-SUB-455): a verb whose flags say how a value is written gets a
// fourth column, 写法; every other verb's table keeps its three columns.
test("526 GWT5: the reference renders valueShape in a fourth column for the verbs that carry one", () => {
  const page = renderCliReference([
    { name: "shaped", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }, { name: "decided-in", required: false, valueKind: "string", valueShape: "minutes:<id>#D<n>" }] },
    { name: "plain", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  ]);
  const section = (name) => page.split(`## \`${name}\``)[1].split("\n## ")[0];
  assert.match(section("shaped"), /\| 旗标 \| 必填 \| 取值类型 \| 写法 \|\n\| --- \| --- \| --- \| --- \|/u);
  assert.ok(section("shaped").includes("| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |"));
  assert.ok(section("shaped").includes("| `--at` | 必填 | `instant` |  |"));
  assert.match(section("plain"), /\| 旗标 \| 必填 \| 取值类型 \|\n\| --- \| --- \| --- \|\n\| `--workspace` \| 可选 \| `string` \|$/mu);
  const real = renderCliReference();
  const realSection = (name) => real.split(`## \`${name}\``)[1].split("\n## ")[0];
  for (const name of ["gates-config-set", "gates-config-remove", "rule-enable", "rule-disable", "settings-set", "settings-remove", "variable-set", "variable-remove"]) {
    assert.ok(realSection(name).includes("| `--decided-in` | 可选 | `string` | `minutes:<id>#D<n>` |"), name);
  }
  assert.equal(realSection("status").includes("写法"), false, "a verb without a shaped flag keeps three columns");
});

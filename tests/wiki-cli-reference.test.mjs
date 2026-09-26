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
    }
  }
});

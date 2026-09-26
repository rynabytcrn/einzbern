#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-350 (TCRN-CROSS-STORY-487): render the Wiki CLI reference from
// the same catalog that the `commands` verb exposes.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_REFERENCE_PATH = join(REPOSITORY_ROOT, "docs/wiki/CLI-Reference.md");

function renderFlag(flag) {
  const required = flag.required ? "必填" : "可选";
  return `| \`--${flag.name}\` | ${required} | \`${flag.valueKind}\` |`;
}

/** Render every catalog entry in catalog order, including verbs that are not exposed by the CLI. */
export function renderCliReference(catalog = COMMAND_CATALOG) {
  const commands = catalog.map((command) => {
    const flags = command.flags.length === 0
      ? "无旗标。"
      : [
        "| 旗标 | 必填 | 取值类型 |",
        "| --- | --- | --- |",
        ...command.flags.map(renderFlag),
      ].join("\n");
    return [
      `## \`${command.name}\``,
      "",
      `- 可用范围：\`${command.availability}\`。`,
      `- 是否写入：${command.mutates ? "是" : "否"}。`,
      "",
      flags,
    ].join("\n");
  });

  return [
    "# 命令行参考",
    "",
    "本页由 `scripts/wiki-cli-reference.mjs` 根据 `COMMAND_CATALOG` 生成。每个动词均列出可用范围、是否写入，以及旗标是否必填和取值类型；`programmatic-only` 表示只能由程序调用。",
    "",
    ...commands.flatMap((command, index) => index === 0 ? [command] : ["", command]),
    "",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("usage: node scripts/wiki-cli-reference.mjs [--check]");
  }

  const expected = renderCliReference();
  if (args[0] === "--check") {
    let actual;
    try {
      actual = await readFile(CLI_REFERENCE_PATH, "utf8");
    } catch (error) {
      const code = error?.code === "ENOENT" ? "CLI_REFERENCE_MISSING" : String(error?.message ?? error);
      process.stderr.write(`${code}: docs/wiki/CLI-Reference.md\n`);
      process.exitCode = 1;
      return;
    }
    if (actual !== expected) {
      process.stderr.write("CLI_REFERENCE_OUT_OF_DATE: run node scripts/wiki-cli-reference.mjs\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write("CLI_REFERENCE_UP_TO_DATE\n");
    return;
  }

  await writeFile(CLI_REFERENCE_PATH, expected, "utf8");
  process.stdout.write("CLI_REFERENCE_WRITTEN\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}

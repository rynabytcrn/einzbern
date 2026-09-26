#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-486 R1, R4 (TCRN-CROSS-SUB-347): the five root READMEs are rendered, not
// written. The finalized Einzbern READMEs are kept under docs/readme/einzbern/ as templates,
// and the one value a template cannot carry is the release version, spelled {{version}}.
// This fills it in and writes README.md, README.en.md, README.ja.md, README.ko.md and
// README.fr.md at the repository root. Change a template and rerun this; a root README is
// never edited by hand.
//
// Usage: node scripts/render-readme.mjs [--version <version>] [--check]
//   --version  the version to fill in; package.json's version when omitted
//   --check    compare the root READMEs with the rendering and write nothing

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const README_TEMPLATE_DIRECTORY = "docs/readme/einzbern";
export const README_NAMES = Object.freeze(["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"]);
export const VERSION_PLACEHOLDER = "{{version}}";
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

class RenderError extends Error {
  constructor(reasonCode, detail = null) {
    super(reasonCode);
    this.reasonCode = reasonCode;
    this.detail = detail;
  }
}

export function renderReadme(template, version) {
  return template.replaceAll(VERSION_PLACEHOLDER, version);
}

function parseArguments(argv) {
  const options = { check: false, version: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
    } else if (argument === "--version") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new RenderError("README_RENDER_VERSION_MISSING");
      options.version = value;
      index += 1;
    } else {
      throw new RenderError("README_RENDER_ARGUMENT_UNKNOWN", argument);
    }
  }
  return options;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function renderReadmes({ root = REPOSITORY_ROOT, version = null, check = false } = {}) {
  const resolved = version ?? JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (typeof resolved !== "string" || !VERSION_SHAPE.test(resolved)) throw new RenderError("README_RENDER_VERSION_INVALID", String(resolved));
  const drifted = [];
  const written = [];
  for (const name of README_NAMES) {
    const template = await readIfPresent(join(root, README_TEMPLATE_DIRECTORY, name));
    if (template === null) throw new RenderError("README_TEMPLATE_MISSING", `${README_TEMPLATE_DIRECTORY}/${name}`);
    const rendered = renderReadme(template, resolved);
    if ((await readIfPresent(join(root, name))) === rendered) continue;
    if (check) {
      drifted.push(name);
    } else {
      await writeFile(join(root, name), rendered);
      written.push(name);
    }
  }
  if (check) {
    return { ok: drifted.length === 0, reasonCode: drifted.length === 0 ? "README_RENDER_MATCHES" : "README_RENDER_DRIFTED", version: resolved, drifted };
  }
  return { ok: true, reasonCode: "README_RENDERED", version: resolved, written };
}

// Node resolves the entry module to its real path, while argv keeps the path as typed; through
// a symlink (the macOS temporary directory is one) a plain comparison of the two never matches,
// and --check would print nothing and exit 0. Both sides are compared as real paths.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await renderReadmes(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const reasonCode = error instanceof RenderError ? error.reasonCode : String(error?.message ?? error);
    const detail = error instanceof RenderError ? error.detail : null;
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode, detail })}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-471 R2 (MIN-227 D23): the stable entry of the engine versions installed on a
// device. The installer places this file as engine/einzbern.mjs in the device directory, beside
// engine/current and one directory per version, and every hook and registry pointer names it,
// never a version directory. It reads engine/current and runs
// engine/<version>/scripts/einzbern.mjs in this process with the same arguments, so it exits
// with that engine's exit code; switching versions (engine-update, engine-rollback) rewrites
// engine/current and nothing that names this file. It imports nothing from any engine, so no
// engine version has to change it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const engineRoot = dirname(fileURLToPath(import.meta.url));
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function refuse(reasonCode, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, error: message })}\n`);
  process.exitCode = 1;
  return null;
}

function currentEntry() {
  const pointer = join(engineRoot, "current");
  let current;
  try {
    current = JSON.parse(readFileSync(pointer, "utf8"));
  } catch (error) {
    return refuse("ENGINE_CURRENT_INVALID", error?.code === "ENOENT"
      ? `${pointer} does not exist: no engine version is current (engine-update installs one)`
      : `${pointer} cannot be read as the current engine version`);
  }
  if (current?.schemaVersion !== "einzbern.engine-current.v1" || typeof current.version !== "string" || !VERSION_PATTERN.test(current.version)) {
    return refuse("ENGINE_CURRENT_INVALID", `${pointer} does not name an engine version`);
  }
  const entry = join(engineRoot, current.version, "scripts", "einzbern.mjs");
  if (!existsSync(entry)) return refuse("ENGINE_NOT_INSTALLED", `engine ${current.version} is current but ${entry} does not exist`);
  return entry;
}

const entry = currentEntry();
if (entry !== null) await import(pathToFileURL(entry).href);

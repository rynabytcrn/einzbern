#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-488 R1, R2, R4 (TCRN-CROSS-SUB-355): keep the engine and helper on one
// version, prepare their local release files, run every release gate, then rehearse publication.
// Remote and tag actions only run when the caller names one with --execute.
// TCRN-CROSS-SUB-357 rev4 (Owner 2026-10-08 item 4): `generate` and `finish` split preparation
// around one local release commit per repository; `generate` writes the release files and a
// receipt, `finish` checks the two commits against it, then runs the gates and packs.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavySlot } from "./lib/heavy-runs.mjs";
import {
  RELEASE_ACTIONS,
  ReleaseLockstepError,
  buildPublishPlan,
  checkRelease,
  executeReleaseAction,
  finishRelease,
  generateRelease,
  prepareRelease,
} from "./lib/release-lockstep.mjs";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/release.mjs check --version <version> --helper <working tree> | prepare --version <version> --helper <working tree> --workspace <library> --project <registered project> [--project-id <stable project id>] [--work-id <comma-separated work ids>] | generate --version <version> --helper <working tree> --workspace <library> --project <registered project> [--project-id <stable project id>] [--work-id <comma-separated work ids>] --receipt <new file outside both repositories> [--keep-extra <helper path>]... | finish --version <version> --helper <working tree> --workspace <library> --project <registered project> [--project-id <stable project id>] [--work-id <comma-separated work ids>] --receipt <generate receipt> | publish-plan --version <version> --helper <working tree> --wiki-dir <Wiki working tree> [--execute tag|push|release|wiki]";
const COMMANDS = Object.freeze(["check", "prepare", "generate", "finish", "publish-plan"]);
const GATED_COMMANDS = Object.freeze(["prepare", "generate", "finish"]);
const RECEIPT_COMMANDS = Object.freeze(["generate", "finish"]);

function fail(reasonCode, message, details = {}) {
  throw new ReleaseLockstepError(reasonCode, message, details);
}

function parseArguments(argv) {
  let command = null;
  const values = new Map();
  const keepExtra = [];
  const options = new Set(["--version", "--helper", "--workspace", "--project", "--project-id", "--work-id", "--wiki-dir", "--execute", "--receipt", "--keep-extra"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") && command === null && COMMANDS.includes(argument)) {
      command = argument;
      continue;
    }
    if (!options.has(argument)) fail("RELEASE_ARGUMENT_UNKNOWN", `unknown argument ${argument}`, { argument });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("RELEASE_ARGUMENT_VALUE_MISSING", `${argument} needs a value`, { argument });
    index += 1;
    // --keep-extra may name several helper files; every other option is given once.
    if (argument === "--keep-extra") {
      keepExtra.push(value);
      continue;
    }
    if (values.has(argument)) fail("RELEASE_ARGUMENT_DUPLICATE", `${argument} is given twice`, { argument });
    values.set(argument, value);
  }
  const execute = values.get("--execute") ?? null;
  if (execute !== null && !RELEASE_ACTIONS.includes(execute)) {
    fail("RELEASE_ARGUMENT_INVALID", `--execute takes one of ${RELEASE_ACTIONS.join(", ")}`, { execute });
  }
  command ??= execute === null ? null : "publish-plan";
  if (command === null) fail("RELEASE_USAGE", USAGE);
  if (execute !== null && command !== "publish-plan") {
    fail("RELEASE_ARGUMENT_INVALID", "--execute is only valid with publish-plan", { command, execute });
  }
  for (const required of ["--version", "--helper"]) {
    if (!values.has(required)) fail("RELEASE_ARGUMENT_MISSING", `${required} is required`, { flag: required });
  }
  if ((execute === null && command === "publish-plan" || execute === "wiki") && !values.has("--wiki-dir")) {
    fail("RELEASE_ARGUMENT_MISSING", "--wiki-dir is required for publish-plan and Wiki execution", { flag: "--wiki-dir" });
  }
  for (const flag of ["--workspace", "--project"]) {
    if (GATED_COMMANDS.includes(command) && !values.has(flag)) {
      fail("RELEASE_ARGUMENT_MISSING", `${flag} is required for ${command} so release gates have an explicit library and project`, { flag });
    }
    if (!GATED_COMMANDS.includes(command) && values.has(flag)) {
      fail("RELEASE_ARGUMENT_INVALID", `${flag} is only used by prepare, generate and finish`, { flag });
    }
  }
  if (values.has("--project-id") && (!GATED_COMMANDS.includes(command) || !/^project:[a-f0-9]{24}$/u.test(values.get("--project-id")))) {
    fail("RELEASE_ARGUMENT_INVALID", "--project-id requires a stable project identifier and prepare, generate or finish", { flag: "--project-id" });
  }
  if (values.has("--work-id") && !GATED_COMMANDS.includes(command)) fail("RELEASE_ARGUMENT_INVALID", "--work-id is only used by prepare, generate and finish");
  if (RECEIPT_COMMANDS.includes(command) && !values.has("--receipt")) {
    fail("RELEASE_ARGUMENT_MISSING", `--receipt is required for ${command}`, { flag: "--receipt" });
  }
  if (!RECEIPT_COMMANDS.includes(command) && values.has("--receipt")) {
    fail("RELEASE_ARGUMENT_INVALID", "--receipt is only used by generate and finish", { flag: "--receipt" });
  }
  if (command !== "generate" && keepExtra.length > 0) {
    fail("RELEASE_ARGUMENT_INVALID", "--keep-extra is only used by generate", { flag: "--keep-extra" });
  }
  return {
    command,
    version: values.get("--version"),
    helperRoot: resolve(values.get("--helper")),
    workspace: values.has("--workspace") ? resolve(values.get("--workspace")) : null,
    projectRoot: values.has("--project") ? resolve(values.get("--project")) : null,
    projectId: values.get("--project-id") ?? null,
    receiptPath: values.has("--receipt") ? resolve(values.get("--receipt")) : null,
    workIds: values.get("--work-id") ?? [],
    keepExtra,
    wikiDirectory: values.has("--wiki-dir") ? resolve(values.get("--wiki-dir")) : null,
    execute,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "check") {
    return checkRelease({ engineRoot: ENGINE_ROOT, helperRoot: options.helperRoot, version: options.version });
  }
  if (options.command === "prepare") {
    return prepareRelease({ engineRoot: ENGINE_ROOT, helperRoot: options.helperRoot, version: options.version, workspace: options.workspace, projectRoot: options.projectRoot, projectId: options.projectId, workIds: options.workIds });
  }
  if (options.command === "generate") {
    return generateRelease({ engineRoot: ENGINE_ROOT, helperRoot: options.helperRoot, version: options.version, workspace: options.workspace, projectRoot: options.projectRoot, projectId: options.projectId, workIds: options.workIds, receiptPath: options.receiptPath, keepExtra: options.keepExtra });
  }
  if (options.command === "finish") {
    // TCRN-CROSS-SUB-484 (MIN-257 D6): finish runs the release gates and packs, a heavy run. It takes
    // a slot of execution.maxConcurrentHeavyRuns (scripts/lib/heavy-runs.mjs) before it checks
    // anything and holds it to the end; the gates and trains it starts inherit the slot through
    // EINZBERN_HEAVY_SLOT.
    const slot = await acquireHeavySlot({ command: "release finish" });
    try {
      return await finishRelease({ engineRoot: ENGINE_ROOT, helperRoot: options.helperRoot, version: options.version, workspace: options.workspace, projectRoot: options.projectRoot, projectId: options.projectId, workIds: options.workIds, receiptPath: options.receiptPath });
    } finally {
      slot.release();
    }
  }
  if (options.execute !== null) {
    return executeReleaseAction({
      action: options.execute,
      engineRoot: ENGINE_ROOT,
      helperRoot: options.helperRoot,
      version: options.version,
      wikiDirectory: options.wikiDirectory,
    });
  }
  return buildPublishPlan({
    engineRoot: ENGINE_ROOT,
    helperRoot: options.helperRoot,
    version: options.version,
    wikiDirectory: options.wikiDirectory,
  });
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "RELEASE_FAILED";
  const details = error?.details !== null && typeof error?.details === "object" ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}

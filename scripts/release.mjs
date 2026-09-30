#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-488 R1, R2, R4 (TCRN-CROSS-SUB-355): keep the engine and helper on one
// version, prepare their local release files, run every release gate, then rehearse publication.
// Remote and tag actions only run when the caller names one with --execute.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_ACTIONS,
  ReleaseLockstepError,
  buildPublishPlan,
  checkRelease,
  executeReleaseAction,
  prepareRelease,
} from "./lib/release-lockstep.mjs";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/release.mjs check --version <version> --helper <working tree> | prepare --version <version> --helper <working tree> --workspace <library> --project <registered project> | publish-plan --version <version> --helper <working tree> --wiki-dir <Wiki working tree> [--execute tag|push|release|wiki]";

function fail(reasonCode, message, details = {}) {
  throw new ReleaseLockstepError(reasonCode, message, details);
}

function parseArguments(argv) {
  let command = null;
  const values = new Map();
  const options = new Set(["--version", "--helper", "--workspace", "--project", "--wiki-dir", "--execute"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") && command === null && ["check", "prepare", "publish-plan"].includes(argument)) {
      command = argument;
      continue;
    }
    if (!options.has(argument)) fail("RELEASE_ARGUMENT_UNKNOWN", `unknown argument ${argument}`, { argument });
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail("RELEASE_ARGUMENT_VALUE_MISSING", `${argument} needs a value`, { argument });
    if (values.has(argument)) fail("RELEASE_ARGUMENT_DUPLICATE", `${argument} is given twice`, { argument });
    values.set(argument, value);
    index += 1;
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
    if (command === "prepare" && !values.has(flag)) {
      fail("RELEASE_ARGUMENT_MISSING", `${flag} is required for prepare so release gates have an explicit library and project`, { flag });
    }
    if (command !== "prepare" && values.has(flag)) {
      fail("RELEASE_ARGUMENT_INVALID", `${flag} is only used by prepare`, { flag });
    }
  }
  return {
    command,
    version: values.get("--version"),
    helperRoot: resolve(values.get("--helper")),
    workspace: values.has("--workspace") ? resolve(values.get("--workspace")) : null,
    projectRoot: values.has("--project") ? resolve(values.get("--project")) : null,
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
    return prepareRelease({ engineRoot: ENGINE_ROOT, helperRoot: options.helperRoot, version: options.version, workspace: options.workspace, projectRoot: options.projectRoot });
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

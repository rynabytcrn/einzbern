// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 / TCRN-CROSS-SUB-269: one place tests create a disposable workspace
// and drive the CLI against it. Tests that only need "a workspace I can write to" use this
// helper, so the storage layout it creates can change in one place (SUB-285 moves it to a
// library).

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "../../dist/build/packages/cli/src/index.js";
import { initializeWorkspace } from "../../dist/build/packages/core/src/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");

const ROOT_KINDS = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];

/** An instant `seconds` after 2026-01-01T00:00:00Z, in the strict form the engine takes. */
export function instant(seconds = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString().replace(".000Z", "Z");
}

/** Run one CLI command in-process; resolves to the parsed receipt, rejects with the engine error. */
export async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** Run one CLI command in its own process through the shipped entry. */
export function cliProcess(args, { env = {} } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

/**
 * A disposable workspace with a project, removed when the test ends.
 * Returns the workspace path, the project id and the base directory.
 */
export async function workspaceFixture(context, { externalKey = "FIXTURE-WORKSPACE", project = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-fixture-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = ROOT_KINDS.map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey, createdAt: instant(0) });
  let projectId = null;
  if (project) {
    const created = await cli(["project-create", "--workspace", workspace, "--at", instant(1), "--external-key", `${externalKey}-PROJECT`, "--name", "Fixture"]);
    projectId = created.record.id;
  }
  return { base, workspace, projectId };
}

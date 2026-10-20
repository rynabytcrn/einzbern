// SPDX-License-Identifier: Apache-2.0
// Batch fixture setup in one isolated process. Every operation still goes through
// the real CLI parser and engine writer; no copied event streams or shared libraries.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const self = fileURLToPath(import.meta.url);

async function register(libraries, invoke) {
  const ids = [];
  for (const { project, library, externalKey, projectKey = externalKey, times } of libraries) {
    await mkdir(project, { recursive: true });
    await invoke(["init", "--workspace", library, "--project-name", externalKey, "--at", times[0]]);
    const created = await invoke(["project-create", "--workspace", library, "--external-key", projectKey, "--name", externalKey, "--at", times[1]]);
    const id = created.record.id;
    await invoke(["library-register", "--project", project, "--library", library, "--project-id", id, "--at", times[2]]);
    ids.push(id);
  }
  return ids;
}

export async function registerLibraries(libraries, env) {
  // An explicitly overridden CLI keeps its process boundary and wrapper semantics.
  if (process.env.TCRN_WORKFLOW_CLI) {
    return register(libraries, async (args) => {
      const { stdout } = await execFileAsync(process.execPath, [process.env.TCRN_WORKFLOW_CLI, ...args], { env: { ...process.env, ...env }, maxBuffer: 32e6 });
      return JSON.parse(stdout);
    });
  }
  const { stdout } = await execFileAsync(process.execPath, [self, JSON.stringify(libraries)], { env: { ...process.env, ...env }, maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

if (process.argv[1] === self) {
  const { assertNodeFloor } = await import("../../dist/build/packages/core/src/node-floor.js");
  assertNodeFloor(process.versions.node);
  const { runCli } = await import("../../dist/build/packages/cli/src/index.js");
  const ids = await register(JSON.parse(process.argv[2]), async (args) => {
    let output = "";
    await runCli(args, { write: (value) => { output += value; } });
    return JSON.parse(output);
  });
  process.stdout.write(`${JSON.stringify(ids)}\n`);
}

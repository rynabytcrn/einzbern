// SPDX-License-Identifier: Apache-2.0
// Test-only construction of historical model-plan records. The portal consumes
// the public CLI at runtime; this helper exercises defining workspace reducers
// only when a fixture needs an old record for replay coverage.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function historicalModelPlan(workspace, operation, input, occurredAt) {
  const moduleUrl = new URL("../../dist/build/packages/core/src/workspace.js", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); const data = JSON.parse(process.argv[1]); const options = { ...data.input, occurredAt: data.occurredAt, actorId: "agent:test" }; const state = data.operation === "set" ? await m.setModelPlanInWorkspace(data.workspace, options) : await m.assignModelPlanInWorkspace(data.workspace, options); process.stdout.write(JSON.stringify({ version: state.version, executionConfig: state.executionConfig }));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ workspace, operation, input, occurredAt })], { encoding: "utf8", maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

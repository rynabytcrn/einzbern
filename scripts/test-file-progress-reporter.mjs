// SPDX-License-Identifier: Apache-2.0
// The spec reporter remains the sole text producer. This observer never yields.

import { expectedDiagnosticError, openFileObserver } from "./lib/test-run-diagnostics.mjs";

export default async function* testFileProgressReporter(source) {
  let observer = null;
  try {
    observer = openFileObserver(process.env, {
      nodeVersion: process.version, pid: process.pid, ppid: process.ppid,
      outerPid: process.env.TCRN_TEST_CONTROLLER_OUTER_PID,
      groupPid: process.env.TCRN_TEST_CONTROLLER_PROCESS_GROUP,
    });
  } catch (error) {
    if (!expectedDiagnosticError(error)) throw error;
  }
  const started = performance.now();
  let complete = false;
  try {
    for await (const event of source) observer?.observe(event, performance.now() - started);
    complete = true;
  } finally {
    observer?.finish(performance.now() - started, complete);
  }
}

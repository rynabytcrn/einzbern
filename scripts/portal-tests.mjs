#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { acquireHeavySlot } from "./lib/heavy-runs.mjs";
import { memoryTestArguments } from "./lib/memory-budget.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";
import { selectTestFiles } from "./lib/test-roster.mjs";

// Match the Core suite's device isolation: tests may initialize engine identity,
// but never in the caller's device home. Other explicit test inputs are retained.
export async function runPortalTestFiles(tests, environment = process.env) {
  const slot = await acquireHeavySlot({ command: "portal:test", env: environment });
  let deviceDirectory;
  try {
    deviceDirectory = await mkdtemp(join(tmpdir(), "einzbern-portal-device-"));
    return await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, memoryTestArguments(["--test", ...tests]), {
        cwd: repositoryRoot,
        env: { ...environment, EINZBERN_HOME: join(deviceDirectory, "einzbern"), EINZBERN_TEST_DEVICE_ROOT: deviceDirectory },
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", code => resolveResult(code ?? 1));
    });
  } finally {
    try { if (deviceDirectory) await rm(deviceDirectory, { recursive: true, force: true }); }
    finally { slot.release(); }
  }
}

async function main() {
  const tests = selectTestFiles((await walkFiles()).map((path) => toPosixPath(relative(repositoryRoot, path))), "portal");
  if (tests.length === 0) throw new Error("Portal test roster is empty");
  if (process.env.EINZBERN_PORTAL_EVIDENCE_DIR) {
    await writeFile(join(process.env.EINZBERN_PORTAL_EVIDENCE_DIR, "test-roster.json"), `${JSON.stringify(tests)}\n`, { flag: "wx" });
  }
  process.exitCode = await runPortalTestFiles(tests);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

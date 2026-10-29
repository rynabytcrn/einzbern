#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { acquireHeavySlot } from "./lib/heavy-runs.mjs";
import { memoryTestArguments } from "./lib/memory-budget.mjs";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";
import { selectTestFiles } from "./lib/test-roster.mjs";

const tests = selectTestFiles((await walkFiles()).map((path) => toPosixPath(relative(repositoryRoot, path))), "portal");
if (tests.length === 0) throw new Error("Portal test roster is empty");
if (process.env.EINZBERN_PORTAL_EVIDENCE_DIR) {
  await writeFile(join(process.env.EINZBERN_PORTAL_EVIDENCE_DIR, "test-roster.json"), `${JSON.stringify(tests)}\n`, { flag: "wx" });
}
const slot = await acquireHeavySlot({ command: "portal:test" });
const child = spawn(process.execPath, memoryTestArguments(["--test", ...tests]), { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("close", (code) => { try { slot.release(); } catch (error) { process.stderr.write(`${error.reasonCode ?? error.message}\n`); process.exitCode = 1; return; } process.exitCode = code ?? 1; });

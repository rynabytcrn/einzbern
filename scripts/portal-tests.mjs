#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
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
const child = spawn(process.execPath, ["--test", ...tests], { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });

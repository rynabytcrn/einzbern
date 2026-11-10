// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const [baseline, candidate, library] = process.argv.slice(2);
const script = fileURLToPath(new URL("./recall-sample.mjs", import.meta.url));
for (let pair = 0; pair < 15; pair += 1) {
  const modes = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (const mode of [...modes, "candidate-observed"]) {
    const result = spawnSync(process.execPath, [script, mode === "baseline" ? baseline : candidate, library, mode === "baseline" ? "baseline" : "candidate", mode === "candidate-observed" ? "1" : "0"], { encoding: "utf8", env: process.env });
    console.log(JSON.stringify({ pair, mode, exit: result.status, stderr: result.stderr, ...(result.status === 0 ? { sample: JSON.parse(result.stdout) } : { stdout: result.stdout }) }));
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [baseline, candidate, library, entrySpec] = process.argv.slice(2);
const spec = entrySpec === undefined ? null : JSON.parse(await readFile(entrySpec, "utf8"));
if (spec !== null && dirname(resolve(spec.deviceTemplate)) !== resolve(spec.deviceRoot)) {
  throw new Error("Sample devices must be siblings of the template to preserve device-relative registry/configuration paths");
}
const script = fileURLToPath(new URL(spec === null ? "./recall-sample.mjs" : "./recall-entry-sample.mjs", import.meta.url));
let failures = 0;
for (let pair = 0; pair < 15; pair += 1) {
  const modes = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (let queryIndex = 0; queryIndex < (spec?.queries.length ?? 1); queryIndex += 1) {
    for (const mode of [...modes, "candidate-observed"]) {
      const repository = mode === "baseline" ? baseline : candidate;
      const observed = mode === "candidate-observed" ? "1" : "0";
      let environment = process.env;
      let device;
      if (spec !== null) {
        device = join(resolve(spec.deviceRoot), `${spec.devicePrefix ?? ""}${pair}-${queryIndex}-${mode}`);
        // Each destination must be new: rerunning a series requires a new deviceRoot.
        await mkdir(device);
        for (const name of await readdir(resolve(spec.deviceTemplate))) {
          await cp(join(resolve(spec.deviceTemplate), name), join(device, name), { recursive: true, force: false, errorOnExist: true });
        }
        environment = { ...process.env, EINZBERN_HOME: device };
      }
      const args = spec === null
        ? [script, repository, library, mode === "baseline" ? "baseline" : "candidate", observed]
        : [script, repository, library, resolve(entrySpec), String(queryIndex), observed];
      const osTime = spec?.osTime === true && process.platform === "darwin";
      const started = performance.now();
      const result = spawnSync(osTime ? "/usr/bin/time" : process.execPath, osTime ? ["-lp", process.execPath, ...args] : args, { encoding: "utf8", env: environment });
      const lifecycleElapsedMs = performance.now() - started;
      let sample;
      let parseError = null;
      try { sample = JSON.parse(result.stdout); } catch (error) { parseError = error.message; }
      if (result.status !== 0 || parseError !== null) failures += 1;
      const osSeconds = name => osTime ? Number(result.stderr.match(new RegExp(`^${name}\\s+([0-9.]+)$`, "mu"))?.[1] ?? NaN) : NaN;
      const osUserSeconds = osSeconds("user");
      const osSystemSeconds = osSeconds("sys");
      const osMaxRssBytes = osTime ? Number(result.stderr.match(/^\s*(\d+)\s+maximum resident set size$/mu)?.[1] ?? NaN) : NaN;
      let resultLogs = [];
      if (device !== undefined) {
        try {
          resultLogs = (await readFile(join(device, "log/hook.ndjson"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      console.log(JSON.stringify({ pair, queryIndex, mode, exit: result.status, signal: result.signal, lifecycleElapsedMs,
        lifecycleBoundary: osTime ? "spawn /usr/bin/time -lp Node through close" : "spawn Node through close",
        osUserSeconds: Number.isFinite(osUserSeconds) ? osUserSeconds : null,
        osSystemSeconds: Number.isFinite(osSystemSeconds) ? osSystemSeconds : null,
        osMaxRssBytes: Number.isFinite(osMaxRssBytes) ? osMaxRssBytes : null,
        stderr: result.stderr, stdout: result.stdout, resultLogs, parseError, ...(sample === undefined ? {} : { sample }) }));
    }
  }
}
process.exitCode = failures === 0 ? 0 : 1;

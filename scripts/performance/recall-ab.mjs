// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { groups: { type: "string", default: "15" }, "start-pair": { type: "string", default: "0" }, "query-indexes": { type: "string" } },
});
const [baseline, candidate, library, entrySpec] = positionals;
if (positionals.length < 3 || positionals.length > 4) throw new Error("Expected baseline, candidate, library and optional entry spec");
const groups = Number(values.groups), startPair = Number(values["start-pair"]);
if (!Number.isSafeInteger(groups) || groups < 1 || !Number.isSafeInteger(startPair) || startPair < 0 || !Number.isSafeInteger(startPair + groups)) {
  throw new Error("groups must be positive and start-pair nonnegative safe integers");
}
const spec = entrySpec === undefined ? null : JSON.parse(await readFile(entrySpec, "utf8"));
const queryCount = spec?.queries.length ?? 1;
const queryIndexes = values["query-indexes"] === undefined ? Array.from({ length: queryCount }, (_, index) => index)
  : values["query-indexes"].split(",").map(value => value.trim() === "" ? NaN : Number(value));
if (queryIndexes.length === 0 || new Set(queryIndexes).size !== queryIndexes.length
  || queryIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= queryCount)) {
  throw new Error("query-indexes must select unique indexes from the unchanged input spec");
}
if (spec !== null && dirname(resolve(spec.deviceTemplate)) !== resolve(spec.deviceRoot)) {
  throw new Error("Sample devices must be siblings of the template to preserve device-relative registry/configuration paths");
}
const script = fileURLToPath(new URL(spec === null ? "./recall-sample.mjs" : "./recall-entry-sample.mjs", import.meta.url));
let failures = 0;
for (let pair = startPair; pair < startPair + groups; pair += 1) {
  const modes = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (const queryIndex of queryIndexes) {
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
        invocation: { command: osTime ? "/usr/bin/time" : process.execPath, argv: osTime ? ["-lp", process.execPath, ...args] : args, cwd: process.cwd(),
          environmentSha256: createHash("sha256").update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex"), deviceHome: device ?? null },
        lifecycleBoundary: osTime ? "spawn /usr/bin/time -lp Node through close" : "spawn Node through close",
        osUserSeconds: Number.isFinite(osUserSeconds) ? osUserSeconds : null,
        osSystemSeconds: Number.isFinite(osSystemSeconds) ? osSystemSeconds : null,
        osMaxRssBytes: Number.isFinite(osMaxRssBytes) ? osMaxRssBytes : null,
        stderr: result.stderr, stdout: result.stdout, resultLogs, parseError, ...(sample === undefined ? {} : { sample }) }));
    }
  }
}
process.exitCode = failures === 0 ? 0 : 1;

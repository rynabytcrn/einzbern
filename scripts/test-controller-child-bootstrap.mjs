// SPDX-License-Identifier: Apache-2.0

// A controller-managed child group starts here and remains inert until the
// owning test process has durably registered this process group. The command
// then runs inside the same group with only the gate runner's private pipes.

import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [tokenArgument, executable, ...arguments_] = process.argv.slice(2);
const tokenPrefix = "--tcrn-controller-child=";
const token = typeof tokenArgument === "string" && tokenArgument.startsWith(tokenPrefix) ? tokenArgument.slice(tokenPrefix.length) : "";
const registryDirectory = process.env.TCRN_TEST_CONTROLLER_CHILD_REGISTRY ?? "";
const ownerPid = Number(process.env.TCRN_TEST_CONTROLLER_CHILD_OWNER_PID);
const childGroupSchema = "tcrn.test-controller-child-group.v1";

function fail(reasonCode) {
  process.stderr.write(`${JSON.stringify({ reasonCode })}\n`);
  process.exitCode = 1;
}

function slotPaths() {
  return Array.from({ length: 8 }, (_, index) => resolve(registryDirectory, `slot-${index}.ndjson`));
}

function readState(path) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let state = null;
  for (const line of lines) {
    if (line === "") continue;
    const event = JSON.parse(line);
    if (event?.schemaVersion !== childGroupSchema || event.token !== token || event.ownerPid !== ownerPid) return null;
    if (state === null && event.state !== "reserved") return null;
    if (state !== null && !["bound", "finished", "cancelled"].includes(event.state)) return null;
    state = event;
  }
  return state;
}

function registeredHere() {
  if (!registryDirectory.startsWith("/") || !/^[0-9a-f]{32}$/u.test(token) ||
      !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || process.ppid !== ownerPid) return false;
  for (const path of slotPaths()) {
    const state = readState(path);
    if (state?.state === "bound" && state.processGroup === process.pid) return true;
  }
  return false;
}

async function waitForRegistration() {
  for (let elapsed = 0; elapsed < 5_000; elapsed += 10) {
    if (process.ppid !== ownerPid) return false;
    try { process.kill(ownerPid, 0); }
    catch (error) { if (error?.code === "ESRCH") return false; throw error; }
    if (registeredHere()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return false;
}

let target;
let terminateRequested = false;
process.on("SIGTERM", () => {
  terminateRequested = true;
  if (target?.pid) {
    try { target.kill("SIGTERM"); } catch { /* group cleanup below remains authoritative */ }
  }
});

if (executable === undefined || arguments_.some((argument) => typeof argument !== "string") || !await waitForRegistration()) {
  fail("TEST_CONTROLLER_CHILD_REGISTRATION_MISSING");
} else {
  const environment = { ...process.env };
  delete environment.TCRN_TEST_CONTROLLER_CHILD_TOKEN;
  delete environment.TCRN_TEST_CONTROLLER_CHILD_OWNER_PID;
  let launchError = null;
  try {
    target = childProcess.spawn(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: ["ignore", 1, 2],
      windowsHide: true,
    });
    target.once("error", (error) => { launchError = error; });
    const result = await new Promise((resolveResult) => {
      target.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    if (launchError) {
      const message = {
        type: "managed-child-launch-error",
        code: launchError.code ?? launchError.message,
        message: launchError.message,
      };
      if (typeof process.send === "function") await new Promise((resolveSend) => process.send(message, () => resolveSend()));
      else process.stderr.write(`${JSON.stringify(message)}\n`);
      process.exitCode = 127;
    } else if (terminateRequested || result.signal !== null) process.exitCode = result.code ?? 1;
    else process.exitCode = result.code ?? 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ reasonCode: "TEST_CONTROLLER_CHILD_START_FAILED", error: String(error?.message ?? error) })}\n`);
    process.exitCode = 127;
  }
}

if (typeof process.disconnect === "function" && process.connected) process.disconnect();

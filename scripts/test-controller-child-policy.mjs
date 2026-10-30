// SPDX-License-Identifier: Apache-2.0

// A governed test command owns its output session as one process group. A
// detached child normally escapes that group and is refused. The single
// exception is the product gate runner: its private stdout/stderr pipes are
// routed through a registered bootstrap, and the controller reaper owns that
// process group until it is gone.

import childProcess from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const policyNodeOption = `--import=${import.meta.url}`;
const childBootstrapPath = fileURLToPath(new URL("./test-controller-child-bootstrap.mjs", import.meta.url));
const registryDirectory = process.env.TCRN_TEST_CONTROLLER_CHILD_REGISTRY ?? "";
const outerProcessGroup = Number(process.env.TCRN_TEST_CONTROLLER_PROCESS_GROUP);
const childOwnerPid = Number(process.env.TCRN_TEST_CONTROLLER_CHILD_OWNER_PID);
const childToken = process.env.TCRN_TEST_CONTROLLER_CHILD_TOKEN ?? "";
const raceCrashAt = process.env.TCRN_TEST_CONTROLLER_CHILD_CRASH_AT ?? "";
const raceProbePath = process.env.TCRN_TEST_CONTROLLER_CHILD_RACE_PROBE_PATH ?? "";
const managedChildGroupLimit = 8;
const childGroupSchema = "tcrn.test-controller-child-group.v1";

function nodeOptionsWithPolicy(nodeOptions) {
  const current = typeof nodeOptions === "string" ? nodeOptions.trim() : "";
  if (current.split(/\s+/u).includes(policyNodeOption)) return current;
  return current === "" ? policyNodeOption : `${current} ${policyNodeOption}`;
}

function nodeOptionsWithoutPolicy(nodeOptions) {
  return typeof nodeOptions === "string"
    ? nodeOptions.split(/\s+/u).filter((option) => option !== policyNodeOption).join(" ").trim()
    : "";
}

process.env.NODE_OPTIONS = nodeOptionsWithPolicy(process.env.NODE_OPTIONS);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function optionsIndex(name, arguments_) {
  if (name === "execSync") return 1;
  if (name === "execFileSync") return Array.isArray(arguments_[1]) ? 2 : 1;
  if (name === "spawn" || name === "spawnSync" || name === "execFile" || name === "fork") {
    if (name !== "execFile") {
      return Array.isArray(arguments_[1]) || (arguments_.length >= 3 && arguments_[1] === undefined) ? 2 : 1;
    }
    if (Array.isArray(arguments_[1]) || (arguments_.length >= 3 && arguments_[1] === undefined)) {
      return typeof arguments_[2] === "function" ? undefined : 2;
    }
    return typeof arguments_[1] === "function" ? undefined : 1;
  }
  if (name === "exec") return typeof arguments_[1] === "function" ? undefined : 1;
  return undefined;
}

function optionsFor(name, arguments_) {
  const index = optionsIndex(name, arguments_);
  return index === undefined ? undefined : object(arguments_[index]);
}

function isNodeExecutable(command) {
  if (typeof command !== "string") return false;
  if (command === process.execPath || command === "node" || command === "nodejs") return true;
  const leading = command.trimStart().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/u);
  const executable = leading?.[1] ?? leading?.[2] ?? leading?.[3];
  if (executable === undefined) return false;
  const base = executable.split(/[/\\]/u).pop();
  return executable === process.execPath || base === "node" || base === "nodejs" ||
    base === "node.exe" || base === "nodejs.exe";
}

const taskEntrypointPattern = /(?:^|[\s/])scripts\/task\.mjs(?:\s|$)/u;

function taskEntrypointArguments(name, arguments_) {
  if (name === "exec" || name === "execSync") {
    return typeof arguments_[0] === "string" && taskEntrypointPattern.test(arguments_[0]);
  }
  const argumentsForCommand = Array.isArray(arguments_[1]) ? arguments_[1] : [];
  return typeof argumentsForCommand[0] === "string" && taskEntrypointPattern.test(argumentsForCommand[0]);
}

function environmentWithoutPolicy(environment) {
  const updated = { ...environment };
  const nodeOptions = nodeOptionsWithoutPolicy(updated.NODE_OPTIONS);
  if (nodeOptions === "") delete updated.NODE_OPTIONS;
  else updated.NODE_OPTIONS = nodeOptions;
  return updated;
}

const requirePolicyDependency = createRequire(import.meta.url);
function managedPackageTask(arguments_, cwd) {
  if (typeof arguments_[0] !== "string" || !/(?:^|[\\/])(?:corepack(?:\.cmd|\.exe)?|pnpm(?:\.cjs|\.exe)?)$/u.test(arguments_[0]) || !Array.isArray(arguments_[1])) return false;
  // Restricted CLI children need only this builtin-only policy. Load the executor
  // verifier only for an actual package-manager dispatch, never at preload time.
  try { return requirePolicyDependency("./lib/memory-budget.mjs").memoryPackageTask([arguments_[0], ...arguments_[1]], cwd)?.entry === "scripts/task.mjs"; }
  catch { return false; }
}

function propagatePolicyToNodeChild(name, arguments_) {
  const takesCommandLine = name === "exec" || name === "execSync";
  const index = optionsIndex(name, arguments_);
  const options = index === undefined ? {} : object(arguments_[index]) ?? {};
  // The same verified task entry may be reached through its exact pinned package runner.
  // Its own task controller remains responsible; arbitrary package scripts keep the policy.
  const packageTask = managedPackageTask(arguments_, options.cwd ?? process.cwd());
  if (name !== "fork" && !takesCommandLine && !isNodeExecutable(arguments_[0]) && !packageTask) return arguments_;
  const environment = object(options.env) ?? process.env;
  const updatedOptions = {
    ...options,
    env: taskEntrypointArguments(name, arguments_) || packageTask
      ? environmentWithoutPolicy(environment)
      : { ...environment, NODE_OPTIONS: nodeOptionsWithPolicy(environment.NODE_OPTIONS) },
  };
  const updated = [...arguments_];
  if (index !== undefined) {
    updated[index] = updatedOptions;
    return updated;
  }
  if (name === "exec") {
    if (typeof updated[1] === "function") updated.splice(1, 0, updatedOptions);
    else updated[1] = updatedOptions;
    return updated;
  }
  if (name === "execFile") {
    const argumentsWereSupplied = Array.isArray(updated[1]) || (updated.length >= 3 && updated[1] === undefined);
    const target = argumentsWereSupplied ? 2 : 1;
    if (typeof updated[target] === "function") updated.splice(target, 0, updatedOptions);
    else updated[target] = updatedOptions;
    return updated;
  }
  return updated;
}

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function detachedForbidden() {
  throw policyError("TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN");
}

// The only product spawn permitted to detach is gates-run's bounded process
// group. Its exact stdio contract gives the test controller private pipes; the
// wrapper receives those pipes and never inherits the controller's output.
function isGateRunnerSpawn(name, arguments_, options) {
  if (name !== "spawn" || options?.detached !== true || options?.shell !== false) return false;
  if (!Array.isArray(arguments_[1]) || arguments_[1].some((argument) => typeof argument !== "string")) return false;
  if (!Array.isArray(options.stdio) || options.stdio.length !== 3 ||
      options.stdio[0] !== "ignore" || options.stdio[1] !== "pipe" || options.stdio[2] !== "pipe") return false;
  const stack = new Error().stack ?? "";
  if (/(?:^|[\\/])packages[\\/]core[\\/]src[\\/]gates-run\.(?:js|ts):\d+:\d+/u.test(stack)) return true;
  // Distribution bundles keep the gate runner but not its original filesystem path.
  // Admit only the actual manifest-covered CLI entry, never an arbitrary same-named probe.
  const frame = /at runGateProcess \(([^\n()]+[\\/]scripts[\\/]einzbern\.mjs):\d+:\d+\)/u.exec(stack);
  if (!frame) return false;
  try {
    const entry = frame[1].startsWith("file:") ? fileURLToPath(frame[1]) : resolve(frame[1]);
    const metadata = lstatSync(entry);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), "manifest.json"), "utf8"));
    const member = manifest.schemaVersion === "einzbern.release-manifest.v1" && manifest.files?.find(row => row.path === "scripts/einzbern.mjs");
    const bytes = readFileSync(entry);
    return member?.size === bytes.length && member.sha256 === createHash("sha256").update(bytes).digest("hex");
  } catch { return false; }
}

function slotPaths(directory = registryDirectory) {
  return Array.from({ length: managedChildGroupLimit }, (_, index) => resolve(directory, `slot-${index}.ndjson`));
}

function validateRegistryDirectory(directory) {
  if (!directory.startsWith("/") || directory.includes("\0")) throw policyError("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  let metadata;
  try { metadata = lstatSync(directory); }
  catch { throw policyError("TEST_CONTROLLER_CHILD_REGISTRY_INVALID"); }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw policyError("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  }
}

function appendSlotEvent(path, event) {
  const line = Buffer.from(`${JSON.stringify({ schemaVersion: childGroupSchema, ...event })}\n`, "utf8");
  const descriptor = openSync(path, "a");
  try {
    let offset = 0;
    while (offset < line.length) offset += writeSync(descriptor, line, offset, line.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function reserveChildSlot(token) {
  if (!Number.isSafeInteger(outerProcessGroup) || outerProcessGroup <= 0 ||
      !Number.isSafeInteger(process.pid) || process.pid <= 0 || registryDirectory === "") {
    detachedForbidden();
  }
  validateRegistryDirectory(registryDirectory);
  for (const path of slotPaths()) {
    let descriptor;
    try { descriptor = openSync(path, "wx", 0o600); }
    catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    try {
      const line = Buffer.from(`${JSON.stringify({ schemaVersion: childGroupSchema, state: "reserved", token, ownerPid: process.pid })}\n`, "utf8");
      let offset = 0;
      while (offset < line.length) offset += writeSync(descriptor, line, offset, line.length - offset);
      fsyncSync(descriptor);
      return path;
    } catch (error) {
      try { unlinkSync(path); } catch { /* keep the original registration failure */ }
      throw error;
    } finally {
      closeSync(descriptor);
    }
  }
  throw policyError("TEST_CONTROLLER_MANAGED_CHILD_LIMIT");
}

function writeRaceProbe(stage, token, processGroup = null) {
  if (raceProbePath === "") return;
  if (!raceProbePath.startsWith("/") || raceProbePath.includes("\0")) throw policyError("TEST_CONTROLLER_CHILD_RACE_PROBE_PATH_INVALID");
  const value = { stage, token, processGroup };
  const descriptor = openSync(raceProbePath, "w", 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    let offset = 0;
    while (offset < line.length) offset += writeSync(descriptor, line, offset, line.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readSlotState(path, token, ownerPid) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const completeLines = source.split("\n");
  if (completeLines.at(-1) === "") completeLines.pop();
  let state = null;
  for (const line of completeLines) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); }
    catch { return null; }
    if (event?.schemaVersion !== childGroupSchema || event.token !== token || event.ownerPid !== ownerPid) return null;
    if (state === null && event.state !== "reserved") return null;
    if (state !== null && !["bound", "finished", "cancelled"].includes(event.state)) return null;
    if (event.state === "bound" && (!Number.isSafeInteger(event.processGroup) || event.processGroup <= 0)) return null;
    state = event;
  }
  return state;
}

function matchingSlot(token, ownerPid, wantedState = undefined) {
  if (registryDirectory === "") return null;
  try {
    validateRegistryDirectory(registryDirectory);
    for (const path of slotPaths()) {
      const state = readSlotState(path, token, ownerPid);
      if (state && (wantedState === undefined || state.state === wantedState)) return { path, state };
    }
  } catch {
    return null;
  }
  return null;
}

function isBootstrapRelay(name, arguments_, options) {
  if (name !== "spawn" || options?.detached === true ||
      resolve(process.argv[1] ?? "") !== childBootstrapPath ||
      !/^--tcrn-controller-child=[0-9a-f]{32}$/u.test(childToken) ||
      !Number.isSafeInteger(childOwnerPid) || childOwnerPid <= 0 || process.ppid !== childOwnerPid) return false;
  if (!Array.isArray(options?.stdio) || options.stdio.length !== 3 ||
      options.stdio[0] !== "ignore" || options.stdio[1] !== 1 || options.stdio[2] !== 2) return false;
  const reservation = matchingSlot(childToken.slice("--tcrn-controller-child=".length), childOwnerPid, "bound");
  return reservation?.state.processGroup === process.pid;
}

function spawnManagedGate(name, arguments_, options, original, receiver) {
  const token = randomBytes(16).toString("hex");
  const slotPath = reserveChildSlot(token);
  const executable = arguments_[0];
  const commandArguments = arguments_[1];
  const environment = { ...(object(options.env) ?? process.env) };
  environment.NODE_OPTIONS = nodeOptionsWithPolicy(environment.NODE_OPTIONS);
  environment.TCRN_TEST_CONTROLLER_CHILD_REGISTRY = registryDirectory;
  environment.TCRN_TEST_CONTROLLER_CHILD_OWNER_PID = String(process.pid);
  environment.TCRN_TEST_CONTROLLER_CHILD_TOKEN = `--tcrn-controller-child=${token}`;
  let child;
  try {
    writeRaceProbe("reserved", token);
    if (raceCrashAt === "after-reserve") process.kill(process.pid, "SIGKILL");
    const wrapperOptions = {
      ...options,
      detached: true,
      env: environment,
      shell: false,
      stdio: [...options.stdio, "ipc"],
    };
    child = original.call(receiver, process.execPath, [childBootstrapPath, environment.TCRN_TEST_CONTROLLER_CHILD_TOKEN, executable, ...commandArguments], wrapperOptions);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw policyError("TEST_CONTROLLER_CHILD_PID_INVALID");
    writeRaceProbe("spawned-before-bind", token, child.pid);
    if (raceCrashAt === "after-spawn-before-bind") process.kill(process.pid, "SIGKILL");
    appendSlotEvent(slotPath, { state: "bound", token, ownerPid: process.pid, processGroup: child.pid });
  } catch (error) {
    if (!child?.pid) {
      try { appendSlotEvent(slotPath, { state: "cancelled", token, ownerPid: process.pid, processGroup: null }); } catch { /* preserve the spawn failure */ }
      try { unlinkSync(slotPath); } catch { /* reservation recovery is fail-closed */ }
    }
    throw error;
  }
  child.on("message", (message) => {
    if (message?.type !== "managed-child-launch-error" || typeof message.code !== "string") return;
    const error = policyError(message.code);
    error.message = typeof message.message === "string" ? message.message : message.code;
    child.emit("error", error);
  });
  child.once("close", () => {
    void finishChildSlot(slotPath, token, process.pid, child.pid).catch((error) => {
      process.stderr.write(`${JSON.stringify({ reasonCode: "TEST_CONTROLLER_MANAGED_CHILD_CLEANUP_FAILED", processGroup: child.pid, error: String(error?.message ?? error) })}\n`);
    });
  });
  return child;
}

async function waitForGroupGone(processGroup, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try { process.kill(-processGroup, 0); }
    catch (error) { if (error?.code === "ESRCH") return true; throw error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return false;
}

async function finishChildSlot(path, token, ownerPid, processGroup) {
  if (!Number.isSafeInteger(processGroup) || processGroup <= 0) {
    appendSlotEvent(path, { state: "cancelled", token, ownerPid, processGroup: null });
    unlinkSync(path);
    return;
  }
  if (!await waitForGroupGone(processGroup, 2_000)) {
    try { process.kill(-processGroup, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    if (!await waitForGroupGone(processGroup, 1_000)) {
      try { process.kill(-processGroup, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      if (!await waitForGroupGone(processGroup, 2_000)) throw policyError("TEST_CONTROLLER_MANAGED_CHILD_GROUP_LIVE");
    }
  }
  appendSlotEvent(path, { state: "finished", token, ownerPid, processGroup });
  unlinkSync(path);
}

function rejectInheritedStdio(name, options) {
  if (inheritsStdioForCall(name, options)) throw policyError("TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN");
}

function rejectDetached(name, arguments_, options) {
  if (!options?.detached) return;
  if (isGateRunnerSpawn(name, arguments_, options)) return;
  detachedForbidden();
}

// An allowlist, not a denylist. Besides "inherit", [0,1,2] and parent stream
// objects can carry a test controller's output descriptor.
const nonInheritingStdio = new Set(["pipe", "ignore", "overlapped", "ipc", null, undefined]);

function inheritsStdio(stdio) {
  if (stdio === undefined || stdio === null) return false;
  if (Array.isArray(stdio)) return stdio.some((entry) => !nonInheritingStdio.has(entry));
  return !nonInheritingStdio.has(stdio);
}

function inheritsStdioForCall(name, options) {
  if (name === "fork" && options?.stdio === undefined && !options?.silent) return true;
  return inheritsStdio(options?.stdio);
}

// TCRN-CROSS-INIT-053 R48 (R48-INT-1): node gives exec and execFile a util.promisify.custom whose promise
// resolves { stdout, stderr }, rejects with the error carrying stdout and stderr, and holds the child as
// .child. A replacement without it promisifies to a bare stdout string, so promisify(execFile) callers
// (platform-doctor among them) read stdout as undefined under the controller only. The replacement keeps
// node's custom form, built over the guarded function so every call still passes the policy.
function promisifiedExec(run) {
  return (...arguments_) => {
    const { promise, resolve: settle, reject } = Promise.withResolvers();
    promise.child = run(...arguments_, (error, stdout, stderr) => {
      if (error !== null) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        settle({ stdout, stderr });
      }
    });
    return promise;
  };
}

for (const name of ["spawn", "spawnSync", "exec", "execFile", "execSync", "execFileSync", "fork"]) {
  const original = childProcess[name];
  const guarded = function guardedChildProcess(...arguments_) {
    const options = optionsFor(name, arguments_);
    const gateRunnerSpawn = isGateRunnerSpawn(name, arguments_, options);
    const bootstrapRelay = isBootstrapRelay(name, arguments_, options);
    if (options?.detached) {
      rejectDetached(name, arguments_, options);
      if (gateRunnerSpawn) return spawnManagedGate(name, arguments_, options, original, this);
    }
    if (!bootstrapRelay) rejectInheritedStdio(name, options);
    return original.apply(this, propagatePolicyToNodeChild(name, arguments_));
  };
  if (Object.hasOwn(original, promisify.custom)) {
    Object.defineProperty(guarded, promisify.custom, { enumerable: false, value: promisifiedExec(guarded) });
  }
  childProcess[name] = guarded;
}

syncBuiltinESMExports();

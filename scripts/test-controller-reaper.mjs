// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { stopCoverage } from "node:v8";

import { appendProgressIfConfigured, delay } from "./lib/incremental-output.mjs";

// The reaper is lifecycle infrastructure, not a test worker. It must not add a
// late coverage document when it removes the private controller output tree.
if (process.env.NODE_V8_COVERAGE) stopCoverage();

const [parentPidText, controllerGroupText, outputDirectory, childRegistryDirectory] = process.argv.slice(2);
const parentPid = Number(parentPidText);
const controllerGroup = Number(controllerGroupText);
const progressPath = process.env.TCRN_TEST_CONTROLLER_PROGRESS_PATH;
const groupSchema = "tcrn.test-controller-child-group.v1";
const tokenMarker = "--tcrn-controller-child=";

if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !Number.isSafeInteger(controllerGroup) || controllerGroup <= 0 ||
    typeof outputDirectory !== "string" || !outputDirectory.startsWith("/") || !basename(outputDirectory).startsWith("tcrn-test-controller-") ||
    childRegistryDirectory !== resolve(outputDirectory, "managed-child-groups")) {
  process.exit(1);
}

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processRows() {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,ppid=,command="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  if (listed.status !== 0 || listed.error || (listed.stderr ?? "").trim() !== "") throw new Error("TEST_CONTROLLER_REAPER_PROCESS_LIST_FAILED");
  const rows = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) throw new Error("TEST_CONTROLLER_REAPER_PROCESS_LIST_INVALID");
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), ppid: Number(match[3]), command: match[4] });
  }
  return rows;
}

function signalMembers(members, signal) {
  for (const pid of members) {
    try { process.kill(pid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

function groupMembers(processGroup, excludedPid = null) {
  return processRows().filter((row) => row.pgid === processGroup && row.pid !== excludedPid).map((row) => row.pid);
}

async function waitForNoMembers(processGroup, excludedPid, timeoutMs) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 20) {
    if (groupMembers(processGroup, excludedPid).length === 0) return true;
    await delay(20);
  }
  return groupMembers(processGroup, excludedPid).length === 0;
}

async function waitForGroupGone(processGroup, timeoutMs) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 20) {
    try { process.kill(-processGroup, 0); }
    catch (error) { if (error?.code === "ESRCH") return true; throw error; }
    await delay(20);
  }
  try { process.kill(-processGroup, 0); }
  catch (error) { if (error?.code === "ESRCH") return true; throw error; }
  return false;
}

async function terminateGroupMembers(processGroup, excludedPid = null) {
  let members = groupMembers(processGroup, excludedPid);
  signalMembers(members, "SIGTERM");
  if (await waitForNoMembers(processGroup, excludedPid, 1_000)) return;
  members = groupMembers(processGroup, excludedPid);
  signalMembers(members, "SIGKILL");
  if (!await waitForNoMembers(processGroup, excludedPid, 1_000)) throw new Error("TEST_CONTROLLER_REAPER_GROUP_LIVE");
}

async function readSlot(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  }
  let source;
  try { source = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const lines = source.split("\n");
  lines.pop(); // The final item has no newline and cannot follow a spawn.
  const events = [];
  for (const line of lines) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID"); }
    if (event?.schemaVersion !== groupSchema || !/^[0-9a-f]{32}$/u.test(event.token) ||
        !Number.isSafeInteger(event.ownerPid) || event.ownerPid <= 0) {
      throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
    }
    if (events.length === 0 && event.state !== "reserved") throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
    if (events.length > 0 && !["bound", "finished", "cancelled"].includes(event.state)) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
    if (events.length > 0 && (event.token !== events[0].token || event.ownerPid !== events[0].ownerPid)) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
    if (event.state === "bound" && (!Number.isSafeInteger(event.processGroup) || event.processGroup <= 0)) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
    events.push(event);
  }
  return events.at(-1) ?? { state: "empty" };
}

async function pendingGroupFromToken(state) {
  const rows = processRows().filter((row) => row.command.includes("test-controller-child-bootstrap.mjs") &&
    row.command.includes(`${tokenMarker}${state.token}`));
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0].pid !== rows[0].pgid) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_AMBIGUOUS");
  return rows[0].pgid;
}

async function removeSlot(path) {
  try { await unlink(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function terminateManagedChildGroups() {
  const metadata = await lstat(childRegistryDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  const files = (await readdir(childRegistryDirectory)).filter((name) => /^slot-[0-7]\.ndjson$/u.test(name)).sort();
  if ((await readdir(childRegistryDirectory)).length !== files.length) throw new Error("TEST_CONTROLLER_CHILD_REGISTRY_INVALID");
  let cleaned = 0;
  for (const name of files) {
    const path = resolve(childRegistryDirectory, name);
    const state = await readSlot(path);
    if (state === null || state.state === "empty" || state.state === "finished" || state.state === "cancelled") {
      await removeSlot(path);
      continue;
    }
    let processGroup = state.processGroup ?? null;
    if (state.state === "reserved") processGroup = await pendingGroupFromToken(state);
    if (processGroup !== null) {
      if (!Number.isSafeInteger(processGroup) || processGroup <= 0 || processGroup === controllerGroup ||
          processGroup === process.pid || processGroup === state.ownerPid) {
        throw new Error("TEST_CONTROLLER_CHILD_PROCESS_GROUP_INVALID");
      }
      await terminateGroupMembers(processGroup);
      if (!await waitForNoMembers(processGroup, null, 1_000) || !await waitForGroupGone(processGroup, 1_000)) {
        throw new Error("TEST_CONTROLLER_CHILD_GROUP_LIVE");
      }
      cleaned += 1;
    }
    await removeSlot(path);
  }
  return cleaned;
}

async function removeOutputDirectory() {
  const path = resolve(outputDirectory);
  if (basename(path) !== basename(outputDirectory) || !basename(path).startsWith("tcrn-test-controller-") ||
      childRegistryDirectory !== resolve(path, "managed-child-groups")) {
    throw new Error("TEST_CONTROLLER_REAPER_OUTPUT_PATH_INVALID");
  }
  await rm(path, { recursive: true, force: true });
}

let cleanupPromise;
let cleanCount = 0;
let cleaned = false;
let disposeRequested = false;
let parentCleanupStarted = false;

// TCRN-CROSS-INC-394 (TCRN-CROSS-SUB-418): the task runner removes the progress directory once it
// has stopped reading it: after it joined this reaper's group, or at once when it failed closed
// before joining it. A missing directory therefore means nobody is left to read the reaper-clean
// record. It ends the record, never the cleanup, which is already confirmed when the record is
// written; any other failure to record is retried as before.
async function progressDirectoryGone() {
  try {
    await lstat(dirname(progressPath));
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function recordClean() {
  try {
    await appendProgressIfConfigured(progressPath, "reaper-clean", { processGroup: controllerGroup, reaperProcessGroup: process.pid, managedChildGroups: cleanCount });
  } catch (error) {
    if (error?.code !== "ENOENT" || !await progressDirectoryGone()) throw error;
  }
}

// A parent that has gone cannot be told. Without a callback, process.send on a closed channel
// raises an unhandled 'error' event on the next tick, which ended the reaper before it removed
// its output directory. A send that fails means the channel closed, and the disconnect handler
// finishes the run.
function notifyParent(message) {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(message, () => {});
}

function cleanupOnce() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (;;) {
      try {
        cleanCount += await terminateManagedChildGroups();
        await terminateGroupMembers(controllerGroup, parentPid);
        cleaned = true;
        await recordClean();
        notifyParent({ type: "clean", managedChildGroups: cleanCount });
        return;
      } catch {
        await delay(100);
      }
    }
  })().finally(() => { cleanupPromise = undefined; });
  return cleanupPromise;
}

async function finishAfterParentDeath() {
  for (;;) {
    try {
      if (!cleaned) await cleanupOnce();
      await removeOutputDirectory();
      process.exit(0);
    } catch {
      await delay(100);
    }
  }
}

process.on("message", (message) => {
  if (message?.type === "cleanup") void cleanupOnce();
  if (message?.type === "dispose") {
    disposeRequested = true;
    void (async () => {
      for (;;) {
        if (!cleaned) await cleanupOnce();
        if (cleaned) {
          try {
            await removeOutputDirectory();
            process.exit(0);
          } catch {
            await delay(100);
          }
        }
      }
    })();
  }
});

process.send?.({ type: "ready", processGroup: process.pid });
setInterval(() => {
  if (disposeRequested) return;
  try {
    if (!parentCleanupStarted && !parentAlive()) {
      parentCleanupStarted = true;
      void finishAfterParentDeath();
    }
  } catch {
    // An unknown parent state keeps the reaper alive and the output lock held.
  }
}, 20);

process.on("disconnect", () => {
  if (disposeRequested || parentCleanupStarted) return;
  parentCleanupStarted = true;
  void finishAfterParentDeath();
});

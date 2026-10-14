// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-484 (TCRN-CROSS-STORY-529 GWT5-7, MIN-257 D6): the machine's heavy-run semaphore.
// gates-run, the whole test suite (scripts/task.mjs test), verify-p1 (scripts/task.mjs verify-p1,
// TCRN-CROSS-SUB-493), the portal proof train (scripts/verify-portal.mjs) and release finish
// (scripts/release.mjs) each take one of the execution.maxConcurrentHeavyRuns slots before they
// start, one unless this device's machine settings say otherwise, so two of them do not run at once
// on one machine. A slot records the command its taker names: gates-run, test, verify-p1,
// verify:portal or release finish (TCRN-CROSS-SUB-502).
//
// A slot is a lock file in the device directory's locks/ (heavy.lock, then heavy-2.lock and on),
// created exclusively and owned as core's file locks are (packages/core/src/file-lock.ts):
// einzbern.file-lock.v1 with pid, token, hostname and createdAt, and the command holding it.
// EINZBERN_HEAVY_LOCK_DIR names another directory, so several device directories (one per test
// run or per agent) can share one set of slots; without EINZBERN_HOME the directory is
// ~/.einzbern/locks, machine-wide (Q7). A slot is reclaimed only from an owner on this host whose
// process is provably dead; age is never evidence, and a malformed or foreign owner is waited for.
//
// The holder puts EINZBERN_HEAVY_SLOT (its token and its slot file) into its environment, so a
// heavy run it starts -- gates-run's gates, the suite's tests, verify-p1's legs, finish's gates and
// trains -- finds the slot held for it and takes none of its own: waiting for the parent's slot would
// never end.
// A token whose slot file no longer carries it, or whose holder is provably dead, is ignored.
//
// A run that has to wait says so on stderr, once and again whenever the holders change: one JSON
// line naming each holder's slot file, pid, command and since when. It waits as long as it takes
// unless its caller gave a timeout (HEAVY_SLOT_TIMEOUT).
//
// This file imports node: built-ins only, so scripts/task.mjs can take a slot before dist/build
// exists or after it went stale. The engine imports it by relative path, as it imports
// runtime-capacity.mjs, and the build copies it to dist/build/scripts/lib.

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";

export const HEAVY_RUNS_SETTING = "execution.maxConcurrentHeavyRuns";
export const HEAVY_RUNS_DEFAULT = 1;
export const HEAVY_RUNS_MIN = 1;
export const HEAVY_RUNS_MAX = 16;
export const HEAVY_SLOT_VARIABLE = "EINZBERN_HEAVY_SLOT";
export const HEAVY_LOCK_DIRECTORY_VARIABLE = "EINZBERN_HEAVY_LOCK_DIR";
export const HEAVY_RUNS_REASON_CODES = Object.freeze([
  "HEAVY_SLOT_OPTIONS_INVALID",
  "HEAVY_SLOT_TIMEOUT",
  "MACHINE_SETTINGS_FILE_INVALID",
  "MACHINE_SETTING_VALUE_INVALID",
]);
// Held equal to packages/core/src/names.ts (DIRECTORY.device), device-home.ts (DEVICE_HOME_ENTRIES
// locks and machineSettings), machine-settings.ts (MACHINE_SETTINGS_VERSION) and file-lock.ts
// (FILE_LOCK_SCHEMA_VERSION) by tests/heavy-runs.test.mjs: this file imports no engine module.
export const DEVICE_DIRECTORY = ".einzbern";
export const LOCKS_DIRECTORY = "locks";
export const MACHINE_SETTINGS_FILE = "machine-settings.json";
export const MACHINE_SETTINGS_SCHEMA_VERSION = "tcrn.machine-settings.v1";
export const LOCK_SCHEMA_VERSION = "einzbern.file-lock.v1";

const TOKEN = /^[a-f0-9]{32}$/u;
// EINZBERN_HEAVY_SLOT: the holder's token, a colon, and the slot file it holds.
const SLOT_VALUE = /^([a-f0-9]{32}):(.+)$/su;
const WAIT_CEILING_MS = 200;

export class HeavyRunsError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "HeavyRunsError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new HeavyRunsError(reasonCode, message, details);
}

/** The device directory: EINZBERN_HOME when it is set and non-empty, otherwise .einzbern in the user's home (device-home.ts). */
export function deviceDirectory(env = process.env, home = homedir()) {
  const configured = env.EINZBERN_HOME;
  return typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(home, DEVICE_DIRECTORY);
}

/** Where the slots are: EINZBERN_HEAVY_LOCK_DIR when it is set and non-empty, otherwise locks/ in the device directory. */
export function heavyLockDirectory(env = process.env, home = homedir()) {
  const configured = env[HEAVY_LOCK_DIRECTORY_VARIABLE];
  return typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(deviceDirectory(env, home), LOCKS_DIRECTORY);
}

/** The lock file of slot `slot`, counted from 1: heavy.lock, then heavy-2.lock, heavy-3.lock and on. */
export function heavySlotPath(directory, slot) {
  return join(directory, slot === 1 ? "heavy.lock" : `heavy-${slot}.lock`);
}

/** A stored execution.maxConcurrentHeavyRuns as a number: a whole number from 1 to 16, as the machine settings catalog checks it. */
export function heavyRunsValue(value) {
  if (typeof value !== "string" || !/^-?\d+$/u.test(value)) fail("MACHINE_SETTING_VALUE_INVALID", `${HEAVY_RUNS_SETTING} needs a whole number`, { key: HEAVY_RUNS_SETTING });
  const parsed = Number(value);
  if (parsed < HEAVY_RUNS_MIN || parsed > HEAVY_RUNS_MAX) {
    fail("MACHINE_SETTING_VALUE_INVALID", `${HEAVY_RUNS_SETTING} must be from ${HEAVY_RUNS_MIN} to ${HEAVY_RUNS_MAX}`, { key: HEAVY_RUNS_SETTING });
  }
  return parsed;
}

/**
 * How many heavy runs this device lets run at once: execution.maxConcurrentHeavyRuns in its machine
 * settings, 1 when the file or the key is absent. A file that is there but unreadable refuses, as
 * the machine settings layer does, rather than reading as no preference.
 */
export function maxConcurrentHeavyRuns(env = process.env, home = homedir()) {
  let text;
  try {
    text = readFileSync(join(deviceDirectory(env, home), MACHINE_SETTINGS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return HEAVY_RUNS_DEFAULT;
    throw error;
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    fail("MACHINE_SETTINGS_FILE_INVALID", "the machine settings file is not JSON");
  }
  const values = file?.values;
  if (file?.schemaVersion !== MACHINE_SETTINGS_SCHEMA_VERSION || values === null || typeof values !== "object" || Array.isArray(values)) {
    fail("MACHINE_SETTINGS_FILE_INVALID", `the machine settings file is not ${MACHINE_SETTINGS_SCHEMA_VERSION}`);
  }
  return Object.hasOwn(values, HEAVY_RUNS_SETTING) ? heavyRunsValue(values[HEAVY_RUNS_SETTING]) : HEAVY_RUNS_DEFAULT;
}

// A slot's owner as file-lock.ts writes it, or null when it is not one. The command came with
// TCRN-CROSS-SUB-480 and is read as optional: an owner without one is still well formed.
function parseOwner(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || value.schemaVersion !== LOCK_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.token !== "string" || !TOKEN.test(value.token) ||
      typeof value.hostname !== "string" || value.hostname.length === 0 ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      return null;
    }
    return { pid: value.pid, token: value.token, hostname: value.hostname, createdAt: value.createdAt, command: typeof value.command === "string" ? value.command : null };
  } catch {
    return null;
  }
}

function readOwner(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return { owner: parseOwner(text), text };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH establishes absence; a permission or unknown failure does not.
    return error?.code !== "ESRCH";
  }
}

function provablyDead(owner, processAlive) {
  if (owner === null || owner.hostname !== hostname()) return false;
  try {
    return processAlive(owner.pid) === false;
  } catch {
    return false;
  }
}

function createExclusive(path, content) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    // An owner that was never written would read as malformed and be waited for forever.
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(descriptor);
  return true;
}

// Remove the slot at `path` if it still holds `judged`, an owner on this host whose process is
// provably dead, under an exclusive breaker as file-lock.ts does; an abandoned breaker is cleared
// the same way. Returns whether the slot is free now.
function reclaim(path, judged, content, processAlive) {
  const breaker = `${path}.breaker`;
  if (!createExclusive(breaker, content)) {
    const held = readOwner(breaker);
    if (held !== null && provablyDead(held.owner, processAlive)) reclaim(breaker, held.text, content, processAlive);
    return false;
  }
  try {
    const current = readOwner(path);
    if (current === null) return true;
    if (current.text !== judged || !provablyDead(current.owner, processAlive)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    if (readOwner(breaker)?.text === content) rmSync(breaker, { force: true });
  }
}

// The slot a heavy run above this process holds for it, from EINZBERN_HEAVY_SLOT, or null.
function inheritedSlot(env, processAlive) {
  const match = SLOT_VALUE.exec(typeof env[HEAVY_SLOT_VARIABLE] === "string" ? env[HEAVY_SLOT_VARIABLE] : "");
  if (match === null) return null;
  const [, token, path] = match;
  let held;
  try {
    held = readOwner(path);
  } catch {
    return null;
  }
  if (held?.owner?.token !== token || provablyDead(held.owner, processAlive)) return null;
  return { token, path };
}

function holdSlot(env, slot, path, token, content) {
  const value = `${token}:${path}`;
  const previous = env[HEAVY_SLOT_VARIABLE];
  env[HEAVY_SLOT_VARIABLE] = value;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    if (env[HEAVY_SLOT_VARIABLE] === value) {
      if (previous === undefined) delete env[HEAVY_SLOT_VARIABLE];
      else env[HEAVY_SLOT_VARIABLE] = previous;
    }
    try {
      if (readOwner(path)?.text === content) rmSync(path, { force: true });
    } catch {
      // A slot that cannot be read back is left to the next taker's dead-owner check.
    }
  };
  // A holder that exits without releasing (process.exit on a red step) still frees its slot.
  process.once("exit", release);
  return Object.freeze({ held: true, inherited: false, slot, path, token, release });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, Math.max(0, milliseconds));
  });
}

/**
 * Take a heavy-run slot for `command` (gates-run, test, verify-p1, verify:portal, release finish), waiting
 * while every slot is held. Returns the slot, whose release() frees it and takes EINZBERN_HEAVY_SLOT
 * back out of `env`; when a heavy run above this process already holds one for it, returns that
 * slot as inherited, with nothing to release. `env` is read for EINZBERN_HOME,
 * EINZBERN_HEAVY_LOCK_DIR and EINZBERN_HEAVY_SLOT and is where the token is put (process.env, so
 * every process started from here inherits it). `timeoutMs` bounds the wait (HEAVY_SLOT_TIMEOUT);
 * omitted, the run waits until a slot is free.
 */
export async function acquireHeavySlot({ command, timeoutMs, env = process.env, home = homedir(), stderr = process.stderr, processAlive = defaultProcessAlive } = {}) {
  if (typeof command !== "string" || command.length === 0) fail("HEAVY_SLOT_OPTIONS_INVALID", "a heavy run names its command");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) fail("HEAVY_SLOT_OPTIONS_INVALID", "timeoutMs must be a whole number of milliseconds");
  const inherited = inheritedSlot(env, processAlive);
  if (inherited !== null) {
    return Object.freeze({ held: false, inherited: true, slot: null, path: inherited.path, token: inherited.token, release() {} });
  }
  const limit = maxConcurrentHeavyRuns(env, home);
  const directory = heavyLockDirectory(env, home);
  mkdirSync(directory, { recursive: true });
  const token = randomBytes(16).toString("hex");
  const content = `${JSON.stringify({ schemaVersion: LOCK_SCHEMA_VERSION, pid: process.pid, token, hostname: hostname(), createdAt: new Date().toISOString(), command })}\n`;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let reported = null;
  let wait = 5;
  for (;;) {
    for (let slot = 1; slot <= limit; slot += 1) {
      const path = heavySlotPath(directory, slot);
      if (createExclusive(path, content)) return holdSlot(env, slot, path, token, content);
    }
    const holders = [];
    let freed = false;
    for (let slot = 1; slot <= limit; slot += 1) {
      const path = heavySlotPath(directory, slot);
      const held = readOwner(path);
      if (held === null || (provablyDead(held.owner, processAlive) && reclaim(path, held.text, content, processAlive))) {
        freed = true;
        continue;
      }
      holders.push({ slot: basename(path), pid: held.owner?.pid ?? null, command: held.owner?.command ?? null, since: held.owner?.createdAt ?? null });
    }
    if (freed) continue;
    const seen = JSON.stringify(holders);
    if (seen !== reported) {
      reported = seen;
      stderr.write(`${JSON.stringify({ reasonCode: "HEAVY_SLOT_WAITING", command, slots: limit, holders })}\n`);
    }
    if (deadline !== undefined && Date.now() >= deadline) fail("HEAVY_SLOT_TIMEOUT", `all ${limit} heavy-run slots are held`, { slots: limit, holders });
    await delay(Math.min(wait + Math.floor(Math.random() * wait), deadline === undefined ? WAIT_CEILING_MS : deadline - Date.now()));
    wait = Math.min(wait * 2, WAIT_CEILING_MS);
  }
}

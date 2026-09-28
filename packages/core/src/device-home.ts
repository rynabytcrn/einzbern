// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R3, R6 (MIN-227 D13, D19): the device directory. What belongs to this
// machine rather than to a library lives here: the device identity, the library registry,
// the machine settings, each library's cache and write lock, backups and the installed
// engine versions. None of it travels with a library.
//
// EINZBERN_HOME names the directory itself and wins; without it the directory is `.einzbern`
// under the user's home. Directories are created with the process defaults and nothing
// reads a mode back, so no behaviour here depends on permission bits (R6).

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DIRECTORY } from "./names.js";

export const DEVICE_HOME_ENVIRONMENT_VARIABLE = "EINZBERN_HOME" as const;

export const DEVICE_HOME_ENTRIES = Object.freeze({
  device: "device.json",
  registry: "registry.json",
  machineSettings: "machine-settings.json",
  cache: "cache",
  locks: "locks",
  backups: "backups",
  engine: "engine",
  // TCRN-CROSS-STORY-476 R5: the user-level crest, unless crest.userPath names another place.
  crest: "crest",
} as const);
export const USER_CREST_EVENTS_DIRECTORY = "events" as const;
// TCRN-CROSS-STORY-477 R1: the stable hook launcher in engine/, beside the stable entry
// engine/einzbern.mjs; every host hook runs it (host-hooks.ts) and the install manifest lists it.
// Defined here, in a module that imports no other engine module, so the install manifest can read
// it while the barrel is still loading.
export const ENGINE_HOOK_LAUNCHER = "hook.mjs" as const;

/** The device-level key that moves the user-level crest (machine-settings.ts validates and stores it). */
export const USER_CREST_PATH_SETTING = "crest.userPath" as const;

// The name the user crest's lock and cache directory carry in locks/ and cache/. A library's are
// named by its id (libraryDirectoryName), which never has this shape.
const USER_CREST_DEVICE_NAME = "user-crest";

export class DeviceHomeError extends Error {
  readonly reasonCode: "DEVICE_LIBRARY_ID_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DeviceHomeError";
    this.reasonCode = "DEVICE_LIBRARY_ID_INVALID";
  }
}

/**
 * The device directory: EINZBERN_HOME when it is set and non-empty (resolved against the
 * working directory), otherwise `<home>/.einzbern`. Computing it touches nothing.
 */
export function deviceHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env[DEVICE_HOME_ENVIRONMENT_VARIABLE];
  if (typeof configured === "string" && configured.length > 0) return resolve(configured);
  return join(home, DIRECTORY.device);
}

// A library id is `library:` or, for a library imported from an old workspace, `workspace:`
// followed by 24 lowercase hex digits. On disk the colon becomes a hyphen: a colon is not a
// legal file-name character on Windows, and the id is otherwise already short and plain.
const LIBRARY_ID_PATTERN = /^(library|workspace):([a-f0-9]{24})$/u;

export function libraryDirectoryName(libraryId: string): string {
  const match = LIBRARY_ID_PATTERN.exec(libraryId);
  if (match === null) throw new DeviceHomeError(`${libraryId} is not a library id`);
  return `${match[1]}-${match[2]}`;
}

export function deviceFilePath(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.device);
}

export function registryPath(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.registry);
}

/** This library's derived state on this machine: views, snapshots and indexes. */
export function cachePath(libraryId: string, home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.cache, libraryDirectoryName(libraryId));
}

/** The one write lock every process on this machine takes before writing this library. */
export function lockPath(libraryId: string, home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.locks, `${libraryDirectoryName(libraryId)}.lock`);
}

/**
 * TCRN-CROSS-STORY-476 R5: the user-level crest, the knowledge store of one user across every
 * project. It is the device-level key crest.userPath when this device set one -- an absolute, real
 * path, which may sit in a cloud folder -- and `crest` in the device directory otherwise. `settings`
 * are this device's machine-setting values; readUserCrestPath (machine-settings.ts) reads them from
 * the file and asks here, so this module stays below the settings layer that imports it.
 */
export function userCrestPath(settings: Readonly<Record<string, string>> = {}, home: string = deviceHome()): string {
  const configured = settings[USER_CREST_PATH_SETTING];
  return typeof configured === "string" && configured.length > 0 ? configured : join(home, DEVICE_HOME_ENTRIES.crest);
}

/** The shared, append-only event root inside this user's crest. */
export function userCrestEventsPath(crest: string): string {
  return join(crest, USER_CREST_EVENTS_DIRECTORY);
}

/** The one lock every process on this machine takes before reading or writing the user crest. */
export function userCrestLockPath(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.locks, `${USER_CREST_DEVICE_NAME}.lock`);
}

/** The user crest's derived state on this machine (its index view); never a file in the crest. */
export function userCrestCachePath(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.cache, USER_CREST_DEVICE_NAME);
}

export function backupsPath(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.backups);
}

export function engineRoot(home: string = deviceHome()): string {
  return join(home, DEVICE_HOME_ENTRIES.engine);
}

/** Create a directory under the device directory (and its parents) with the process defaults. */
export async function ensureDeviceDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

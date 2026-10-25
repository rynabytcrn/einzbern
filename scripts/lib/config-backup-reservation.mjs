// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

// This marker is a preservation signal, never permission to create a backup or
// read its contents. Keep the wire bytes shared by the writer and output cleaner.
export const CONFIG_BACKUP_RESERVATION_FILE = ".einzbern-config-backup-reserved.json";
export const CONFIG_BACKUP_RESERVATION_SCHEMA_VERSION = "einzbern.config-backup-reservation.v1";
export const CONFIG_BACKUP_RESERVED_AREAS = Object.freeze(["config-backups", "config-backup-staging", "config-backup-recovery"]);
export const CONFIG_BACKUP_RESERVATION_TEXT = JSON.stringify({ areas: CONFIG_BACKUP_RESERVED_AREAS, schemaVersion: CONFIG_BACKUP_RESERVATION_SCHEMA_VERSION });

export class ConfigBackupReservationError extends Error {
  constructor(reasonCode, path) {
    super(`${reasonCode}: ${path}`);
    this.name = "ConfigBackupReservationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, path) {
  throw new ConfigBackupReservationError(reasonCode, path);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.isFile() && right.nlink === 1;
}

/** The caller binds the directory and its ancestors; no payload is opened here. */
export async function readConfigBackupReservation(root) {
  const path = join(root, CONFIG_BACKUP_RESERVATION_FILE);
  let before;
  try { before = await lstat(path); } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("CONFIG_BACKUP_RESERVATION_INVALID", path);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== Buffer.byteLength(CONFIG_BACKUP_RESERVATION_TEXT)) {
    fail("CONFIG_BACKUP_RESERVATION_INVALID", path);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail("CONFIG_BACKUP_RESERVATION_INVALID", path));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail("CONFIG_BACKUP_RESERVATION_CHANGED", path);
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const named = await lstat(path).catch(() => fail("CONFIG_BACKUP_RESERVATION_CHANGED", path));
    if (!sameFile(opened, await handle.stat()) || !sameFile(opened, named)) fail("CONFIG_BACKUP_RESERVATION_CHANGED", path);
    if (!bytes.equals(Buffer.from(CONFIG_BACKUP_RESERVATION_TEXT))) fail("CONFIG_BACKUP_RESERVATION_INVALID", path);
    return true;
  } finally { await handle.close(); }
}

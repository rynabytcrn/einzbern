// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigBackupReservationError, CONFIG_BACKUP_RESERVATION_FILE, CONFIG_BACKUP_RESERVED_AREAS, readConfigBackupReservation } from "./config-backup-reservation.mjs";

function fail(path) {
  throw new ConfigBackupReservationError("CONFIG_BACKUP_RESERVATION_INVALID", path);
}

function backupJsonPath(parts) {
  if (parts.length === 1) return parts[0] === CONFIG_BACKUP_RESERVATION_FILE;
  if (!CONFIG_BACKUP_RESERVED_AREAS.includes(parts[0]) || !/^[A-Za-z0-9_-]+$/u.test(parts[1] ?? "") || !/^[a-f0-9]{32}$/u.test(parts[2] ?? "")) return false;
  if (parts.length === 4) return parts[0] === "config-backups" && parts[3] === "index.json";
  if (!/^[0-9TZ-]+-[a-f0-9]{32}$/u.test(parts[3] ?? "")) return false;
  return (parts.length === 5 && parts[4] === "manifest.json") ||
    (parts.length === 6 && parts[4] === "members" && /^[a-f0-9]{64}\.json$/u.test(parts[5] ?? ""));
}

/** Formatter-only exclusion. Source, lint and privacy readers never use this. */
export async function isConfigBackupFormatProtected(repositoryPath, filePath) {
  const repository = resolve(repositoryPath);
  const file = resolve(filePath);
  const relation = relative(repository, file);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail(file);
  let current = repository;
  for (const part of ["", ...relative(repository, dirname(file)).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const directory = await lstat(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail(current);
    if (!await readConfigBackupReservation(current)) continue;
    if (current === repository) fail(current);
    // A marker cannot turn an ordinary source folder into a format exemption.
    // The dedicated root is closed, and only the protocol's JSON paths qualify.
    for (const name of await readdir(current)) {
      if (name === CONFIG_BACKUP_RESERVATION_FILE) continue;
      if (!CONFIG_BACKUP_RESERVED_AREAS.includes(name)) fail(current);
      const area = await lstat(join(current, name));
      if (!area.isDirectory() || area.isSymbolicLink()) fail(current);
    }
    if (!backupJsonPath(relative(current, file).split(sep))) fail(file);
    return true;
  }
  return false;
}

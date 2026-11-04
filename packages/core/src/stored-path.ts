// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Persistent device paths are relative to the file's directory; APIs use resolved paths. */
export function storePath(base: string, path: string): string {
  const stored = relative(resolve(base), resolve(path));
  if (isAbsolute(stored)) throw new Error("PORTABLE_PATH_DIFFERENT_VOLUME");
  return stored.split(sep).join("/") || ".";
}

/** Absolute legacy values remain readable; the next supported write makes them portable. */
export function loadPath(base: string, path: string): string {
  if (!path || /[\0\r\n]/u.test(path)) throw new Error("PORTABLE_PATH_INVALID");
  return resolve(base, path);
}

// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface StorageLocation { readonly schemaVersion: "einzbern.storage-location.v1"; readonly library: string; readonly runtime: string; readonly at: string; readonly decidedIn: string }
export function readStorageLocation(home: string): StorageLocation | null {
  let value: StorageLocation;
  try { value = JSON.parse(readFileSync(join(home, "storage-location.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (value.schemaVersion !== "einzbern.storage-location.v1" || !isAbsolute(value.library) || !isAbsolute(value.runtime)) throw new Error("STORAGE_LOCATION_INVALID");
  return value;
}
export function defaultSharedLibraryPath(home: string): string { return readStorageLocation(home)?.library ?? join(home, "library"); }
export function runtimeHome(home: string): string { return readStorageLocation(home)?.runtime ?? home; }

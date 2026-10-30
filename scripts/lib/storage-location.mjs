// SPDX-License-Identifier: Apache-2.0
// Shared storage pointer contract, usable before the engine build exists.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function readStorageLocation(home) {
  let value;
  try { value = JSON.parse(readFileSync(join(home, "storage-location.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (value.schemaVersion !== "einzbern.storage-location.v1" || !isAbsolute(value.library) || !isAbsolute(value.runtime)) throw new Error("STORAGE_LOCATION_INVALID");
  return value;
}

// SPDX-License-Identifier: Apache-2.0
// Shared storage pointer contract, usable before the engine build exists.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function readStorageLocation(home) {
  let value;
  try { value = JSON.parse(readFileSync(join(home, "storage-location.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!["einzbern.storage-location.v1", "einzbern.storage-location.v2"].includes(value.schemaVersion) || typeof value.library !== "string" || !value.library || typeof value.runtime !== "string" || !value.runtime) throw new Error("STORAGE_LOCATION_INVALID");
  return { ...value, library: resolve(home, value.library), runtime: resolve(home, value.runtime) };
}

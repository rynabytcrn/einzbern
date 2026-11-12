// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateMachineSettingsFile } from "./machine-settings.js";
import { deviceHome } from "./device-home.js";

const PREFIX = "binding:projectArtifacts/";
export function isProjectArtifactBinding(value: string): boolean {
  return /^binding:projectArtifacts\/[a-f0-9]{64}$/u.test(value);
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
}
export function resolveProjectArtifactBinding(value: string, home: string = deviceHome()): string {
  if (!isProjectArtifactBinding(value)) return invalid("invalid project artifact binding");
  let record;
  try { record = JSON.parse(readFileSync(join(home, "artifact-paths", `${value.slice(PREFIX.length)}.json`), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return invalid("project artifact directory is not configured on this device");
    throw error;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.libraryId !== "string" || typeof record.projectId !== "string" ||
      record.schemaVersion !== "einzbern.project-artifact-path.v1" || typeof record.path !== "string" || !isAbsolute(record.path) ||
      projectArtifactBinding(record.libraryId, record.projectId) !== value) return invalid("project artifact binding is invalid");
  return record.path;
}
export function projectArtifactBinding(libraryId: string, projectId: string): string {
  return PREFIX + createHash("sha256").update(JSON.stringify([libraryId, projectId])).digest("hex");
}

const PORTABLE_PATH_BINDINGS = ["paths.artifacts", "paths.knowledgeArticles"] as const;
export function isPortablePathBinding(value: string): boolean {
  if (isProjectArtifactBinding(value)) return true;
  const [name, ...parts] = value.split("/");
  return PORTABLE_PATH_BINDINGS.some(key => name === `binding:${key}`) &&
    parts.every(part => part.length > 0 && part !== "." && part !== ".." && !/[\\\u0000-\u001f\u007f:]/u.test(part));
}
/** Shared declarations carry only the logical name; the existing machine settings own location. */
export function resolvePortablePath(root: string, value: string, home: string = deviceHome()): string {
  if (isProjectArtifactBinding(value)) return resolveProjectArtifactBinding(value, home);
  if (!value.startsWith("binding:")) return isAbsolute(value) ? resolve(value) : resolve(root, value);
  const [key, ...suffix] = value.slice("binding:".length).split("/");
  if (!isPortablePathBinding(value)) throw Object.assign(new Error("unknown portable path binding"), { reasonCode: "PATH_BINDING_INVALID" });
  let file: unknown;
  try { file = JSON.parse(readFileSync(join(home, "machine-settings.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const path = file === undefined ? undefined : validateMachineSettingsFile(file, home).values[key!];
  if (typeof path !== "string" || !isAbsolute(path)) throw Object.assign(new Error(`${key} is not configured on this device`), { reasonCode: "PATH_BINDING_UNCONFIGURED", key });
  return resolve(path, ...suffix);
}

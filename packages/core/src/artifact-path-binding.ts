// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { deviceHome } from "./device-home.js";

const PREFIX = "binding:projectArtifacts/";
export function isProjectArtifactBinding(value: string): boolean {
  return /^binding:projectArtifacts\/[a-f0-9]{64}$/u.test(value);
}
function bindingPath(value: string, home: string): string {
  return join(home, "artifact-paths", `${value.slice(PREFIX.length)}.json`);
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { reasonCode: "PATH_BINDING_UNCONFIGURED" });
}
export function resolveProjectArtifactBinding(value: string, home: string = deviceHome()): string {
  if (!isProjectArtifactBinding(value)) return invalid("invalid project artifact binding");
  let record;
  try { record = JSON.parse(readFileSync(bindingPath(value, home), "utf8")); }
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
/** Device-local location, keyed by stable library/project identity, not by another device's path. */
export async function bindProjectArtifactPath(libraryId: string, projectId: string, path: string): Promise<string> {
  const value = projectArtifactBinding(libraryId, projectId);
  const home = deviceHome();
  await mkdir(join(home, "artifact-paths"), { recursive: true });
  const body = JSON.stringify({ schemaVersion: "einzbern.project-artifact-path.v1", libraryId, projectId, path });
  const target = bindingPath(value, home);
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, body, { mode: 0o600 });
  await rename(staging, target);
  return value;
}

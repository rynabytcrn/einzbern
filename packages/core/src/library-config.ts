// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R2, AC5 (MIN-227 D13): a library's project-level configuration is its
// settings events, merged like every other event, so every device reads the same values (the
// later writer in merge order wins). config/project.json is a readable projection of them for a
// person or a tool that does not run the engine: only a command that writes a project-level
// setting rewrites it, atomically, and no read ever trusts it. Two devices can rewrite it apart,
// and a sync client may then keep a conflicted copy; that costs nothing, because the events are
// the truth and status says when the projection does not match them.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { DIRECTORY } from "./names.js";

export const PROJECT_CONFIG_SCHEMA_VERSION = "einzbern.project-config.v1" as const;
export const PROJECT_CONFIG_FILE = "project.json" as const;

export interface ProjectConfigProjection {
  readonly schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  // The stream sequences of the merged state the values were read from.
  readonly versionVector: Readonly<Record<string, number>>;
  readonly values: Readonly<Record<string, string>>;
}

/** How config/project.json stands against the merged settings: matching, differing, missing or unreadable. */
export type ProjectConfigStatus = "current" | "stale" | "absent" | "invalid";

export function projectConfigPath(libraryRoot: string): string {
  return join(libraryRoot, DIRECTORY.projectConfig, PROJECT_CONFIG_FILE);
}

/** The project-level values of a merged state, keyed and sorted by setting key. */
export function projectConfigValues(settings: readonly { readonly key: string; readonly value: string }[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const setting of [...settings].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    values[setting.key] = setting.value;
  }
  return values;
}

/** Rewrite config/project.json from a merged state, atomically. */
export async function writeConfigProjection(
  libraryRoot: string,
  state: { readonly versionVector: Readonly<Record<string, number>>; readonly settings: readonly { readonly key: string; readonly value: string }[] },
): Promise<ProjectConfigProjection> {
  const projection: ProjectConfigProjection = {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    versionVector: state.versionVector,
    values: projectConfigValues(state.settings),
  };
  await writeFileAtomic(projectConfigPath(libraryRoot), canonicalJson(projection));
  return projection;
}

/** The projection as stored, "absent" when there is none, or "invalid" when it does not parse as one. */
export async function readConfigProjection(libraryRoot: string): Promise<ProjectConfigProjection | "absent" | "invalid"> {
  let text: string;
  try {
    text = await readFile(projectConfigPath(libraryRoot), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "absent";
    return "invalid";
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid";
    const record = value as Readonly<Record<string, unknown>>;
    const values = record.values;
    const versionVector = record.versionVector;
    if (record.schemaVersion !== PROJECT_CONFIG_SCHEMA_VERSION || values === null || typeof values !== "object" || Array.isArray(values) ||
      versionVector === null || typeof versionVector !== "object" || Array.isArray(versionVector) ||
      Object.values(values).some((entry) => typeof entry !== "string") ||
      Object.values(versionVector).some((entry) => !Number.isSafeInteger(entry))) {
      return "invalid";
    }
    return value as ProjectConfigProjection;
  } catch {
    return "invalid";
  }
}

/**
 * Whether config/project.json shows the merged settings. Only the values are compared: a
 * projection written before another device's unrelated events still shows the right values.
 */
export async function configProjectionStatus(libraryRoot: string, settings: readonly { readonly key: string; readonly value: string }[]): Promise<ProjectConfigStatus> {
  const stored = await readConfigProjection(libraryRoot);
  if (stored === "absent" || stored === "invalid") {
    // A library that never set a project-level key has nothing to project.
    return stored === "absent" && settings.length === 0 ? "current" : stored;
  }
  return canonicalJson(stored.values) === canonicalJson(projectConfigValues(settings)) ? "current" : "stale";
}

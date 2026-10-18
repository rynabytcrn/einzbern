// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R2, AC5 (MIN-227 D13): a library's project-level configuration is its
// settings events, merged like every other event, so every device reads the same values (the
// later writer in merge order wins). config/project.json is a readable projection of them for a
// person or a tool that does not run the engine: only a command that writes a project-level
// setting rewrites it, atomically, and no read ever trusts it. Two devices can rewrite it apart,
// and a sync client may then keep a conflicted copy; that costs nothing, because the events are
// the truth and status says when the projection does not match them.
// TCRN-CROSS-STORY-478 R1 (SUB-315): the project-level configuration records (config-records.ts)
// are projected beside the settings, grouped by collection, by the same writes and on the same terms.
// TCRN-CROSS-STORY-528 (MIN-256 R1 Q4; SUB-456): except the work leases. A lease is not
// configuration a person reads off the file; it comes and goes with the work, so the projection
// skips the collection and a claim or a release leaves the file as it was.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { DIRECTORY } from "./names.js";

export const PROJECT_CONFIG_SCHEMA_VERSION = "einzbern.project-config.v1" as const;
export const PROJECT_CONFIG_FILE = "project.json" as const;

/** The configuration records of a projection: collection, then key, then the record's value. */
export type ProjectConfigRecords = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

export interface ProjectConfigProjection {
  readonly schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  // The stream sequences of the merged state the values were read from.
  readonly versionVector: Readonly<Record<string, number>>;
  readonly values: Readonly<Record<string, string>>;
  // A projection written before records existed carries none and reads as holding none.
  readonly records: ProjectConfigRecords;
  readonly projects?: Readonly<Record<string, { readonly values: Readonly<Record<string, string>>; readonly records: ProjectConfigRecords }>>;
}

/** A configuration record in the shape a projection needs (config-records.ts holds the full one). */
export interface ProjectedConfigRecord {
  readonly collection: string;
  readonly key: string;
  readonly projectId?: string;
  readonly value: JsonValue;
}

/** How config/project.json stands against the merged settings: matching, differing, missing or unreadable. */
export type ProjectConfigStatus = "current" | "stale" | "absent" | "invalid";

export function projectConfigPath(libraryRoot: string): string {
  return join(libraryRoot, DIRECTORY.projectConfig, PROJECT_CONFIG_FILE);
}

/** The project-level values of a merged state, keyed and sorted by setting key. */
export function projectConfigValues(settings: readonly { readonly key: string; readonly value: string; readonly projectId?: string }[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const setting of [...settings].filter((entry) => entry.projectId === undefined).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    values[setting.key] = setting.value;
  }
  return values;
}

// The collections a projection leaves out: the leases (TCRN-CROSS-STORY-528) and the proposals that
// wait for Atelier (TCRN-CROSS-STORY-527), which are not configuration in force.
const UNPROJECTED_COLLECTIONS: ReadonlySet<string> = new Set(["lease", "proposal"]);

function projectedRecords<T extends ProjectedConfigRecord>(records: readonly T[]): readonly T[] {
  return records.filter((entry) => !UNPROJECTED_COLLECTIONS.has(entry.collection));
}

/** The configuration records of a merged state, grouped by collection and keyed by record key. */
export function projectConfigRecords(records: readonly ProjectedConfigRecord[]): ProjectConfigRecords {
  const grouped: Record<string, Record<string, JsonValue>> = {};
  for (const record of projectedRecords(records).filter((entry) => entry.projectId === undefined)) {
    (grouped[record.collection] ??= {})[record.key] = record.value;
  }
  return grouped;
}

/** Raw overrides by stable project identity; effective values are resolved by the engine, not stored here. */
export function projectConfigScopes(settings: readonly { readonly key: string; readonly value: string; readonly projectId?: string }[], allRecords: readonly ProjectedConfigRecord[]): NonNullable<ProjectConfigProjection["projects"]> {
  const records = projectedRecords(allRecords);
  const ids = [...new Set([...settings, ...records].flatMap((entry) => entry.projectId === undefined ? [] : [entry.projectId]))].sort();
  return Object.fromEntries(ids.map((id) => [id, {
    values: projectConfigValues(settings.filter((entry) => entry.projectId === id).map(({ projectId: _scope, ...entry }) => entry)),
    records: projectConfigRecords(records.filter((entry) => entry.projectId === id).map(({ projectId: _scope, ...entry }) => entry)),
  }]));
}

/** Rewrite config/project.json from a merged state, atomically. */
export async function writeConfigProjection(
  libraryRoot: string,
  state: {
    readonly versionVector: Readonly<Record<string, number>>;
    readonly settings: readonly { readonly key: string; readonly value: string; readonly projectId?: string }[];
    readonly configRecords?: readonly ProjectedConfigRecord[];
  },
): Promise<ProjectConfigProjection> {
  const projection: ProjectConfigProjection = {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    versionVector: state.versionVector,
    values: projectConfigValues(state.settings),
    records: projectConfigRecords(state.configRecords ?? []),
    ...(Object.keys(projectConfigScopes(state.settings, state.configRecords ?? [])).length === 0 ? {} : { projects: projectConfigScopes(state.settings, state.configRecords ?? []) }),
  };
  await writeFileAtomic(projectConfigPath(libraryRoot), canonicalJson(projection));
  return projection;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    if (!isObject(value)) return "invalid";
    const values = value.values;
    const versionVector = value.versionVector;
    const records = value.records;
    const projects = value.projects;
    if (projects !== undefined && (!isObject(projects) || Object.entries(projects).some(([id, entry]) => !/^project:[a-f0-9]{24}$/u.test(id) || !isObject(entry) || !isObject(entry.values) || Object.values(entry.values).some((v) => typeof v !== "string") || !isObject(entry.records) || Object.values(entry.records).some((v) => !isObject(v))))) return "invalid";
    if (value.schemaVersion !== PROJECT_CONFIG_SCHEMA_VERSION || !isObject(values) || !isObject(versionVector) ||
      Object.values(values).some((entry) => typeof entry !== "string") ||
      Object.values(versionVector).some((entry) => !Number.isSafeInteger(entry)) ||
      (records !== undefined && (!isObject(records) || Object.values(records).some((collection) => !isObject(collection))))) {
      return "invalid";
    }
    return {
      schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
      versionVector: versionVector as Readonly<Record<string, number>>,
      values: values as Readonly<Record<string, string>>,
      records: (records ?? {}) as ProjectConfigRecords,
      ...(projects === undefined ? {} : { projects: projects as NonNullable<ProjectConfigProjection["projects"]> }),
    };
  } catch {
    return "invalid";
  }
}

/**
 * Whether config/project.json shows the merged settings, and the merged configuration records
 * when the caller passes them (a caller that passes the settings alone has the values judged).
 * Only values are compared: a projection written before another device's unrelated events still
 * shows the right values.
 */
export async function configProjectionStatus(
  libraryRoot: string,
  settings: readonly { readonly key: string; readonly value: string; readonly projectId?: string }[],
  records?: readonly ProjectedConfigRecord[],
): Promise<ProjectConfigStatus> {
  const stored = await readConfigProjection(libraryRoot);
  if (stored === "absent" || stored === "invalid") {
    // A library that never set a project-level key or record has nothing to project.
    return stored === "absent" && settings.length === 0 && projectedRecords(records ?? []).length === 0 ? "current" : stored;
  }
  if (canonicalJson(stored.values) !== canonicalJson(projectConfigValues(settings))) return "stale";
  const expectedProjects = projectConfigScopes(settings, records ?? []);
  if (records === undefined) {
    // Record-only scopes do not introduce settings; compare values on both sides without
    // treating omitted records as an assertion that each project's records are empty.
    const projectIds = new Set([...Object.keys(stored.projects ?? {}), ...Object.keys(expectedProjects)]);
    for (const id of projectIds) {
      if (canonicalJson(stored.projects?.[id]?.values ?? {}) !== canonicalJson(expectedProjects[id]?.values ?? {})) return "stale";
    }
    return "current";
  }
  if (canonicalJson(stored.projects ?? {}) !== canonicalJson(expectedProjects)) return "stale";
  return canonicalJson(stored.records) === canonicalJson(projectConfigRecords(records)) ? "current" : "stale";
}

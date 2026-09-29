// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-489 R1 (TCRN-CROSS-SUB-364; MIN-235 D17, MIN-238 D4): the plan of setup --mode
// migrate. Before the rename, each partition's chain sat in an old-layout workspace; the migration
// makes each chain the first stream of a library, .ether in the root of the project the partition
// belongs to (the container root for cross-project). Which project that is comes from the mapping,
// a JSON file of this device's paths that is never committed:
//
//   { "schemaVersion": "einzbern.migration-mapping.v1",
//     "partitions": [ { "partition", "legacyWorkspace", "projectRoot", "projectName"?, "gitRemote"? } ] }
//
// legacyWorkspace is the directory that holds the old control directory and projectRoot the project
// whose library the chain becomes, both absolute. projectName and gitRemote are the library's project
// hints, by default the project directory's name and its working tree's remote. Without a mapping,
// an old workspace in the project itself is the one partition there is to infer.
//
// planMigration writes nothing. For each partition it runs the import's dry run (legacy-import.ts),
// which validates the whole chain from genesis and reports its events and head, then replays the
// chain once more and requires the same head. From that replay it lists every gate that is not
// satisfied (id, bound work, status, title, outcome class: a pending gate stays pending and is
// listed, never counted as none, MIN-238 D4) and counts the work that is still open. A target that
// is not a new or empty directory stops the apply, as the import itself would. The plan also names
// the registry entry each library gets (migratedFrom is the old workspace), the portal keys of the
// old device directory's machine settings, and the host files the migration cleans up
// (TCRN-CROSS-SUB-366 fills those in). Running the plan is TCRN-CROSS-SUB-365's.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import "./index.js";
import type { WorkStatus } from "../../protocol/src/index.js";
import type { GateRecord } from "./assignment-gate.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { registryPath } from "./device-home.js";
import { importLegacyWorkspace } from "./legacy-import.js";
import { openLegacyWorkspace, replayLegacyWorkspace } from "./legacy-workspace.js";
import { MACHINE_SETTINGS_FILE_NAME, assertMachineSettingKey, readMachineSettings, validateMachineSettingValue } from "./machine-settings.js";
import { DIRECTORY } from "./names.js";
import { gitRemoteOf, normalizeGitRemote, readRegistry } from "./registry.js";
import type { Registry } from "./registry.js";
import { setupFail } from "./setup.js";
import type { SetupBlocker, SetupStep, SetupWrite, SetupWriteAction } from "./setup.js";
import { entryKind, libraryLanguage, messageOf, realTarget, reasonOf } from "./setup-fresh.js";
import type { WorkspaceState } from "./workspace.js";

export const MIGRATION_MAPPING_SCHEMA_VERSION = "einzbern.migration-mapping.v1" as const;

// A mapping names a handful of partitions; a file larger than this is not one.
const MAPPING_MAXIMUM_BYTES = 1_048_576;
const MAPPING_FIELDS: readonly string[] = Object.freeze(["partition", "legacyWorkspace", "projectRoot", "projectName", "gitRemote"]);
// The library manifest's bound on a project hint (ether-library.ts), which a partition's name shares.
const HINT_MAXIMUM_LENGTH = 512;
const PORTAL_KEY_PREFIX = "portal.";

/** One partition of the mapping: the old workspace and the project whose library it becomes. */
export interface MigrationMappingEntry {
  readonly partition: string;
  readonly legacyWorkspace: string;
  readonly projectRoot: string;
  readonly projectName?: string;
  readonly gitRemote?: string;
}

export interface MigrationMapping {
  readonly schemaVersion: typeof MIGRATION_MAPPING_SCHEMA_VERSION;
  readonly partitions: readonly MigrationMappingEntry[];
}

// What is at a partition's target: nothing or an empty directory, which the import creates the
// library in, or something the import refuses.
export type MigrationTargetState = "absent" | "empty" | "not-empty" | "not-a-directory";

/** A gate of the old chain that is not satisfied; it keeps its status through the migration. */
export interface MigrationGate {
  readonly id: string;
  readonly workId: string | null;
  readonly status: Exclude<GateRecord["status"], "satisfied">;
  readonly title: string;
  readonly outcomeClass: GateRecord["outcomeClass"];
}

export type OpenWorkStatus = Exclude<WorkStatus, "done" | "cancelled">;
const OPEN_WORK_STATUSES: readonly OpenWorkStatus[] = Object.freeze(["planned", "ready", "active", "blocked", "pending-owner-acceptance"]);

/** The work of the old chain that is neither done nor cancelled, by status. */
export interface MigrationOpenItems {
  readonly total: number;
  readonly byStatus: Readonly<Record<OpenWorkStatus, number>>;
}

export interface MigrationPartitionPlan {
  readonly partition: string;
  // The old workspace and the project as they are on this device (real paths once they exist).
  readonly legacyWorkspace: string;
  readonly projectRoot: string;
  // The library the chain becomes, <projectRoot>/.ether, and what is there now.
  readonly target: string;
  readonly targetState: MigrationTargetState;
  // import, or blocked when a blocker of the plan names this partition.
  readonly action: "import" | "blocked";
  // The import's dry run: the old workspace id (the library keeps it as its id), its stream, and the
  // chain's events and head. Null when the old workspace does not read.
  readonly workspaceId: string | null;
  readonly streamId: string | null;
  readonly events: number | null;
  readonly headEventHash: string | null;
  // The library's project hints.
  readonly projectName: string | null;
  readonly gitRemote: string | null;
  // The artifact.language the old chain records, which the library keeps; null when it records none.
  readonly language: string | null;
  // Null when the old chain does not read: unknown, never none.
  readonly unsatisfiedGates: readonly MigrationGate[] | null;
  readonly openItems: MigrationOpenItems | null;
}

/** The entry this device's registry gets for a partition's library. */
export interface MigrationRegistryEntry {
  readonly partition: string;
  readonly projectPath: string;
  readonly libraryPath: string;
  readonly libraryId: string | null;
  readonly cloudHosted: boolean;
  readonly gitRemote: string | null;
  // The old workspace the library was imported from.
  readonly migratedFrom: string;
}

/** A portal key of the old device directory's machine settings, and what the migration does with it. */
export interface MigrationDeviceSetting {
  readonly key: string;
  readonly value: string;
  // What this device's settings hold for the key now.
  readonly current: string | null;
  // set: this device holds none; unchanged: it holds the same; kept: it holds another value, which
  // stays; invalid: this engine does not take the key or the value.
  readonly action: "set" | "unchanged" | "kept" | "invalid";
}

export interface MigrationDeviceSettings {
  // The old device directory's machine-settings.json, or null when there is none.
  readonly from: string | null;
  // This device directory's machine-settings.json.
  readonly to: string;
  readonly keys: readonly MigrationDeviceSetting[];
}

/** A host file or directory the migration cleans up: moved, or updated after its original is copied, into the device directory's backups; never deleted. */
export interface MigrationCleanupItem {
  readonly path: string;
  readonly action: "move" | "update";
  readonly into: string;
}

/** What setup --mode migrate plans (the plan's migration field). */
export interface MigrationPlan {
  // The --mapping file, resolved; null when the mapping was inferred or there is none yet.
  readonly mappingFile: string | null;
  // The mapping in the file's shape: what the apply follows, and what a changed one is written as.
  readonly mapping: MigrationMapping | null;
  readonly partitions: readonly MigrationPartitionPlan[];
  readonly registry: readonly MigrationRegistryEntry[];
  readonly deviceSettings: MigrationDeviceSettings;
  // TCRN-CROSS-SUB-366 fills these in.
  readonly hostCleanup: readonly MigrationCleanupItem[];
}

export interface MigrationPlanInput {
  readonly mapping: MigrationMapping | null;
  readonly mappingFile: string | null;
  // The user's home, the device directory, and the old device directory when there is one.
  readonly home: string;
  readonly deviceHome: string;
  readonly legacyDeviceHome: string | null;
  // The instant of the plan; the dry run takes it as its creation instant.
  readonly at: string;
  // --cloud for every library; left out, each takes the cloud folder table's suggestion.
  readonly cloud?: boolean;
}

/** The plan, the writes its apply makes in order (library, registry, machine-settings), and what stops the apply. */
export interface MigrationPlanResult {
  readonly migration: MigrationPlan;
  readonly writes: readonly SetupWrite[];
  readonly blockers: readonly SetupBlocker[];
}

// ---- The mapping ----

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= HINT_MAXIMUM_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.trim() === value && !value.includes("\u0000") && isAbsolute(value);
}

function mappingInvalid(message: string, details: Readonly<Record<string, string>>): never {
  return setupFail("SETUP_ANSWER_INVALID", message, { question: "mapping", ...details });
}

/** Check a parsed mapping (from `file`) against einzbern.migration-mapping.v1; SETUP_ANSWER_INVALID names what breaks it. */
export function checkMigrationMapping(value: unknown, file: string): MigrationMapping {
  if (!isRecord(value)) mappingInvalid(`the mapping ${file} is not an object with schemaVersion and partitions`, { file });
  const unknownFields = Object.keys(value).filter((field) => field !== "schemaVersion" && field !== "partitions");
  if (unknownFields[0] !== undefined) mappingInvalid(`the mapping ${file} carries ${unknownFields.join(", ")}, which it does not take`, { file, field: unknownFields[0] });
  if (value.schemaVersion !== MIGRATION_MAPPING_SCHEMA_VERSION) {
    mappingInvalid(`the mapping's schemaVersion must be ${MIGRATION_MAPPING_SCHEMA_VERSION}`, { file, field: "schemaVersion" });
  }
  const listed = value.partitions;
  if (!Array.isArray(listed) || listed.length === 0) mappingInvalid("the mapping lists no partition", { file, field: "partitions" });
  const partitions: MigrationMappingEntry[] = [];
  for (const [index, raw] of (listed as readonly unknown[]).entries()) {
    const at = (field: string): Readonly<Record<string, string>> => ({ file, entry: String(index), field });
    if (!isRecord(raw)) mappingInvalid(`partitions[${index}] is not an object`, at("partitions"));
    const extra = Object.keys(raw).filter((field) => !MAPPING_FIELDS.includes(field));
    if (extra[0] !== undefined) mappingInvalid(`partitions[${index}] carries ${extra.join(", ")}, which a partition does not take`, at(extra[0]));
    const { partition, legacyWorkspace, projectRoot, projectName, gitRemote } = raw;
    if (!isHint(partition)) mappingInvalid(`partitions[${index}].partition must name the partition on one line`, at("partition"));
    if (!isAbsolutePath(legacyWorkspace)) mappingInvalid(`partitions[${index}].legacyWorkspace must be an absolute path`, at("legacyWorkspace"));
    if (!isAbsolutePath(projectRoot)) mappingInvalid(`partitions[${index}].projectRoot must be an absolute path`, at("projectRoot"));
    if (projectName !== undefined && !isHint(projectName)) mappingInvalid(`partitions[${index}].projectName must be one line of at most ${HINT_MAXIMUM_LENGTH} characters`, at("projectName"));
    if (gitRemote !== undefined && !isHint(gitRemote)) mappingInvalid(`partitions[${index}].gitRemote must be one line of at most ${HINT_MAXIMUM_LENGTH} characters`, at("gitRemote"));
    partitions.push({
      partition,
      legacyWorkspace,
      projectRoot,
      ...(projectName === undefined ? {} : { projectName }),
      ...(gitRemote === undefined ? {} : { gitRemote }),
    });
  }
  // A partition, an old workspace and a project are each named once.
  for (const field of ["partition", "legacyWorkspace", "projectRoot"] as const) {
    const seen = new Set<string>();
    for (const [index, entry] of partitions.entries()) {
      const key = field === "partition" ? entry.partition : resolve(entry[field]);
      if (seen.has(key)) mappingInvalid(`partitions[${index}].${field} names ${key} a second time`, { file, entry: String(index), field });
      seen.add(key);
    }
  }
  return { schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION, partitions };
}

/** Read the mapping file (einzbern.migration-mapping.v1); one that does not read or does not check answers SETUP_ANSWER_INVALID. */
export async function readMigrationMapping(fileInput: string): Promise<MigrationMapping> {
  const file = resolve(fileInput);
  let size: number;
  let regular: boolean;
  try {
    const metadata = await stat(file);
    size = metadata.size;
    regular = metadata.isFile();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") mappingInvalid(`the mapping ${file} does not exist`, { file });
    throw error;
  }
  if (!regular || size > MAPPING_MAXIMUM_BYTES) mappingInvalid(`the mapping ${file} is not a regular file of at most ${MAPPING_MAXIMUM_BYTES} bytes`, { file });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    mappingInvalid(`the mapping ${file} is not JSON`, { file });
  }
  return checkMigrationMapping(parsed, file);
}

/** The mapping an old workspace in the project itself implies: one partition, named after the project directory, into the project's own library. Null when the project holds none. */
export function inferMigrationMapping(projectRoot: string, controlDirectory: string | null): MigrationMapping | null {
  if (controlDirectory === null) return null;
  const partition = basename(projectRoot);
  return {
    schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION,
    partitions: [{ partition: partition === "" ? projectRoot : partition, legacyWorkspace: projectRoot, projectRoot }],
  };
}

// ---- The plan ----

/** The writes and blockers of one plan, each listed once. */
class MigrationRecorder {
  readonly writes: SetupWrite[] = [];
  readonly blockers: SetupBlocker[] = [];

  write(step: SetupStep, path: string, action: SetupWriteAction): void {
    if (!this.writes.some((entry) => entry.path === path)) this.writes.push({ step, path, action });
  }

  block(step: SetupBlocker["step"], path: string, reasonCode: string, message: string): void {
    if (!this.blockers.some((entry) => entry.step === step && entry.path === path && entry.reasonCode === reasonCode)) {
      this.blockers.push({ step, path, reasonCode, message });
    }
  }

  // Run a read; a refusal with a reason code becomes a blocker of `step`, and null is answered.
  async attempt<T>(step: SetupBlocker["step"], path: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      const reasonCode = reasonOf(error);
      if (reasonCode === null) throw error;
      this.block(step, path, reasonCode, messageOf(error));
      return null;
    }
  }
}

// A path's real path when it exists, else the path itself.
async function realOrGiven(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return resolve(path);
    throw error;
  }
}

async function targetState(target: string): Promise<MigrationTargetState> {
  const kind = await entryKind(target);
  if (kind === null) return "absent";
  if (kind !== "directory") return "not-a-directory";
  return (await readdir(target)).length === 0 ? "empty" : "not-empty";
}

function unsatisfiedGates(state: WorkspaceState): readonly MigrationGate[] {
  const gates: MigrationGate[] = [];
  for (const gate of state.gates) {
    if (gate.tombstone || gate.status === "satisfied") continue;
    gates.push({ id: gate.id, workId: gate.workId, status: gate.status, title: gate.title, outcomeClass: gate.outcomeClass });
  }
  return gates;
}

function isOpenWorkStatus(status: WorkStatus): status is OpenWorkStatus {
  return (OPEN_WORK_STATUSES as readonly string[]).includes(status);
}

function openItems(state: WorkspaceState): MigrationOpenItems {
  const byStatus: Record<OpenWorkStatus, number> = { planned: 0, ready: 0, active: 0, blocked: 0, "pending-owner-acceptance": 0 };
  let total = 0;
  for (const record of state.work) {
    if (record.tombstone || !isOpenWorkStatus(record.status)) continue;
    byStatus[record.status] += 1;
    total += 1;
  }
  return { total, byStatus };
}

function hintOrNull(value: string | null): string | null {
  return value !== null && isHint(value) ? value : null;
}

interface PlannedPartition {
  readonly partition: MigrationPartitionPlan;
  readonly registry: MigrationRegistryEntry;
}

async function planPartition(recorder: MigrationRecorder, input: MigrationPlanInput, entry: MigrationMappingEntry, registry: Registry | null): Promise<PlannedPartition> {
  const blockersBefore = recorder.blockers.length;
  const name = entry.partition;

  // The project: its library is .ether in it, which the import creates in a new or empty directory.
  const projectRoot = await realOrGiven(entry.projectRoot);
  const projectKind = await entryKind(projectRoot);
  if (projectKind !== "directory") {
    recorder.block("library", projectRoot, "SETUP_INPUT_INVALID", `the project ${projectRoot} of partition ${name} is not a directory`);
  }
  const target = projectKind === "directory" ? await realTarget(join(projectRoot, DIRECTORY.library)) : join(projectRoot, DIRECTORY.library);
  const state = await targetState(target);
  if (state === "not-empty") {
    recorder.block("library", target, "LIBRARY_TARGET_NOT_EMPTY", `${target} is not empty: partition ${name} is imported into a new or empty directory`);
  } else if (state === "not-a-directory") {
    recorder.block("library", target, "LIBRARY_TARGET_INVALID", `${target} is not a directory: partition ${name} is imported into a new or empty directory`);
  }

  // The old chain: the import's dry run validates it from genesis and reports its events and head;
  // a replay of the same chain must reach the same head before its gates and work are listed.
  const legacyWorkspace = await realOrGiven(entry.legacyWorkspace);
  const report = await recorder.attempt("library", legacyWorkspace, () => importLegacyWorkspace(legacyWorkspace, target, { createdAt: input.at, dryRun: true }));
  const replayed = report === null ? null : await recorder.attempt("library", legacyWorkspace, async () => replayLegacyWorkspace(await openLegacyWorkspace(legacyWorkspace)));
  if (report !== null && replayed !== null && (replayed.version !== report.events || replayed.headEventHash !== report.headEventHash)) {
    recorder.block("library", legacyWorkspace, "LEGACY_IMPORT_MISMATCH",
      `the old workspace of partition ${name} changed while it was planned (${report.events} events, then ${replayed.version}): plan again once nothing writes to it`);
  }

  // This device's registry: a project registered to another library keeps it until the user moves it.
  const registered = registry?.entries.find((candidate) => candidate.projectPath === projectRoot) ?? null;
  if (registered !== null && registered.libraryPath !== target) {
    recorder.block("registry", target, "SETUP_LIBRARY_CONFLICT",
      `the project ${projectRoot} is registered to the library at ${registered.libraryPath}, not to ${target}, which partition ${name} becomes`);
  }

  const remote = entry.gitRemote ?? (projectKind === "directory" ? gitRemoteOf(projectRoot) : null);
  const gitRemote = remote === null ? null : hintOrNull(normalizeGitRemote(remote));
  const workspaceId = report?.workspaceId ?? null;
  const partition: MigrationPartitionPlan = {
    partition: name,
    legacyWorkspace,
    projectRoot,
    target,
    targetState: state,
    action: recorder.blockers.length > blockersBefore ? "blocked" : "import",
    workspaceId,
    streamId: report?.streamId ?? null,
    events: report?.events ?? null,
    headEventHash: report?.headEventHash ?? null,
    projectName: entry.projectName ?? hintOrNull(basename(projectRoot)),
    gitRemote,
    language: replayed === null ? null : libraryLanguage(replayed),
    unsatisfiedGates: replayed === null ? null : unsatisfiedGates(replayed),
    openItems: replayed === null ? null : openItems(replayed),
  };
  return {
    partition,
    registry: {
      partition: name,
      projectPath: projectRoot,
      libraryPath: target,
      libraryId: workspaceId,
      cloudHosted: input.cloud ?? suggestCloudHosted(target, { platform: process.platform, env: process.env, home: input.home }),
      gitRemote,
      migratedFrom: legacyWorkspace,
    },
  };
}

function validPortalSetting(key: string, value: unknown): boolean {
  try {
    assertMachineSettingKey(key);
    validateMachineSettingValue(key, value);
    return true;
  } catch (error) {
    if (reasonOf(error) === null) throw error;
    return false;
  }
}

// The portal keys of the old device directory's machine settings, read without its schema: only
// their values travel. Null, with a blocker, when the file does not read as settings.
async function readPortalValues(recorder: MigrationRecorder, from: string): Promise<readonly (readonly [string, unknown])[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(from, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    recorder.block("machine-settings", from, "MACHINE_SETTINGS_FILE_INVALID", `${from} is not JSON`);
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.values)) {
    recorder.block("machine-settings", from, "MACHINE_SETTINGS_FILE_INVALID", `${from} holds no values object`);
    return null;
  }
  return Object.entries(parsed.values)
    .filter(([key]) => key.startsWith(PORTAL_KEY_PREFIX))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

async function planDeviceSettings(recorder: MigrationRecorder, input: MigrationPlanInput): Promise<MigrationDeviceSettings> {
  const to = join(input.deviceHome, MACHINE_SETTINGS_FILE_NAME);
  const candidate = input.legacyDeviceHome === null ? null : join(input.legacyDeviceHome, MACHINE_SETTINGS_FILE_NAME);
  const kind = candidate === null ? null : await entryKind(candidate);
  if (candidate === null || kind === null) return { from: null, to, keys: [] };
  if (kind !== "file") {
    recorder.block("machine-settings", candidate, "MACHINE_SETTINGS_FILE_INVALID", `${candidate} is not a regular file`);
    return { from: candidate, to, keys: [] };
  }
  const values = await readPortalValues(recorder, candidate);
  if (values === null || values.length === 0) return { from: candidate, to, keys: [] };
  const held = await recorder.attempt("machine-settings", to, () => readMachineSettings(to));
  const keys = values.map(([key, raw]): MigrationDeviceSetting => {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const current = held?.values[key] ?? null;
    const action = !validPortalSetting(key, raw) ? "invalid" : current === null ? "set" : current === value ? "unchanged" : "kept";
    return { key, value, current, action };
  });
  if (keys.some((setting) => setting.action === "set")) recorder.write("machine-settings", to, await entryKind(to) === null ? "create" : "update");
  return { from: candidate, to, keys };
}

/**
 * Plan the migration the mapping describes (TCRN-CROSS-STORY-489 R1): for each partition its target,
 * the dry run's events and head, the gates that are not satisfied and the open work; the registry
 * entries; the portal keys of the old device directory. Nothing is written: the writes are the ones
 * the apply makes, and a blocker is what stops it. With no mapping there are no partitions.
 */
export async function planMigration(input: MigrationPlanInput): Promise<MigrationPlanResult> {
  const recorder = new MigrationRecorder();
  const registryFile = registryPath(input.deviceHome);
  const registry = await recorder.attempt("registry", registryFile, () => readRegistry(input.deviceHome));
  const partitions: MigrationPartitionPlan[] = [];
  const registryEntries: MigrationRegistryEntry[] = [];
  for (const entry of input.mapping?.partitions ?? []) {
    const planned = await planPartition(recorder, input, entry, registry);
    // Two entries that reach one place through a link are the same old workspace, or the same library.
    for (const field of ["legacyWorkspace", "target"] as const) {
      const other = partitions.find((partition) => partition[field] === planned.partition[field]);
      if (other !== undefined) {
        mappingInvalid(`partitions ${other.partition} and ${entry.partition} both reach ${planned.partition[field]}`, {
          file: input.mappingFile ?? "",
          field: field === "target" ? "projectRoot" : field,
        });
      }
    }
    partitions.push(planned.partition);
    registryEntries.push(planned.registry);
  }
  for (const partition of partitions) if (partition.action === "import") recorder.write("library", partition.target, "create");
  if (partitions.length > 0) recorder.write("registry", registryFile, await entryKind(registryFile) === null ? "create" : "update");
  const deviceSettings = await planDeviceSettings(recorder, input);
  return {
    migration: {
      mappingFile: input.mappingFile,
      mapping: input.mapping,
      partitions,
      registry: registryEntries,
      deviceSettings,
      hostCleanup: [],
    },
    writes: recorder.writes,
    blockers: recorder.blockers,
  };
}

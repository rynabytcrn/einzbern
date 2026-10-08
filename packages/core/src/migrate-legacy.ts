import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-489 R1 (TCRN-CROSS-SUB-364; MIN-235 D17, MIN-238 D4): the plan of setup --mode
// migrate. Before the rename, each partition's chain sat in an old-layout workspace; the migration
// makes each chain the first stream of a library, .ether in the root of the project the partition
// belongs to (the container root for cross-project). Which project that is comes from the mapping,
// a JSON file of this device's paths that is never committed:
//
//   { "schemaVersion": "einzbern.migration-mapping.v1",
//     "partitions": [ { "partition", "legacyWorkspace", "projectRoot", "projectName"?, "gitRemote"?, "chainRole"? } ] }
//
// legacyWorkspace is the directory that holds the old control directory and projectRoot the project
// whose library the chain becomes, both absolute. projectName and gitRemote are the library's project
// hints, by default the project directory's name and its working tree's remote. Without a mapping,
// an old workspace in the project itself is the one partition there is to infer.
//
// chainRole (INIT-053 U08, approved contract item 1) is the only source of a migrated library's chain
// role: "coordination" for the one coordination chain of the mapping, whose identity names its own
// library, or "project" for a concrete project chain, whose identity names the coordination row's
// library. A mapping takes at most one coordination row, and project rows need it in the same
// mapping. A row without chainRole stays unclassified, and the plan says so (chainIdentity null);
// a role is never inferred from a partition's name, its paths or a basename. The identity is written
// once the import is checked, signed by the setup actor; a library migrated before carrying none
// gets it, and one carrying another identity stops the plan.
//
// planMigration writes nothing. For each partition whose target the import can create the library
// in, it runs the import's dry run (legacy-import.ts), which validates the whole chain from genesis
// and reports its events and head, then replays the chain once more and requires the same head.
// From that replay it lists every gate that is not satisfied (id, bound work, status, title, outcome
// class: a pending gate stays pending and is listed, never counted as none, MIN-238 D4) and counts
// the work that is still open. A dry run the old knowledge store refuses (TCRN-CROSS-SUB-421 R18)
// read the chain first, so the chain is still replayed and listed, and the refusal is a blocker of
// its own on the file of the store it names. A target that is not a new or empty directory stops
// the apply, as the import itself would, unless it is the library an earlier run imported this same
// chain into (TCRN-CROSS-SUB-365): that partition is skipped, so running the same mapping again
// changes nothing. The plan also names the registry entry each library gets (migratedFrom is the old
// workspace), the portal keys of the old device directory's machine settings, and the host files
// the migration cleans up (TCRN-CROSS-SUB-366 fills those in).
//
// applyMigration (TCRN-CROSS-STORY-489 R1, R2, R4; TCRN-CROSS-SUB-365) runs a confirmed plan in the
// plan's order: each partition's library, imported as its first stream and its events and head
// compared with the plan's (a difference stops the apply and names the partition), or skipped
// once the library holds that chain; then the registry entries, each with migratedFrom, the old
// path's tombstone (registry.ts), an existing registry copied into this run's backups first; then
// the portal keys this device does not hold yet. Nothing is written into an old workspace, and no
// gate changes: a pending one stays pending in the library (MIN-238 D4) until it is released in
// Atelier (workspace.ts, work-gate-release).

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import "./index.js";
import type { WorkStatus } from "../../protocol/src/index.js";
import { readAllStreams } from "./akasha.js";
import type { GateRecord } from "./assignment-gate.js";
import { writeFileAtomic } from "./atomic-file.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { ensureDeviceDirectory, registryPath } from "./device-home.js";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import { LegacyImportError, LegacyKnowledgeRefusedError, importLegacyWorkspace, legacyKnowledgeOmissionIssue } from "./legacy-import.js";
import type { LegacyImportKnowledge, LegacyImportReport, LegacyKnowledgeOmission, LegacyKnowledgeOmissionReport } from "./legacy-import.js";
import { openLegacyWorkspace, replayLegacyWorkspace } from "./legacy-workspace.js";
import {
  MACHINE_SETTINGS_FILE_NAME,
  applyMachineSettingSet,
  assertMachineSettingKey,
  readMachineSettings,
  validateMachineSettingValue,
} from "./machine-settings.js";
import { DIRECTORY } from "./names.js";
import { gitRemoteOf, normalizeGitRemote, readRegistry, registerLibrary } from "./registry.js";
import type { Registry, RegistryEntry } from "./registry.js";
import { SETUP_ACTOR, setupFail } from "./setup.js";
import type { SetupBlocker, SetupStep, SetupWrite, SetupWriteAction } from "./setup.js";
import { entryKind, libraryLanguage, messageOf, realTarget, reasonOf } from "./setup-fresh.js";
import type { SetupRecorder } from "./setup-fresh.js";
import { legacyWorkspaceStreamId, materializeWorkspaceFromGenesis } from "./workspace.js";
import { chainIdentity, declareChainIdentity } from "./project-chain.js";
import type { ChainIdentity } from "./project-chain.js";
import type { WorkspaceState } from "./workspace.js";

export const MIGRATION_MAPPING_SCHEMA_VERSION = "einzbern.migration-mapping.v1" as const;

// A mapping names a handful of partitions; a file larger than this is not one.
const MAPPING_MAXIMUM_BYTES = RUNTIME_CAPACITY.bufferBytes;
const MAPPING_FIELDS: readonly string[] = Object.freeze(["partition", "legacyWorkspace", "projectRoot", "projectName", "gitRemote", "omitLegacyKnowledge", "chainRole"]);
const CHAIN_ROLES: readonly string[] = Object.freeze(["coordination", "project"]);
// The library manifest's bound on a project hint (ether-library.ts), which a partition's name shares.
const HINT_MAXIMUM_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const PORTAL_KEY_PREFIX = "portal.";

/** One partition of the mapping: the old workspace and the project whose library it becomes. */
export interface MigrationMappingEntry {
  readonly partition: string;
  readonly legacyWorkspace: string;
  readonly projectRoot: string;
  readonly projectName?: string;
  readonly gitRemote?: string;
  readonly omitLegacyKnowledge?: LegacyKnowledgeOmission;
  // The partition's chain role, given explicitly; absent, the library stays unclassified.
  readonly chainRole?: ChainIdentity["role"];
}

export interface MigrationMapping {
  readonly schemaVersion: typeof MIGRATION_MAPPING_SCHEMA_VERSION;
  readonly partitions: readonly MigrationMappingEntry[];
}

// What is at a partition's target: nothing or an empty directory, which the import creates the
// library in; the library an earlier run imported this partition's chain into (migrated: its id is
// the old workspace id and its first stream carries the old chain up to the old head); or
// something the import refuses.
export type MigrationTargetState = "absent" | "empty" | "migrated" | "not-empty" | "not-a-directory";

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
  // import; skip, when the target is migrated already; or blocked when a blocker of the plan names
  // this partition.
  readonly action: "import" | "skip" | "blocked";
  // The import's dry run (or, for a target it would refuse, the replay): the old workspace id (the
  // library keeps it as its id), its stream, and the chain's events and head. Null when the old
  // workspace does not read.
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
  readonly knowledge: LegacyImportKnowledge | null;
  readonly knowledgeOmission: LegacyKnowledgeOmissionReport | null;
  // The chain identity the mapping's chainRole gives the library; null while unclassified (no
  // chainRole), or while the coordination row's library id is unknown.
  readonly chainIdentity: ChainIdentity | null;
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

/** The plan, the writes its apply makes in order (library, registry, machine-settings), the originals it copies first, and what stops the apply. */
export interface MigrationPlanResult {
  readonly migration: MigrationPlan;
  readonly writes: readonly SetupWrite[];
  // An existing registry the apply changes is copied into this run's backups first.
  readonly backups: readonly { readonly step: SetupStep; readonly path: string }[];
  readonly blockers: readonly SetupBlocker[];
}

/** A partition as the apply left it: its library imported, or skipped as migrated already. */
export interface MigrationPartitionApplied {
  readonly partition: string;
  readonly legacyWorkspace: string;
  readonly projectRoot: string;
  readonly target: string;
  readonly libraryId: string;
  readonly action: "imported" | "skipped";
  // The old chain the library's first stream carries.
  readonly events: number;
  readonly headEventHash: string | null;
  readonly knowledge: LegacyImportKnowledge | null;
  readonly knowledgeOmission: LegacyKnowledgeOmissionReport | null;
  // The chain identity the library carries after the apply; null when it stays unclassified.
  readonly chainIdentity: ChainIdentity | null;
}

/** What setup --mode migrate did (the SETUP_APPLIED receipt's migration field). */
export interface MigrationApplied {
  readonly partitions: readonly MigrationPartitionApplied[];
  // Each partition's registry entry as it stands after the apply, migratedFrom included.
  readonly registry: readonly RegistryEntry[];
  // The portal keys, with what this device held before the apply and what the apply did.
  readonly deviceSettings: MigrationDeviceSettings;
}

export interface MigrationApplyInput {
  // The confirmed plan's migration: the apply follows it, and reads each file again first.
  readonly migration: MigrationPlan;
  readonly deviceHome: string;
  // The plan's instant, which the libraries and the registry entries are stamped with.
  readonly at: string;
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
    const { partition, legacyWorkspace, projectRoot, projectName, gitRemote, omitLegacyKnowledge, chainRole } = raw;
    if (!isHint(partition)) mappingInvalid(`partitions[${index}].partition must name the partition on one line`, at("partition"));
    if (!isAbsolutePath(legacyWorkspace)) mappingInvalid(`partitions[${index}].legacyWorkspace must be an absolute path`, at("legacyWorkspace"));
    if (!isAbsolutePath(projectRoot)) mappingInvalid(`partitions[${index}].projectRoot must be an absolute path`, at("projectRoot"));
    if (projectName !== undefined && !isHint(projectName)) mappingInvalid(`partitions[${index}].projectName must be one line of at most ${HINT_MAXIMUM_LENGTH} characters`, at("projectName"));
    if (gitRemote !== undefined && !isHint(gitRemote)) mappingInvalid(`partitions[${index}].gitRemote must be one line of at most ${HINT_MAXIMUM_LENGTH} characters`, at("gitRemote"));
    if (omitLegacyKnowledge !== undefined) {
      const field = legacyKnowledgeOmissionIssue(omitLegacyKnowledge);
      if (field !== null) mappingInvalid(`partitions[${index}].omitLegacyKnowledge must contain only a nonempty one-line reason`, at(field));
    }
    if (chainRole !== undefined && !CHAIN_ROLES.includes(chainRole as string)) mappingInvalid(`partitions[${index}].chainRole must be coordination or project`, at("chainRole"));
    partitions.push({
      partition,
      legacyWorkspace,
      projectRoot,
      ...(projectName === undefined ? {} : { projectName }),
      ...(gitRemote === undefined ? {} : { gitRemote }),
      ...(omitLegacyKnowledge === undefined ? {} : { omitLegacyKnowledge: { reason: (omitLegacyKnowledge as LegacyKnowledgeOmission).reason } }),
      ...(chainRole === undefined ? {} : { chainRole: chainRole as ChainIdentity["role"] }),
    });
  }
  // One coordination chain per mapping; project rows name the coordination of this same mapping.
  const coordinationRows = [...partitions.entries()].filter(([, entry]) => entry.chainRole === "coordination");
  if (coordinationRows.length > 1) {
    mappingInvalid(`partitions[${coordinationRows[1]![0]}].chainRole names a second coordination chain`, { file, entry: String(coordinationRows[1]![0]), field: "chainRole" });
  }
  const projectRow = partitions.findIndex((entry) => entry.chainRole === "project");
  if (projectRow >= 0 && coordinationRows.length === 0) {
    mappingInvalid(`partitions[${projectRow}].chainRole project needs the coordination partition in this mapping`, { file, entry: String(projectRow), field: "chainRole" });
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

/** The writes, backups and blockers of one plan, each listed once. */
class MigrationRecorder {
  readonly writes: SetupWrite[] = [];
  readonly backups: { readonly step: SetupStep; readonly path: string }[] = [];
  readonly blockers: SetupBlocker[] = [];

  write(step: SetupStep, path: string, action: SetupWriteAction): void {
    if (!this.writes.some((entry) => entry.path === path)) this.writes.push({ step, path, action });
  }

  backup(step: SetupStep, path: string): void {
    if (!this.backups.some((entry) => entry.path === path)) this.backups.push({ step, path });
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

/** The old chain a partition carries: the old workspace id, its stream, and its events and head. */
interface LegacyChainFacts {
  readonly workspaceId: string;
  readonly streamId: string;
  readonly events: number;
  readonly headEventHash: string | null;
}

// Whether `target` is the library an import of this chain created (TCRN-CROSS-SUB-365): its id is
// the old workspace id and one of its streams is the old stream, imported as it was (the legacy
// identity scheme), carrying the old chain up to the old head, whatever this device has appended
// since. A library with that id whose stream does not is diverged; anything else is some other
// content of the directory.
async function migratedLibraryState(target: string, chain: LegacyChainFacts): Promise<"migrated" | "diverged" | "other"> {
  if (!(await hasLibraryManifest(target))) return "other";
  const library = await openLibrary(target);
  if (library.manifest.libraryId !== chain.workspaceId) return "other";
  const stream = (await readAllStreams(library.root)).streams
    .find((entry) => entry.manifest?.streamId === chain.streamId && entry.manifest.identityScheme === "legacy");
  if (stream === undefined) return "diverged";
  if (chain.events === 0) return "migrated";
  return stream.events.length >= chain.events && stream.events[chain.events - 1]?.eventHash === chain.headEventHash ? "migrated" : "diverged";
}

function divergedMessage(target: string, name: string, chain: LegacyChainFacts): string {
  return `${target} holds the library ${chain.workspaceId}, the id of partition ${name}'s old workspace, but not its chain of ${chain.events} events up to ${chain.headEventHash ?? "no head"}: the library and the old workspace have diverged`;
}

interface PlannedDryRun {
  readonly report: LegacyImportReport | null;
  // The old knowledge store refused the dry run, after the chain was validated.
  readonly knowledgeRefused: boolean;
}

// The import's dry run of a partition: its report, or null and a blocker. TCRN-CROSS-SUB-421 R18: a
// refusal of the old knowledge store (LegacyKnowledgeRefusedError) is a blocker on the file of the
// store it names, the store's root when it is about the store as a whole.
async function dryRunImport(recorder: MigrationRecorder, legacyWorkspace: string, target: string, at: string, omission?: LegacyKnowledgeOmission): Promise<PlannedDryRun> {
  try {
    return { report: await importLegacyWorkspace(legacyWorkspace, target, {
      createdAt: at, dryRun: true, ...(omission === undefined ? {} : { omitLegacyKnowledge: omission }),
    }), knowledgeRefused: false };
  } catch (error) {
    if (error instanceof LegacyKnowledgeRefusedError) {
      recorder.block("library", error.file === "." ? error.store : join(error.store, ...error.file.split("/")), error.reasonCode, error.message);
      return { report: null, knowledgeRefused: true };
    }
    const reasonCode = reasonOf(error);
    if (reasonCode === null) throw error;
    recorder.block("library", legacyWorkspace, reasonCode, messageOf(error));
    return { report: null, knowledgeRefused: false };
  }
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
  let state = await targetState(target);
  const importable = state === "absent" || state === "empty";

  // The old chain. Where the import could create the library, its dry run validates the chain from
  // genesis and reports its events and head, and a replay of the same chain must reach the same
  // head before its gates and work are listed. Where the import would refuse the target, the
  // replay alone (which validates the chain from genesis too) says what the chain is.
  // TCRN-CROSS-SUB-421 R18: a dry run refused by the old knowledge store validated the chain before
  // it read the store, so the replay still says what the chain is, its gates and its open work; the
  // store's refusal is a blocker of its own, on the file of the store it names.
  const legacyWorkspace = await realOrGiven(entry.legacyWorkspace);
  const dryRun = importable || entry.omitLegacyKnowledge !== undefined
    ? await dryRunImport(recorder, legacyWorkspace, target, input.at, entry.omitLegacyKnowledge)
    : null;
  const report = dryRun?.report ?? null;
  const replayed = importable && report === null && dryRun?.knowledgeRefused !== true
    ? null
    : await recorder.attempt("library", legacyWorkspace, async () => replayLegacyWorkspace(await openLegacyWorkspace(legacyWorkspace)));
  if (report !== null && replayed !== null && (replayed.version !== report.events || replayed.headEventHash !== report.headEventHash)) {
    recorder.block("library", legacyWorkspace, "LEGACY_IMPORT_MISMATCH",
      `the old workspace of partition ${name} changed while it was planned (${report.events} events, then ${replayed.version}): plan again once nothing writes to it`);
  }
  const chain: LegacyChainFacts | null = report !== null
    ? { workspaceId: report.workspaceId, streamId: report.streamId, events: report.events, headEventHash: report.headEventHash }
    : replayed === null
      ? null
      : { workspaceId: replayed.metadata.workspaceId, streamId: legacyWorkspaceStreamId(replayed.metadata), events: replayed.version, headEventHash: replayed.headEventHash };

  // A target that is not empty is refused, unless it is this chain's library from an earlier run.
  if (state === "not-empty" && chain !== null) {
    const found = await recorder.attempt("library", target, () => migratedLibraryState(target, chain));
    if (found === "migrated") state = "migrated";
    if (found === "diverged") recorder.block("library", target, "LEGACY_IMPORT_MISMATCH", divergedMessage(target, name, chain));
  }
  if (state === "migrated" && entry.omitLegacyKnowledge !== undefined &&
      await entryKind(join(target, DIRECTORY.knowledge, "metadata")) !== null) {
    recorder.block("library", join(target, DIRECTORY.knowledge), "LEGACY_IMPORT_MISMATCH",
      `partition ${name} already carries old knowledge in ${target}; an omission declaration cannot remove files from an existing library`);
  }
  if (state === "not-empty" && !recorder.blockers.slice(blockersBefore).some((blocker) => blocker.path === target)) {
    recorder.block("library", target, "LIBRARY_TARGET_NOT_EMPTY", `${target} is not empty: partition ${name} is imported into a new or empty directory`);
  } else if (state === "not-a-directory") {
    recorder.block("library", target, "LIBRARY_TARGET_INVALID", `${target} is not a directory: partition ${name} is imported into a new or empty directory`);
  }

  // This device's registry: a project registered to another library keeps it until the user moves it.
  const registered = registry?.entries.find((candidate) => candidate.projectPath === projectRoot) ?? null;
  if (registered !== null && registered.libraryPath !== target) {
    recorder.block("registry", target, "SETUP_LIBRARY_CONFLICT",
      `the project ${projectRoot} is registered to the library at ${registered.libraryPath}, not to ${target}, which partition ${name} becomes`);
  }

  const remote = entry.gitRemote ?? (projectKind === "directory" ? gitRemoteOf(projectRoot) : null);
  const gitRemote = remote === null ? null : hintOrNull(normalizeGitRemote(remote));
  const workspaceId = chain?.workspaceId ?? null;
  const partition: MigrationPartitionPlan = {
    partition: name,
    legacyWorkspace,
    projectRoot,
    target,
    targetState: state,
    action: recorder.blockers.length > blockersBefore ? "blocked" : state === "migrated" ? "skip" : "import",
    workspaceId,
    streamId: chain?.streamId ?? null,
    events: chain?.events ?? null,
    headEventHash: chain?.headEventHash ?? null,
    projectName: entry.projectName ?? hintOrNull(basename(projectRoot)),
    gitRemote,
    language: replayed === null ? null : libraryLanguage(replayed),
    unsatisfiedGates: replayed === null ? null : unsatisfiedGates(replayed),
    openItems: replayed === null ? null : openItems(replayed),
    knowledge: report?.knowledge ?? null,
    knowledgeOmission: report?.knowledgeOmission ?? null,
    chainIdentity: null,
  };
  // The cloud flag: --cloud; else what this device's registry holds for the project and this
  // library, so running the plan again keeps it; else the cloud folder table's suggestion.
  const cloudHosted = input.cloud ??
    (registered !== null && registered.libraryPath === target ? registered.cloudHosted : suggestCloudHosted(target, { platform: process.platform, env: process.env, home: input.home }));
  return {
    partition,
    registry: {
      partition: name,
      projectPath: projectRoot,
      libraryPath: target,
      libraryId: workspaceId,
      cloudHosted,
      gitRemote,
      migratedFrom: legacyWorkspace,
    },
  };
}

// Whether the registry already holds the entry a partition gets, so the apply leaves it as it is.
// With the partition's chain role, the entry must also record that role (registry.ts records it from
// the library's identity when the entry is written), so an entry written before the identity is
// written again.
function registryEntryCurrent(registry: Registry | null, planned: MigrationRegistryEntry, role: ChainIdentity["role"] | null = null): boolean {
  const entry = registry?.entries.find((candidate) => candidate.projectPath === planned.projectPath);
  return entry !== undefined && entry.libraryPath === planned.libraryPath && entry.libraryId === planned.libraryId &&
    entry.cloudHosted === planned.cloudHosted && entry.gitRemote === planned.gitRemote && entry.migratedFrom === planned.migratedFrom &&
    (role === null || entry.chainRole === role);
}

// The role the plan gives the partition named `name`; null while it stays unclassified.
function plannedRole(partitions: readonly MigrationPartitionPlan[], name: string): ChainIdentity["role"] | null {
  return partitions.find((partition) => partition.partition === name)?.chainIdentity?.role ?? null;
}

// INIT-053 U08: each partition's chain identity, from the mapping's explicit chainRole alone. A
// coordination row names its own library; a project row names the coordination row's library. A
// partition migrated before is read for the identity it carries: none is written by the apply,
// the same is left, another stops the plan. Answers the partitions with their identities.
async function plannedChainIdentities(recorder: MigrationRecorder, entries: readonly MigrationMappingEntry[], planned: readonly MigrationPartitionPlan[]): Promise<MigrationPartitionPlan[]> {
  const coordinationIndex = entries.findIndex((entry) => entry.chainRole === "coordination");
  const coordinationId = coordinationIndex >= 0 ? planned[coordinationIndex]?.workspaceId ?? null : null;
  const partitions: MigrationPartitionPlan[] = [];
  for (const [index, partition] of planned.entries()) {
    const role = entries[index]?.chainRole;
    const identity: ChainIdentity | null = role === undefined || coordinationId === null || partition.workspaceId === null
      ? null
      : role === "coordination" ? { role, coordinationLibraryId: partition.workspaceId } : { role, coordinationLibraryId: coordinationId };
    const conflict = (message: string): void => {
      recorder.block("library", partition.target, "SETUP_LIBRARY_CONFLICT", message);
    };
    if (identity !== null && identity.role === "project" && partition.workspaceId === coordinationId) {
      conflict(`partition ${partition.partition} carries the library id ${coordinationId} of the coordination partition; a project chain cannot be its own coordination`);
      partitions.push({ ...partition, action: "blocked", chainIdentity: identity });
      continue;
    }
    if (identity !== null && partition.action === "skip") {
      const held = await recorder.attempt("library", partition.target, async () => ({ identity: chainIdentity(await materializeWorkspaceFromGenesis(partition.target)) }));
      if (held === null) {
        partitions.push({ ...partition, action: "blocked", chainIdentity: identity });
        continue;
      }
      if (held.identity !== null && (held.identity.role !== identity.role || held.identity.coordinationLibraryId !== identity.coordinationLibraryId)) {
        conflict(`${partition.target} already declares the ${held.identity.role} identity naming ${held.identity.coordinationLibraryId}; a chain role changes only through chain-declare`);
        partitions.push({ ...partition, action: "blocked", chainIdentity: identity });
        continue;
      }
    }
    partitions.push({ ...partition, chainIdentity: identity });
  }
  return partitions;
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
  const identified = await plannedChainIdentities(recorder, input.mapping?.partitions ?? [], partitions);
  for (const partition of identified) {
    if (partition.action === "import") recorder.write("library", partition.target, "create");
    else if (partition.action === "skip" && partition.chainIdentity !== null && await libraryLacksIdentity(partition.target)) recorder.write("library", partition.target, "update");
  }
  partitions.splice(0, partitions.length, ...identified);
  // The registry is written when an entry is missing or differs; an existing file is copied first.
  if (registryEntries.some((planned) => !registryEntryCurrent(registry, planned, plannedRole(partitions, planned.partition)))) {
    const exists = await entryKind(registryFile) !== null;
    recorder.write("registry", registryFile, exists ? "update" : "create");
    if (exists) recorder.backup("registry", registryFile);
  }
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
    backups: recorder.backups,
    blockers: recorder.blockers,
  };
}

// ---- The apply ----

function applyFail(reasonCode: "LEGACY_IMPORT_MISMATCH", message: string, partition: MigrationPartitionPlan): never {
  throw new LegacyImportError(reasonCode, message, {
    partition: partition.partition,
    legacyWorkspace: partition.legacyWorkspace,
    target: partition.target,
  });
}

// An import that stops says which partition it was importing: the refusal keeps its own reason
// code and details, and its message and a partition field name the partition.
function namingPartition(error: unknown, partition: MigrationPartitionPlan): unknown {
  if (error instanceof Error && typeof (error as { reasonCode?: unknown }).reasonCode === "string") {
    error.message = `partition ${partition.partition}: ${error.message}`;
    Object.assign(error, { partition: partition.partition });
  }
  return error;
}

function plannedChain(partition: MigrationPartitionPlan): LegacyChainFacts {
  if (partition.workspaceId === null || partition.streamId === null || partition.events === null) {
    return setupFail("SETUP_INPUT_INVALID", `the plan does not say what partition ${partition.partition}'s old chain is`, { field: "plan" });
  }
  return { workspaceId: partition.workspaceId, streamId: partition.streamId, events: partition.events, headEventHash: partition.headEventHash };
}

// Whether the library at `target` declares no chain identity yet (read without writing).
async function libraryLacksIdentity(target: string): Promise<boolean> {
  return chainIdentity(await materializeWorkspaceFromGenesis(target)) === null;
}

// INIT-053 U08: the identity the plan gave the partition, written once the import is checked and
// signed by the setup actor (an imported chain that enabled attestation requires one). A library
// migrated before gets it when it has none; one holding another identity stops the apply.
async function applyChainIdentity(recorder: SetupRecorder, partition: MigrationPartitionPlan, at: string, imported: boolean): Promise<ChainIdentity | null> {
  if (partition.chainIdentity === null) return null;
  const current = chainIdentity(await materializeWorkspaceFromGenesis(partition.target));
  if (current !== null) {
    if (current.role !== partition.chainIdentity.role || current.coordinationLibraryId !== partition.chainIdentity.coordinationLibraryId) {
      setupFail("SETUP_LIBRARY_CONFLICT", `${partition.target} declares another chain identity than partition ${partition.partition}'s plan; a chain role changes only through chain-declare`, { library: partition.target, partition: partition.partition });
    }
    return current;
  }
  await declareChainIdentity(partition.target, partition.chainIdentity, { occurredAt: at, actorId: SETUP_ACTOR });
  recorder.write("library", partition.target, imported ? "create" : "update");
  return partition.chainIdentity;
}

// One partition's library, in the plan's order: imported, with the events and head it carries
// compared with the plan's, or, planned as skipped, found holding the same chain again.
async function applyPartition(recorder: SetupRecorder, partition: MigrationPartitionPlan, at: string): Promise<MigrationPartitionApplied> {
  if (partition.action === "blocked") {
    return setupFail("SETUP_BLOCKED", `partition ${partition.partition} cannot be migrated as planned`, { field: "plan", partition: partition.partition });
  }
  const chain = plannedChain(partition);
  const applied = {
    partition: partition.partition,
    legacyWorkspace: partition.legacyWorkspace,
    projectRoot: partition.projectRoot,
    target: partition.target,
    libraryId: chain.workspaceId,
  };
  if (partition.action === "skip") {
    const found = await migratedLibraryState(partition.target, chain);
    if (found !== "migrated") {
      applyFail("LEGACY_IMPORT_MISMATCH", `partition ${partition.partition}: ${partition.target} no longer holds the library the plan found migrated; plan again`, partition);
    }
    return { ...applied, action: "skipped", events: chain.events, headEventHash: chain.headEventHash,
      knowledge: partition.knowledge, knowledgeOmission: partition.knowledgeOmission,
      chainIdentity: await applyChainIdentity(recorder, partition, at, false) };
  }
  let report: Awaited<ReturnType<typeof importLegacyWorkspace>>;
  try {
    report = await importLegacyWorkspace(partition.legacyWorkspace, partition.target, {
      createdAt: at,
      projectName: partition.projectName,
      gitRemote: partition.gitRemote,
      ...(partition.knowledgeOmission === null ? {} : { omitLegacyKnowledge: { reason: partition.knowledgeOmission.reason } }),
    });
  } catch (error) {
    throw namingPartition(error, partition);
  }
  recorder.write("library", report.target ?? partition.target, "create");
  if (report.workspaceId !== chain.workspaceId || report.streamId !== chain.streamId || report.events !== chain.events || report.headEventHash !== chain.headEventHash) {
    applyFail("LEGACY_IMPORT_MISMATCH",
      `partition ${partition.partition}: the old workspace was imported with ${report.events} events up to ${report.headEventHash ?? "no head"}, not the ${chain.events} up to ${chain.headEventHash ?? "no head"} the plan read; the library at ${partition.target} holds the chain as it was imported, and the apply stopped before the registry: plan again once nothing writes to the old workspace`,
      partition);
  }
  return { ...applied, action: "imported", events: report.events, headEventHash: report.headEventHash,
    knowledge: report.knowledge, knowledgeOmission: report.knowledgeOmission,
    chainIdentity: await applyChainIdentity(recorder, partition, at, true) };
}

// The registry entries, each written only when it is missing or differs; an existing registry is
// copied into this run's backups before the first write.
async function applyRegistryEntries(recorder: SetupRecorder, input: MigrationApplyInput, planned: readonly MigrationRegistryEntry[]): Promise<readonly RegistryEntry[]> {
  const registryFile = registryPath(input.deviceHome);
  const existed = await entryKind(registryFile) !== null;
  let registry = await readRegistry(input.deviceHome);
  const written: RegistryEntry[] = [];
  let backedUp = false;
  for (const entry of planned) {
    if (!registryEntryCurrent(registry, entry, plannedRole(input.migration.partitions, entry.partition))) {
      if (existed && !backedUp) {
        const copy = join(recorder.backupDirectory("registry"), basename(registryFile));
        if (await entryKind(copy) === null) {
          await ensureDeviceDirectory(recorder.backupDirectory("registry"));
          await writeFileAtomic(copy, await readFile(registryFile));
        }
        recorder.backup("registry", registryFile);
        backedUp = true;
      }
      await registerLibrary({
        projectPath: entry.projectPath,
        libraryPath: entry.libraryPath,
        registeredAt: input.at,
        cloudHosted: entry.cloudHosted,
        gitRemote: entry.gitRemote,
        migratedFrom: entry.migratedFrom,
      }, input.deviceHome);
      recorder.write("registry", registryFile, existed ? "update" : "create");
      registry = await readRegistry(input.deviceHome);
    }
    const current = registry.entries.find((candidate) => candidate.projectPath === entry.projectPath);
    if (current !== undefined) written.push(current);
  }
  return written;
}

// The portal keys the plan sets, each set only while this device still holds none for it.
async function applyDeviceSettings(recorder: SetupRecorder, input: MigrationApplyInput): Promise<MigrationDeviceSettings> {
  const { deviceSettings } = input.migration;
  if (deviceSettings.keys.length === 0) return deviceSettings;
  const held = await readMachineSettings(deviceSettings.to);
  const existed = await entryKind(deviceSettings.to) !== null;
  const keys: MigrationDeviceSetting[] = [];
  for (const setting of deviceSettings.keys) {
    const current = held.values[setting.key] ?? null;
    if (setting.action === "invalid") {
      keys.push({ ...setting, current });
      continue;
    }
    if (current !== null) {
      keys.push({ ...setting, current, action: current === setting.value ? "unchanged" : "kept" });
      continue;
    }
    await applyMachineSettingSet({ key: setting.key, value: setting.value, occurredAt: input.at, path: deviceSettings.to });
    recorder.write("machine-settings", deviceSettings.to, existed ? "update" : "create");
    keys.push({ ...setting, current, action: "set" });
  }
  return { from: deviceSettings.from, to: deviceSettings.to, keys };
}

/**
 * Apply a confirmed migration plan (TCRN-CROSS-STORY-489 R1, R2, R4; TCRN-CROSS-SUB-365), after the
 * device step: each partition's library in the plan's order (imported and compared with the plan,
 * or skipped as migrated already; a difference stops the apply and names the partition), then the
 * registry entries with migratedFrom, then the portal keys this device does not hold yet. Every
 * file is read again before it is written, so applying the same mapping again writes nothing. No
 * old workspace is written, and no gate is satisfied.
 */
export async function applyMigration(recorder: SetupRecorder, input: MigrationApplyInput): Promise<MigrationApplied> {
  const partitions: MigrationPartitionApplied[] = [];
  for (const partition of input.migration.partitions) partitions.push(await applyPartition(recorder, partition, input.at));
  const registry = await applyRegistryEntries(recorder, input, input.migration.registry);
  const deviceSettings = await applyDeviceSettings(recorder, input);
  return { partitions, registry, deviceSettings };
}

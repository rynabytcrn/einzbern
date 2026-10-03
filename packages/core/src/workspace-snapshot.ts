import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  assertCanonicalJson,
  canonicalJson,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { WORKSPACE_CONTROL_DIRECTORY, WORKSPACE_SEGMENT_BYTES_MAX, validateWorkspace, withWorkspaceWriteLock } from "./workspace.js";
import { DIRECTORY, WORKSPACE_WRITE_LOCK_FILE } from "./names.js";
import { knowledgeStorePath, validateKnowledgeStore } from "./knowledge-core.js";
import { AKASHA_SEGMENT_BYTES_MAXIMUM } from "./akasha.js";
import { hasLibraryManifest } from "./ether-library.js";
import { SEGMENTED_BODY_FILE_LIMIT } from "./store-backend.js";

// WSF-2: the read-only snapshot witness. It computes a deterministic manifest over
// the workspace control tree so a copy can be proved byte-identical after restore,
// and it never mutates the workspace it inspects. The buildable half of ADR 0002's
// hybrid make-vs-teach verdict — the copy itself is taught (OS tools), only the
// manifest and its verification are made.
export const SNAPSHOT_MANIFEST_SCHEMA_VERSION = "tcrn.workspace-snapshot-manifest.v1" as const;
export const SNAPSHOT_VERIFY_SCHEMA_VERSION = "tcrn.workspace-snapshot-verify.v1" as const;

// New frozen reason-code list, sorted, owned by this module. WORKSPACE_REASON_CODES
// is not edited (protocol-sensitivity: the witness is additive).
export const SNAPSHOT_REASON_CODES = Object.freeze([
  "SNAPSHOT_INPUT_INVALID",
  "SNAPSHOT_MANIFEST_INVALID",
  "SNAPSHOT_MISMATCH",
  "SNAPSHOT_PATH_INVALID",
  "SNAPSHOT_RESIDUE_PRESENT",
  "SNAPSHOT_VERIFIED",
] as const);

export type SnapshotReasonCode = typeof SNAPSHOT_REASON_CODES[number];

export class SnapshotError extends Error {
  readonly reasonCode: SnapshotReasonCode;

  constructor(reasonCode: SnapshotReasonCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.reasonCode = reasonCode;
  }
}

export interface SnapshotFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function fail(reasonCode: SnapshotReasonCode, message: string): never {
  throw new SnapshotError(reasonCode, message);
}

// The parameter admits undefined because a field read off a JSON object is
// `JsonValue | undefined` -- an absent field is not an object, which is exactly
// what the existing `typeof value === "object"` test already reports.
function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// SDC-9 control-tree residue taxonomy. Exact relative paths under the control root
// that a live, leased workspace legitimately carries but that are NOT part of the
// backup content: the held lease directory, the lease-recovery claim, and the
// knowledge/artifact in-flight mutation claims. Excluding them keeps the manifest
// stable across the claim churn of normal operation.
const EXCLUDED_RELATIVE_PATHS = Object.freeze([
  // TCRN-CROSS-STORY-467: the engine write lock, held while the manifest is computed.
  WORKSPACE_WRITE_LOCK_FILE,
  "lease",
  "lease-recovery.claim",
  "knowledge/mutation.claim",
  "artifacts/restore.claim",
]);

// WSR-1: the manifest is blind in BOTH directions, and the relocation verbs have to
// assert on exactly the blindness this module defines. The list is EXPORTED rather
// than restated over there: a second copy would drift, and the drift would be
// silent in the one place a silent drift is most expensive.
//
//   * blind to a MISSING empty directory — walkControlTree collects files only, so
//     a copy that dropped an empty backups/ still verifies clean (T8);
//   * blind to an EXTRA lock or claim file — the four paths above are skipped, so a
//     copy that carried the source's held lease also verifies clean (T9).
//
// Neither blindness is a bug; both are the manifest doing what it was scoped to do.
export const CONTROL_TREE_TRANSPORT_RESIDUE_PATHS: readonly string[] = EXCLUDED_RELATIVE_PATHS;

// The directories initializeWorkspace creates and every live control tree must
// still have. The manifest structurally cannot see them when they are empty.
export const CONTROL_TREE_SKELETON_DIRECTORIES: readonly string[] = Object.freeze([
  "events",
  "views",
  "backups",
]);

// Crashed-session quarantine residue. reclaimObservedLease/release can leave these
// behind between a rename and its removal, and the engine never cleans control-root
// quarantines (recover only removes .tmp- files under events/ and views/). A backup
// over such residue would bake partial state into the receipt, so the witness fails
// closed: the runbook says remove the quarantine manually, then re-snapshot. The
// prefix set covers stale-lease-*, released-*/released-lease-*/released-recovery-*/
// released-restore-* (workspace, knowledge, artifact release quarantines), and the
// attempt-owned-* test quarantine. released-mutation-* lives INSIDE lease/, which is
// excluded whole, so it is never reached.
const RESIDUE_PREFIX = /^(?:stale-lease-|released-|attempt-owned-)/u;

// Atomic-write temporaries. atomicWrite stages under .tmp-<pid>-<seq> and renames
// into place, so a live snapshot can momentarily observe one; it is never content.
const TEMPORARY_PREFIX = ".tmp-";

// TCRN-CROSS-STORY-354 (round 2): matches SegmentedBackend.readSegment's own name
// filter (segmented-backend.ts) so the two places that read events/NNNNNN.ndjson
// agree on which files are event segments. A segment legitimately grows up to its
// configured segmentEventLimit (16 MiB was that engine's default) before rotating, so it is read
// under WORKSPACE_SEGMENT_BYTES_MAX below rather than the generic per-control-file
// ceiling every other file in the tree still uses.
const EVENT_SEGMENT_NAME_PATTERN = /^\d{6,}\.ndjson$/u;

// TCRN-CROSS-STORY-469: in a library the witness covers the whole library tree. Its event
// segments are the files in each akasha/<device>/ directory, and the knowledge mutation claim
// is the one piece of transport residue that can sit inside it (the write lock lives in the
// device directory, never in the library).
//
// The rules are built when a walk starts, not when this module loads: workspace.js and
// akasha.js import this module back, so their constants are not yet initialised while it
// evaluates on that path.
interface TreeRules {
  readonly excluded: readonly string[];
  readonly readLimit: (relativePath: string) => { readonly maximumBytes: number; readonly expectedBytes?: number };
}

function controlTreeRules(): TreeRules {
  return {
    excluded: EXCLUDED_RELATIVE_PATHS,
    readLimit: (relativePath) => ({ maximumBytes: relativePath.startsWith("events/") && EVENT_SEGMENT_NAME_PATTERN.test(relativePath.slice("events/".length))
      ? WORKSPACE_SEGMENT_BYTES_MAX : PROTOCOL_LIMITS.maxCanonicalBytes }),
  };
}

async function libraryTreeRules(root: string, invalidManifest: SnapshotReasonCode = "SNAPSHOT_PATH_INVALID"): Promise<TreeRules> {
  const segment = new RegExp(`^${DIRECTORY.events}/[a-f0-9]{32}/[0-9a-f]{8}\\.(?:ndjson|json)$`, "u");
  const bodyBase = `${DIRECTORY.knowledge}/bodies/`;
  const manifestPath = `${bodyBase}manifest.json`;
  const bodySegments = new Map<string, number>();
  // The metadata/body backend reads only the exact segments its bounded manifest declares.
  // Reuse its existing dynamic limit; a filename alone never admits a larger read.
  if (await fileExists(resolve(root, manifestPath))) {
    let manifest: JsonValue;
    try {
      manifest = assertCanonicalJson((await boundReadFileBytes(resolve(root, manifestPath), RUNTIME_CAPACITY.bufferBytes)).toString("utf8"));
    } catch (error) {
      if (error instanceof ProtocolError) fail(invalidManifest, manifestPath);
      throw error;
    }
    if (!isJsonObject(manifest) || manifest.schemaVersion !== "tcrn.knowledge-body-manifest.v1" || !Array.isArray(manifest.segments) ||
      typeof manifest.count !== "number" || !Number.isSafeInteger(manifest.count) || manifest.count < 0 ||
      typeof manifest.indexDigest !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.indexDigest)) fail(invalidManifest, manifestPath);
    for (const entry of manifest.segments) {
      if (!isJsonObject(entry) || typeof entry.name !== "string" || !/^\d{6,}\.ndjson$/u.test(entry.name) ||
        typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
        typeof entry.records !== "number" || !Number.isSafeInteger(entry.records) ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail(invalidManifest, manifestPath);
      bodySegments.set(`${bodyBase}${entry.name}`, entry.bytes);
    }
  }
  return {
    excluded: [`${DIRECTORY.knowledge}/mutation.claim`],
    readLimit: (relativePath) => {
      if (segment.test(relativePath)) return { maximumBytes: AKASHA_SEGMENT_BYTES_MAXIMUM };
      const expectedBytes = bodySegments.get(relativePath);
      if (expectedBytes !== undefined) return { maximumBytes: Math.max(SEGMENTED_BODY_FILE_LIMIT, expectedBytes), expectedBytes };
      return { maximumBytes: relativePath === manifestPath ? RUNTIME_CAPACITY.bufferBytes : PROTOCOL_LIMITS.maxCanonicalBytes };
    },
  };
}

// Minimal bound-read helpers, re-implemented locally per the duplicate-machinery
// discipline (ADR-precedent: adapters duplicate rather than export workspace
// internals). These mirror boundDirectory/boundFile semantics — symlink rejection,
// single-link (nlink === 1) enforcement, and double-stat identity checks — without
// importing workspace.ts private helpers.
async function boundReadDirectory(path: string): Promise<string> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("SNAPSHOT_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    fail("SNAPSHOT_PATH_INVALID", `${path} must be a real directory`);
  }
  const resolved = await realpath(path);
  const after = await lstat(resolved);
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    fail("SNAPSHOT_PATH_INVALID", `${path} changed while resolving`);
  }
  return resolved;
}

async function boundReadFileBytes(path: string, maximumBytes: number = PROTOCOL_LIMITS.maxCanonicalBytes): Promise<Buffer> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("SNAPSHOT_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail("SNAPSHOT_PATH_INVALID", `${path} must be a single-link regular file`);
  }
  if (before.size > maximumBytes) {
    fail("SNAPSHOT_PATH_INVALID", `${path} exceeds the snapshot read limit`);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("SNAPSHOT_PATH_INVALID", "O_NOFOLLOW is unavailable");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("SNAPSHOT_PATH_INVALID", `${path} changed while opening`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || content.length > maximumBytes) {
      fail("SNAPSHOT_PATH_INVALID", `${path} changed while reading`);
    }
    return content;
  } finally {
    await handle?.close();
  }
}

// Public bounded reader for the manifest receipt file, so the CLI verb can read a
// saved manifest under the same governed read discipline (no plain readFile, no
// symlink follow) before handing the text to verifySnapshotManifest.
export async function readSnapshotManifestFile(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "manifest path");
  }
  const content = await boundReadFileBytes(path);
  return content.toString("utf8");
}

// WSR-1: the same governed read for the destination-side relocation-inspect document
// an abort may present. Separate export rather than a second parameter on the
// manifest reader, so the refusal names what the operator actually passed.
export async function readGovernedDocumentFile(path: string, label: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", label);
  }
  const content = await boundReadFileBytes(path, RUNTIME_CAPACITY.bufferBytes);
  return content.toString("utf8");
}

// Deterministic walk of the control tree under `controlRoot`, applying the SDC-9
// exclusions and failing closed on residue. Returns files sorted by posix relative
// path in utf8-byte order so two runs on an unchanged tree are byte-identical.
async function walkControlTree(controlRoot: string, rules: TreeRules = controlTreeRules()): Promise<readonly SnapshotFileEntry[]> {
  const collected: SnapshotFileEntry[] = [];
  const walk = async (directory: string, relativeBase: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const relativePath = relativeBase === "" ? name : `${relativeBase}/${name}`;
      const full = resolve(directory, name);
      if (name.startsWith(TEMPORARY_PREFIX)) {
        continue;
      }
      if (rules.excluded.includes(relativePath)) {
        continue;
      }
      if (RESIDUE_PREFIX.test(name)) {
        fail("SNAPSHOT_RESIDUE_PRESENT", relativePath);
      }
      const metadata = await lstat(full);
      if (metadata.isSymbolicLink()) {
        fail("SNAPSHOT_PATH_INVALID", `${relativePath} is a symbolic link`);
      }
      if (metadata.isDirectory()) {
        await walk(full, relativePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("SNAPSHOT_PATH_INVALID", `${relativePath} must be a single-link regular file`);
      }
      const limit = rules.readLimit(relativePath);
      const content = await boundReadFileBytes(full, limit.maximumBytes);
      if (limit.expectedBytes !== undefined && content.length !== limit.expectedBytes) {
        fail("SNAPSHOT_MISMATCH", relativePath);
      }
      collected.push({
        path: relativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    }
  };
  await walk(controlRoot, "");
  return [...collected].sort((left, right) => compareCanonicalText(left.path, right.path));
}

/**
 * Every file of a library tree with its SHA-256 and size, under the witness's rules: temporaries
 * skipped, an in-flight knowledge claim left out, residue failing closed. A relocation compares
 * the source and the copy by it (TCRN-CROSS-STORY-470 R3).
 */
export async function libraryTreeDigests(root: string): Promise<readonly SnapshotFileEntry[]> {
  return walkControlTree(root, await libraryTreeRules(root));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Build a canonical snapshot manifest for a quiesced workspace. The engine write lock is
// the quiesce proof (only one writer can hold it), taken here for the whole computation. Emits sorted per-file sha256,
// the workspace headEventHash/version/workspaceId, and the embedded validate result
// for both stores. No Date.now, no randomness — determinism constraint 6.
export async function createSnapshotManifest(workspaceRootInput: string): Promise<string> {
  if (typeof workspaceRootInput !== "string" || workspaceRootInput.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "workspace root");
  }
  const root = await boundReadDirectory(workspaceRootInput);
  return withWorkspaceWriteLock(root, () => snapshotManifestHoldingLock(root));
}

async function snapshotManifestHoldingLock(root: string): Promise<string> {
  // INC-086 (superseded, TCRN-CROSS-STORY-354): the manifest walks the DISK
  // file tree (walkControlTree below), so validate here was pinned to the FILE
  // backend rather than the ambient factory, which served PG before STORY-189
  // retired it (50db3e2, TCRN-CROSS-INC-275). The backends left afterward both
  // read the same on-disk control tree, so the pin stopped guarding against a
  // stale mirror and instead broke every file-segmented workspace:
  // FileBackend.listSegmentNames does not filter the segmented backend's
  // per-segment .idx sidecars the way SegmentedBackend.listSegmentNames does,
  // so validateWorkspace's readSegmentEvents rejected them with
  // WORKSPACE_EVENT_CORRUPT: "unexpected event entry 000001.idx". Let
  // validateWorkspace pick its own backend via backendForStorage, keyed by
  // the workspace's actual storageVersion, instead of pinning one here.
  const state = await validateWorkspace(root);
  let knowledgeStatus: "valid" | "absent" = "absent";
  if (await fileExists(resolve(await knowledgeStorePath(root), "store.json"))) {
    await validateKnowledgeStore(root);
    knowledgeStatus = "valid";
  }
  // The write lock is only granted on a library, so this is the library tree.
  const files = await walkControlTree(root, await libraryTreeRules(root));
  return canonicalJson({
    schemaVersion: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    validate: { workspace: "valid", knowledge: knowledgeStatus },
    files,
  });
}

function assertManifestShape(value: JsonValue): asserts value is {
  readonly schemaVersion: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly headEventHash: string | null;
  readonly validate: Readonly<Record<string, JsonValue>>;
  readonly files: readonly JsonValue[];
} {
  if (!isJsonObject(value)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest must be an object");
  }
  if (value.schemaVersion !== SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
    fail("SNAPSHOT_MANIFEST_INVALID", "unexpected manifest schemaVersion");
  }
  if (typeof value.workspaceId !== "string" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
    !(value.headEventHash === null || typeof value.headEventHash === "string")) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest header fields are invalid");
  }
  if (!isJsonObject(value.validate)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest validate block is invalid");
  }
  if (!Array.isArray(value.files)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest files must be an array");
  }
}

function assertFileEntry(value: JsonValue): asserts value is { readonly path: string; readonly sha256: string; readonly bytes: number } {
  if (!isJsonObject(value)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry must be an object");
  }
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\\") || value.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry path is invalid");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry sha256 is invalid");
  }
  if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("SNAPSHOT_MANIFEST_INVALID", "file entry bytes is invalid");
  }
}

// Recompute the control tree under the root directory and prove it
// matches `manifestJson`. Read-only: no lease, no validate — the target is a copy,
// not a live workspace. Throws SNAPSHOT_MISMATCH naming the first differing path.
export async function verifySnapshotManifest(
  rootDirectoryInput: string,
  manifestJson: string,
  // WSR-1: additive, defaulted to empty, byte-neutral for every existing caller.
  // relocation-adopt re-runs the comparison on an ALREADY adopted tree, where
  // workspace.json is the one slot that legitimately differs from the manifest
  // taken before the move. Pre-commit it is byte-identical, so the exclusion only
  // matters on a retry.
  options: { readonly excludePaths?: readonly string[] } = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  if (typeof rootDirectoryInput !== "string" || rootDirectoryInput.length === 0) {
    fail("SNAPSHOT_INPUT_INVALID", "root directory");
  }
  const excluded = new Set(options.excludePaths ?? []);
  if (typeof manifestJson !== "string") {
    fail("SNAPSHOT_MANIFEST_INVALID", "manifest must be a string");
  }
  let manifest: JsonValue;
  try {
    manifest = assertCanonicalJson(manifestJson);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("SNAPSHOT_MANIFEST_INVALID", error.message);
    }
    throw error;
  }
  assertManifestShape(manifest);
  const expected: SnapshotFileEntry[] = [];
  for (const entry of manifest.files) {
    assertFileEntry(entry);
    if (excluded.has(entry.path)) continue;
    expected.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  expected.sort((left, right) => compareCanonicalText(left.path, right.path));
  const root = await boundReadDirectory(rootDirectoryInput);
  let actualTree: readonly SnapshotFileEntry[];
  if (await hasLibraryManifest(root)) {
    actualTree = await walkControlTree(root, await libraryTreeRules(root, "SNAPSHOT_MISMATCH"));
  } else {
    const controlRoot = resolve(root, WORKSPACE_CONTROL_DIRECTORY);
    if (!(await directoryExists(controlRoot))) {
      fail("SNAPSHOT_MISMATCH", WORKSPACE_CONTROL_DIRECTORY);
    }
    actualTree = await walkControlTree(controlRoot);
  }
  const actual = actualTree.filter((entry) => !excluded.has(entry.path));
  const bound = Math.max(expected.length, actual.length);
  for (let index = 0; index < bound; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left === undefined) {
      fail("SNAPSHOT_MISMATCH", right?.path ?? "extra entry");
    }
    if (right === undefined) {
      fail("SNAPSHOT_MISMATCH", left.path);
    }
    if (left.path !== right.path || left.sha256 !== right.sha256 || left.bytes !== right.bytes) {
      fail("SNAPSHOT_MISMATCH", compareCanonicalText(left.path, right.path) <= 0 ? left.path : right.path);
    }
  }
  return {
    schemaVersion: SNAPSHOT_VERIFY_SCHEMA_VERSION,
    reasonCode: "SNAPSHOT_VERIFIED",
    files: expected.length,
  };
}

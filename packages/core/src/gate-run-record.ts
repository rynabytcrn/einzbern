// SPDX-License-Identifier: Apache-2.0
// Shared cache receipt admission and ordering for the engine and Portal.
import { compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import type { GateRootTree, GateRun } from "./gates-run.js";

export const GATE_RUN_SCHEMA_VERSION = "einzbern.gate-run.v1" as const;

// A path a run recorded under a root: relative, with forward slashes, and no empty, . or .. segment.
function isRootPath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\u0000") && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// TCRN-CROSS-STORY-534: a root's state as einzbern.gate-tree.v3 records it. A root limited to the
// Story's files names them, each with its content digest, and no HEAD; any other root names its HEAD
// and the digest of its changes. A root of an older record that names its paths without their
// digests cannot be read again, so the record is not taken as a run.
function isGateRootTree(value: unknown): value is GateRootTree {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const tree = value as Readonly<Record<string, unknown>>;
  if (typeof tree.root !== "string") return false;
  if (tree.paths === undefined && tree.files === undefined) {
    return typeof tree.git === "boolean" && (tree.head === null || typeof tree.head === "string") && (tree.changes === null || typeof tree.changes === "string");
  }
  const paths = tree.paths;
  const files = tree.files;
  return tree.git === true && tree.head === undefined && tree.changes === undefined &&
    Array.isArray(paths) && paths.every(isRootPath) && Array.isArray(files) && files.length === paths.length &&
    files.every((file: unknown, index: number) => {
      if (file === null || typeof file !== "object" || Array.isArray(file)) return false;
      const entry = file as Readonly<Record<string, unknown>>;
      return entry.path === paths[index] && typeof entry.digest === "string";
    });
}

export function isGateRunRecord(value: unknown): value is GateRun {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const workIds = record.workIds;
  const gates = record.gates;
  const trees = record.trees;
  return record.schemaVersion === GATE_RUN_SCHEMA_VERSION && typeof record.runId === "string" && record.runId.isWellFormed() && typeof record.libraryId === "string" &&
    (record.baseByRoot === undefined || (record.baseByRoot !== null && typeof record.baseByRoot === "object" && !Array.isArray(record.baseByRoot) &&
      Object.values(record.baseByRoot).every((value) => typeof value === "string"))) &&
    // These fields decide which gates are due and are consumed by run readers.
    // A malformed release flag must never silently become a non-release run.
    typeof record.release === "boolean" && (record.base === null || typeof record.base === "string") &&
    Array.isArray(record.reds) && record.reds.every((name: unknown) => typeof name === "string") &&
    Array.isArray(trees) && trees.every(isGateRootTree) &&
    (record.projectId === undefined || (typeof record.projectId === "string" && /^project:[a-f0-9]{24}$/u.test(record.projectId))) &&
    typeof record.at === "string" && instant(record.at) !== null && typeof record.treeDigest === "string" && typeof record.declarationsDigest === "string" &&
    Array.isArray(workIds) && workIds.every((workId: unknown) => typeof workId === "string" && /^work:[0-9a-f]{24}$/u.test(workId)) &&
    Array.isArray(gates) && gates.every((gate: unknown) => {
      if (gate === null || typeof gate !== "object") return false;
      const result = gate as Readonly<Record<string, unknown>>;
      const matched = result.matched;
      const matchedWorkIds = result.matchedWorkIds;
      const timingAbsent = result.startedAt === undefined && result.finishedAt === undefined && result.durationMs === undefined;
      const timingValid = typeof result.startedAt === "string" && instant(result.startedAt) !== null &&
        typeof result.finishedAt === "string" && instant(result.finishedAt) !== null &&
        typeof result.durationMs === "number" && Number.isSafeInteger(result.durationMs) && result.durationMs >= 0;
      return (timingAbsent || timingValid) && typeof result.name === "string" && typeof result.ok === "boolean" && typeof result.required === "boolean" &&
        typeof result.root === "string" && (result.exitCode === null || (typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode))) &&
        (result.signal === null || typeof result.signal === "string") && typeof result.timedOut === "boolean" &&
        typeof result.outputFile === "string" && typeof result.outputBytes === "number" && Number.isSafeInteger(result.outputBytes) && result.outputBytes >= 0 &&
        typeof result.truncated === "boolean" &&
        Array.isArray(matched) && matched.every((path: unknown) => typeof path === "string") &&
        Array.isArray(matchedWorkIds) && matchedWorkIds.every((workId: unknown) => typeof workId === "string" && /^work:[0-9a-f]{24}$/u.test(workId));
    });
}

function instant(value: string): bigint | null {
  try {
    return parseStrictInstant(value);
  } catch {
    return null;
  }
}

/** Newest first, with the engine's canonical descending run-id tie break. */
export function compareGateRuns(left: GateRun, right: GateRun): number {
  const leftAt = parseStrictInstant(left.at);
  const rightAt = parseStrictInstant(right.at);
  return leftAt === rightAt ? compareCanonicalText(right.runId, left.runId) : leftAt > rightAt ? -1 : 1;
}

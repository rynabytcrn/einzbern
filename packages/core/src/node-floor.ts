// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-481 R4 (MIN-227): the oldest Node.js this engine runs on. It is the major
// version package.json engines.node names (engines.node pins the exact runtime the gates run on; a
// user needs only its release line or a later one). The CLI entry asks assertNodeFloor before the
// rest of the engine loads, so an older Node.js is told ENGINE_NODE_TOO_OLD with the version
// required and the version found, rather than failing somewhere inside the engine.
//
// This module imports nothing, so an entry can load it on its own before everything else.
// The stable hook launcher mirrors this floor because it must refuse an old runtime before it can
// import the versioned engine entry; its launcher test checks that the two values stay in sync.

export const NODE_FLOOR = "24.0.0" as const;

export const NODE_FLOOR_REASON_CODES = Object.freeze(["ENGINE_NODE_TOO_OLD"] as const);
export type NodeFloorReasonCode = typeof NODE_FLOOR_REASON_CODES[number];

export class NodeFloorError extends Error {
  readonly reasonCode: NodeFloorReasonCode;
  readonly details: Readonly<Record<"required" | "actual", string>>;

  constructor(required: string, actual: string) {
    super(`Node.js ${actual} is older than ${required}, the oldest this engine runs on: upgrade Node.js to ${required} or later`);
    this.name = "NodeFloorError";
    this.reasonCode = "ENGINE_NODE_TOO_OLD";
    this.details = Object.freeze({ required, actual });
  }
}

// major.minor.patch, with or without the leading v of process.version, and with whatever
// pre-release or build suffix follows; only the three numbers are compared.
const NODE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;

function versionNumbers(version: string): readonly number[] | null {
  const match = NODE_VERSION.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `actual`, a Node.js version such as process.versions.node, is NODE_FLOOR or later. */
export function meetsNodeFloor(actual: string): boolean {
  const found = versionNumbers(actual);
  const floor = versionNumbers(NODE_FLOOR);
  if (found === null || floor === null) return false;
  for (const [index, required] of floor.entries()) {
    const value = found[index] ?? 0;
    if (value !== required) return value > required;
  }
  return true;
}

/** Throws ENGINE_NODE_TOO_OLD, with details {required, actual}, unless `actual` meets NODE_FLOOR. */
export function assertNodeFloor(actual: string): void {
  if (!meetsNodeFloor(actual)) throw new NodeFloorError(NODE_FLOOR, String(actual));
}

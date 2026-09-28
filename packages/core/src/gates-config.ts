// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R1 (MIN-227 D4; TCRN-CROSS-SUB-343): gate declarations. A gate is a
// project-level configuration record of the gate collection (config-records.ts), keyed by its
// name, so every device that merges the library runs the same gates. It says what to run (an
// argv, never a shell line), in which directory of the project (its root, which the command
// runs in and whose Git changes select it), which paths under that root it covers (globs, see
// gates-plan.ts), whether it is required before a Story is done, whether it is enabled, and
// whether it runs only for a release. A gate is configuration, not a setting.

import { configRecords, removeConfigRecord, setConfigRecord } from "./config-records.js";
import { GatesPlanError, compileGlob } from "./gates-plan.js";
import type { WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const GATES_CONFIG_REASON_CODES = Object.freeze(["GATES_CONFIG_INVALID"] as const);

export type GatesConfigReasonCode = typeof GATES_CONFIG_REASON_CODES[number];

export class GatesConfigError extends Error {
  readonly reasonCode: GatesConfigReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: GatesConfigReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "GatesConfigError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function invalid(field: string, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new GatesConfigError("GATES_CONFIG_INVALID", message, { field, ...details });
}

/** What a gate declares; its name is the record's key. */
export interface GateDeclaration {
  readonly command: readonly string[];
  readonly root: string;
  readonly covers: readonly string[];
  readonly required: boolean;
  readonly enabled: boolean;
  readonly releaseOnly: boolean;
}

export interface NamedGate extends GateDeclaration {
  readonly name: string;
}

export const GATE_COMMAND_MAX_ARGUMENTS = 64 as const;
export const GATE_ARGUMENT_MAX_BYTES = 4_096 as const;
export const GATE_COVERS_MAX = 64 as const;
const GATE_WORK_COVER = /^work:[0-9a-f]{24}$/u;
const GATE_FIELDS = ["command", "covers", "enabled", "releaseOnly", "required", "root"];
const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export function isGateName(value: unknown): value is string {
  return typeof value === "string" && GATE_NAME.test(value);
}

/** A directory of the project, relative to it: "." for the project itself, or forward-slash segments that stay inside. */
export function isProjectRelativeRoot(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 512) return false;
  if (value === ".") return true;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A gate declaration, checked field by field; returns a detached copy. */
export function checkGateDeclaration(value: unknown, name = "the gate"): GateDeclaration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("gate", `${name} is not a JSON object`, { name });
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record).sort();
  if (fields.join(",") !== GATE_FIELDS.join(",")) invalid("gate", `${name} declares exactly ${GATE_FIELDS.join(", ")}`, { name });
  const command = record.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > GATE_COMMAND_MAX_ARGUMENTS ||
    command.some((argument) => typeof argument !== "string" || argument === "" || argument.includes("\u0000") || Buffer.byteLength(argument, "utf8") > GATE_ARGUMENT_MAX_BYTES)) {
    invalid("command", `the command of ${name} is an argv: 1 to ${GATE_COMMAND_MAX_ARGUMENTS} non-empty strings`, { name });
  }
  if (!isProjectRelativeRoot(record.root)) {
    invalid("root", `the root of ${name} is a directory relative to the project that stays inside it ("." for the project itself)`, { name, root: String(record.root) });
  }
  const covers = record.covers;
  if (!Array.isArray(covers) || covers.length > GATE_COVERS_MAX || covers.some((glob) => typeof glob !== "string")) {
    invalid("covers", `the covers of ${name} are at most ${GATE_COVERS_MAX} globs`, { name });
  }
  for (const cover of covers as readonly string[]) {
    if (cover.startsWith("work:")) {
      if (!GATE_WORK_COVER.test(cover)) invalid("covers", `the work-id cover of ${name} is work:<24 lowercase hexadecimal characters>`, { name, cover });
      continue;
    }
    try {
      compileGlob(cover);
    } catch (error) {
      if (error instanceof GatesPlanError) invalid("covers", `the covers of ${name}: ${error.message}`, { name, glob: cover, reason: error.details?.reason ?? "" });
      throw error;
    }
  }
  for (const field of ["required", "enabled", "releaseOnly"]) {
    if (typeof record[field] !== "boolean") invalid(field, `${field} of ${name} is true or false`, { name });
  }
  return {
    command: [...(command as readonly string[])],
    root: record.root,
    covers: [...(covers as readonly string[])],
    required: record.required as boolean,
    enabled: record.enabled as boolean,
    releaseOnly: record.releaseOnly as boolean,
  };
}

/** The check the gate collection of config-records.ts applies to a record: its key is the gate's name. */
export function checkGateRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  if (!isGateName(key)) invalid("name", `${key} is not a gate name: 1 to 64 letters, digits, dots, colons, underscores and hyphens`, { name: key });
  checkGateDeclaration(value, key);
}

/** The gates a merged state declares, sorted by name. */
export function listGates(state: Pick<WorkspaceState, "configRecords">): readonly NamedGate[] {
  return configRecords(state, "gate").map((record) => ({ name: record.key, ...(record.value as unknown as GateDeclaration) }));
}

/** Declare or redeclare one gate in a library. */
export async function setGate(workspaceRoot: string, input: { readonly name: string; readonly gate: unknown } & WorkspaceMutationOptions): Promise<WorkspaceState> {
  if (!isGateName(input.name)) invalid("name", `${input.name} is not a gate name: 1 to 64 letters, digits, dots, colons, underscores and hyphens`, { name: String(input.name) });
  const gate = checkGateDeclaration(input.gate, input.name);
  return setConfigRecord(workspaceRoot, { ...input, collection: "gate", key: input.name, value: gate });
}

/** Remove one gate from a library; a name the library does not declare is refused (CONFIG_RECORD_NOT_FOUND). */
export async function removeGate(workspaceRoot: string, input: { readonly name: string } & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return removeConfigRecord(workspaceRoot, { ...input, collection: "gate", key: input.name });
}

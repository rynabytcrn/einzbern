// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R4 (MIN-227 D4; TCRN-CROSS-SUB-344): a Story is done only when the required
// gates of its change are green. The check does not run gates itself, which would make a
// transition take as long as the slowest gate: it reads this device's latest gate run made on the
// tree as it is now, under the gate declarations as they are now (gates-run.ts). A project that
// declares no enabled gate is not held back. Without a run for this tree the transition is
// refused with WORK_DONE_GATES_NOT_RUN (remedy: gates-run); with one in which a required gate is
// red it is refused with WORK_DONE_GATES_RED, naming every red required gate. The gates the run
// planned are the change's own: the plan for the same tree and declarations.

import { compareCanonicalText } from "../../protocol/src/index.js";
import { listGates } from "./gates-config.js";
import { gateDeclarationsDigest } from "./gates-plan.js";
import { gateTreeState, latestGateRun } from "./gates-run.js";
import type { WorkspaceState } from "./workspace.js";

export const GATES_DONE_REASON_CODES = Object.freeze(["WORK_DONE_GATES_NOT_RUN", "WORK_DONE_GATES_RED"] as const);

export type GatesDoneReasonCode = typeof GATES_DONE_REASON_CODES[number];

export class GatesDoneError extends Error {
  readonly reasonCode: GatesDoneReasonCode;
  readonly details: Readonly<Record<string, string | readonly string[]>>;

  constructor(reasonCode: GatesDoneReasonCode, message: string, details: Readonly<Record<string, string | readonly string[]>>) {
    super(message);
    this.name = "GatesDoneError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface DoneGatesVerdict {
  // Whether a run was consulted; nothing is checked when no Story goes to done or no gate is enabled.
  readonly checked: boolean;
  readonly reason: "green" | "no-gates" | "no-story";
  readonly runId: string | null;
  readonly treeDigest: string | null;
}

/**
 * Refuse, before any write, a transition that takes a Story to done while a required gate of
 * the change is red or has not run on the tree as it is. `workIds` are the records going to done;
 * only Stories among them are held to the gates. `library` is the merged state that declares the
 * gates; `projectRoot` is the project their roots are relative to.
 */
export async function assertDoneGates(input: {
  readonly projectRoot: string;
  readonly library: Pick<WorkspaceState, "configRecords" | "metadata" | "work">;
  readonly workIds: readonly string[];
  readonly deviceHome?: string;
}): Promise<DoneGatesVerdict> {
  const stories = input.workIds.filter((id) => input.library.work.some((record) => record.id === id && record.kind === "Story"));
  if (stories.length === 0) return { checked: false, reason: "no-story", runId: null, treeDigest: null };
  const gates = listGates(input.library).filter((gate) => gate.enabled);
  if (gates.length === 0) return { checked: false, reason: "no-gates", runId: null, treeDigest: null };
  const tree = await gateTreeState(input.projectRoot, [...new Set(gates.map((gate) => gate.root))].sort(compareCanonicalText));
  const run = await latestGateRun({
    libraryId: input.library.metadata.workspaceId,
    treeDigest: tree.treeDigest,
    declarationsDigest: gateDeclarationsDigest(gates),
    ...(input.deviceHome === undefined ? {} : { deviceHome: input.deviceHome }),
  });
  if (run === null) {
    throw new GatesDoneError("WORK_DONE_GATES_NOT_RUN", "no gate run was made on the project as it is now; run gates-run, then move the Story to done", {
      remedy: "gates-run",
      treeDigest: tree.treeDigest,
      stories,
    });
  }
  const reds = run.gates.filter((gate) => gate.required && !gate.ok).map((gate) => gate.name);
  if (reds.length > 0) {
    throw new GatesDoneError("WORK_DONE_GATES_RED", `required gates are red: ${reds.join(", ")}`, { reds, runId: run.runId, stories });
  }
  return { checked: true, reason: "green", runId: run.runId, treeDigest: tree.treeDigest };
}

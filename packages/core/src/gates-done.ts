// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R4 (MIN-235 D8; TCRN-CROSS-SUB-344): a Story is done only when at least one
// required gate declares and records an exact work-id cover for that Story, and every required
// gate in the Story's run is green. A path match selects a gate but cannot establish Story coverage
// without a trusted Story-to-path association. The check does not run gates itself: it reads this
// device's latest run for the same tree, declarations and exact Story set.

import { compareCanonicalText } from "../../protocol/src/index.js";
import { listGates } from "./gates-config.js";
import { gateDeclarationsDigest } from "./gates-plan.js";
import { gateTreeState, latestGateRun } from "./gates-run.js";
import type { WorkspaceState } from "./workspace.js";

export const GATES_DONE_REASON_CODES = Object.freeze([
  "WORK_DONE_GATES_NOT_COVERED",
  "WORK_DONE_GATES_NOT_RUN",
  "WORK_DONE_GATES_RED",
] as const);

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
  // Whether a run was consulted; nothing is checked when no Story goes to done.
  readonly checked: boolean;
  readonly reason: "green" | "no-story";
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
  const required = gates.filter((gate) => gate.required);
  const withoutRequiredSubjectCover = stories.filter((storyId) => !required.some((gate) => gate.covers.includes(storyId)));
  if (withoutRequiredSubjectCover.length > 0) {
    throw new GatesDoneError("WORK_DONE_GATES_NOT_COVERED", "no enabled required gate declares an exact work-id cover for the Story", {
      stories: withoutRequiredSubjectCover,
      remedy: "declare an enabled required gate with covers work:<Story id>, then run gates-run with that --work-id and --base <commit> or --release",
    });
  }
  const tree = await gateTreeState(input.projectRoot, [...new Set(gates.map((gate) => gate.root))].sort(compareCanonicalText));
  const run = await latestGateRun({
    libraryId: input.library.metadata.workspaceId,
    treeDigest: tree.treeDigest,
    declarationsDigest: gateDeclarationsDigest(gates),
    workIds: stories,
    ...(input.deviceHome === undefined ? {} : { deviceHome: input.deviceHome }),
  });
  if (run === null) {
    throw new GatesDoneError("WORK_DONE_GATES_NOT_RUN", "no gate run was made on the project as it is now; run gates-run, then move the Story to done", {
      remedy: "gates-run",
      treeDigest: tree.treeDigest,
      stories,
    });
  }
  const uncovered = stories.filter((storyId) => !run.gates.some((result) => {
    if (!result.required || !result.matchedWorkIds.includes(storyId)) return false;
    const declaration = gates.find((gate) => gate.name === result.name && gate.required);
    return declaration?.covers.includes(storyId) === true;
  }));
  if (uncovered.length > 0) {
    throw new GatesDoneError("WORK_DONE_GATES_NOT_COVERED", "the latest gate run has no required coverage for the Story", {
      stories: uncovered,
      runId: run.runId,
      remedy: "declare an enabled required gate with covers work:<Story id>, then run gates-run with that --work-id and --base <commit> or --release",
    });
  }
  const reds = run.gates.filter((gate) => gate.required && !gate.ok).map((gate) => gate.name);
  if (reds.length > 0) {
    throw new GatesDoneError("WORK_DONE_GATES_RED", `required gates are red: ${reds.join(", ")}`, { reds, runId: run.runId, stories });
  }
  return { checked: true, reason: "green", runId: run.runId, treeDigest: tree.treeDigest };
}

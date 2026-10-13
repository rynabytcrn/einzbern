// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-525 (MIN-256; TCRN-CROSS-SUB-448), after TCRN-CROSS-STORY-485 R4 (MIN-235 D8): a
// Story is done when every gate that applies to it ran green, bound to it, on the project as it is
// now. A gate applies to a Story when it is enabled and required, when the Story's gates field or an
// ancestor's names it, or when its covers name the Story or one of its ancestors (gateAppliesTo in
// gates-plan.ts); a release-only gate applies only to a release run. A path cover selects a gate for a
// change but binds no Story, and no cover has to list the Story any more. A library with no enabled
// gate holds no Story back (no-gates), nor does a Story no enabled gate applies to
// (no-applicable-gates). Otherwise the check reads this device's latest run made on the same tree
// under the same declarations whose target Stories include the Story, a run made with --work-id for
// it alone or beside others: without one the Story is WORK_DONE_GATES_NOT_RUN; an applicable gate the
// run does not hold bound to the Story, or a gate name the Story is bound to that the project does not
// declare, is WORK_DONE_GATES_NOT_COVERED; an applicable gate that is red is WORK_DONE_GATES_RED. The
// check does not run gates itself.

import { compareCanonicalText } from "../../protocol/src/index.js";
import { listGates } from "./gates-config.js";
import type { NamedGate } from "./gates-config.js";
import { gateAppliesTo, gateDeclarationsDigest } from "./gates-plan.js";
import { gateTreeState, latestGateRun } from "./gates-run.js";
import type { GateRun } from "./gates-run.js";
import { effectiveWorkGates, workAncestorIds } from "./work-gates.js";
import type { WorkspaceState } from "./workspace.js";

export const GATES_DONE_REASON_CODES = Object.freeze([
  "WORK_DONE_GATES_NOT_COVERED",
  "WORK_DONE_GATES_NOT_RUN",
  "WORK_DONE_GATES_RED",
] as const);

export type GatesDoneReasonCode = typeof GATES_DONE_REASON_CODES[number];

/** What a refusal tells a caller to do. */
const GATES_DONE_REMEDY = "run gates-run --work-id <Story id> with --base <commit> or --release on the project as it is, then move the Story to done";

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
  // Whether a run was consulted; nothing is checked when no Story goes to done, when the library
  // declares no enabled gate, or when no enabled gate applies to any of the Stories.
  readonly checked: boolean;
  readonly reason: "green" | "no-story" | "no-gates" | "no-applicable-gates";
  // The run that cleared the first Story checked; runIds lists every run consulted when there are several.
  readonly runId: string | null;
  readonly treeDigest: string | null;
  readonly runIds?: readonly string[];
}

/** A Story's gates: the enabled ones that apply to it, and the names it is bound to that no gate is declared by. */
interface StoryGates {
  readonly id: string;
  readonly applicable: readonly NamedGate[];
  readonly unknown: readonly string[];
}

/**
 * Refuse, before any write, a transition that takes a Story to done while a gate that applies to it is
 * red, has not run bound to it, or has not run on the tree as it is. `workIds` are the records going
 * to done; only Stories among them are held to the gates, each with its parent chain read from
 * `library.work`. `library` is the merged state that declares the gates; `projectRoot` is the project
 * their roots are relative to, or a function that finds it, called only when a run has to be read.
 */
export async function assertDoneGates(input: {
  readonly projectRoot: string | (() => Promise<string>);
  readonly library: Pick<WorkspaceState, "configRecords" | "metadata" | "work">;
  readonly workIds: readonly string[];
  readonly configurationProjectId?: string;
  readonly deviceHome?: string;
}): Promise<DoneGatesVerdict> {
  const stories = input.workIds.filter((id) => input.library.work.some((record) => record.id === id && record.kind === "Story"));
  if (stories.length === 0) return { checked: false, reason: "no-story", runId: null, treeDigest: null };
  const declared = listGates(input.library);
  const gates = declared.filter((gate) => gate.enabled);
  if (gates.length === 0) return { checked: false, reason: "no-gates", runId: null, treeDigest: null };
  const bound: StoryGates[] = [];
  for (const id of stories) {
    const subject = { workId: id, ancestorIds: workAncestorIds(input.library.work, id), gates: effectiveWorkGates(input.library, id) };
    const applicable = gates.filter((gate) => gateAppliesTo(gate, id, subject));
    const unknown = subject.gates.filter((name) => !declared.some((gate) => gate.name === name));
    if (applicable.length > 0 || unknown.length > 0) bound.push({ id, applicable, unknown });
  }
  if (bound.length === 0) return { checked: false, reason: "no-applicable-gates", runId: null, treeDigest: null };
  const unknown = bound.filter((entry) => entry.unknown.length > 0);
  if (unknown.length > 0) {
    // TCRN-CROSS-STORY-525 Q10: no run can hold a gate the project does not declare.
    throw new GatesDoneError("WORK_DONE_GATES_NOT_COVERED", `the Story is bound to gates the project does not declare: ${[...new Set(unknown.flatMap((entry) => entry.unknown))].sort(compareCanonicalText).join(", ")}`, {
      stories: unknown.map((entry) => entry.id),
      gates: [...new Set(unknown.flatMap((entry) => entry.unknown))].sort(compareCanonicalText),
      remedy: "declare the gates, or take the names out of the gates field of the Story or its ancestors; then run gates-run --work-id <Story id> with --base <commit> or --release",
    });
  }
  const projectRoot = typeof input.projectRoot === "string" ? input.projectRoot : await input.projectRoot();
  const tree = await gateTreeState(projectRoot, [...new Set(gates.map((gate) => gate.root))].sort(compareCanonicalText));
  const declarationsDigest = gateDeclarationsDigest(gates);
  const runs = new Map<string, GateRun>();
  for (const entry of bound) {
    const run = await latestGateRun({
      libraryId: input.library.metadata.workspaceId,
      ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }),
      treeDigest: tree.treeDigest,
      declarationsDigest,
      includesWorkIds: [entry.id],
      ...(input.deviceHome === undefined ? {} : { deviceHome: input.deviceHome }),
    });
    if (run !== null) runs.set(entry.id, run);
  }
  const notRun = bound.filter((entry) => !runs.has(entry.id)).map((entry) => entry.id);
  if (notRun.length > 0) {
    throw new GatesDoneError("WORK_DONE_GATES_NOT_RUN", "no gate run bound to the Story was made on the project as it is now; run gates-run --work-id <Story id>, then move the Story to done", {
      remedy: GATES_DONE_REMEDY,
      treeDigest: tree.treeDigest,
      stories: notRun,
    });
  }
  // What each Story's run holds of the gates that apply to it: a release-only gate applies to a release run only.
  const results = bound.map((entry) => {
    const run = runs.get(entry.id)!;
    const due = entry.applicable.filter((gate) => run.release || !gate.releaseOnly);
    const missing = due.filter((gate) => !run.gates.some((result) => result.name === gate.name && result.matchedWorkIds.includes(entry.id))).map((gate) => gate.name);
    const reds = run.gates.filter((result) => !result.ok && due.some((gate) => gate.name === result.name)).map((result) => result.name);
    return { id: entry.id, run, missing, reds };
  });
  const uncovered = results.filter((result) => result.missing.length > 0);
  if (uncovered.length > 0) {
    const missing = [...new Set(uncovered.flatMap((result) => result.missing))].sort(compareCanonicalText);
    throw new GatesDoneError("WORK_DONE_GATES_NOT_COVERED", `the latest gate run bound to the Story does not hold these gates for it: ${missing.join(", ")}`, {
      stories: uncovered.map((result) => result.id),
      gates: missing,
      runId: uncovered[0]!.run.runId,
      remedy: GATES_DONE_REMEDY,
    });
  }
  const red = results.filter((result) => result.reds.length > 0);
  if (red.length > 0) {
    const reds = [...new Set(red.flatMap((result) => result.reds))];
    throw new GatesDoneError("WORK_DONE_GATES_RED", `gates that apply to the Story are red: ${reds.join(", ")}`, {
      reds,
      runId: red[0]!.run.runId,
      stories: red.map((result) => result.id),
      remedy: GATES_DONE_REMEDY,
    });
  }
  const runIds = [...new Set(results.map((result) => result.run.runId))];
  return { checked: true, reason: "green", runId: runIds[0]!, treeDigest: tree.treeDigest, ...(runIds.length > 1 ? { runIds } : {}) };
}

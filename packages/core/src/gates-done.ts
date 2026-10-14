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
//
// TCRN-CROSS-STORY-530 (TCRN-CROSS-SUB-450), TCRN-CROSS-STORY-534 (MIN-257 D6; TCRN-CROSS-SUB-470):
// "the project as it is now" is judged for each run against the files the run recorded. A run made
// for Stories whose commits are known by key took its tree digest over the content of the files those
// commits touched, without HEAD (einzbern.gate-tree.v3); the check reads the same files again and
// compares the digests, and takes the files the commits of the Story and its Subtasks touch now
// (Q2): a run that did not read one of them does not stand for the Story. So a commit or a file
// another process makes elsewhere in the project leaves the run standing, and the Story goes to done
// without its gates running again; a change to the content of one of the Story's files, committed or
// not, or a new commit of the Story's that touches another file, does not. The refusal names those
// files (changedPaths, addedPaths), as the latest run that read the Story's files saw them. A run made
// without keys records HEAD and every change, and any of them moves it.

import { realpath } from "node:fs/promises";

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { listGates } from "./gates-config.js";
import type { NamedGate } from "./gates-config.js";
import { gateAppliesTo, gateDeclarationsDigest, resolveGateRoot, storyCommitPaths } from "./gates-plan.js";
import { gateTreeState, latestGateRun } from "./gates-run.js";
import type { GateRun, GateTreeState } from "./gates-run.js";
import { effectiveWorkGates, workAncestorIds, workSubjectKeys } from "./work-gates.js";
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

// TCRN-CROSS-STORY-534: whether a run read the Story's files, at least one root of it limited to them.
function readsStoryFiles(run: GateRun): boolean {
  return run.trees.some((tree) => tree.files !== undefined);
}

// A path under a gate root as the project root names it.
function projectPath(root: string, path: string): string {
  return root === "." ? path : `${root}/${path}`;
}

// TCRN-CROSS-STORY-534: the files a run read whose content is not what it read, named from the project
// root; `reading` is the run's files read again (treeOf).
function changedPathsOf(run: GateRun, reading: GateTreeState): readonly string[] {
  const changed: string[] = [];
  for (const tree of run.trees) {
    if (tree.files === undefined) continue;
    const now = new Map((reading.trees.find((entry) => entry.root === tree.root)?.files ?? []).map((file) => [file.path, file.digest]));
    for (const file of tree.files) if (now.get(file.path) !== file.digest) changed.push(projectPath(tree.root, file.path));
  }
  return changed;
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
  const roots = [...new Set(gates.map((gate) => gate.root))].sort(compareCanonicalText);
  const declarationsDigest = gateDeclarationsDigest(gates);
  // The tree as each run saw it, read again over the files the run recorded (TCRN-CROSS-STORY-534:
  // run.trees[].files); runs that recorded the same files share one reading.
  const readings = new Map<string, Promise<GateTreeState>>();
  const treeOf = (run: GateRun): Promise<GateTreeState> => {
    const paths: Record<string, readonly string[]> = {};
    for (const tree of run.trees) if (tree.files !== undefined) paths[tree.root] = tree.files.map((file) => file.path);
    const key = canonicalJson(paths);
    let reading = readings.get(key);
    if (reading === undefined) {
      reading = gateTreeState(projectRoot, roots, { paths });
      readings.set(key, reading);
    }
    return reading;
  };
  // Q2: the files under each root that the commits of a Story and its Subtasks touch now, read once
  // per Story and only for a run that recorded the Story's files.
  const storyFiles = new Map<string, Promise<ReadonlyMap<string, readonly string[]>>>();
  const filesOf = (id: string): Promise<ReadonlyMap<string, readonly string[]>> => {
    let files = storyFiles.get(id);
    if (files === undefined) {
      files = (async (): Promise<ReadonlyMap<string, readonly string[]>> => {
        const project = await realpath(projectRoot);
        const keys = workSubjectKeys(input.library.work, [id]);
        const byRoot = new Map<string, readonly string[]>();
        for (const root of roots) byRoot.set(root, storyCommitPaths(await resolveGateRoot(project, root), keys));
        return byRoot;
      })();
      storyFiles.set(id, files);
    }
    return files;
  };
  // The files the Story's commits touch now that a run did not read, named from the project root.
  const addedPathsOf = async (id: string, run: GateRun): Promise<readonly string[]> => {
    if (!readsStoryFiles(run)) return [];
    const now = await filesOf(id);
    const added: string[] = [];
    for (const tree of run.trees) {
      if (tree.files === undefined) continue;
      const recorded = new Set(tree.paths);
      for (const path of now.get(tree.root) ?? []) if (!recorded.has(path)) added.push(projectPath(tree.root, path));
    }
    return added;
  };
  const runs = new Map<string, GateRun>();
  // For each Story, the latest run bound to it under these declarations that read its files: what a
  // refusal reports the changed and added files against.
  const latestReading = new Map<string, GateRun>();
  for (const entry of bound) {
    const run = await latestGateRun({
      libraryId: input.library.metadata.workspaceId,
      ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }),
      declarationsDigest,
      includesWorkIds: [entry.id],
      accept: async (candidate) => {
        if (!latestReading.has(entry.id) && readsStoryFiles(candidate)) latestReading.set(entry.id, candidate);
        return (await treeOf(candidate)).treeDigest === candidate.treeDigest && (await addedPathsOf(entry.id, candidate)).length === 0;
      },
      ...(input.deviceHome === undefined ? {} : { deviceHome: input.deviceHome }),
    });
    if (run !== null) runs.set(entry.id, run);
  }
  const notRun = bound.filter((entry) => !runs.has(entry.id)).map((entry) => entry.id);
  if (notRun.length > 0) {
    // The digest a run made now for these Stories would record.
    const now = await gateTreeState(projectRoot, roots, { keys: workSubjectKeys(input.library.work, notRun) });
    const changedPaths = new Set<string>();
    const addedPaths = new Set<string>();
    for (const id of notRun) {
      const run = latestReading.get(id);
      if (run === undefined) continue;
      for (const path of changedPathsOf(run, await treeOf(run))) changedPaths.add(path);
      for (const path of await addedPathsOf(id, run)) addedPaths.add(path);
    }
    throw new GatesDoneError("WORK_DONE_GATES_NOT_RUN", "no gate run bound to the Story was made on the project as it is now; run gates-run --work-id <Story id>, then move the Story to done", {
      remedy: GATES_DONE_REMEDY,
      treeDigest: now.treeDigest,
      stories: notRun,
      changedPaths: [...changedPaths].sort(compareCanonicalText),
      addedPaths: [...addedPaths].sort(compareCanonicalText),
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
  return { checked: true, reason: "green", runId: runIds[0]!, treeDigest: results[0]!.run.treeDigest, ...(runIds.length > 1 ? { runIds } : {}) };
}

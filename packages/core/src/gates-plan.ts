import { localProbeTimeout } from "./io-policy.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R2 (MIN-227 D4; TCRN-CROSS-SUB-343): which gates a change needs. A project
// declares its gates (gates-config.ts): each names a root, a directory of the project, and the
// paths under it that the gate covers, as globs or exact work ids. A non-release plan requires an
// explicit Git base, includes committed and working-tree changes, and selects declarations by
// path or target id. A release plan lists every enabled gate, the release-only ones included, and
// needs no Git at all; without Git a project can only run that one. The engine derives the
// selection from the declarations; nobody picks gates by hand.
//
// TCRN-CROSS-STORY-525 (MIN-256; TCRN-CROSS-SUB-447): a plan made for Stories (--work-id) selects every
// gate that applies to them: each enabled required gate, for every Story; each gate a Story's gates
// field or an ancestor's names (work-gates.ts); and each gate whose covers name the Story or one of
// its ancestors, so a work:<Initiative or Epic id> cover reaches every Story under it. Each such gate
// records the Stories it applies to as its matchedWorkIds. A path match still selects a gate and
// records the files, without binding a Story. A plan made for no Story is what it was.

import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import type { NamedGate } from "./gates-config.js";

export const GATES_PLAN_REASON_CODES = Object.freeze([
  "GATES_BASE_INVALID",
  "GATES_BASE_REQUIRED",
  "GATES_GIT_UNAVAILABLE",
  "GATES_GLOB_INVALID",
  "GATES_ROOT_INVALID",
  "GATES_WORK_ID_INVALID",
] as const);

export type GatesPlanReasonCode = typeof GATES_PLAN_REASON_CODES[number];

export class GatesPlanError extends Error {
  readonly reasonCode: GatesPlanReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: GatesPlanReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "GatesPlanError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: GatesPlanReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new GatesPlanError(reasonCode, message, details);
}

export const GATES_GLOB_MAX_BYTES = RUNTIME_CAPACITY.bufferBytes;

// One segment of a glob as a regular expression: * and ? stay inside the segment, a character
// class is [abc], [a-z] or negated with ! or ^, and every other character stands for itself.
function segmentSource(segment: string, invalid: (reason: string) => never): string {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close === -1) invalid("a [ has no closing ]");
      let body = segment.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      if (body === "") invalid("a character class is empty");
      source += `[${negated ? "^/" : ""}${[...body].map((entry) => (/[\\\][^]/u.test(entry) ? `\\${entry}` : entry)).join("")}]`;
      index = close;
    } else if (character === "]") {
      invalid("a ] has no opening [");
    } else {
      source += /[.+^${}()|]/u.test(character) ? `\\${character}` : character;
    }
  }
  return source;
}

/**
 * A glob as a regular expression over paths relative to a gate's root, with forward slashes.
 * `**` is a whole segment and matches any number of segments; `*`, `?` and `[...]` match within
 * one segment; a glob ending in `/` covers everything under that directory. A glob matches the
 * whole path: `*.md` is a Markdown file at the root, `**\/*.md` one at any depth. Anything else
 * is GATES_GLOB_INVALID.
 */
export function compileGlob(pattern: string): RegExp {
  const invalid = (reason: string): never => fail("GATES_GLOB_INVALID", `${JSON.stringify(pattern)} is not a glob: ${reason}`, { glob: String(pattern), reason });
  if (typeof pattern !== "string" || pattern.length === 0 || Buffer.byteLength(pattern, "utf8") > GATES_GLOB_MAX_BYTES) invalid(`a glob is 1 to ${GATES_GLOB_MAX_BYTES} bytes`);
  if (/[\u0000-\u001f\u007f\\]/u.test(pattern)) invalid("a glob holds no control character and no backslash");
  if (pattern.startsWith("/")) invalid("a glob is relative to its gate's root");
  const segments = (pattern.endsWith("/") ? `${pattern}**` : pattern).split("/");
  let source = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "" || segment === "." || segment === "..") invalid("a glob has no empty, . or .. segment");
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    if (segment.includes("**")) invalid("** stands for whole segments only");
    source += segmentSource(segment, invalid);
    if (!last) source += "/";
  }
  try {
    return new RegExp(`^${source}$`, "u");
  } catch (error) {
    return invalid(`it does not compile (${(error as Error).message})`);
  }
}

/** Whether a path relative to a gate's root is covered by the glob. */
export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path);
}

// Git runs against the named directory only: a variable that would point it at another
// repository (as a Git hook's environment does) is dropped, and it takes no optional lock, so
// reading the changes never rewrites the index.
const GIT_REPOSITORY_VARIABLES = ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_WORK_TREE"];

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of GIT_REPOSITORY_VARIABLES) delete environment[name];
  return environment;
}

function git(directory: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: RUNTIME_CAPACITY.bufferBytes,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: localProbeTimeout(30_000),
    });
  } catch {
    return null;
  }
}

function paths(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/** The commit HEAD names in the repository at `directory`, or null without Git or without a commit. */
export function gitHead(directory: string): string | null {
  return git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim() || null;
}

// A base names a commit; it never starts with - so Git cannot read it as an option.
const BASE_SHAPE = /^[A-Za-z0-9._/@{}~^][A-Za-z0-9._/@{}~^-]*$/u;

/**
 * The files changed under `root`, relative to it with forward slashes, sorted: the difference
 * between `base` (HEAD when it is not named) and the working tree, the staged and unstaged
 * changes included, deletions and both sides of a rename included, and every untracked file Git
 * does not ignore. In a repository without a commit every tracked file counts as changed.
 */
export function changedFiles(root: string, options: { readonly base?: string } = {}): readonly string[] {
  if (git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    fail("GATES_GIT_UNAVAILABLE", `${root} is not inside a Git working tree, or git cannot run; without Git only a release plan runs`, { root, remedy: "--release" });
  }
  const base = options.base;
  if (base !== undefined) {
    if (!BASE_SHAPE.test(base) || git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
      fail("GATES_BASE_INVALID", `${base} does not name a commit in the repository at ${root}`, { root, base });
    }
  }
  const against = base ?? (gitHead(root) === null ? null : "HEAD");
  const tracked = against === null
    ? git(root, ["ls-files", "--cached", "-z"])
    : git(root, ["diff", "--name-only", "--no-renames", "--relative", "-z", against, "--"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked === null || untracked === null) {
    fail("GATES_GIT_UNAVAILABLE", `git could not list the changes under ${root}`, { root, remedy: "--release" });
  }
  return [...new Set([...paths(tracked), ...paths(untracked)])].sort(compareCanonicalText);
}

// TCRN-CROSS-STORY-530 (MIN-256; TCRN-CROSS-SUB-450; Q13): a key names a commit when the message holds
// it followed by anything but a digit, so STORY-52 does not name a commit of STORY-525.
function namesKey(message: string, key: string): boolean {
  let from = message.indexOf(key);
  while (from !== -1) {
    const next = message.charCodeAt(from + key.length);
    if (!(next >= 48 && next <= 57)) return true;
    from = message.indexOf(key, from + 1);
  }
  return false;
}

/**
 * TCRN-CROSS-STORY-530 (MIN-256; TCRN-CROSS-SUB-450; Q13): the files under `root` that a Story's
 * commits touched, relative to it with forward slashes, sorted: every commit HEAD reaches whose
 * message names one of `keys` (the external keys of the Story and its Subtasks) followed by anything
 * but a digit, deletions included, renames as a deletion and an addition. None without a key or
 * without a commit; GATES_GIT_UNAVAILABLE when git cannot read the history.
 */
export function storyCommitPaths(root: string, keys: readonly string[]): readonly string[] {
  const named = [...new Set(keys)].filter((key) => key.length > 0 && !key.includes("\u0000")).sort(compareCanonicalText);
  if (named.length === 0 || gitHead(root) === null) return [];
  const log = git(root, ["log", "HEAD", "--fixed-strings", ...named.map((key) => `--grep=${key}`), "--format=%H%x00%B%x00"]);
  if (log === null) fail("GATES_GIT_UNAVAILABLE", `git could not read the history under ${root}`, { root, remedy: "--release" });
  const fields = log.split("\0");
  const commits: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = (fields[index] ?? "").trim();
    if (/^[0-9a-f]{40,64}$/u.test(commit) && named.some((key) => namesKey(fields[index + 1] ?? "", key))) commits.push(commit);
  }
  const files = new Set<string>();
  // A bounded number of commits per call keeps the argument list within the platform's limit.
  for (let start = 0; start < commits.length; start += 256) {
    const listed = git(root, ["log", "--no-walk=unsorted", "--format=", "--name-only", "--no-renames", "--relative", "-z", ...commits.slice(start, start + 256)]);
    if (listed === null) fail("GATES_GIT_UNAVAILABLE", `git could not list the files of the Story's commits under ${root}`, { root, remedy: "--release" });
    for (const file of paths(listed)) files.add(file);
  }
  return [...files].sort(compareCanonicalText);
}

export interface PlannedGate {
  readonly name: string;
  readonly root: string;
  readonly command: readonly string[];
  readonly required: boolean;
  readonly releaseOnly: boolean;
  // "release" for a full run; otherwise the first of these that selected the gate: "changed" for path
  // coverage, "work-id" for a cover naming a target Story or one of its ancestors, "work-field" for a
  // gate a target's gates field names, "required" for a required gate of a plan made for Stories.
  readonly reason: "changed" | "release" | "work-id" | "work-field" | "required";
  // The changed files under the gate's root that its covers match (none in a release plan).
  readonly matched: readonly string[];
  // The target Stories the gate applies to: all of them for a required gate, else those whose gates
  // field names it or that its covers name, the Story itself or an ancestor.
  readonly matchedWorkIds: readonly string[];
}

/**
 * TCRN-CROSS-STORY-525: what binds one target Story to gates besides a required declaration: the ids
 * of its ancestors (workAncestorIds), whose work covers cover it, and the gate names its gates field
 * and its ancestors' name (effectiveWorkGates). A target the plan has no subject for has neither.
 */
export interface GateSubject {
  readonly workId: string;
  readonly ancestorIds: readonly string[];
  readonly gates: readonly string[];
}

export interface GatesPlan {
  // The project's real path, which every root is relative to.
  readonly projectRoot: string;
  readonly release: boolean;
  readonly base: string | null;
  // Stories whose required coverage this plan is intended to prove.
  readonly workIds: readonly string[];
  // Each root's changed files the covers were matched against; null for a release plan.
  readonly changed: readonly { readonly root: string; readonly files: readonly string[] }[] | null;
  readonly gates: readonly PlannedGate[];
  // TCRN-CROSS-STORY-485 R3, R4 (SUB-344): the root of every enabled gate, planned or not, and a
  // digest of every enabled gate's declaration. A run records both; the done check compares them.
  readonly roots: readonly string[];
  readonly declarationsDigest: string;
  // TCRN-CROSS-STORY-525 (Q10): the names a target's gates field gives that the project declares no
  // gate by, sorted; present only when there is one. Such a gate never runs, so its Story is not done.
  readonly unknownGates?: readonly string[];
  // TCRN-CROSS-STORY-530 (TCRN-CROSS-SUB-450): the external keys of the target Stories and their
  // Subtasks, sorted, when there is one: the run's tree digest then counts only the files their
  // commits touched (gateTreeState).
  readonly subjectKeys?: readonly string[];
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep) && !relation.includes(`${sep}..${sep}`));
}

/** A gate's root as a real directory inside the project, or GATES_ROOT_INVALID. */
export async function resolveGateRoot(projectRoot: string, root: string): Promise<string> {
  const target = root === "." ? projectRoot : join(projectRoot, ...root.split("/"));
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return fail("GATES_ROOT_INVALID", `the gate root ${root} does not exist in the project`, { root });
  }
  if (!inside(projectRoot, real) || !(await stat(real)).isDirectory()) {
    fail("GATES_ROOT_INVALID", `the gate root ${root} is not a directory inside the project`, { root });
  }
  return real;
}

/**
 * The digest of the enabled gates' declarations, by name: a run made under other declarations does
 * not count. A gate's order (TCRN-CROSS-STORY-508 R7) is not part of it: it changes when a gate runs,
 * not what the run proves, so a run stays valid when only the orders change.
 */
export function gateDeclarationsDigest(gates: readonly NamedGate[]): string {
  return canonicalSha256({
    schemaVersion: "einzbern.gate-declarations.v1",
    gates: [...gates]
      .filter((gate) => gate.enabled)
      .sort((left, right) => compareCanonicalText(left.name, right.name))
      .map((gate) => ({ name: gate.name, command: gate.command, root: gate.root, covers: gate.covers, required: gate.required, enabled: gate.enabled, releaseOnly: gate.releaseOnly })),
  });
}

// TCRN-CROSS-STORY-508 R7: the order a plan lists, runs and shows its gates in: the gates with an
// order first, by order, then the others; gates of one order, and those without one, by name.
function planningOrder(left: NamedGate, right: NamedGate): number {
  if (left.order !== right.order) {
    if (left.order === undefined) return 1;
    if (right.order === undefined) return -1;
    return left.order - right.order;
  }
  return compareCanonicalText(left.name, right.name);
}

function planned(gate: NamedGate, reason: PlannedGate["reason"], matched: readonly string[], matchedWorkIds: readonly string[]): PlannedGate {
  return { name: gate.name, root: gate.root, command: gate.command, required: gate.required, releaseOnly: gate.releaseOnly, reason, matched, matchedWorkIds };
}

const WORK_ID = /^work:[0-9a-f]{24}$/u;

function normalizedWorkIds(workIds: readonly string[] | undefined): readonly string[] {
  const unique = new Set<string>();
  for (const workId of workIds ?? []) {
    if (!WORK_ID.test(workId)) fail("GATES_WORK_ID_INVALID", `${workId} is not a work:<24 lowercase hexadecimal characters> id`, { workId });
    unique.add(workId);
  }
  return [...unique].sort(compareCanonicalText);
}

/**
 * Whether `gate` applies to the Story `workId` (TCRN-CROSS-STORY-525): it is required, the Story's
 * gates field or an ancestor's names it, or its covers name the Story or an ancestor. Whether it is
 * enabled, and whether a release-only gate counts, is the caller's question.
 */
export function gateAppliesTo(gate: NamedGate, workId: string, subject: GateSubject | undefined): boolean {
  return gate.required || gateBindsByWork(gate, workId, subject) || (subject?.gates.includes(gate.name) ?? false);
}

// A cover naming the Story or one of its ancestors.
function gateBindsByWork(gate: NamedGate, workId: string, subject: GateSubject | undefined): boolean {
  return gate.covers.includes(workId) || (subject?.ancestorIds.some((ancestorId) => gate.covers.includes(ancestorId)) ?? false);
}

/**
 * The gates a change or Story needs: every enabled, non-release-only gate whose path covers match
 * changed files under its root, and, when the plan is made for Stories, every such gate that applies
 * to one of them (gateAppliesTo); or, for a release, every enabled gate. Non-release plans require an
 * explicit valid Git base. Disabled gates are never listed. The gates are listed in their planning
 * order (planningOrder): by name while no gate holds an order.
 */
export async function planGates(input: {
  readonly projectRoot: string;
  readonly gates: readonly NamedGate[];
  readonly release?: boolean;
  readonly base?: string;
  readonly workIds?: readonly string[];
  // TCRN-CROSS-STORY-525: each target's ancestors and the gate names that bind it.
  readonly subjects?: readonly GateSubject[];
  // TCRN-CROSS-STORY-530: the external keys of the targets and their Subtasks.
  readonly subjectKeys?: readonly string[];
}): Promise<GatesPlan> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(input.projectRoot);
  } catch {
    return fail("GATES_ROOT_INVALID", `the project ${input.projectRoot} does not exist`, { root: "." });
  }
  const release = input.release === true;
  const workIds = normalizedWorkIds(input.workIds);
  if (!release && input.base === undefined) {
    fail("GATES_BASE_REQUIRED", "a non-release gate plan requires an explicit Git --base; use --release for a full run", { remedy: "--base <commit> or --release" });
  }
  const enabled = [...input.gates]
    .filter((gate) => gate.enabled)
    .sort(planningOrder);
  const gates = enabled.filter((gate) => release || !gate.releaseOnly);
  const roots = new Map<string, string>();
  for (const gate of enabled) {
    if (!roots.has(gate.root)) roots.set(gate.root, await resolveGateRoot(projectRoot, gate.root));
  }
  const base = input.base ?? null;
  const subjects = new Map((input.subjects ?? []).map((subject) => [subject.workId, subject]));
  const unknownGates = [...new Set(workIds.flatMap((workId) => subjects.get(workId)?.gates ?? []))]
    .filter((name) => !input.gates.some((gate) => gate.name === name))
    .sort(compareCanonicalText);
  const subjectKeys = [...new Set(input.subjectKeys ?? [])].sort(compareCanonicalText);
  const declared = {
    roots: [...roots.keys()].sort(compareCanonicalText),
    declarationsDigest: gateDeclarationsDigest(enabled),
    ...(unknownGates.length === 0 ? {} : { unknownGates }),
    ...(subjectKeys.length === 0 ? {} : { subjectKeys }),
  };
  const appliesTo = (gate: NamedGate): readonly string[] => workIds.filter((workId) => gateAppliesTo(gate, workId, subjects.get(workId)));
  if (release) return {
    projectRoot, release, base, workIds, changed: null,
    gates: gates.map((gate) => planned(gate, "release", [], appliesTo(gate))),
    ...declared,
  };
  const changed = new Map<string, readonly string[]>();
  for (const root of declared.roots) {
    const directory = roots.get(root);
    if (directory === undefined) continue;
    const files = changedFiles(directory, { base: input.base! });
    if (gates.some((gate) => gate.root === root)) changed.set(root, files);
  }
  // Even an empty plan or a declaration set containing only release-only gates must reject a
  // missing Git project or a base that names no commit.
  if (declared.roots.length === 0) changedFiles(projectRoot, { base: input.base! });
  const selected: PlannedGate[] = [];
  for (const gate of gates) {
    const covers = gate.covers.filter((cover) => !cover.startsWith("work:")).map((glob) => compileGlob(glob));
    const matched = (changed.get(gate.root) ?? []).filter((file) => covers.some((glob) => glob.test(file)));
    const matchedWorkIds = appliesTo(gate);
    if (matched.length > 0 || matchedWorkIds.length > 0) {
      const reason: PlannedGate["reason"] = matched.length > 0
        ? "changed"
        : matchedWorkIds.some((workId) => gateBindsByWork(gate, workId, subjects.get(workId)))
          ? "work-id"
          : matchedWorkIds.some((workId) => subjects.get(workId)?.gates.includes(gate.name) === true) ? "work-field" : "required";
      selected.push(planned(gate, reason, matched, matchedWorkIds));
    }
  }
  return {
    projectRoot,
    release,
    base,
    workIds,
    changed: [...changed.entries()].map(([root, files]) => ({ root, files })),
    gates: selected,
    ...declared,
  };
}

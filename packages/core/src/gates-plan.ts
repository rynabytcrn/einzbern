// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R2 (MIN-227 D4; TCRN-CROSS-SUB-343): which gates a change needs. A project
// declares its gates (gates-config.ts): each names a root, a directory of the project, and the
// paths under it that the gate covers, as globs. The plan takes each root's changes from Git
// against a base (HEAD unless another is named) together with the uncommitted and the untracked
// files, and lists every enabled gate whose covers match one of its root's changed files. A
// release plan lists every enabled gate, the release-only ones included, and needs no Git at
// all; without Git a project can only run that one. The engine derives the selection from the
// declarations; nobody picks gates by hand.

import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { compareCanonicalText } from "../../protocol/src/index.js";
import type { NamedGate } from "./gates-config.js";

export const GATES_PLAN_REASON_CODES = Object.freeze([
  "GATES_BASE_INVALID",
  "GATES_GIT_UNAVAILABLE",
  "GATES_GLOB_INVALID",
  "GATES_ROOT_INVALID",
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

export const GATES_GLOB_MAX_BYTES = 512 as const;

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
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
  } catch {
    return null;
  }
}

function paths(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

// A base names a commit; it never starts with - so Git cannot read it as an option.
const BASE_SHAPE = /^[A-Za-z0-9._/@{}~^][A-Za-z0-9._/@{}~^-]{0,255}$/u;

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
  if (base !== undefined && (!BASE_SHAPE.test(base) || git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null)) {
    fail("GATES_BASE_INVALID", `${base} does not name a commit of the repository at ${root}`, { root, base });
  }
  const against = base ?? (git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]) === null ? null : "HEAD");
  const tracked = against === null
    ? git(root, ["ls-files", "--cached", "-z"])
    : git(root, ["diff", "--name-only", "--no-renames", "--relative", "-z", against, "--"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked === null || untracked === null) {
    fail("GATES_GIT_UNAVAILABLE", `git could not list the changes under ${root}`, { root, remedy: "--release" });
  }
  return [...new Set([...paths(tracked), ...paths(untracked)])].sort(compareCanonicalText);
}

export interface PlannedGate {
  readonly name: string;
  readonly root: string;
  readonly command: readonly string[];
  readonly required: boolean;
  readonly releaseOnly: boolean;
  // "release" in a release plan; "changed" when the gate's covers match changed files.
  readonly reason: "changed" | "release";
  // The changed files under the gate's root that its covers match (none in a release plan).
  readonly matched: readonly string[];
}

export interface GatesPlan {
  // The project's real path, which every root is relative to.
  readonly projectRoot: string;
  readonly release: boolean;
  readonly base: string | null;
  // Each root's changed files the covers were matched against; null for a release plan.
  readonly changed: readonly { readonly root: string; readonly files: readonly string[] }[] | null;
  readonly gates: readonly PlannedGate[];
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

function planned(gate: NamedGate, reason: PlannedGate["reason"], matched: readonly string[]): PlannedGate {
  return { name: gate.name, root: gate.root, command: gate.command, required: gate.required, releaseOnly: gate.releaseOnly, reason, matched };
}

/**
 * The gates a change needs: every enabled gate whose covers match a changed file of its root,
 * release-only gates left out; or, for a release, every enabled gate. Disabled gates are never
 * listed.
 */
export async function planGates(input: {
  readonly projectRoot: string;
  readonly gates: readonly NamedGate[];
  readonly release?: boolean;
  readonly base?: string;
}): Promise<GatesPlan> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(input.projectRoot);
  } catch {
    return fail("GATES_ROOT_INVALID", `the project ${input.projectRoot} does not exist`, { root: "." });
  }
  const release = input.release === true;
  const gates = [...input.gates]
    .filter((gate) => gate.enabled && (release || !gate.releaseOnly))
    .sort((left, right) => compareCanonicalText(left.name, right.name));
  const roots = new Map<string, string>();
  for (const gate of gates) {
    if (!roots.has(gate.root)) roots.set(gate.root, await resolveGateRoot(projectRoot, gate.root));
  }
  const base = input.base ?? null;
  if (release) return { projectRoot, release, base, changed: null, gates: gates.map((gate) => planned(gate, "release", [])) };
  const changed = new Map<string, readonly string[]>();
  for (const [root, directory] of [...roots.entries()].sort(([left], [right]) => compareCanonicalText(left, right))) {
    changed.set(root, changedFiles(directory, input.base === undefined ? {} : { base: input.base }));
  }
  const selected: PlannedGate[] = [];
  for (const gate of gates) {
    const covers = gate.covers.map((glob) => compileGlob(glob));
    const matched = (changed.get(gate.root) ?? []).filter((file) => covers.some((glob) => glob.test(file)));
    if (matched.length > 0) selected.push(planned(gate, "changed", matched));
  }
  return {
    projectRoot,
    release,
    base,
    changed: [...changed.entries()].map(([root, files]) => ({ root, files })),
    gates: selected,
  };
}

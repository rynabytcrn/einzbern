// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-533. The portal gate's DS reconciliation reads the source the consumer
// contract binds — the candidate commit — out of the Design System repository's git
// objects, never out of its working tree. Each case builds a throwaway repository as the
// Design System root: the candidate commit carries the export, and a later commit plus an
// uncommitted edit carry a split without it. That is the shape that turned the portal gate
// red while this repository's bytes stood still.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { INLINE_MARKER, reconcile } from "../scripts/ds-component-css-reconcile.mjs";
import { CANDIDATE_SOURCE_PATH, readCandidateSource } from "../scripts/lib/ds-candidate-source.mjs";

const RECONCILE = resolve(import.meta.dirname, "../scripts/ds-component-css-reconcile.mjs");
const GENERATE = resolve(import.meta.dirname, "../scripts/generate-ds-component-css-snapshot.mjs");
const CSS = ":root { --tcrn-probe: #246f80; }\n";
const ABSENT_COMMIT = "1234567890abcdef1234567890abcdef12345678";

/** The DS source shape the extractor reads: one tagged template export. */
const sourceFixture = (css) => `export const tcrnComponentCss = \`${css}\`;\n`;
/** The split that moved the CSS out of Navigation.tsx: no template literal left to read. */
const SPLIT_SOURCE = 'import { familySegments } from "./segments";\nexport const tcrnComponentCss = familySegments.join("");\n';

/**
 * git for the fixture only: no inherited git environment, no user or system configuration,
 * and an identity that is a bare name — git does not require an address.
 */
function fixtureGit(root, configPath, arguments_) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...inherited,
      GIT_AUTHOR_DATE: "2026-10-14T00:00:00Z",
      GIT_AUTHOR_EMAIL: "fixture",
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_DATE: "2026-10-14T00:00:00Z",
      GIT_COMMITTER_EMAIL: "fixture",
      GIT_COMMITTER_NAME: "fixture",
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

async function designSystem(context, {
  candidateSource = sourceFixture(CSS),
  snapshotCss = CSS,
  inlineCss = CSS,
} = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story533-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "design-system");
  const configPath = join(base, "gitconfig");
  const sourceFile = join(root, CANDIDATE_SOURCE_PATH);
  await mkdir(dirname(sourceFile), { recursive: true });
  await writeFile(configPath, "", "utf8");
  const git = (arguments_) => fixtureGit(root, configPath, arguments_);

  git(["init", "-q", "-b", "main"]);
  await writeFile(sourceFile, candidateSource, "utf8");
  git(["add", "--", CANDIDATE_SOURCE_PATH]);
  git(["commit", "-q", "-m", "candidate"]);
  const candidate = git(["rev-parse", "HEAD"]);
  const candidateTree = git(["rev-parse", "HEAD^{tree}"]);
  // The unpublished split: a later commit, then an uncommitted edit on top of it.
  await writeFile(sourceFile, SPLIT_SOURCE, "utf8");
  git(["commit", "-q", "-a", "--allow-empty", "-m", "split"]);
  const worktreeSource = `${SPLIT_SOURCE}// unpublished\n`;
  await writeFile(sourceFile, worktreeSource, "utf8");

  const contractPath = join(base, "ds-consumer-contract.json");
  await writeFile(contractPath, `${JSON.stringify({ candidate, candidateTree })}\n`, "utf8");
  const snapshotPath = join(base, "snapshot.css");
  const indexPath = join(base, "index.html");
  await writeFile(snapshotPath, snapshotCss, "utf8");
  await writeFile(indexPath, `<html>${INLINE_MARKER}${inlineCss}</style></html>\n`, "utf8");
  return { base, root, git, sourceFile, worktreeSource, candidate, candidateTree, contractPath, snapshotPath, indexPath };
}

/** reconcile() reading the bound candidate: no explicit source file. */
const fromCandidate = (fixture, overrides = {}) => ({
  snapshotPath: fixture.snapshotPath,
  indexPath: fixture.indexPath,
  contractPath: fixture.contractPath,
  designSystemRoot: fixture.root,
  sourcePath: null,
  ...overrides,
});

/** A script at its command boundary, with the fixture behind every seam it reads. */
function runScript(script, fixture, { designSystemRoot = fixture.root, contractPath = fixture.contractPath, arguments_ = [] } = {}) {
  const env = {
    ...process.env,
    TCRN_DESIGN_SYSTEM_ROOT: designSystemRoot,
    TCRN_DS_CONSUMER_CONTRACT: contractPath,
    TCRN_DS_COMPONENT_CSS_SNAPSHOT: fixture.snapshotPath,
    TCRN_DS_COMPONENT_CSS_INDEX: fixture.indexPath,
  };
  delete env.TCRN_DS_COMPONENT_CSS_SOURCE;
  const result = spawnSync(process.execPath, [script, ...arguments_], { encoding: "utf8", env });
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") };
}

const unreconciled = (report) => report.observations.filter((entry) => entry.reasonCode === "DS_COMPONENT_CSS_SOURCE_UNRECONCILED");

test("STORY-533 GWT1 a working tree and a bound candidate that both lack the export exit 0 and observe why", async (context) => {
  const fixture = await designSystem(context, { candidateSource: SPLIT_SOURCE });
  const { status, stderr, report } = runScript(RECONCILE, fixture);
  assert.equal(status, 0, "a source with no usable export cannot turn this repository red");
  assert.equal(stderr, "", "git's diagnostics stay inside the reader");
  assert.equal(report.ok, true);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT");
  assert.equal(report.reconciliation.sourceStatus, "unverified");
  assert.equal(report.reconciliation.sourceReconciled, false);
  assert.equal(report.reconciliation.candidate, fixture.candidate);
  assert.deepEqual(report.observations, [{
    reasonCode: "DS_COMPONENT_CSS_SOURCE_UNRECONCILED",
    reason: "export-not-found",
    source: `${fixture.candidate}:${CANDIDATE_SOURCE_PATH}`,
    candidate: fixture.candidate,
  }]);
});

const UNREADABLE = [
  { reason: "not-a-repository", label: "a Design System root that does not exist", options: (fixture) => ({ designSystemRoot: join(fixture.base, "absent") }), candidate: true },
  { reason: "not-a-repository", label: "a directory inside the repository rather than its root", options: (fixture) => ({ designSystemRoot: join(fixture.root, "packages") }), candidate: true },
  { reason: "candidate-absent", label: "a contract bound to a commit the repository does not hold", contract: () => ({ candidate: ABSENT_COMMIT, candidateTree: ABSENT_COMMIT }), candidate: true },
  { reason: "candidate-absent", label: "a contract that cannot be read", options: (fixture) => ({ contractPath: join(fixture.base, "absent-contract.json") }), candidate: false },
  { reason: "tree-mismatch", label: "a candidate whose tree is not the bound tree", contract: (fixture) => ({ candidate: fixture.candidate, candidateTree: fixture.git(["rev-parse", "HEAD^{tree}"]) }), candidate: true },
  { reason: "export-has-interpolation", label: "a candidate export that interpolates", candidateSource: sourceFixture(":root { --tcrn-probe: ${probe}; }\n"), candidate: true },
];

for (const entry of UNREADABLE) {
  test(`STORY-533 GWT1 ${entry.label} is observed as ${entry.reason} and leaves the verdict to the inline leg`, async (context) => {
    const fixture = await designSystem(context, entry.candidateSource ? { candidateSource: entry.candidateSource } : {});
    if (entry.contract) await writeFile(fixture.contractPath, `${JSON.stringify(entry.contract(fixture))}\n`, "utf8");
    const report = await reconcile(fromCandidate(fixture, entry.options?.(fixture) ?? {}));
    assert.equal(report.ok, true);
    assert.equal(report.reasonCode, "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT");
    assert.equal(report.reconciliation.sourceStatus, "unverified");
    const observed = unreconciled(report);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].reason, entry.reason);
    const expectedCandidate = entry.contract ? entry.contract(fixture).candidate : fixture.candidate;
    assert.equal(observed[0].candidate, entry.candidate ? expectedCandidate : null);
  });
}

test("STORY-533 GWT2 the bound candidate is read from git objects while the working tree lacks the export", async (context) => {
  const fixture = await designSystem(context);
  const statusBefore = fixture.git(["status", "--porcelain=v1"]);
  const report = await reconcile(fromCandidate(fixture));
  assert.equal(report.ok, true);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_RECONCILED");
  assert.equal(report.reconciliation.sourceStatus, "verified");
  assert.equal(report.reconciliation.candidate, fixture.candidate);
  assert.equal(report.reconciliation.source, `${fixture.candidate}:${CANDIDATE_SOURCE_PATH}`);
  assert.equal(report.reconciliation.sourceMatchesSnapshot, true);
  assert.equal(report.reconciliation.sourceReconciled, true);
  assert.deepEqual(report.observations, []);
  // Read, never touched: the working tree and the index are as the other session left them.
  assert.equal(await readFile(fixture.sourceFile, "utf8"), fixture.worktreeSource);
  assert.equal(fixture.git(["status", "--porcelain=v1"]), statusBefore);

  const boundary = runScript(RECONCILE, fixture);
  assert.equal(boundary.status, 0);
  assert.equal(boundary.report.reasonCode, "DS_COMPONENT_CSS_RECONCILED");
  assert.equal(boundary.report.reconciliation.candidate, fixture.candidate);
});

test("STORY-533 GWT2 a bound candidate that differs from the snapshot is compared and observed as drift", async (context) => {
  const fixture = await designSystem(context, { candidateSource: sourceFixture(":root { --tcrn-probe: #246f81; }\n") });
  const report = await reconcile(fromCandidate(fixture));
  assert.equal(report.ok, true);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_INLINE_RECONCILED");
  assert.equal(report.reconciliation.sourceStatus, "verified");
  assert.equal(report.reconciliation.sourceMatchesSnapshot, false);
  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].reasonCode, "DS_COMPONENT_CSS_SOURCE_DRIFT");
  assert.equal(report.observations[0].source, `${fixture.candidate}:${CANDIDATE_SOURCE_PATH}`);
});

test("STORY-533 GWT3 one byte off in the snapshot or in the inline copy is still DS_COMPONENT_CSS_INLINE_DRIFT", async (context) => {
  const offByOne = ":root { --tcrn-probe: #246f82; }\n";
  const snapshotOff = await designSystem(context, { snapshotCss: offByOne });
  const boundary = runScript(RECONCILE, snapshotOff);
  assert.equal(boundary.status, 1);
  assert.equal(boundary.report.ok, false);
  assert.equal(boundary.report.reasonCode, "DS_COMPONENT_CSS_INLINE_DRIFT");

  const inlineOff = await designSystem(context, { inlineCss: offByOne });
  const inlineReport = await reconcile(fromCandidate(inlineOff));
  assert.equal(inlineReport.ok, false);
  assert.equal(inlineReport.reasonCode, "DS_COMPONENT_CSS_INLINE_DRIFT");
  assert.equal(inlineReport.inline.matchesSnapshot, false);

  // The verdict does not wait on the source: an unreadable candidate still reds the drift.
  const unreadable = await reconcile(fromCandidate(inlineOff, { designSystemRoot: join(inlineOff.base, "absent") }));
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reasonCode, "DS_COMPONENT_CSS_INLINE_DRIFT");
});

test("STORY-533 GWT4 a readable bound candidate is what the snapshot is generated from", async (context) => {
  const fixture = await designSystem(context, { snapshotCss: "stale\n" });
  const written = runScript(GENERATE, fixture);
  assert.equal(written.status, 0);
  assert.equal(written.stderr, "");
  assert.equal(written.report.reasonCode, "DS_COMPONENT_CSS_SNAPSHOT_WRITTEN");
  assert.equal(written.report.candidate, fixture.candidate);
  assert.equal(written.report.source, `${fixture.candidate}:${CANDIDATE_SOURCE_PATH}`);
  assert.equal(await readFile(fixture.snapshotPath, "utf8"), CSS, "the candidate's export, not the working tree's split");

  const checked = runScript(GENERATE, fixture, { arguments_: ["--check"] });
  assert.equal(checked.status, 0);
  assert.equal(checked.report.reasonCode, "DS_COMPONENT_CSS_SNAPSHOT_MATCHES_SOURCE");
  assert.equal(checked.report.candidate, fixture.candidate);
});

test("STORY-533 GWT4 an unreadable bound candidate refuses generation, says why, and leaves the snapshot's bytes", async (context) => {
  const fixture = await designSystem(context, { snapshotCss: "stale\n" });
  await writeFile(fixture.contractPath, `${JSON.stringify({ candidate: ABSENT_COMMIT, candidateTree: ABSENT_COMMIT })}\n`, "utf8");
  const before = await readFile(fixture.snapshotPath);
  for (const arguments_ of [[], ["--check"]]) {
    const refused = runScript(GENERATE, fixture, { arguments_ });
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, "");
    assert.equal(refused.report.ok, false);
    assert.equal(refused.report.reasonCode, "DS_COMPONENT_CSS_SOURCE_UNAVAILABLE");
    assert.equal(refused.report.reason, "candidate-absent");
    assert.equal(refused.report.candidate, ABSENT_COMMIT);
  }
  assert.deepEqual(await readFile(fixture.snapshotPath), before);

  // A candidate that is there but carries no export is refused the same way.
  const split = await designSystem(context, { candidateSource: SPLIT_SOURCE, snapshotCss: "stale\n" });
  const refused = runScript(GENERATE, split);
  assert.equal(refused.status, 1);
  assert.equal(refused.report.reasonCode, "DS_COMPONENT_CSS_SOURCE_UNAVAILABLE");
  assert.equal(refused.report.reason, "export-not-found");
  assert.equal(await readFile(split.snapshotPath, "utf8"), "stale\n");
});

test("STORY-533 an explicit source file is read as given, ahead of the bound candidate", async (context) => {
  const fixture = await designSystem(context);
  const explicit = join(fixture.base, "Navigation.tsx");
  await writeFile(explicit, sourceFixture(CSS), "utf8");
  const read = await readCandidateSource({ contractPath: fixture.contractPath, designSystemRoot: fixture.root, sourceFile: explicit });
  assert.deepEqual(read, { status: "available", reason: null, text: sourceFixture(CSS), candidate: null });
  const absent = await readCandidateSource({ contractPath: fixture.contractPath, designSystemRoot: fixture.root, sourceFile: join(fixture.base, "absent.tsx") });
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.reason, "source-absent");
});

test("STORY-533 a hook's git environment does not redirect the candidate read", async (context) => {
  const fixture = await designSystem(context);
  const saved = { dir: process.env.GIT_DIR, workTree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(fixture.base, "elsewhere.git");
  process.env.GIT_WORK_TREE = join(fixture.base, "elsewhere");
  try {
    const read = await readCandidateSource({ contractPath: fixture.contractPath, designSystemRoot: fixture.root, sourceFile: null });
    assert.equal(read.status, "available");
    assert.equal(read.candidate, fixture.candidate);
    assert.equal(read.text, sourceFixture(CSS));
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.workTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = saved.workTree;
  }
});

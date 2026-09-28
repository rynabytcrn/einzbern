// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 R1, R2, AC1, AC2 (MIN-227 D4; TCRN-CROSS-SUB-343): gate declarations and the
// plan that selects them. A gate is a project-level configuration record; the plan takes each
// root's Git changes against a base, the uncommitted and untracked files included, and lists the
// enabled gates whose covers match them. A release plan lists every enabled gate and needs no
// Git. Every repository here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { checkGateDeclaration, listGates, removeGate, setGate } from "../dist/build/packages/core/src/gates-config.js";
import { changedFiles, compileGlob, gateDeclarationsDigest, matchesGlob, planGates } from "../dist/build/packages/core/src/gates-plan.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 8, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gates-plan-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

// Git for the fixtures only: no system or global configuration, a fixed identity.
function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=gates-test", "-c", "user.email=gates-test-at-example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function put(root, path, text = `${path}\n`) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** A project that is a Git repository with one commit of a few files. */
async function project(base) {
  const root = join(base, "project");
  await mkdir(root);
  git(root, ["init", "-q"]);
  for (const path of ["portal/index.html", "portal/styles/site.css", "packages/core/src/a.ts", "README.md", "docs/guide.md"]) await put(root, path);
  await put(root, ".gitignore", "vendor-tool/\nbuild/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

const gate = (covers, extra = {}) => ({ command: ["node", "--version"], root: ".", covers, required: true, enabled: true, releaseOnly: false, ...extra });

const GATES = [
  { name: "portal", ...gate(["portal/**"]) },
  { name: "engine", ...gate(["packages/**", "scripts/**"]) },
  { name: "links", ...gate(["**/*.md"], { required: false }) },
  { name: "release-pack", ...gate(["**"], { releaseOnly: true }) },
  { name: "off", ...gate(["**"], { enabled: false }) },
];

const names = (plan) => plan.gates.map((entry) => entry.name);
const head = (root) => git(root, ["rev-parse", "HEAD"]).trim();

test("485-AC1: only a file under portal changed, so only the gate covering portal is planned", async (context) => {
  const root = await project(await scratch(context));
  const base = head(root);
  await put(root, "portal/index.html", "<p>changed</p>\n");
  const plan = await planGates({ projectRoot: root, gates: GATES, base });
  assert.deepEqual(names(plan), ["portal"]);
  assert.deepEqual(plan.gates[0], {
    name: "portal",
    root: ".",
    command: ["node", "--version"],
    required: true,
    releaseOnly: false,
    reason: "changed",
    matched: ["portal/index.html"],
    matchedWorkIds: [],
  });
  assert.deepEqual(plan.changed, [{ root: ".", files: ["portal/index.html"] }]);
  assert.equal(plan.release, false);
  assert.deepEqual(plan.workIds, []);
});

test("485-AC2: a release plan lists every enabled gate, the release-only one included, and needs no Git", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const plan = await planGates({ projectRoot: root, gates: GATES, release: true });
  assert.deepEqual(names(plan), ["engine", "links", "portal", "release-pack"], "every enabled gate, sorted; the disabled one is not listed");
  assert.equal(plan.changed, null);
  assert.ok(plan.gates.every((entry) => entry.reason === "release" && entry.matched.length === 0 && entry.matchedWorkIds.length === 0));

  // Outside a Git working tree a normal plan refuses and a release plan still lists every gate.
  const plain = join(base, "plain");
  await mkdir(plain);
  await assert.rejects(planGates({ projectRoot: plain, gates: GATES, base: "HEAD" }), { reasonCode: "GATES_GIT_UNAVAILABLE" });
  assert.deepEqual(names(await planGates({ projectRoot: plain, gates: GATES, release: true })), ["engine", "links", "portal", "release-pack"]);
});

test("485-R2: a release-only gate is not planned for an ordinary change, even when its covers match", async (context) => {
  const root = await project(await scratch(context));
  const base = head(root);
  await put(root, "README.md", "# Changed\n");
  const plan = await planGates({ projectRoot: root, gates: GATES, base });
  assert.deepEqual(names(plan), ["links"]);
  assert.deepEqual(plan.gates[0].matched, ["README.md"]);
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: [], base })), [], "a project without gates plans none");
  await assert.rejects(planGates({ projectRoot: root, gates: [], base: "no-such-commit" }), { reasonCode: "GATES_BASE_INVALID" },
    "an empty plan still validates its explicit base");
  await assert.rejects(planGates({ projectRoot: root, gates: [GATES[3]], base: "no-such-commit" }), { reasonCode: "GATES_BASE_INVALID" },
    "a release-only declaration cannot bypass non-release base validation");
});

test("D8: exact Story covers are distinct from path globs and an unrelated work id does not select a gate", async (context) => {
  const root = await project(await scratch(context));
  const base = head(root);
  const story = `work:${"1".repeat(24)}`;
  const other = `work:${"2".repeat(24)}`;
  const gates = [
    { name: "path", ...gate(["portal/**"]) },
    { name: "story", ...gate([story]) },
    { name: "other-story", ...gate([other]) },
  ];

  const byId = await planGates({ projectRoot: root, gates, base, workIds: [story] });
  assert.deepEqual(names(byId), ["story"]);
  assert.deepEqual(byId.gates[0], {
    name: "story", root: ".", command: ["node", "--version"], required: true, releaseOnly: false,
    reason: "work-id", matched: [], matchedWorkIds: [story],
  });
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: [gates[2]], base, workIds: [story] })), [], "a different Story id is not coverage");

  await put(root, "portal/index.html", "<p>changed</p>\n");
  const byPath = await planGates({ projectRoot: root, gates, base, workIds: [story] });
  assert.deepEqual(names(byPath), ["path", "story"]);
  assert.deepEqual(byPath.gates.find((entry) => entry.name === "path")?.matched, ["portal/index.html"]);
  assert.deepEqual(byPath.gates.find((entry) => entry.name === "path")?.matchedWorkIds, [], "path matching is not rewritten as an id match");

  await assert.rejects(planGates({ projectRoot: root, gates, base, workIds: ["work:not-an-id"] }), { reasonCode: "GATES_WORK_ID_INVALID" });
});

test("485-R2: the changes are the base's difference plus staged, unstaged, deleted, renamed and untracked files", async (context) => {
  const root = await project(await scratch(context));
  const initial = git(root, ["rev-parse", "HEAD"]).trim();
  await put(root, "packages/core/src/a.ts", "export const a = 2;\n");
  git(root, ["commit", "-q", "-am", "engine change"]);
  await assert.rejects(planGates({ projectRoot: root, gates: GATES }), { reasonCode: "GATES_BASE_REQUIRED" }, "HEAD is never chosen implicitly");
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: GATES, base: initial })), ["engine"], "an explicit base includes committed-only changes");

  await put(root, "portal/new.css", "p {}\n");
  git(root, ["mv", "docs/guide.md", "docs/handbook.md"]);
  await unlink(join(root, "README.md"));
  await put(root, "build/output.txt", "ignored\n");
  assert.deepEqual(changedFiles(root), ["README.md", "docs/guide.md", "docs/handbook.md", "portal/new.css"], "untracked, both sides of a rename, a deletion; ignored files left out");
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: GATES, base: initial })), ["engine", "links", "portal"]);

  for (const base of ["no-such-commit", "--output=x", "HEAD..HEAD~1 extra"]) {
    await assert.rejects(planGates({ projectRoot: root, gates: GATES, base }), { reasonCode: "GATES_BASE_INVALID" }, base);
  }
});

test("485-R2: each root takes its own changes, relative to itself", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  git(root, ["branch", "baseline"]);
  // A second repository inside the project, which the project's own repository ignores.
  const tool = join(root, "vendor-tool");
  await mkdir(tool);
  git(tool, ["init", "-q"]);
  await put(tool, "src/b.ts", "export const b = 1;\n");
  git(tool, ["add", "-A"]);
  git(tool, ["commit", "-q", "-m", "tool"]);
  git(tool, ["branch", "baseline"]);
  const gates = [
    ...GATES,
    { name: "tool-tests", ...gate(["src/**"], { root: "vendor-tool" }) },
    { name: "portal-html", ...gate(["**/*.html"], { root: "portal" }) },
  ];

  await put(tool, "src/b.ts", "export const b = 2;\n");
  let plan = await planGates({ projectRoot: root, gates, base: "baseline" });
  assert.deepEqual(names(plan), ["tool-tests"], "a change in the second repository selects only its gate");
  assert.deepEqual(plan.changed, [{ root: ".", files: [] }, { root: "portal", files: [] }, { root: "vendor-tool", files: ["src/b.ts"] }]);

  git(tool, ["commit", "-q", "-am", "tool change"]);
  await put(root, "portal/index.html", "<p>again</p>\n");
  plan = await planGates({ projectRoot: root, gates, base: "baseline" });
  assert.deepEqual(names(plan), ["portal", "portal-html", "tool-tests"], "the explicit baseline retains committed changes in each root");
  assert.deepEqual(plan.gates.find((entry) => entry.name === "portal-html").matched, ["index.html"], "a subdirectory root sees paths relative to itself");

  await assert.rejects(planGates({ projectRoot: root, gates: [{ name: "missing", ...gate(["**"], { root: "no/such/dir" }) }], base: "baseline" }), { reasonCode: "GATES_ROOT_INVALID" });
  await symlink(base, join(root, "outside"));
  await assert.rejects(planGates({ projectRoot: root, gates: [{ name: "escape", ...gate(["**"], { root: "outside" }) }], base: "baseline" }), { reasonCode: "GATES_ROOT_INVALID" }, "a root reached through a link must stay inside the project");
});

test("485-R2: globs match whole paths: ** across segments, * and ? within one, character classes", () => {
  const cases = [
    ["portal/**", "portal/index.html", true],
    ["portal/**", "portal/a/b/c.css", true],
    ["portal/**", "portalx/index.html", false],
    ["portal/", "portal/index.html", true],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/a/b.md", true],
    ["*.md", "README.md", true],
    ["*.md", "docs/guide.md", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["[a-c]*.ts", "b1.ts", true],
    ["[a-c]*.ts", "d.ts", false],
    ["[!a]*.ts", "a.ts", false],
    ["[!a]*.ts", "b.ts", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "a/x/y/c", false],
    ["file.(1).txt", "file.(1).txt", true],
    ["file.(1).txt", "fileX(1)Xtxt", false],
    ["**", "anything/at/all", true],
  ];
  for (const [glob, path, expected] of cases) assert.equal(matchesGlob(glob, path), expected, `${glob} ~ ${path}`);
  for (const glob of ["", "/rooted/**", "../up/**", "a/./b", "a//b", "a/**b", "a**/b", "[abc", "abc]", "[]", "a\\b", "z[b-a]"]) {
    assert.throws(() => compileGlob(glob), { reasonCode: "GATES_GLOB_INVALID" }, JSON.stringify(glob));
  }
});

test("485-R1: a gate is declared in the library, checked field by field, listed and removed", async (context) => {
  const base = await scratch(context);
  const home = join(base, "desk");
  const library = join(base, ".ether");
  process.env.EINZBERN_HOME = home;
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });

  await setGate(library, { name: "portal", gate: gate(["portal/**"]), occurredAt: at() });
  await setGate(library, { name: "links", gate: gate(["**/*.md"], { required: false }), occurredAt: at() });
  let state = await materializeWorkspace(library);
  assert.deepEqual(listGates(state).map((entry) => entry.name), ["links", "portal"]);
  assert.deepEqual(listGates(state)[1], { name: "portal", ...gate(["portal/**"]) });
  const projection = JSON.parse(await readFile(join(library, "config", "project.json"), "utf8"));
  assert.deepEqual(Object.keys(projection.records.gate), ["links", "portal"], "the projection shows the declared gates");

  for (const [label, value, field] of [
    ["an absolute root", gate(["**"], { root: "/opt/project" }), "root"],
    ["a root that climbs out", gate(["**"], { root: "../elsewhere" }), "root"],
    ["an empty argv", gate(["**"], { command: [] }), "command"],
    ["a shell line", gate(["**"], { command: "pnpm test" }), "command"],
    ["an empty argument", gate(["**"], { command: ["node", ""] }), "command"],
    ["a bad glob", gate(["portal/[x"]), "covers"],
    ["an invalid work id", gate(["work:1234"]), "covers"],
    ["a flag that is not a boolean", gate(["**"], { required: "yes" }), "required"],
    ["an extra field", { ...gate(["**"]), timeoutMs: 5 }, "gate"],
  ]) {
    await assert.rejects(setGate(library, { name: "bad", gate: value, occurredAt: at() }), (error) => {
      assert.equal(error.reasonCode, "GATES_CONFIG_INVALID", label);
      assert.equal(error.details.field, field, label);
      return true;
    });
  }
  await assert.rejects(setGate(library, { name: "has space", gate: gate(["**"]), occurredAt: at() }), { reasonCode: "GATES_CONFIG_INVALID" });
  assert.throws(() => checkGateDeclaration(gate(["**"], { enabled: 1 })), { reasonCode: "GATES_CONFIG_INVALID" });

  await removeGate(library, { name: "links", occurredAt: at() });
  state = await materializeWorkspace(library);
  assert.deepEqual(listGates(state).map((entry) => entry.name), ["portal"]);
  await assert.rejects(removeGate(library, { name: "links", occurredAt: at() }), { reasonCode: "CONFIG_RECORD_NOT_FOUND" });
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): a gate may hold an order, which is the
// order a plan lists, runs and shows its gates in; it is not part of what a run proves.
test("508-R7: GIVEN gates with an order WHEN gates-plan THEN they are planned first, by order, and the rest by name", async (context) => {
  const root = await project(await scratch(context));
  const ordered = [
    { name: "portal", ...gate(["portal/**"], { order: 2 }) },
    { name: "engine", ...gate(["packages/**", "scripts/**"], { order: 3 }) },
    { name: "links", ...gate(["**/*.md"], { required: false }) },
    { name: "release-pack", ...gate(["**"], { releaseOnly: true, order: 1 }) },
    { name: "docs", ...gate(["**/*.md"], { required: false, order: 2 }) },
    { name: "off", ...gate(["**"], { enabled: false, order: 1 }) },
  ];
  const release = await planGates({ projectRoot: root, gates: ordered, release: true });
  assert.deepEqual(names(release), ["release-pack", "docs", "portal", "engine", "links"], "one order keeps name order; a gate without one comes after");
  const base = head(root);
  await put(root, "portal/index.html", "<p>changed</p>\n");
  await put(root, "README.md", "# Changed\n");
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: ordered, base })), ["docs", "portal", "links"]);
  // Without an order the plan is by name, as before.
  assert.deepEqual(names(await planGates({ projectRoot: root, gates: GATES, release: true })), ["engine", "links", "portal", "release-pack"]);
});

test("508-R7, D8: the declarations digest leaves the order out, and still changes with a command, a cover or required", async (context) => {
  const root = await project(await scratch(context));
  const plain = GATES.filter((entry) => entry.name !== "release-pack");
  const ordered = plain.map((entry, index) => ({ ...entry, order: plain.length - index }));
  assert.equal(gateDeclarationsDigest(ordered), gateDeclarationsDigest(plain), "only the orders differ");
  const reversed = plain.map((entry, index) => ({ ...entry, order: index + 1 }));
  assert.equal(gateDeclarationsDigest(reversed), gateDeclarationsDigest(plain));
  const [release, releaseOrdered] = [await planGates({ projectRoot: root, gates: plain, release: true }), await planGates({ projectRoot: root, gates: ordered, release: true })];
  assert.deepEqual([releaseOrdered.declarationsDigest, releaseOrdered.roots], [release.declarationsDigest, release.roots]);
  assert.notDeepEqual(names(releaseOrdered), names(release), "while the plan's order follows the orders");
  const portal = ordered.find((entry) => entry.name === "portal");
  for (const [label, changed] of [
    ["command", { command: ["node", "-e", "process.exit(0)"] }],
    ["covers", { covers: ["portal/**", "docs/**"] }],
    ["required", { required: false }],
  ]) {
    const redeclared = ordered.map((entry) => entry === portal ? { ...entry, ...changed } : entry);
    assert.notEqual(gateDeclarationsDigest(redeclared), gateDeclarationsDigest(ordered), label);
  }
});

test("508-R7: a declaration's order is a positive integer, checked on every write, and kept by the record", async (context) => {
  const base = await scratch(context);
  const library = join(base, ".ether");
  process.env.EINZBERN_HOME = join(base, "desk");
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });
  assert.deepEqual(checkGateDeclaration(gate(["**"], { order: 4 })), gate(["**"], { order: 4 }));
  assert.equal(Object.hasOwn(checkGateDeclaration(gate(["**"])), "order"), false, "a declaration without an order has none");
  for (const order of [0, -1, 2.5, "3", null]) {
    assert.throws(() => checkGateDeclaration(gate(["**"], { order })), (error) => error?.reasonCode === "GATES_CONFIG_INVALID" && error.details.field === "order", JSON.stringify(order));
  }
  await setGate(library, { name: "portal", gate: gate(["portal/**"], { order: 2 }), occurredAt: at() });
  await setGate(library, { name: "links", gate: gate(["**/*.md"]), occurredAt: at() });
  const gates = listGates(await materializeWorkspace(library));
  assert.deepEqual(gates.map((entry) => [entry.name, entry.order]), [["links", undefined], ["portal", 2]], "listed by name, each with its order");
});

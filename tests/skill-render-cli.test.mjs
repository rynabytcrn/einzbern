// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-479 R1, AC1, AC3 through the CLI (MIN-227 D28; TCRN-CROSS-SUB-322): skill-render
// writes the skill directory the engine generates for its version: SKILL.md, rendered exactly as
// the core renders it against this engine's command catalog, and references/, agents/ and scripts/
// copied from the template beside the engine. Every verb the generated table names is one that
// `commands` lists, the file stays under 6000 bytes, --out must be missing or empty, a refusal
// writes nothing, and the verb runs only where the template sits beside the engine: its source tree
// or a release. Every case writes into a temporary directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION } from "../dist/build/packages/core/src/index.js";
import { computeInstallTreeDigest } from "../dist/build/packages/core/src/install-tree-digest.js";
import { BRAND } from "../dist/build/packages/core/src/names.js";
import { SKILL_MARKDOWN_BYTE_LIMIT, renderSkillMarkdown } from "../dist/build/packages/core/src/skill-render.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const templateDirectory = join(repositoryRoot, "skill", BRAND.helper.id);
const bundleScript = join(repositoryRoot, "scripts", "bundle.mjs");
const cliEntry = join(repositoryRoot, "scripts", "einzbern.mjs");
const TEMPLATE_PARTS = Object.freeze(["references", "agents", "scripts"]);

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-skill-render-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function invoke(args) {
  let output = "";
  try {
    await runCli(args, { write: (value) => { output += value; } });
    return { ok: true, report: JSON.parse(output) };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode, message: String(error?.message ?? error) };
  }
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

// Every file under root/prefix (all of root when prefix is empty), relative to root, with POSIX
// separators.
async function walk(root, prefix = "") {
  const found = [];
  const directory = prefix === "" ? root : join(root, ...prefix.split("/"));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await walk(root, path));
    else found.push(path);
  }
  return found;
}

async function templateFiles(root) {
  const found = [];
  for (const part of TEMPLATE_PARTS) {
    if (await exists(join(root, part))) found.push(...await walk(root, part));
  }
  return found.sort();
}

// The verbs in the second column of the generated navigation table.
function tableVerbs(markdown) {
  const lines = markdown.split("\n");
  const header = lines.indexOf("| Moment | Verb | What to do |");
  assert.ok(header > 0, "SKILL.md holds the navigation table");
  const verbs = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("| ")) break;
    const cell = line.slice(2, -2).split(" | ")[1];
    verbs.push(...[...cell.matchAll(/`([a-z][a-z0-9-]*)`/gu)].map((match) => match[1]));
  }
  return verbs;
}

test("479-R1: skill-render writes SKILL.md and copies the template's references, agents and scripts", async (context) => {
  const base = await scratch(context);
  const out = join(base, "skill");
  const outcome = await invoke(["skill-render", "--out", out]);
  assert.equal(outcome.ok, true, outcome.message);
  const { report } = outcome;
  assert.equal(report.reasonCode, "SKILL_RENDERED");
  assert.equal(report.skill, BRAND.helper.id);
  assert.equal(report.version, FRAMEWORK_VERSION, "the engine's own version when --version is not given");
  assert.equal(report.out, out);
  assert.equal(await exists(join(templateDirectory, "SKILL.md")), false, "the template keeps no SKILL.md");
  const copied = await templateFiles(templateDirectory);
  assert.ok(copied.includes("agents/openai.yaml") && copied.filter((path) => path.startsWith("references/")).length === 6);
  assert.deepEqual([...report.files].sort(), ["SKILL.md", ...copied].sort());
  assert.deepEqual((await walk(out)).sort(), ["SKILL.md", ...copied].sort(), "the directory holds SKILL.md and the template's files, nothing else");
  for (const path of copied) {
    assert.deepEqual(await readFile(join(out, ...path.split("/"))), await readFile(join(templateDirectory, ...path.split("/"))), `${path} is copied byte for byte`);
  }
  assert.equal(report.installTreeDigest, (await computeInstallTreeDigest(out)).sha256);
});

test("479-R1: the generated SKILL.md is the core rendering for this engine's version and command catalog", async (context) => {
  const base = await scratch(context);
  const out = join(base, "skill");
  assert.equal((await invoke(["skill-render", "--out", out])).ok, true);
  const expected = renderSkillMarkdown({ version: FRAMEWORK_VERSION, catalogNames: COMMAND_CATALOG.map((entry) => entry.name) });
  assert.equal(await readFile(join(out, "SKILL.md"), "utf8"), expected);
  const versioned = join(base, "versioned");
  const outcome = await invoke(["skill-render", "--out", versioned, "--version", "2.0.0-rc.1"]);
  assert.equal(outcome.report.version, "2.0.0-rc.1");
  assert.equal(await readFile(join(versioned, "SKILL.md"), "utf8"), renderSkillMarkdown({ version: "2.0.0-rc.1", catalogNames: COMMAND_CATALOG.map((entry) => entry.name) }));
});

test("479-AC1, AC3 through the CLI: every verb the generated table names is listed by commands, and SKILL.md retains its complete generated command contract", async (context) => {
  const base = await scratch(context);
  const out = join(base, "skill");
  assert.equal((await invoke(["skill-render", "--out", out])).ok, true);
  const markdown = await readFile(join(out, "SKILL.md"), "utf8");
  const listed = (await invoke(["commands"])).report.commands.map((entry) => entry.name);
  const verbs = tableVerbs(markdown);
  // The full-text moment includes both project context and the packaged evidence entry.
  assert.equal(verbs.length, 12, "the six moments name twelve verbs");
  assert.ok(verbs.includes("execution-evidence"), "the installed workflow names its public evidence entry");
  for (const verb of verbs) assert.ok(listed.includes(verb), `${verb} is listed by commands`);
  assert.ok(listed.includes("skill-render"), "skill-render is itself listed by commands");
  assert.ok(Buffer.byteLength(markdown, "utf8") < SKILL_MARKDOWN_BYTE_LIMIT);
  assert.equal(SKILL_MARKDOWN_BYTE_LIMIT, Number.MAX_SAFE_INTEGER, "runtime Buffer capacity replaces the retired product ceiling");
});

test("479-R1: --out must be missing or empty, and a refusal writes nothing", async (context) => {
  const base = await scratch(context);
  const occupied = join(base, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "mine\n");
  const refused = await invoke(["skill-render", "--out", occupied]);
  assert.equal(refused.reasonCode, "SKILL_OUT_NOT_EMPTY");
  assert.deepEqual(await readdir(occupied), ["keep.txt"]);
  assert.equal(await readFile(join(occupied, "keep.txt"), "utf8"), "mine\n");

  const file = join(base, "a-file");
  await writeFile(file, "x\n");
  assert.equal((await invoke(["skill-render", "--out", file])).reasonCode, "SKILL_OUT_NOT_EMPTY");
  assert.equal(await readFile(file, "utf8"), "x\n");

  const empty = join(base, "empty");
  await mkdir(empty);
  assert.equal((await invoke(["skill-render", "--out", empty])).ok, true, "an empty directory is accepted");

  const invalid = join(base, "invalid");
  assert.equal((await invoke(["skill-render", "--out", invalid, "--version", "latest"])).reasonCode, "SKILL_VERSION_INVALID");
  assert.equal(await exists(invalid), false, "a refused version creates nothing");
  assert.equal((await invoke(["skill-render"])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await invoke(["skill-render", "--out", join(base, "x"), "--source", base])).reasonCode, "CLI_ARGUMENT_UNKNOWN");
});

test("479-R1: in a release the verb copies the template beside the bundled engine, and refuses without one", async (context) => {
  const base = await scratch(context);
  const release = join(base, "release");
  const bundled = join(release, "scripts", "einzbern.mjs");
  const written = spawnSync(process.execPath, [bundleScript, "--entry", cliEntry, "--out", bundled], { encoding: "utf8" });
  assert.equal(written.status, 0, written.stderr);
  const home = join(base, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, EINZBERN_HOME: join(home, "einzbern") };
  const run = (out) => spawnSync(process.execPath, [bundled, "skill-render", "--out", out], { cwd: base, encoding: "utf8", env });
  const lastLine = (text) => JSON.parse(text.trim().split("\n").at(-1));

  const missing = run(join(base, "out-missing"));
  assert.equal(missing.status, 1);
  assert.equal(lastLine(missing.stderr).reasonCode, "SKILL_SOURCE_MISSING");
  assert.equal(await exists(join(base, "out-missing")), false);

  const template = join(release, "skill", BRAND.helper.id);
  await mkdir(join(template, "references"), { recursive: true });
  await writeFile(join(template, "references", "install.md"), "# install from the release\n");
  const incomplete = run(join(base, "out-incomplete"));
  assert.equal(incomplete.status, 1);
  assert.equal(lastLine(incomplete.stderr).reasonCode, "SKILL_SOURCE_MISSING", "a template without agents/ is incomplete");

  await mkdir(join(template, "agents"));
  await writeFile(join(template, "agents", "openai.yaml"), "interface: {}\n");
  await mkdir(join(template, "scripts"));
  await writeFile(join(template, "scripts", "install.mjs"), "export {};\n");
  const out = join(base, "out");
  const rendered = run(out);
  assert.equal(rendered.status, 0, rendered.stderr);
  const report = lastLine(rendered.stdout);
  assert.equal(report.reasonCode, "SKILL_RENDERED");
  assert.deepEqual(report.files, ["SKILL.md", "agents/openai.yaml", "references/install.md", "scripts/install.mjs"]);
  assert.equal(await readFile(join(out, "references", "install.md"), "utf8"), "# install from the release\n");
  assert.equal(await readFile(join(out, "SKILL.md"), "utf8"), renderSkillMarkdown({ version: FRAMEWORK_VERSION, catalogNames: COMMAND_CATALOG.map((entry) => entry.name) }));
});

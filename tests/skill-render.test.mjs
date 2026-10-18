// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-479 R1, AC1, AC3 (MIN-227 D28; TCRN-CROSS-SUB-319): the engine generates the
// SKILL.md of the Mana Orchestrate skill for its own version. Every verb the navigation table names
// is a verb of the current command catalog, and a verb the catalog lacks refuses the rendering; the
// file stays under 6000 bytes and carries none of the wizard text the references hold; and its
// description is the finalized English description A, word for word.

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { BRAND, LEGACY_REPOSITORY_NAMES } from "../dist/build/packages/core/src/names.js";
import {
  SKILL_DESCRIPTION,
  SKILL_MARKDOWN_BYTE_LIMIT,
  SKILL_NAVIGATION,
  SkillRenderError,
  renderSkillMarkdown,
  skillNamedVerbs,
} from "../dist/build/packages/core/src/skill-render.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const referenceDirectory = join(repositoryRoot, "skill", BRAND.helper.id, "references");
const descriptionFixture = join(repositoryRoot, "tests", "fixtures", "skill", "description-a.en.txt");
const catalogNames = COMMAND_CATALOG.map((entry) => entry.name);
const version = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;

// Text that belongs to the wizard references and never to SKILL.md: each phrase is checked below
// to occur in at least one reference, so the list cannot drift into words the references lack.
const WIZARD_PHRASES = Object.freeze([
  "setup --mode",
  "SETUP_PLAN_READY",
  "SETUP_APPLIED",
  "--yes true",
  "AskUserQuestion",
  "Questions (one screen)",
  "doctor --project",
  "--managed-sections",
  "--rollback",
  "--mapping",
  "--restore",
  "--archive",
  "selfCheck",
]);
// Built from parts so that this file does not itself read as a local path.
const LOCAL_PATHS = Object.freeze([["", "Users", ""].join("/"), ["", "home", ""].join("/"), ["", "Users", ""].join("\\")]);

function render(overrides = {}) {
  return renderSkillMarkdown({ version, catalogNames, ...overrides });
}

function refusal(reasonCode, check = () => true) {
  return (error) => error instanceof SkillRenderError && error.reasonCode === reasonCode && check(error);
}

function frontmatter(markdown) {
  const lines = markdown.split("\n");
  assert.equal(lines[0], "---", "SKILL.md opens with its frontmatter");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 1, "the frontmatter is closed");
  return Object.fromEntries(lines.slice(1, end).map((line) => {
    const colon = line.indexOf(": ");
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
}

function tableRows(markdown) {
  const lines = markdown.split("\n");
  const header = lines.indexOf("| Moment | Verb | What to do |");
  assert.ok(header > 0, "SKILL.md holds the navigation table");
  assert.equal(lines[header + 1], "| --- | --- | --- |");
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ");
    assert.equal(cells.length, 3, `${line} has three cells`);
    rows.push(cells);
  }
  return rows;
}

async function references() {
  const names = (await readdir(referenceDirectory)).filter((name) => name.endsWith(".md")).sort();
  assert.equal(names.length, 6, "the six install-type references are present");
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(referenceDirectory, name), "utf8") })));
}

test("479-AC1: every verb the navigation table names is a verb of the current command catalog", () => {
  // STORY-479 AC1 with EPIC-144 R3: reading the full text before development dispatch includes
  // each involved project's own configuration (work-project-context).
  assert.deepEqual(SKILL_NAVIGATION.map((entry) => [...entry.verbs]), [
    ["recall"],
    ["work-show", "minutes-show", "work-project-context", "dispatch-evidence"],
    ["work-transition", "work-annotate"],
    ["minutes-record"],
    ["knowledge-create"],
    ["settings-catalog"],
  ]);
  for (const verb of skillNamedVerbs()) assert.ok(catalogNames.includes(verb), `${verb} is in COMMAND_CATALOG`);
  const rows = tableRows(render());
  assert.equal(rows.length, SKILL_NAVIGATION.length, "one table row per navigation entry");
  rows.forEach(([moment, verbs], index) => {
    const entry = SKILL_NAVIGATION[index];
    assert.equal(moment, entry.moment);
    assert.equal(verbs, entry.verbs.map((verb) => `\`${verb}\``).join(", "));
    for (const verb of entry.verbs) assert.ok(catalogNames.includes(verb), `${verb} in the table is in COMMAND_CATALOG`);
  });
});

test("479-R1, 475-R4: the table records a decision as soon as it is judged one and echoes its number", () => {
  const rows = tableRows(render());
  const decision = rows.find(([, verbs]) => verbs === "`minutes-record`");
  assert.ok(decision !== undefined, "the decision row names minutes-record");
  assert.ok(decision[2].includes("As soon as you judge"), "the row records at the moment of judgement");
  assert.ok(decision[2].includes("已记 <minutes key> Dn"), "the row echoes the minutes key and decision number");
  const design = rows.find(([, verbs]) => verbs === "`settings-catalog`");
  assert.ok(design[2].includes("`design.authority`"), "UI design reads design.authority first");
});

// INIT-053 U10 (approved contract item 9): the native host dispatch passes each target's own handoff,
// the object gate processes receive, and an unresolved target stops only the work that needs it.
test("U10: the full-text row passes each target's handoff to the native host dispatch, as gate processes receive it", () => {
  const fullText = tableRows(render()).find(([, verbs]) => verbs.includes("`work-project-context`"));
  for (const phrase of ["`handoff`", "a native host dispatch passes that object for that target", "the same object as `EINZBERN_PROJECT_CONTEXT`", "stops only the work that needs it", "Coordination-only work requires no invented development target"]) {
    assert.ok(fullText[2].includes(phrase), phrase);
  }
});

// TCRN-CROSS-STORY-532 (MIN-256 D6): several sessions write to one library at once; the engine queues
// their writes, so none steps aside for another, and only a migration may ask the user to stop the others.
test("532 (MIN-256 D6): the navigation says the engine queues concurrent writes, so no session steps aside", () => {
  const markdown = render();
  const lines = markdown.split("\n");
  const navigation = lines.indexOf("## Navigation");
  const table = lines.indexOf("| Moment | Verb | What to do |");
  const note = lines.findIndex((line) => line.startsWith("Several sessions can work in one library at the same time:"));
  assert.ok(navigation > 0 && navigation < note && note < table, "the note stands in the Navigation section, before the table");
  for (const phrase of ["the engine queues their writes", "no session has to stop or step aside for another", "Except for a migration, never ask the user to stop the other sessions."]) {
    assert.ok(lines[note].includes(phrase), phrase);
  }
  assert.ok(Buffer.byteLength(markdown, "utf8") < 6000, `${Buffer.byteLength(markdown, "utf8")} bytes`);
});

test("479-AC1: a verb the command catalog does not carry refuses the rendering", () => {
  for (const verb of skillNamedVerbs()) {
    const without = catalogNames.filter((name) => name !== verb);
    assert.throws(() => render({ catalogNames: without }), refusal("SKILL_NAVIGATION_VERB_UNKNOWN", (error) => error.details.verb === verb), verb);
  }
  assert.throws(() => render({ catalogNames: [] }), refusal("SKILL_NAVIGATION_VERB_UNKNOWN"));
});

test("479-AC3: SKILL.md stays under 6000 bytes and carries none of the wizard text", async () => {
  const markdown = render();
  assert.ok(SKILL_MARKDOWN_BYTE_LIMIT > 6000);
  assert.ok(Buffer.byteLength(markdown, "utf8") < 6000, `${Buffer.byteLength(markdown, "utf8")} bytes`);
  const texts = await references();
  for (const phrase of WIZARD_PHRASES) {
    assert.ok(texts.some(({ text }) => text.includes(phrase)), `${phrase} is wizard text in a reference`);
    assert.equal(markdown.includes(phrase), false, `SKILL.md carries the wizard text ${phrase}`);
  }
  for (const { name, text } of texts) {
    for (const line of text.split("\n").map((value) => value.trim()).filter((value) => value.length >= 40)) {
      assert.equal(markdown.includes(line), false, `SKILL.md repeats a line of ${name}: ${line}`);
    }
  }
});

test("479-AC3: SKILL.md points to references/ for install-type tasks only, naming files that exist", async () => {
  const markdown = render();
  const pointer = markdown.split("\n").filter((line) => line.includes("`references/`"));
  assert.equal(pointer.length, 1, "one line points to references/");
  assert.ok(pointer[0].includes("never load them for any other work"));
  const named = [...pointer[0].matchAll(/`([a-z]+\.md)`/gu)].map((match) => match[1]).sort();
  assert.deepEqual(named, (await references()).map(({ name }) => name));
  for (const name of named) await access(join(referenceDirectory, name));
});

test("INC-399: a valid rendering beyond the former 6000-byte ceiling is complete", () => {
  const long = `1.0.0-${"x".repeat(6001)}`;
  const complete = render({ version: long });
  assert.ok(Buffer.byteLength(complete) > 6000);
  assert.ok(complete.includes(long));
});

test("479-R1: the description is the finalized English description A, word for word", async () => {
  const fixture = await readFile(descriptionFixture, "utf8");
  assert.ok(fixture.endsWith("\n") && !fixture.endsWith("\n\n"), "the fixture ends with one newline");
  const finalized = fixture.slice(0, -1);
  assert.equal(SKILL_DESCRIPTION, finalized);
  const fields = frontmatter(render());
  assert.deepEqual(Object.keys(fields), ["name", "description"]);
  assert.equal(fields.name, BRAND.helper.id);
  assert.equal(JSON.parse(fields.description), finalized);
});

test("479-R1: SKILL.md is generated for one engine version, the same way every time", () => {
  const markdown = render();
  assert.equal(render(), markdown, "the same input renders the same bytes");
  assert.ok(markdown.includes(`Navigation for ${BRAND.engine.name} ${version}:`), "the version it was generated for");
  assert.ok(render({ version: "2.0.0-rc.1" }).includes(`${BRAND.engine.name} 2.0.0-rc.1:`));
  assert.ok(markdown.endsWith("\n") && !markdown.endsWith("\n\n"), "one final newline");
  assert.equal(markdown.includes("\r"), false);
  for (const path of LOCAL_PATHS) assert.equal(markdown.includes(path), false, "no local path");
  for (const bad of ["latest", "1.2", "v1.2.1", "1.2.1\n# injected", ""]) {
    assert.throws(() => render({ version: bad }), refusal("SKILL_VERSION_INVALID"), JSON.stringify(bad));
  }
});

test("488-AC2 (MIN-238 D4): the install line and the fetch script name both repositories under the existing account", async () => {
  const lines = render().split("\n").filter((line) => line.includes("npx skills add"));
  assert.equal(lines.length, 1, "one line installs the skill");
  const helper = lines[0].match(/`npx skills add ([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)`/u);
  assert.ok(helper, lines[0]);
  const installer = await readFile(join(repositoryRoot, "skill", BRAND.helper.id, "scripts", "install.mjs"), "utf8");
  const constants = [...installer.matchAll(/^const RELEASE_REPOSITORY = "([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)";$/gmu)];
  assert.equal(constants.length, 1, "the fetch script names one release repository");
  const [, engineOwner, engineRepository] = constants[0];
  const [, helperOwner, helperRepository] = helper;
  assert.equal(helperRepository, BRAND.helper.id);
  assert.equal(engineRepository, BRAND.engine.id);
  assert.equal(helperOwner, engineOwner, "one account holds both repositories");
  assert.equal(engineOwner, LEGACY_REPOSITORY_NAMES.owner, "renamed under the existing account, not the placeholder");
});

test("552: generated dispatch workflow consumes admission rather than treating a catalog as permission", () => {
  const row = tableRows(render()).find(([, verbs]) => verbs.includes("`work-project-context`"));
  for (const phrase of ["--execution-request", "`dispatchAdmitted` is true", "Pass its selected runner/model/effort exactly", "never substitute", "not a global scheduler", "stdout, stderr and exit code"]) assert.ok(row[2].includes(phrase), phrase);
});

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
    ["work-show", "minutes-show", "work-project-context", "execution-prepare", "execution-record", "execution-evidence"],
    ["execution-native-prepare", "execution-native-record", "execution-native-evidence"],
    ["shared-submit-plan", "shared-submit-evidence", "shared-submit-advisory-read", "shared-submit-advisory-write"],
    ["config-backup-plan", "config-backup-create", "config-backup-verify", "config-backup-list", "config-backup-resume", "config-backup-retire", "config-restore-plan", "config-restore-apply"],
    ["work-transition", "work-annotate"],
    ["minutes-record"],
    ["knowledge-create", "knowledge-capture"],
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

// Local write queues retain their scope: incremental remote publication needs serial handoff.
test("532 / DOT-R01: local queue guidance does not imply a distributed lock or platform service", () => {
  const markdown = render();
  const lines = markdown.split("\n");
  const navigation = lines.indexOf("## Navigation");
  const table = lines.indexOf("| Moment | Verb | What to do |");
  const note = lines.findIndex((line) => line.startsWith("Local sessions share"));
  assert.ok(navigation > 0 && navigation < note && note < table);
  for (const phrase of ["queued writes without stepping aside", "not cross-device exclusion", "serial handoff", "No platform-native dot hook, background lifecycle manager or sync service is installed"]) {
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
  for (const phrase of ["--execution-request", "`dispatchAdmitted` is true", "Pass its selected runner/model/effort exactly", "never substitute", "not a reusable permit or a global scheduler", "stdout, stderr and exit code"]) assert.ok(row[2].includes(phrase), phrase);
  assert.ok(row[2].includes("`execution-evidence --from-file <json>` remains read-only validation, not authentication"),
    "J17: retain the exact public process-evidence navigation and its non-authentication boundary");
  assert.ok(row[2].includes("specs/dispatch-admission-evidence-v1.md"));
});

// Original DOT-R01/R02/R03 generation consumers: authored here, actual sessions remain E4.
test("DOT-R01/R02: generated navigation separates native evidence, rules, schedules and permission", () => {
  const markdown = render();
  const native = tableRows(markdown).find(([, verbs]) => verbs.includes("`execution-native-prepare`"))[2];
  for (const phrase of ["Machine-assemble private inputs from current tool results", "never ask users to hand-fill JSON", "reapprove authorized dispatch bookkeeping", "Unknown capability is not pass", "not-applicable", "actual model may be unavailable", "targetDispatchAdmitted", "pending attempt", "raw source and attempt association", "unknown retains responsibility", "validates, not authenticates"]) assert.ok(native.includes(phrase), phrase);
  for (const phrase of ["parent or patrol reads do not substitute", "INIT batch covers all pending Stories", "at most five sourced lessons", "No dynamic progress in AGENTS", "independent dot target", "Installation, policy changes, restoration and publication retain their separate approvals", "20-minute patrol", "00:00 Asia/Shanghai", "unapproved policy forbids daily enablement", "unknown stays unknown"]) assert.ok(markdown.includes(phrase), phrase);
  for (const phrase of ["saved prepare output as `--binding`", "prior full output as `--prior`", "inspect merged history", "--retry-from", "--reconciliation", "query unknown first"]) assert.ok(native.includes(phrase), phrase);
  assert.ok(markdown.includes("actual engine bundle root `specs/` (beside `scripts/`), not this Skill"),
    "J02: closed inputs come from the actual shipped contracts, not only flag help or source TS");
  const shared = tableRows(markdown).find(([, verbs]) => verbs.includes("`shared-submit-plan`"))[2];
  for (const phrase of ["Complete baseline", "one complete pre-submit refresh", "engine reapply", "serial handoff", "segments before manifest", "verify remote bytes", "complete destination", "observe release", "Advisory is not a lock", "absence/age grants nothing", "Query unknown publication before retry"]) assert.ok(shared.includes(phrase), phrase);
});

test("DOT-R02: dot install reference is complete, source-bound and separate from traditional hooks", async () => {
  const text = await readFile(join(referenceDirectory, "install.md"), "utf8");
  for (const phrase of ["--execution-target chatgpt-dot", "--dot-input", "DotAgentsOptions", "engineCommit", "unavailable", "Catalog membership is not enablement", "preInjection", "skip performs no target write", "SETUP_DOT_PARTIAL", "sessionRead: \"not-verified\"", "Parent/patrol observations cannot substitute", "00:00 Asia/Shanghai", "Two distinct successful checks at least 20 minutes apart", "pending-resume", "activeLimit", "recoveryDuration", "exact policy digest", "two stable content-tree observations", "not release certification", "SharedSubmitInput", "no acquire, force-expiry or remote CAS flag"]) assert.ok(text.includes(phrase), phrase);
  const dotSection = text.slice(text.indexOf("## Choose the installation target first"), text.indexOf("## Traditional target workflow"));
  assert.ok(dotSection.includes("do not ask the\nuser to hand-fill JSON"));
  assert.ok(dotSection.includes("does not prove that an\nexecution session read them"));
  assert.ok(dotSection.includes("No retention amounts or cleanup permission"));
  assert.ok(dotSection.includes("sourceVersion") || dotSection.includes("Source identity is obtained asynchronously"));
  assert.ok(text.indexOf("## Traditional target workflow") < text.indexOf("## Questions (one screen)"));
});

test("J01/J02/J03/J04/J09–J13: install guidance consumes reviewed source interfaces without promoting unknown or cached claims", async () => {
  const text = (await readFile(join(referenceDirectory, "install.md"), "utf8")).replace(/\s+/gu, " ");
  for (const phrase of [
    "actual engine bundle root contains `scripts/einzbern.mjs` and its sibling `specs/`",
    "contracts are not in this Skill's directory",
    "required/optional/null fields, enums and digest rules",
    "rule-list --workspace <actual-library> --project-id <actual-project>",
    'dotRuleSources.status: "available"', "inherited enabled rules are included",
    "enabledRules: null", "Never substitute catalog entries or `[]`",
    "--approved-plan-digest <saved-digest>", "previously reviewed `dot.planDigest` unchanged",
    "same mode, project, at and dot-input", "Do not compute a new digest at apply time",
    "returns a new preview and refuses before writing",
    "full `tcrn.native-dispatch-preparation.v1`", "do not pass stdout's outer object",
    "Omit `--prior` only for the first record", "previous full saved output",
    "new create-only `--output`", "revalidated merged `history` / `normalized`",
    "--retry-from <previous-saved-record>", "--reconciliation <private-json>",
    "Query unknown outcomes first", "confirmed-not-executed", "notExecutedPointer",
    "Completed, conflicting or unresolved predecessors cannot retry",
    "Source association and digests are not provider authentication",
    "Independent dot user fragments and rules are unmappable",
    "preserves the independent AGENTS and provenance bytes",
    "projection pending, not rendered",
    "Ordinary terminal checks do not clear pending resume/pause",
    "Unknown actual enabled state stays unknown",
    "fresh matching false readback after the current action boundary",
    "historical disabled state cannot confirm this request",
    "Readback must match the original ID, group, selection and fixed schedule",
    "strictly later than both `lastReadbackAt` and the current boundary's `returnedAt`",
    "Older/equal reads refuse",
    "Missing boundaries, including legacy unknown state, stay unknown rather than treating a late read as proof",
    "merge.observedAt", "writerHandoff.observedAt",
    "local completion <= fresh refresh <= merge observation <= handoff observation <= advisory observation <= every publication",
    "Missing times stay pending", "Never fill phase timestamps with JSON assembly time",
  ]) assert.ok(text.includes(phrase), phrase);
});

// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-478 R1, R2, R6, AC1-AC3 (MIN-227 D14; TCRN-CROSS-SUB-316): the managed-section
// writer. The engine changes only the lines between its own markers; a section the user changed
// is left alone and goes pending; a section the user deleted is not put back; a file whose markers
// do not parse is refused whole with the line; CRLF and trailing white space are not changes; a
// missing file is created only for a section to write; a second render writes nothing.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import {
  applyManagedWrite,
  managedSectionRecordKey,
  managedSectionRecordsFor,
  normalizeSectionBody,
  parseManagedFile,
  planManagedWrite,
  renderSection,
  sectionDigest,
} from "../dist/build/packages/core/src/managed-sections.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 7, 0, second)).toISOString().replace(".000Z", "Z");
};

const NAV_V1 = "This project is managed by Einzbern.\nLoad Mana Orchestrate before you start.\nStart by recalling.\n";
const NAV_V2 = "This project is managed by Einzbern.\nLoad Mana Orchestrate before work starts.\nStart with recall.\n";
const RULE_V1 = "Autonomy v1: act without asking.\n";
const RULE_V2 = "Autonomy v1: act without asking; stop only before a destructive step.\n";
const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-managed-sections-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(project);
  return { base, project, backups: join(base, "device", "backups") };
}

/** Plan and apply one render of `desired` into the file, as a caller holding the library's records would. */
async function render(filePath, desired, records, backupRoot) {
  const plan = await planManagedWrite({ filePath, desired, records });
  const applied = await applyManagedWrite(plan, { now: at(), backupRoot });
  return { plan, applied, records: plan.sections.map((decision) => decision.record) };
}

const results = (plan) => plan.sections.map((decision) => [decision.id, decision.result, decision.record.state]);

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

test("478-AC1: a section the user changed by one character stays as it is and goes pending; the untouched one is updated", async (context) => {
  const { base, project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  await writeFile(path, USER_TEXT);
  const first = await render(path, [{ id: "navigation", body: NAV_V1 }, { id: "rule:autonomy", body: RULE_V1 }], [], backups);
  assert.deepEqual(results(first.plan), [["navigation", "create", "managed"], ["rule:autonomy", "create", "managed"]]);
  const written = await readFile(path, "utf8");
  assert.ok(written.startsWith(`${USER_TEXT}\n`), "the user's text stays where it was");

  // The user changes one character inside the navigation section.
  const edited = written.replace("Start by recalling.", "Start by recallin.");
  assert.notEqual(edited, written);
  await writeFile(path, edited);

  const next = await render(path, [{ id: "navigation", body: NAV_V2 }, { id: "rule:autonomy", body: RULE_V2 }], first.records, backups);
  assert.deepEqual(results(next.plan), [["navigation", "refused-user-modified", "pending"], ["rule:autonomy", "replace", "managed"]]);
  assert.deepEqual(next.plan.pending, ["navigation"]);
  const navigation = next.plan.sections[0].record;
  assert.equal(navigation.rev, 1, "a pending section keeps the baseline the engine wrote");
  assert.equal(navigation.digest, sectionDigest(NAV_V1));

  const after = await readFile(path, "utf8");
  const [editedNavigation] = parseManagedFile(edited).sections;
  const [afterNavigation, afterRule] = parseManagedFile(after).sections;
  assert.equal(afterNavigation.raw, editedNavigation.raw, "the changed section is byte-identical");
  assert.equal(afterRule.rev, 2);
  assert.equal(afterRule.body, normalizeSectionBody(RULE_V2), "the untouched section is updated");
  assert.equal(afterRule.digest, sectionDigest(RULE_V2));
  assert.deepEqual(parseManagedFile(after).outside, parseManagedFile(edited).outside, "nothing outside the sections changed");

  // The records the render left are what the library keeps; the pending section is visible there.
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  process.env.EINZBERN_HOME = desk;
  let output = "";
  await runCli(["init", "--workspace", library, "--at", at()], { write: (value) => { output += value; } });
  assert.equal(JSON.parse(output).reasonCode, "LIBRARY_CREATED");
  for (const decision of next.plan.sections) {
    await setConfigRecord(library, { collection: "managed-section", key: managedSectionRecordKey("AGENTS.md", decision.id), value: decision.record, occurredAt: at() });
  }
  const kept = managedSectionRecordsFor(await materializeWorkspace(library), "AGENTS.md");
  assert.deepEqual(kept.map((record) => [record.id, record.state]), [["navigation", "pending"], ["rule:autonomy", "managed"]]);
});

test("478-AC2: a section the user deleted with its markers is not put back, and its record says removed", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  await writeFile(path, USER_TEXT);
  const first = await render(path, [{ id: "navigation", body: NAV_V1 }, { id: "rule:autonomy", body: RULE_V1 }], [], backups);
  const written = await readFile(path, "utf8");
  const [navigation] = parseManagedFile(written).sections;
  await writeFile(path, written.replace(navigation.raw, ""));

  const next = await render(path, [{ id: "navigation", body: NAV_V2 }, { id: "rule:autonomy", body: RULE_V2 }], first.records, backups);
  assert.deepEqual(results(next.plan), [["rule:autonomy", "replace", "managed"], ["navigation", "removed", "removed"]]);
  const removed = next.plan.sections.find((decision) => decision.id === "navigation");
  assert.equal(removed.recordChanged, true);
  assert.equal(removed.line, null);
  const after = await readFile(path, "utf8");
  assert.equal(after.includes("id=navigation"), false, "the removed section is not put back");

  const third = await render(path, [{ id: "navigation", body: NAV_V2 }, { id: "rule:autonomy", body: RULE_V2 }], next.records, backups);
  assert.deepEqual(results(third.plan), [["rule:autonomy", "unchanged", "managed"], ["navigation", "removed", "removed"]]);
  assert.equal(third.plan.sections.some((decision) => decision.recordChanged), false);
  assert.equal(third.applied.written, false);
  assert.equal(await readFile(path, "utf8"), after);
});

test("478-AC3: a file whose markers do not parse is refused whole, naming the line", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  const start = (id) => `<!-- einzbern:section id=${id} rev=1 digest=${sectionDigest("x\n")} -->`;
  const end = (id) => `<!-- einzbern:section-end id=${id} -->`;
  const cases = [
    ["a start without its end", ["# Notes", "", start("navigation"), "x"], 3],
    ["a start inside another section", ["# Notes", start("navigation"), "x", start("rule:autonomy"), "x", end("rule:autonomy"), end("navigation")], 4],
    ["an end without its start", ["# Notes", end("navigation")], 2],
    ["an end naming another section", [start("navigation"), "x", end("rule:autonomy")], 3],
    ["one id twice", [start("navigation"), "x", end("navigation"), start("navigation"), "x", end("navigation")], 4],
    ["a missing attribute", ["# Notes", "<!-- einzbern:section id=navigation rev=1 -->", "x", end("navigation")], 2],
    ["an unknown attribute", [`<!-- einzbern:section id=navigation rev=1 digest=${"0".repeat(64)} owner=me -->`, "x", end("navigation")], 1],
    ["a revision that is not a number", [`<!-- einzbern:section id=navigation rev=one digest=${"0".repeat(64)} -->`, "x", end("navigation")], 1],
    ["a marker without its close", ["# Notes", "<!-- einzbern:section id=navigation"], 2],
  ];
  for (const [label, lines, line] of cases) {
    const text = `${lines.join("\n")}\n`;
    await writeFile(path, text);
    const error = await refusal(() => planManagedWrite({ filePath: path, desired: [{ id: "navigation", body: NAV_V1 }], records: [] }));
    assert.equal(error.reasonCode, "MANAGED_SECTION_MALFORMED", label);
    assert.equal(error.details.line, String(line), label);
    assert.equal(error.details.file, "AGENTS.md", label);
    assert.throws(() => parseManagedFile(text), { reasonCode: "MANAGED_SECTION_MALFORMED" }, label);
    assert.equal(await readFile(path, "utf8"), text, `${label}: nothing is written`);
  }
  assert.deepEqual(await readdir(project), ["AGENTS.md"], "no temporary file was left behind");
  // A line that mentions a marker inside other text is not a marker.
  await writeFile(path, "The engine writes <!-- einzbern:section id=x rev=1 digest=y --> markers.\n");
  const plan = await planManagedWrite({ filePath: path, desired: [{ id: "navigation", body: NAV_V1 }], records: [] });
  assert.deepEqual(results(plan), [["navigation", "create", "managed"]]);
  await applyManagedWrite(plan, { now: at(), backupRoot: backups });
});

test("478-R1: CRLF and trailing white space are not changes; a CRLF file keeps its line endings", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  await writeFile(path, USER_TEXT);
  const first = await render(path, [{ id: "navigation", body: NAV_V1 }], [], backups);
  const windows = (await readFile(path, "utf8")).split("\n").map((line) => (line.startsWith("Start") ? `${line} \t` : line)).join("\r\n");
  await writeFile(path, windows);

  const same = await render(path, [{ id: "navigation", body: NAV_V1 }], first.records, backups);
  assert.deepEqual(results(same.plan), [["navigation", "unchanged", "managed"]], "the section still reads as the engine wrote it");
  assert.equal(same.applied.written, false);
  assert.equal(await readFile(path, "utf8"), windows);

  const updated = await render(path, [{ id: "navigation", body: NAV_V2 }], same.records, backups);
  assert.deepEqual(results(updated.plan), [["navigation", "replace", "managed"]]);
  const after = await readFile(path, "utf8");
  assert.equal(after.replace(/\r\n/gu, "").includes("\n"), false, "every line of the file still ends in CRLF");
  assert.equal(parseManagedFile(after).sections[0].rev, 2);

  assert.equal(normalizeSectionBody("a  \r\nb\t\r\n\r\n\r\n"), "a\nb\n");
  assert.equal(sectionDigest("a  \r\nb\t\r\n"), sectionDigest("a\nb"));
  assert.equal(normalizeSectionBody("\n\n"), "");
});

test("478-R2: a missing file is created only when a section is to be written into it", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "CLAUDE.md");

  const nothing = await render(path, [], [], backups);
  assert.equal(nothing.plan.exists, false);
  assert.equal(nothing.plan.write, false);
  assert.equal(nothing.applied.written, false);
  await assert.rejects(stat(path), { code: "ENOENT" }, "no section to write, no file");

  // A file the user deleted with the sections the engine had written in it is not recreated.
  const previously = [{ file: "CLAUDE.md", id: "claude-import", rev: 1, digest: sectionDigest("@AGENTS.md\n"), state: "managed" }];
  const deleted = await render(path, [{ id: "claude-import", body: "@AGENTS.md\n" }], previously, backups);
  assert.deepEqual(results(deleted.plan), [["claude-import", "removed", "removed"]]);
  await assert.rejects(stat(path), { code: "ENOENT" });

  const created = await render(path, [{ id: "claude-import", body: "@AGENTS.md\n" }], [], backups);
  assert.deepEqual(results(created.plan), [["claude-import", "create", "managed"]]);
  assert.equal(created.applied.backupPath, null, "a new file has nothing to back up");
  assert.equal(await readFile(path, "utf8"), renderSection({ id: "claude-import", rev: 1, body: "@AGENTS.md\n" }));
});

test("478-R2: rendering again writes nothing, and a write backs the file up and replaces it through a rename", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  await writeFile(path, USER_TEXT);
  const first = await render(path, [{ id: "navigation", body: NAV_V1 }, { id: "rule:autonomy", body: RULE_V1 }], [], backups);
  assert.equal(first.applied.written, true);
  assert.match(first.applied.backupPath, /[/\\]managed-sections[/\\][0-9a-f]{16}[/\\]AGENTS\.md$/u);
  assert.equal(first.applied.backupPath.startsWith(join(backups, "20260926T07")), true, "under backups/<UTC second>/");
  assert.equal(await readFile(first.applied.backupPath, "utf8"), USER_TEXT, "the backup holds the file as it was");
  assert.deepEqual(await readdir(project), ["AGENTS.md"], "the temporary file was renamed into place");

  const bytes = await readFile(path, "utf8");
  const { mtimeMs } = await stat(path);
  const again = await render(path, [{ id: "navigation", body: NAV_V1 }, { id: "rule:autonomy", body: RULE_V1 }], first.records, backups);
  assert.deepEqual(results(again.plan), [["navigation", "unchanged", "managed"], ["rule:autonomy", "unchanged", "managed"]]);
  assert.equal(again.plan.sections.some((decision) => decision.recordChanged), false);
  assert.equal(again.plan.write, false);
  assert.equal(again.applied.written, false);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal((await stat(path)).mtimeMs, mtimeMs, "the file was not touched");

  // A change made between the plan and the write is not overwritten.
  const plan = await planManagedWrite({ filePath: path, desired: [{ id: "navigation", body: NAV_V2 }], records: again.records });
  await writeFile(path, `${bytes}More notes.\n`);
  const error = await refusal(() => applyManagedWrite(plan, { now: at(), backupRoot: backups }));
  assert.equal(error.reasonCode, "MANAGED_SECTION_CHANGED_SINCE_PLAN");
  assert.equal(await readFile(path, "utf8"), `${bytes}More notes.\n`);
});

test("478 implementation notes: a section never renders an absolute path, and only regular files are written", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, "AGENTS.md");
  await writeFile(path, USER_TEXT);
  for (const [body, line] of [["Run /opt/tools/bin/check first.\n", "1"], ["Paths:\nD:\\work\\tools\n", "2"], ["See (/data/share/docs) too.\n", "1"]]) {
    const error = await refusal(() => planManagedWrite({ filePath: path, desired: [{ id: "navigation", body }], records: [] }));
    assert.equal(error.reasonCode, "MANAGED_SECTION_ABSOLUTE_PATH", body);
    assert.equal(error.details.line, line, body);
  }
  const relative = await planManagedWrite({ filePath: path, desired: [{ id: "navigation", body: "See docs/wiki/Home.md, ~/.einzbern/backups and https://example.com/a/b.\n" }], records: [] });
  assert.deepEqual(results(relative), [["navigation", "create", "managed"]], "relative paths and URLs are not absolute paths");
  assert.equal(await readFile(path, "utf8"), USER_TEXT, "a plan writes nothing");

  const target = join(project, "SHARED.md");
  await writeFile(target, USER_TEXT);
  const linked = join(project, "LINKED.md");
  await symlink(target, linked);
  const error = await refusal(() => planManagedWrite({ filePath: linked, desired: [{ id: "navigation", body: NAV_V1 }], records: [] }));
  assert.equal(error.reasonCode, "MANAGED_SECTION_FILE_UNSUPPORTED");
  await render(path, [{ id: "navigation", body: NAV_V1 }], [], backups);
});

test("478-R1: the library keeps a managed-section record only as <file>#<id> with a valid revision, digest and state", async (context) => {
  const { base } = await scratch(context);
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  process.env.EINZBERN_HOME = desk;
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });
  const record = { file: "AGENTS.md", id: "navigation", rev: 1, digest: sectionDigest(NAV_V1), state: "managed" };
  await setConfigRecord(library, { collection: "managed-section", key: "AGENTS.md#navigation", value: record, occurredAt: at() });
  for (const [key, value] of [
    ["CLAUDE.md#navigation", record],
    ["AGENTS.md#navigation", { ...record, state: "forgotten" }],
    ["AGENTS.md#navigation", { ...record, digest: "abc" }],
    ["AGENTS.md#navigation", { ...record, rev: 0 }],
    ["AGENTS.md#navigation", { ...record, note: "extra" }],
    ["../AGENTS.md#navigation", { ...record, file: "../AGENTS.md" }],
  ]) {
    const error = await refusal(() => setConfigRecord(library, { collection: "managed-section", key, value, occurredAt: at() }));
    assert.equal(error.reasonCode, "CONFIG_RECORD_VALUE_INVALID", JSON.stringify(value));
    assert.equal(error.details.refusedBy, "MANAGED_SECTION_RECORD_INVALID");
  }
  assert.deepEqual(managedSectionRecordsFor(await materializeWorkspace(library), "AGENTS.md"), [record]);
});

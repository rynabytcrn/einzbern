// SPDX-License-Identifier: Apache-2.0

// Every verb runs here with no flags, so this process never reaches the real device directory or
// home: doctor, which reads both, runs against temporary ones (TCRN-CROSS-STORY-480).
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { COMMAND_CATALOG, assertCatalogCategoriesExclusive, runCli } from "../dist/build/packages/cli/src/index.js";

const guardHome = mkdtempSync(join(tmpdir(), "einzbern-catalog-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

async function invoke(args) {
  let output = "";
  const outcome = await runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
  return outcome;
}

test("commands emits schema-valid, deterministic catalog JSON", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/cli-catalog-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  let a = "";
  await runCli(["commands"], { write: (value) => { a += value; } });
  let b = "";
  await runCli(["commands"], { write: (value) => { b += value; } });
  assert.equal(a, b, "commands output must be byte-identical across invocations");
  const parsed = JSON.parse(a);
  assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
  assert.equal(parsed.reasonCode, "CLI_CATALOG_READY");
  // canonical order: names ascending
  const names = parsed.commands.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
});

test("catalog and dispatcher are in two-way name parity", async () => {
  // Imported typed handlers are dispatch source too; inspect their actual branches,
  // not a second copy of the catalog names that could bless an unimplemented verb.
  const source = (await Promise.all(["index.ts", "config-backup-commands.ts", "native-tool-commands.ts"].map(name => readFile(new URL(`../packages/cli/src/${name}`, import.meta.url), "utf8")))).join("\n");
  const dispatched = new Set();
  for (const match of source.matchAll(/command === "([a-z0-9-]+)"/gu)) {
    if (match[1] !== "-") dispatched.add(match[1]);
  }
  const cataloged = new Set(COMMAND_CATALOG.map((entry) => entry.name));
  const missingFromCatalog = [...dispatched].filter((name) => !cataloged.has(name)).sort();
  const missingFromDispatch = [...cataloged].filter((name) => !dispatched.has(name)).sort();
  assert.deepEqual(missingFromCatalog, [], "every dispatched verb must have a catalog entry (SDC-1)");
  assert.deepEqual(missingFromDispatch, [], "every catalog entry must dispatch");
});

test("unknown verbs fail closed and every cataloged verb dispatches", async () => {
  assert.equal((await invoke(["no-such-verb"])).reasonCode, "CLI_COMMAND_UNKNOWN");
  for (const entry of COMMAND_CATALOG) {
    const outcome = await invoke([entry.name]);
    // `commands` and the read-only vocabulary surface are zero-argument verbs.
    // library-list lists this device's registry, empty or not (TCRN-CROSS-STORY-470 R1), and
    // engine-list its engine versions, none or some (TCRN-CROSS-STORY-471 R2). doctor checks this
    // device with the current directory as the project (TCRN-CROSS-STORY-480 R4).
    if (entry.name === "commands" || entry.name === "doctor" || entry.name === "engine-list" || entry.name === "engine-model-policy-catalog" || entry.name === "install-manifest" || entry.name === "library-list" || entry.name === "machine-settings-catalog" || entry.name === "vocabulary") {
      assert.equal(outcome.ok, true, `${entry.name} resolves with no flags`);
      continue;
    }
    assert.equal(outcome.ok, false, `${entry.name} should reject with no flags`);
    assert.notEqual(outcome.reasonCode, "CLI_COMMAND_UNKNOWN", `${entry.name} must dispatch`);
  }
});

test("INIT-056: the engine policy catalog accepts no arguments and set requires audit fields while workspace may resolve from the registry", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const catalog = entry("engine-model-policy-catalog");
  assert.equal(catalog.mutates, false);
  assert.deepEqual(catalog.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [["host", false, "string"]]);

  const set = entry("engine-model-policy-set");
  assert.equal(set.mutates, true);
  assert.deepEqual(set.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [
    ["workspace", false, "string"], ["host", true, "string"], ["policy", true, "json"], ["at", true, "instant"],
    ["actor", true, "string"], ["decided-in", true, "string"],
  ]);
  assert.equal(set.flags.find((flag) => flag.name === "decided-in")?.valueShape, "minutes:<id>#D<n>");
});

test("required flags in the catalog match the dispatcher's missing-argument failure", async () => {
  for (const entry of COMMAND_CATALOG) {
    const requiredFlags = entry.flags.filter((flag) => flag.required).map((flag) => flag.name);
    if (requiredFlags.length === 0) continue;
    const outcome = await invoke([entry.name]);
    assert.equal(outcome.reasonCode, "CLI_ARGUMENT_MISSING", `${entry.name} with no flags must report missing arguments`);
  }
});

test("WSB-4: exactly the nullable flags carry the '-' sentinel, and only knowledge-create flags carry the 'null' alias", () => {
  const sentinelFlags = {};
  const aliasFlags = {};
  for (const entry of COMMAND_CATALOG) {
    for (const flag of entry.flags) {
      if (flag.nullSentinel !== undefined) {
        assert.equal(flag.nullSentinel, "-", `${entry.name}.${flag.name} null sentinel must be "-"`);
        (sentinelFlags[entry.name] ??= []).push(flag.name);
      }
      if (flag.deprecatedAliases !== undefined) {
        assert.deepEqual([...flag.deprecatedAliases], ["null"], `${entry.name}.${flag.name} deprecated alias set`);
        (aliasFlags[entry.name] ??= []).push(flag.name);
      }
    }
  }
  for (const record of [sentinelFlags, aliasFlags]) {
    for (const name of Object.keys(record)) record[name] = record[name].sort();
  }
  // gate-create's --work-id and profile-authorize's three sentinel flags went with those
  // verbs (TCRN-CROSS-STORY-467 R2).
  assert.deepEqual(sentinelFlags, {
    "knowledge-create": ["last-verified", "project-id", "stale-days", "supersedes"],
    "work-create": ["parent-id"],
  });
  // CQ-05(c2) / OD-5 option 1: the alias inventory is exactly the set of flags whose
  // dispatcher routes through nullableValue, which accepts BOTH "-" and "null". This
  // previously listed only knowledge-create, so work-create --parent-id accepted "null"
  // without declaring it — the catalog is the machine-readable discovery surface, so an
  // accepted-but-undeclared spelling is a catalog that lies.
  // tests/p3-cli-read-surface.test.mjs binds this inventory to the dispatcher's actual
  // behaviour, so the two can no longer drift apart silently.
  assert.deepEqual(aliasFlags, {
    "knowledge-create": ["last-verified", "project-id", "stale-days", "supersedes"],
    "work-create": ["parent-id"],
  });
});

test("WSB-7/WSD-2 retired by STORY-467 R1: no verb carries expected-version or a head sentinel", () => {
  // WSB-7/WSD-2 pinned the head sentinel to the expected-version flag of every workspace-event
  // appender. TCRN-CROSS-STORY-467 R1 removed the caller-supplied version together with the
  // lease: a writer takes the engine write lock and appends to the head it finds under it, so
  // there is no version to supply and no sentinel for one.
  for (const entry of COMMAND_CATALOG) {
    for (const flag of entry.flags) {
      assert.notEqual(flag.name, "expected-version", `${entry.name} still declares expected-version`);
      assert.equal(Object.hasOwn(flag, "headSentinel"), false, `${entry.name}.${flag.name} still carries headSentinel`);
    }
  }
});

test("S369 retired model-plan commands refuse with and without their legacy flags", async () => {
  for (const command of ["model-plan-assign", "model-plan-list", "model-plan-remove", "model-plan-set", "model-plan-unassign"]) {
    const empty = await invoke([command]);
    assert.equal(empty.ok, false);
    assert.equal(empty.reasonCode, "CLI_COMMAND_UNKNOWN");
    const legacy = await invoke([command, "--workspace", "/tmp/retired", "--at", "2026-01-01T00:00:00Z", "--host", "codex", "--name", "legacy", "--default-model", "model"]);
    assert.equal(legacy.ok, false);
    assert.equal(legacy.reasonCode, "CLI_COMMAND_UNKNOWN");
  }
  // The dispatch-* verbs went too (TCRN-CROSS-STORY-467 R3).
  assert.equal(COMMAND_CATALOG.filter((entry) => entry.name.startsWith("dispatch-")).length, 0);
  assert.equal(COMMAND_CATALOG.filter((entry) => entry.name.startsWith("model-plan-")).length, 0);
});

test("INIT-009: operator pins make every non-fixture verb binary-invocable", () => {
  const bySurface = {};
  for (const entry of COMMAND_CATALOG) {
    assert.ok(
      entry.availability === "cli" || entry.availability === "programmatic-only" || entry.availability === "fixture-only",
      `${entry.name} availability must be a known invocation surface`,
    );
    (bySurface[entry.availability] ??= []).push(entry.name);
  }
  for (const surface of Object.keys(bySurface)) bySurface[surface] = bySurface[surface].sort();
  // EPIC-022 adds the host-neutral global operator-pins channel. Compatibility
  // planning therefore no longer needs a bespoke programmatic embedder.
  assert.deepEqual(bySurface["programmatic-only"] ?? [], []);
  assert.deepEqual(bySurface["fixture-only"] ?? [], []);
  assert.equal(
    (bySurface["cli"]?.length ?? 0) +
      (bySurface["programmatic-only"]?.length ?? 0) +
      (bySurface["fixture-only"]?.length ?? 0),
    COMMAND_CATALOG.length,
    "every catalog entry is partitioned into exactly one known surface",
  );
});

test("INC-016: no catalog entry is both a governed write and authority-bearing output", async () => {
  // The shipped catalog already satisfies the exclusion, and the load-time assertion
  // in packages/cli/src/index.ts means an import that got this far proves it.
  assert.equal(assertCatalogCategoriesExclusive(COMMAND_CATALOG), undefined);
  for (const entry of COMMAND_CATALOG) {
    assert.equal(
      entry.mutates === true && entry.authorityBearing === true,
      false,
      `${entry.name} declares two authorization categories`,
    );
  }
  // The negative case: mcp.ts tests `mutates` FIRST, so a both-flags entry would be
  // satisfied by a writeCommands grant alone -- a write grant carrying
  // authority-bearing output, which the retired operator authority contract forbade.
  const both = { name: "adapter-activation-record", availability: "cli", mutates: true, authorityBearing: true, flags: [] };
  assert.throws(
    () => assertCatalogCategoriesExclusive([both]),
    (error) => error?.reasonCode === "CLI_CATALOG_CATEGORY_AMBIGUOUS",
    "CLI_CATALOG_CATEGORY_AMBIGUOUS",
  );
  // The published schema must refuse the same document, or the machine-readable
  // contract permits a state the implementation forbids.
  const schema = JSON.parse(await readFile(new URL("../schemas/cli-catalog-v1.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  const envelope = (commands) => ({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands });
  assert.equal(validate(envelope([both])), false, "the schema must reject authorityBearing with mutates:true");
  assert.equal(validate(envelope([{ ...both, mutates: false }])), true, "authorityBearing with mutates:false stays valid");
});

test("STORY-472 R3, R4: work-create and work-annotate take the relation flags, and work-list filters by a relation", () => {
  const flagsOf = (name) => new Map(COMMAND_CATALOG.find((entry) => entry.name === name).flags.map((flag) => [flag.name, flag]));
  for (const verb of ["work-create", "work-annotate"]) {
    const flags = flagsOf(verb);
    for (const name of ["blocked-by", "implements", "supersedes", "fixes", "decided-in", "decided-by"]) {
      assert.equal(flags.get(name)?.valueKind, "list", `${verb} --${name}`);
      assert.equal(flags.get(name)?.required, false, `${verb} --${name} is optional`);
    }
  }
  assert.equal(flagsOf("work-list").get("relation")?.valueKind, "string");
});

test("STORY-474 R2, R4: recall reads, keeps --host and --tau, and no longer takes --partition", () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "recall");
  assert.equal(entry.mutates, false);
  // TCRN-CROSS-SUB-425 (MIN-239 D6): --status adds removed cards only when a user asked for them.
  assert.deepEqual(entry.flags.map((flag) => flag.name).sort(), ["allow-trailing", "at", "host", "limit", "project-id", "query", "status", "tau", "workspace"]);
  assert.deepEqual(entry.flags.filter((flag) => flag.required).map((flag) => flag.name).sort(), ["at", "query"]);
});

test("STORY-473 R2: work-create and work-annotate take --goal, --acceptance and --body, and --scope stays", () => {
  const flagsOf = (name) => new Map(COMMAND_CATALOG.find((entry) => entry.name === name).flags.map((flag) => [flag.name, flag]));
  for (const verb of ["work-create", "work-annotate"]) {
    const flags = flagsOf(verb);
    for (const name of ["goal", "acceptance", "body", "scope"]) {
      assert.equal(flags.get(name)?.valueKind, "string", `${verb} --${name}`);
      // Optional at the catalog: a Story takes its goal and acceptance from the fields or from a
      // scope, and the engine names whichever one is missing (WORK_STORY_FIELD_REQUIRED).
      assert.equal(flags.get(name)?.required, false, `${verb} --${name} is optional`);
    }
  }
});

test("STORY-475 R1, R2: minutes-record writes and names its required flags; minutes-list and minutes-show read", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  assert.equal(entry("minutes-record").mutates, true);
  assert.deepEqual(entry("minutes-record").flags.filter((flag) => flag.required).map((flag) => flag.name).sort(), ["at", "project-id", "summary", "title"]);
  assert.equal(entry("minutes-record").flags.find((flag) => flag.name === "decisions")?.valueKind, "list");
  assert.equal(entry("minutes-list").mutates, false);
  assert.equal(entry("minutes-show").mutates, false);
  assert.equal(COMMAND_CATALOG.some((candidate) => candidate.name.startsWith("conference-")), false);
  // TCRN-CROSS-SUB-426 (MIN-239 D3, D5, D6): the decision lifecycle rides on the three verbs as optional
  // flags -- what minutes-record supersedes, withdraws and stands beside, and which decisions a read gives.
  const flag = (name, flagName) => entry(name).flags.find((candidate) => candidate.name === flagName);
  for (const flagName of ["supersedes", "withdraws", "coexists"]) {
    assert.deepEqual([flag("minutes-record", flagName)?.valueKind, flag("minutes-record", flagName)?.required], ["list", false], flagName);
  }
  for (const name of ["minutes-list", "minutes-show"]) {
    assert.deepEqual([flag(name, "status")?.valueKind, flag(name, "status")?.required], ["string", false], name);
  }
});

test("STORY-476 R1, R5: knowledge-create's lifecycle is optional, the candidate flags are gone, and the knowledge reads take --scope", () => {
  const flagsOf = (name) => new Map(COMMAND_CATALOG.find((entry) => entry.name === name).flags.map((flag) => [flag.name, flag]));
  assert.equal(flagsOf("knowledge-create").get("lifecycle")?.required, false, "every card is written active");
  assert.equal(flagsOf("knowledge-create").get("scope")?.required, true);
  assert.equal(flagsOf("knowledge-capture").get("scope")?.required, false, "a capture is a role card unless it says otherwise");
  assert.equal(flagsOf("knowledge-list").has("promotion"), false);
  assert.equal(flagsOf("knowledge-body").has("allow-unpromoted"), false);
  for (const verb of ["knowledge-list", "knowledge-snippet", "knowledge-body"]) {
    assert.equal(flagsOf(verb).get("scope")?.valueKind, "string", `${verb} --scope`);
    assert.equal(flagsOf(verb).get("scope")?.required, false, `${verb} reads the library's crest unless told otherwise`);
  }
  for (const retired of ["knowledge-promote", "knowledge-retire", "retire-proposals", "retire-sweep"]) {
    assert.equal(COMMAND_CATALOG.some((entry) => entry.name === retired), false, `${retired} is retired`);
  }
});

// TCRN-CROSS-SUB-425 (TCRN-CROSS-STORY-514 R1, R3, R4; MIN-239 D3 to D6): knowledge-remove writes a
// terminal removal with its reason, basis and actor, and the knowledge reads that answer a set of cards
// take --status; nothing restores a removed card.
test("SUB-425: knowledge-remove is cataloged with its required flags, knowledge-list and recall take --status, and no verb restores a card", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  assert.equal(entry("knowledge-remove").mutates, true);
  assert.deepEqual(entry("knowledge-remove").flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [
    ["workspace", false, "string"], ["at", true, "instant"], ["id", true, "string"], ["reason", true, "string"], ["basis", true, "string"],
    ["actor", true, "string"], ["superseded-by", false, "string"], ["scope", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  for (const verb of ["knowledge-list", "recall"]) {
    const status = entry(verb).flags.find((flag) => flag.name === "status");
    assert.deepEqual([status?.required, status?.valueKind], [false, "string"], `${verb} --status`);
  }
  assert.equal(COMMAND_CATALOG.some((candidate) => /^knowledge-(restore|unremove|revive)/u.test(candidate.name)), false);
});

test("STORY-485 R1 to R4: the gates verbs are cataloged, and work-transition and work-batch take --project", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const shape = (name) => [entry(name).mutates, entry(name).flags.filter((flag) => flag.required).map((flag) => flag.name).sort()];
  assert.deepEqual(shape("gates-config-list"), [false, []]);
  assert.deepEqual([entry("gates-config-list").flags.find((flag) => flag.name === "status")?.required, entry("gates-config-list").flags.find((flag) => flag.name === "status")?.valueKind], [false, "string"]);
  assert.deepEqual(shape("gates-config-set"), [true, ["at", "name"]]);
  assert.deepEqual(shape("gates-config-remove"), [true, ["at", "name"]]);
  assert.deepEqual(shape("gates-plan"), [false, []]);
  assert.deepEqual(shape("gates-run"), [true, ["at"]], "gates-run starts the gates' processes and records the run");
  const flagsOf = (name) => new Map(entry(name).flags.map((flag) => [flag.name, flag]));
  assert.deepEqual(["command", "root", "covers", "required", "enabled", "release-only", "order"].map((name) => flagsOf("gates-config-set").get(name)?.valueKind),
    ["string", "string", "list", "boolean", "boolean", "boolean", "integer"]);
  for (const verb of ["gates-plan", "gates-run"]) {
    assert.deepEqual(["project", "base", "release"].map((name) => flagsOf(verb).get(name)?.valueKind), ["string", "string", "boolean"], verb);
  }
  for (const verb of ["work-transition", "work-batch"]) {
    assert.equal(flagsOf(verb).get("project")?.required, false, `${verb} --project`);
  }
});

test("STORY-479 R1: skill-render writes the skill directory into --out, for this engine's version or --version", () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "skill-render");
  assert.ok(entry !== undefined, "skill-render is cataloged");
  assert.equal(entry.mutates, true, "it writes files");
  assert.deepEqual(entry.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [["out", true, "string"], ["version", false, "string"]]);
});

test("STORY-478 R3: agents-render and rule-resolve write, take --at and resolve the project from --project or the current directory", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const render = entry("agents-render");
  assert.ok(render !== undefined, "agents-render is cataloged");
  assert.equal(render.mutates, true, "it writes the project's files and the library's records");
  assert.deepEqual(render.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [["project", false, "string"], ["at", true, "instant"], ["actor", false, "string"], ["project-id", false, "string"], ["timeout-ms", false, "integer"]]);
  const resolve = entry("rule-resolve");
  assert.ok(resolve !== undefined, "rule-resolve is cataloged (STORY-483 R2 reuses it)");
  assert.equal(resolve.mutates, true);
  assert.deepEqual(resolve.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [
    ["section", true, "string"],
    ["action", true, "string"],
    ["force", false, "boolean"],
    ["at", true, "instant"],
    ["project", false, "string"],
    ["actor", false, "string"], ["project-id", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  // Neither takes --workspace: the library is the one the registry names for the project.
  assert.equal([render, resolve].some((candidate) => candidate.flags.some((flag) => flag.name === "workspace")), false);
});

test("STORY-484 R1, R4: variable-list reads; variable-set and variable-remove write and name their required flags", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => entry(name).flags.map((flag) => [flag.name, flag.required, flag.valueKind]);
  assert.equal(entry("variable-list").mutates, false);
  assert.deepEqual(flags("variable-list"), [["workspace", false, "string"], ["project-id", false, "string"]]);
  assert.equal(entry("variable-set").mutates, true);
  assert.deepEqual(flags("variable-set"), [
    ["workspace", false, "string"], ["at", true, "instant"], ["name", true, "string"], ["type", true, "string"],
    ["value", true, "string"], ["description", false, "string"], ["order", false, "integer"], ["exports", false, "list"], ["actor", false, "string"], ["project-id", false, "string"],
    ["decided-in", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  assert.equal(entry("variable-remove").mutates, true);
  assert.deepEqual(flags("variable-remove"), [["workspace", false, "string"], ["at", true, "instant"], ["name", true, "string"], ["actor", false, "string"], ["project-id", false, "string"], ["decided-in", false, "string"], ["timeout-ms", false, "integer"]]);
  // The refusal of a model's write (MODEL_WRITE_REFUSED) is the dispatcher's, not a flag: the settings
  // writes keep their flags, and take --decided-in to cite an Owner decision (TCRN-CROSS-SUB-453).
  assert.deepEqual(entry("settings-set").flags.map((flag) => flag.name), ["workspace", "at", "key", "value", "actor", "project-id", "decided-in", "timeout-ms"]);
  assert.deepEqual(entry("settings-remove").flags.map((flag) => flag.name), ["workspace", "at", "key", "actor", "project-id", "decided-in", "timeout-ms"]);
});

test("STORY-483 R2: rule-list reads; rule-enable and rule-disable write, take --id and --at, and resolve the project from --project or the current directory", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => entry(name).flags.map((flag) => [flag.name, flag.required, flag.valueKind]);
  assert.equal(entry("rule-list").mutates, false);
  // TCRN-CROSS-STORY-527 (Q6): --status declared|pending|rejected.
  assert.deepEqual(flags("rule-list"), [["workspace", false, "string"], ["project", false, "string"], ["project-id", false, "string"], ["status", false, "string"]]);
  assert.equal(entry("rule-enable").mutates, true);
  assert.deepEqual(flags("rule-enable"), [["id", true, "string"], ["at", true, "instant"], ["project", false, "string"], ["order", false, "integer"], ["actor", false, "string"], ["project-id", false, "string"], ["decided-in", false, "string"], ["timeout-ms", false, "integer"]]);
  assert.equal(entry("rule-disable").mutates, true);
  assert.deepEqual(flags("rule-disable"), [
    ["id", true, "string"], ["force", false, "boolean"], ["at", true, "instant"], ["project", false, "string"], ["actor", false, "string"], ["project-id", false, "string"],
    ["decided-in", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  // Managed writes resolve their stable project through the registry or explicit project-id.
  // rule-list additionally permits an explicit library-only read.
  const verbs = ["agents-render", "rule-disable", "rule-enable", "rule-list", "rule-resolve"];
  assert.equal(verbs.every((name) => entry(name) !== undefined), true);
  assert.deepEqual(verbs.filter((name) => entry(name).flags.some((flag) => flag.name === "workspace")), ["rule-list"], "explicit library-only rule read is declared");
});

test("STORY-480: setup writes and takes the wizard's flags; doctor reads and takes --project alone", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => entry(name).flags.map((flag) => [flag.name, flag.required, flag.valueKind]);
  assert.equal(entry("setup").mutates, true);
  assert.deepEqual(flags("setup"), [
    ["execution-target", false, "string"], ["dot-input", false, "string"], ["approved-plan-digest", false, "string"],
    ["mode", true, "string"], ["project", true, "string"], ["at", true, "instant"], ["artifacts", false, "string"],
    ["cloud", false, "boolean"], ["restore", false, "string"], ["language", false, "string"], ["navigation", false, "boolean"],
    ["archive", false, "string"], ["rollback", false, "boolean"], ["managed-sections", false, "string"], ["mapping", false, "string"],
    ["yes", false, "boolean"],
  ]);
  assert.equal(entry("doctor").mutates, false);
  assert.deepEqual(flags("doctor"), [["project", false, "string"]]);
  // Neither takes --workspace: the project's library is the one this device's registry names.
  assert.equal(["setup", "doctor"].some((name) => entry(name).flags.some((flag) => flag.name === "workspace")), false);
});

// TCRN-CROSS-STORY-526 GWT5 (Q15; TCRN-CROSS-SUB-455): the writes that may cite an Owner decision
// take --decided-in, a string whose valueShape says how a decision is cited. The catalog stays
// schema-valid with it (the schema test above); the integrated engine also documents two JSON
// inputs with valueShape, whose closed roster and exact contracts are checked separately below.
// TCRN-CROSS-STORY-541 (TCRN-CROSS-SUB-510): twelve, with project-bindings-set and -remove,
// work-gate-release and work-release. INIT-056 adds the engine-wide policy writer as the thirteenth.
test("526 GWT5, 541 GWT1, INIT-056: the closed decided-in roster carries its documented valueShape", () => {
  const optionalWrites = ["dot-extension-source-set", "config-restore-apply", "config-restore-plan", "gates-config-remove", "gates-config-set", "project-bindings-remove", "project-bindings-set", "rule-disable", "rule-enable", "settings-remove", "settings-set", "variable-remove", "variable-set", "work-gate-release", "work-release"];
  const writes = ["engine-model-policy-save", "engine-model-policy-set", ...optionalWrites].sort();
  const shaped = COMMAND_CATALOG.flatMap((entry) => entry.flags.filter((flag) => flag.name === "decided-in" && flag.valueShape !== undefined).map((flag) => [entry.name, flag.name]));
  assert.deepEqual(shaped, writes.map((name) => [name, "decided-in"]));
  for (const name of optionalWrites) {
    const flag = COMMAND_CATALOG.find((entry) => entry.name === name).flags.find((candidate) => candidate.name === "decided-in");
    assert.deepEqual({ ...flag }, { name: "decided-in", required: false, valueKind: "string", valueShape: "minutes:<id>#D<n>" }, name);
  }
  const enginePolicy = COMMAND_CATALOG.find((entry) => entry.name === "engine-model-policy-set");
  assert.deepEqual(enginePolicy.flags.find((flag) => flag.name === "decided-in"), { name: "decided-in", required: true, valueKind: "string", valueShape: "minutes:<id>#D<n>" });
  assert.deepEqual(enginePolicy.flags.find((flag) => flag.name === "actor"), { name: "actor", required: true, valueKind: "string" });
});

test("integrated engine: non-decision valueShapes document projection selection, capture host and execution evidence", () => {
  const shaped = COMMAND_CATALOG.filter(entry => entry.name !== "setup" && !/^(?:config-backup-|config-restore-|execution-native-|execution-host-|shared-submit-)/u.test(entry.name)).flatMap((entry) => entry.flags
    .filter((flag) => flag.name !== "decided-in" && flag.valueShape !== undefined)
    .map((flag) => [entry.name, { ...flag }]));
  assert.deepEqual(shaped, [
    ["configuration-projections-refresh", {
      name: "output-keys", required: false, valueKind: "string",
      valueShape: "JSON array of stable registered output keys; omitted selects all known outputs, [] selects none",
    }],
    ["dot-extension-source-set", { name: "source", required: true, valueKind: "json", valueShape: "Private dot extension source JSON; data only, not publication approval" }],
    ["dot-extension-source-set", { name: "verification", required: true, valueKind: "json", valueShape: "Ephemeral local Git bindings {gitExecutable,scratchRoot,repositories:[{key,root}]}; authorized absolute roots only, never persisted" }],
    ["execution-evidence", {
      name: "from-file", required: true, valueKind: "string",
      valueShape: "Path to JSON {handoff, hostResult}; see specs/dispatch-admission-evidence-v1.md in the engine archive. Association only, not host authentication. Exit 0: complete association; exit 1: invalid, unavailable, or unreadable input.",
    }],
    ["execution-prepare", { name: "action", required: false, valueKind: "string", valueShape: "implementation, research or coordination; required to disambiguate legacy content-incomplete dispatch; does not grant authority" }],
    ["execution-prepare", { name: "observations", required: true, valueKind: "string", valueShape: "Machine JSON file: explicit availableCombinations, optional timestamped usage/expectedPolicy; never inferred from policy." }],
    ["execution-prepare", { name: "output", required: true, valueKind: "string", valueShape: "Create-new private local preparation file outside device/library roots; refused preparations are retained. No dispatch." }],
    ["execution-record", { name: "binding", required: true, valueKind: "string", valueShape: "Saved execution-prepare file." }],
    ["execution-record", { name: "target", required: true, valueKind: "integer", valueShape: "Exact zero-based target index in the preparation bindings." }],
    ["execution-record", { name: "process-return", required: true, valueKind: "string", valueShape: "Actual process artifact per specs/dispatch-admission-evidence-v1.md; native tool responses unsupported." }],
    ["execution-record", { name: "output", required: true, valueKind: "string", valueShape: "Create-new private local record, retaining raw and normalized failures/unavailability. No dispatch." }],
    ["knowledge-capture", {
      name: "host", required: false, valueKind: "string",
      valueShape: "Explicit host for configured artifact-language model policy; required by that policy, not inferred.",
    }],
    ["settings-catalog", { name: "work-content-observation", required: false, valueKind: "json", valueShape: "Optional machine-assembled rollout observation JSON; read-only unauthenticated preview, never persisted or approval" }],
    ["work-annotate", { name: "content", required: false, valueKind: "json", valueShape: "tcrn.work-content.v1; cannot be combined with legacy scope/goal/acceptance/body" }],
    ["work-content-context", { name: "offset", required: false, valueKind: "integer", valueShape: "Nonnegative Unicode code-point offset within the document; default 0; nonzero requires digest" }],
    ["work-content-context", { name: "limit", required: false, valueKind: "integer", valueShape: "Positive Unicode code-point window length; omitted returns the full document subject to output capacity" }],
    ["work-content-context", { name: "digest", required: false, valueKind: "string", valueShape: "Exact SHA-256 from the first segment; pins direct and ancestor/source versions" }],
    ["work-create", { name: "content", required: false, valueKind: "json", valueShape: "tcrn.work-content.v1; cannot be combined with legacy scope/goal/acceptance/body" }],
    ["work-draft", { name: "parent-id", required: false, valueKind: "string", valueShape: "Live parent work id in the selected project; supplies complete inherited context" }],
    ["work-draft", { name: "variant", required: false, valueKind: "string", valueShape: "standard or defect (Story only)" }],
    ["work-project-context", {
      name: "execution-request", required: false, valueKind: "string",
      valueShape: "Versioned HostExecutionRequest JSON for native hosts; legacy ExecutionAdmissionRequest / DotExecutionRequest retain historical semantics",
    }],
  ]);
});

// TCRN-CROSS-STORY-527 (MIN-257 D6, Q6; TCRN-CROSS-SUB-478): a model proposes with gates-config-propose
// and rule-propose; Atelier settles with proposal-approve and proposal-reject. All four write, name
// who acts, and none takes --decided-in: a proposal cites no decision, and an approval is its own.
test("527 Q6: the proposal verbs are cataloged with their required flags, and none takes --decided-in", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => entry(name).flags.map((flag) => [flag.name, flag.required, flag.valueKind]);
  for (const name of ["gates-config-propose", "rule-propose", "proposal-approve", "proposal-reject"]) {
    assert.equal(entry(name)?.mutates, true, name);
    assert.equal(entry(name).flags.some((flag) => flag.name === "decided-in"), false, name);
  }
  assert.deepEqual(flags("gates-config-propose"), [
    ["workspace", false, "string"], ["at", true, "instant"], ["name", true, "string"], ["action", false, "string"], ["command", false, "string"], ["root", false, "string"],
    ["covers", false, "list"], ["required", false, "boolean"], ["enabled", false, "boolean"], ["release-only", false, "boolean"], ["order", false, "integer"],
    ["actor", true, "string"], ["project-id", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  assert.deepEqual(flags("rule-propose"), [
    ["id", true, "string"], ["action", false, "string"], ["order", false, "integer"], ["at", true, "instant"], ["workspace", false, "string"], ["project", false, "string"],
    ["actor", true, "string"], ["project-id", false, "string"], ["timeout-ms", false, "integer"],
  ]);
  for (const name of ["proposal-approve", "proposal-reject"]) {
    assert.deepEqual(flags(name), [
      ["key", true, "string"], ["proposed-at", true, "instant"], ["at", true, "instant"], ["workspace", false, "string"], ["project", false, "string"],
      ["actor", true, "string"], ["project-id", false, "string"], ["timeout-ms", false, "integer"],
    ], name);
  }
});

test("529 GWT2 (TCRN-CROSS-SUB-480): every write that takes the library write lock takes an optional integer --timeout-ms", () => {
  const lockWrites = ["dot-extension-source-set", "config-backup-create", "config-backup-resume", "config-backup-retire", "config-restore-apply", "shared-submit-advisory-write", "agents-render", "artifact-put", "chain-declare", "gates-config-propose", "gates-config-remove", "gates-config-set",
    "knowledge-article-create", "knowledge-article-refresh", "knowledge-batch", "knowledge-bodies-migrate", "knowledge-capture",
    "knowledge-create", "knowledge-init", "knowledge-rebase", "knowledge-recover", "knowledge-remove", "knowledge-reverify",
    "minutes-record", "project-bindings-remove", "project-bindings-set", "project-create", "project-delete", "project-update",
    "proposal-approve", "proposal-reject", "recover", "rule-disable", "rule-enable", "rule-propose", "rule-resolve", "settings-remove", "settings-set", "template-admit",
    "variable-remove", "variable-set", "work-annotate", "work-batch", "work-claim", "work-create", "work-delete",
    "work-gate-release", "work-release", "work-transition", "workspace-relocate"];
  const carriers = COMMAND_CATALOG.filter((entry) => entry.flags.some((flag) => flag.name === "timeout-ms")).map((entry) => entry.name);
  assert.deepEqual(carriers.filter((name) => name !== "host-probe").sort(), [...lockWrites].sort());
  for (const name of lockWrites) {
    const entry = COMMAND_CATALOG.find((candidate) => candidate.name === name);
    assert.equal(entry.mutates, true, `${name} writes`);
    assert.deepEqual(entry.flags.find((flag) => flag.name === "timeout-ms"), { name: "timeout-ms", required: false, valueKind: "integer" }, name);
  }
});

test("PR24: capture advertises an optional host in catalog and command help", async () => {
  for (const argv of [["commands"], ["knowledge-capture", "--help"]]) {
    const result = await invoke(argv);
    assert.equal(result.ok, true);
    const command = JSON.parse(result.output).commands.find((entry) => entry.name === "knowledge-capture");
    assert.deepEqual(command.flags.find((flag) => flag.name === "host"), { name: "host", required: false, valueKind: "string", valueShape: "Explicit host for configured artifact-language model policy; required by that policy, not inferred." });
  }
});

// Preparation/recording mutate only explicit create-new local artifacts; legacy validation does not.
test("machine dispatch catalog declares persistence and its complete supported flags", () => {
  const get = name => COMMAND_CATALOG.find(entry => entry.name === name);
  assert.equal(get("execution-evidence").mutates, false);
  for (const name of ["execution-prepare", "execution-record"]) assert.equal(get(name).mutates, true);
  assert.deepEqual(get("execution-prepare").flags.map(flag => flag.name), ["action", "workspace", "id", "host", "category", "rejections", "requested-agents", "observations", "output"]);
  assert.deepEqual(get("execution-record").flags.map(flag => flag.name), ["binding", "target", "process-return", "output"]);
});

test("INIT062 package handlers preserve strict parser and explicit native workspace requirements", async () => {
  const names = COMMAND_CATALOG.filter(entry => /^(?:config-backup-|config-restore-|execution-native-|shared-submit-)/u.test(entry.name));
  assert.equal(names.length, 15);
  for (const entry of names) {
    assert.ok(entry.flags.every(flag => flag.valueKind !== "path"), "paths retain the existing string transport schema");
    const help = await invoke([entry.name, "--help"]);
    assert.equal(help.ok, true, entry.name);
    assert.deepEqual(JSON.parse(help.output).commands[0], entry);
    assert.equal((await invoke([entry.name, "--injected-admission", "true"])).reasonCode, "CLI_ARGUMENT_UNKNOWN", entry.name);
  }
  for (const name of ["execution-native-prepare", "shared-submit-advisory-read", "shared-submit-advisory-write"]) {
    assert.equal(COMMAND_CATALOG.find(entry => entry.name === name).flags.find(flag => flag.name === "workspace").required, true);
  }
});

test("INIT062 new valueShape roster is closed and preserves the existing transport contract", () => {
  const entries = COMMAND_CATALOG.filter(entry => entry.name === "setup" || /^(?:config-backup-|config-restore-|execution-native-|shared-submit-)/u.test(entry.name));
  const shaped = entries.flatMap(entry => entry.flags.filter(flag => flag.valueShape !== undefined && flag.name !== "decided-in").map(flag => `${entry.name}:${flag.name}`));
  assert.deepEqual(shaped, [
    "config-backup-create:request", "config-backup-create:output", "config-backup-plan:request", "config-backup-plan:output", "config-backup-resume:request", "config-backup-resume:output", "config-backup-retire:request", "config-backup-retire:output",
    "config-restore-apply:request", "config-restore-apply:output", "config-restore-apply:approved-plan-digest", "config-restore-plan:request", "config-restore-plan:output",
    "execution-native-prepare:request", "execution-native-prepare:tool-contract", "execution-native-prepare:arguments", "execution-native-prepare:retry-from", "execution-native-prepare:reconciliation", "execution-native-record:response", "execution-native-record:prior", "setup:execution-target", "setup:dot-input", "setup:approved-plan-digest",
  ]);
  const setup = entries.find(entry => entry.name === "setup");
  assert.deepEqual(setup.flags.filter(flag => flag.valueShape !== undefined).map(flag => flag.valueShape), ["traditional | chatgpt-dot", "absolute path to JSON dot target options; required for chatgpt-dot", "saved preview dot.planDigest; required for dot apply"]);
  for (const entry of entries) for (const flag of entry.flags.filter(flag => flag.valueShape !== undefined)) assert.equal(flag.valueKind, "string");
});


test("INIT065 general-native catalog is separate from legacy closed roster", async () => {
  const entries = COMMAND_CATALOG.filter(entry => entry.name.startsWith("execution-host-"));
  assert.deepEqual(entries.map(entry => entry.name), ["execution-host-evidence", "execution-host-prepare", "execution-host-record"]);
  assert.deepEqual(entries.flatMap(entry => entry.flags.filter(flag => flag.valueShape !== undefined).map(flag => `${entry.name}:${flag.name}`)), ["execution-host-prepare:request", "execution-host-prepare:arguments", "execution-host-record:events"]);
  for (const entry of entries) {
    assert.ok(entry.flags.every(flag => flag.valueKind === "string"));
    assert.equal((await invoke([entry.name, "--help"])).ok, true);
    assert.equal((await invoke([entry.name, "--injected-admission", "true"])).reasonCode, "CLI_ARGUMENT_UNKNOWN");
  }
});

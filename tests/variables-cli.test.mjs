// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-484 R1, R4; AC1, AC2 and AC4 through the CLI (MIN-227 D12; TCRN-CROSS-SUB-341):
// variable-list, variable-set and variable-remove, and the soft barrier on the CLI's configuration
// writes. A model runs the CLI from its shell, where EINZBERN_SURFACE is not atelier: settings-set and
// settings-remove on a key that is not modelWritable, and variable-set and variable-remove, are
// refused with MODEL_WRITE_REFUSED and the remedy of changing it in Atelier, and append nothing.
// Atelier runs the same verbs with EINZBERN_SURFACE=atelier and writes. A key the engine refuses
// whoever asks keeps its own refusal, and a read is never refused.

import { ATELIER_SURFACE, cliProcess, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MODEL_WRITE_REMEDY, SURFACE_ENVIRONMENT_VARIABLE, assertModelWriteAllowed, runCli } from "../dist/build/packages/cli/src/index.js";
import { SETTINGS_CATALOG, initializeLibrary, materializeWorkspace, writeVariablesSections } from "../dist/build/packages/core/src/index.js";
import { parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import { VARIABLES_CUSTOM_SECTION_ID } from "../dist/build/packages/core/src/variables-sections.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 3, 0, second)).toISOString().replace(".000Z", "Z");
};

// The keys STORY-484 retires (R3, R5), each refused as unregistered whoever writes it (AC4).
const RETIRED_BY_484 = [
  "backup.cadence",
  "backup.destination",
  "driver.capabilityProfile",
  "execution.claudeCodeSubagentPlan",
  "execution.codexSubagentPlan",
  "execution.dispatchClasses",
  "execution.dispatchMode",
  "execution.dispatchModes",
  "execution.dispatchTiers",
  "execution.maxDispatchDepth",
  "execution.subagentPolicy",
  "storage.backend",
];

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-variables-cli-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const workspace = join(root, ".ether");
  await initializeLibrary({ root: workspace, createdAt: at() });
  return { base, root, workspace };
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(argv) {
  try {
    await runCli(argv, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`${argv[0]} was expected to be refused`);
}

// A model's shell carries no surface; Atelier runs the CLI with EINZBERN_SURFACE=atelier.
const asModel = (operation) => withSurface(undefined, operation);
const asAtelier = (operation) => withSurface(ATELIER_SURFACE, operation);
const versionOf = async (workspace) => (await materializeWorkspace(workspace)).version;
const lastLine = (text) => JSON.parse(text.trim().split("\n").at(-1));

test("484-AC1 through the CLI: variable-set deploy.host is a variable, a row of the custom section and not a setting", async (context) => {
  const fx = await library(context);
  const receipt = await asAtelier(() => cli(["variable-set", "--workspace", fx.workspace, "--at", at(), "--name", "deploy.host", "--type", "string",
    "--value", "build.example.com", "--description", "Where a release deploys"]));
  assert.equal(receipt.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.equal(receipt.schemaVersion, "einzbern.variable-write-receipt.v1");
  assert.deepEqual(receipt.variable, { name: "deploy.host", type: "string", value: "build.example.com", description: "Where a release deploys" });
  // recordId is the CLI's variable name; ids uses STORY-467's global collection identity.
  assert.deepEqual([receipt.recordId, receipt.ids, receipt.version], ["deploy.host", ["variable:deploy.host"], 1]);
  assert.equal(typeof receipt.receiptDigest, "string");

  // A read is never refused: a model lists the variable and does not find it among the settings.
  const listed = await asModel(() => cli(["variable-list", "--workspace", fx.workspace]));
  assert.deepEqual([listed.reasonCode, listed.schemaVersion], ["VARIABLE_LIST_READY", "einzbern.variable-list.v1"]);
  assert.deepEqual(listed.variables, [receipt.variable]);
  assert.deepEqual(listed.withheld, []);
  const catalog = await asModel(() => cli(["settings-catalog", "--workspace", fx.workspace]));
  assert.equal(catalog.settings.some((entry) => entry.key === "deploy.host"), false, "a variable is not a setting");

  // The CLI records the variable; the section writer puts it into AGENTS.md as a row of the custom section.
  const written = await writeVariablesSections(fx.workspace, { projectRoot: fx.root, backupRoot: join(fx.base, "backups"), occurredAt: at() });
  assert.deepEqual([written.written, written.withheld], [true, []]);
  const parsed = parseManagedFile(await readFile(join(fx.root, "AGENTS.md"), "utf8"), "AGENTS.md");
  const custom = parsed.sections.find((section) => section.id === VARIABLES_CUSTOM_SECTION_ID);
  assert.match(custom.body, /^\| deploy\.host \| string \| build\.example\.com \| Where a release deploys \|$/mu);
});

test("484-AC2 through the CLI: a credential-shaped value or description is refused, and nothing is recorded", async (context) => {
  const fx = await library(context);
  const set = (flags) => asAtelier(() => refusal(["variable-set", "--workspace", fx.workspace, "--at", at(), ...flags]));
  const value = await set(["--name", "api.key", "--type", "string", "--value", "sk-proj-0123456789abcdef"]);
  assert.deepEqual([value.reasonCode, value.details.name, value.details.field, value.details.matched], ["VARIABLE_SECRET_SHAPED", "api.key", "value", "sk-"]);
  const description = await set(["--name", "api.note", "--type", "string", "--value", "see the vault", "--description", "old key ghp_0123456789abcdefABCDEF"]);
  assert.deepEqual([description.reasonCode, description.details.field, description.details.matched], ["VARIABLE_SECRET_SHAPED", "description", "ghp_"]);
  assert.equal(await versionOf(fx.workspace), 0, "no refusal appended an event");

  // Through the shipped entry the refusal reaches stderr with its field, and nothing is written.
  const run = await asAtelier(() => cliProcess(["variable-set", "--workspace", fx.workspace, "--at", at(), "--name", "aws.key", "--type", "string", "--value", "AKIAIOSFODNN7EXAMPLE"]));
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, "");
  const refused = lastLine(run.stderr);
  assert.deepEqual([refused.ok, refused.reasonCode, refused.field], [false, "VARIABLE_SECRET_SHAPED", "value"]);
  assert.equal(await versionOf(fx.workspace), 0);
  assert.deepEqual((await cli(["variable-list", "--workspace", fx.workspace])).variables, []);
});

test("484-AC4 through the CLI: settings-set execution.dispatchMode is SETTINGS_KEY_UNREGISTERED for a model and for Atelier, as is every key 484 retires", async (context) => {
  const fx = await library(context);
  for (const [who, run] of [["model", asModel], ["Atelier", asAtelier]]) {
    for (const key of RETIRED_BY_484) {
      const error = await run(() => refusal(["settings-set", "--workspace", fx.workspace, "--at", at(), "--key", key, "--value", "manual"]));
      assert.equal(error.reasonCode, "SETTINGS_KEY_UNREGISTERED", `${key} for ${who}`);
    }
  }
  assert.equal(await versionOf(fx.workspace), 0, "no refusal appended an event");
});

test("484-R4: a model's write of a setting or a variable through the CLI is refused with the remedy of changing it in Atelier, and appends nothing", async (context) => {
  const fx = await library(context);
  const workspace = ["--workspace", fx.workspace];
  await asAtelier(() => cli(["settings-set", ...workspace, "--at", at(), "--key", "retrieval.tau", "--value", "3"]));
  await asAtelier(() => cli(["variable-set", ...workspace, "--at", at(), "--name", "deploy.host", "--type", "string", "--value", "build.example.com"]));
  const before = await versionOf(fx.workspace);
  const writes = [
    [() => ["settings-set", ...workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", "98"], { key: "quota.weeklyWaitPercent" }],
    [() => ["settings-remove", ...workspace, "--at", at(), "--key", "retrieval.tau"], { key: "retrieval.tau" }],
    [() => ["variable-set", ...workspace, "--at", at(), "--name", "deploy.port", "--type", "number", "--value", "8443"], { name: "deploy.port" }],
    [() => ["variable-remove", ...workspace, "--at", at(), "--name", "deploy.host"], { name: "deploy.host" }],
  ];
  // Only the exact surface name lets a write through.
  for (const surface of [undefined, "", "Atelier", "atelier ", "portal"]) {
    for (const [argv, subject] of writes) {
      const args = argv();
      const error = await withSurface(surface, () => refusal(args));
      assert.equal(error.reasonCode, "MODEL_WRITE_REFUSED", `${args[0]} with EINZBERN_SURFACE=${String(surface)}`);
      assert.deepEqual({ ...error.details }, { ...subject, remedy: MODEL_WRITE_REMEDY });
    }
  }
  assert.equal(await versionOf(fx.workspace), before, "no refused write appended an event");

  // Reads answer a model, and settings-catalog tells it which keys it may write.
  assert.deepEqual((await asModel(() => cli(["variable-list", ...workspace]))).variables.map((variable) => variable.name), ["deploy.host"]);
  const catalog = await asModel(() => cli(["settings-catalog", ...workspace]));
  assert.deepEqual(catalog.settings.map((entry) => [entry.key, entry.modelWritable]), SETTINGS_CATALOG.map((entry) => [entry.key, entry.modelWritable]));
  assert.equal(catalog.settings.every((entry) => typeof entry.modelWritable === "boolean"), true);

  // A key the engine refuses whoever asks keeps its own refusal for a model.
  const device = await asModel(() => refusal(["settings-set", ...workspace, "--at", at(), "--key", "portal.defaultTheme", "--value", "dark"]));
  assert.deepEqual([device.reasonCode, device.details.remedy], ["SETTINGS_KEY_DEVICE_LEVEL", "machine-settings-set"]);
  assert.equal((await asModel(() => refusal(["settings-remove", ...workspace, "--at", at(), "--key", "fitness.windowDays"]))).reasonCode, "WORKSPACE_INPUT_INVALID");
  assert.equal(await versionOf(fx.workspace), before);

  // The same writes run for Atelier commit, in order.
  const receipts = [];
  for (const [argv] of writes) receipts.push(await asAtelier(() => cli(argv())));
  assert.deepEqual(receipts.map((receipt) => receipt.reasonCode), ["SETTINGS_WRITE_COMMITTED", "SETTINGS_WRITE_COMMITTED", "VARIABLE_WRITE_COMMITTED", "VARIABLE_WRITE_COMMITTED"]);
  assert.equal(await versionOf(fx.workspace), before + writes.length);
});

test("484-R4: through the shipped entry a model's settings-set is refused on stderr with its remedy, and one run for Atelier commits", async (context) => {
  const fx = await library(context);
  const argv = () => ["settings-set", "--workspace", fx.workspace, "--at", at(), "--key", "retrieval.tau", "--value", "4"];
  const model = await asModel(() => cliProcess(argv()));
  assert.equal(model.status, 1, model.stderr);
  const refused = lastLine(model.stderr);
  assert.deepEqual([refused.ok, refused.reasonCode, refused.remedy], [false, "MODEL_WRITE_REFUSED", MODEL_WRITE_REMEDY]);
  assert.equal(await versionOf(fx.workspace), 0);

  const atelier = await asModel(() => cliProcess(argv(), { env: { [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE } }));
  assert.equal(atelier.status, 0, atelier.stderr);
  assert.equal(JSON.parse(atelier.stdout).reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(await versionOf(fx.workspace), 1);
});

test("484-R4: a key whose catalog entry is modelWritable is written for a model; anything else only for Atelier", () => {
  assert.equal(assertModelWriteAllowed({ key: "fixture.writable" }, true, {}), undefined, "the per-key exception");
  assert.throws(() => assertModelWriteAllowed({ key: "fixture.decision" }, false, {}),
    (error) => error.reasonCode === "MODEL_WRITE_REFUSED" && error.details.key === "fixture.decision" && error.details.remedy === MODEL_WRITE_REMEDY);
  assert.equal(assertModelWriteAllowed({ name: "deploy.host" }, false, { [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE }), undefined);
  assert.throws(() => assertModelWriteAllowed({ name: "deploy.host" }, false, { [SURFACE_ENVIRONMENT_VARIABLE]: "portal" }),
    (error) => error.reasonCode === "MODEL_WRITE_REFUSED" && error.details.name === "deploy.host");
  // The exceptions are declared in the settings catalog, one entry at a time; none is declared yet.
  assert.deepEqual(SETTINGS_CATALOG.filter((entry) => entry.modelWritable).map((entry) => entry.key), []);
});

test("484-R1 through the CLI: variables are set, changed, listed by name with what AGENTS.md leaves out, and removed once", async (context) => {
  const fx = await library(context);
  const set = (flags) => asAtelier(() => cli(["variable-set", "--workspace", fx.workspace, "--at", at(), ...flags]));
  await set(["--name", "deploy.host", "--type", "string", "--value", "build.example.com"]);
  await set(["--name", "build.root", "--type", "string", "--value", "/srv/build/output"]);
  await set(["--name", "deploy.enabled", "--type", "boolean", "--value", "true"]);
  const empty = await set(["--name", "deploy.sshHost", "--type", "string", "--value", ""]);
  assert.deepEqual(empty.variable, { name: "deploy.sshHost", type: "string", value: "", description: "" }, "an empty value is a value");
  const changed = await set(["--name", "deploy.host", "--type", "string", "--value", "release.example.com", "--description", "Where a release deploys"]);
  assert.deepEqual(changed.variable, { name: "deploy.host", type: "string", value: "release.example.com", description: "Where a release deploys" });

  const listed = await cli(["variable-list", "--workspace", fx.workspace]);
  assert.deepEqual(listed.variables.map((variable) => [variable.name, variable.type, variable.value]), [
    ["build.root", "string", "/srv/build/output"],
    ["deploy.enabled", "boolean", "true"],
    ["deploy.host", "string", "release.example.com"],
    ["deploy.sshHost", "string", ""],
  ]);
  assert.deepEqual(listed.withheld, [{ name: "build.root", reason: "absolute-path" }], "the custom section would leave out an absolute path");

  const refuse = (flags) => asAtelier(() => refusal(["variable-set", "--workspace", fx.workspace, "--at", at(), ...flags]));
  assert.equal((await refuse(["--name", "deploy.list", "--type", "list", "--value", "x"])).reasonCode, "VARIABLE_TYPE_INVALID");
  const system = await refuse(["--name", "models.tiers", "--type", "string", "--value", "x"]);
  assert.deepEqual([system.reasonCode, system.details.reason], ["VARIABLE_NAME_INVALID", "system-setting"]);
  assert.equal((await refuse(["--name", "deploy.port", "--type", "number", "--value", "abc"])).reasonCode, "VARIABLE_VALUE_INVALID");
  const missing = await refuse(["--name", "deploy.port", "--type", "number"]);
  assert.deepEqual([missing.reasonCode, missing.message], ["CLI_ARGUMENT_MISSING", "value"]);
  assert.equal((await refuse(["--name", "deploy.port", "--type", "number", "--value", "1", "--key", "x"])).reasonCode, "CLI_ARGUMENT_UNKNOWN");

  const before = await versionOf(fx.workspace);
  const removed = await asAtelier(() => cli(["variable-remove", "--workspace", fx.workspace, "--at", at(), "--name", "deploy.host"]));
  assert.deepEqual([removed.reasonCode, removed.variable, removed.ids, removed.version], ["VARIABLE_WRITE_COMMITTED", null, ["variable:deploy.host"], before + 1]);
  assert.deepEqual((await cli(["variable-list", "--workspace", fx.workspace])).variables.map((variable) => variable.name), ["build.root", "deploy.enabled", "deploy.sshHost"]);
  const again = await asAtelier(() => refusal(["variable-remove", "--workspace", fx.workspace, "--at", at(), "--name", "deploy.host"]));
  assert.equal(again.reasonCode, "CONFIG_RECORD_NOT_FOUND");
  assert.equal(await versionOf(fx.workspace), before + 1);
});

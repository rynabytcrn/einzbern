// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { runtimeInputContract } from "../dist/build/packages/core/src/runtime-input-contract.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { deviceHome } from "../dist/build/packages/core/src/device-home.js";
import { machineSettingsPath } from "../dist/build/packages/core/src/machine-settings.js";
import { deviceCleanHome } from "../dist/build/packages/core/src/device-clean.js";
import { hookHost } from "../dist/build/packages/core/src/hook-recall.js";
import { heavyLockDirectory } from "../scripts/lib/heavy-runs.mjs";

const root = resolve(import.meta.dirname, "..");
const source = (path) => readFile(resolve(root, path), "utf8");
const contract = runtimeInputContract(COMMAND_CATALOG);
const RUNTIME_INPUT_DISCOVERY = contract.coverage;
const byKey = new Map(contract.entries.map((entry) => [entry.key, entry]));

function ast(text, path = "source.ts") {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}
function namedFunction(text, name) {
  const node = ast(text).statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `source function ${name} exists`);
  return ts.transpile(node.getText(), { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS }).replace(/^export /mu, "");
}
async function sourceFiles(directory) {
  const paths = [];
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) paths.push(...await sourceFiles(path));
    else if (/\.(?:ts|js|mjs)$/u.test(path)) paths.push(path);
  }
  return paths;
}

test("runtime dictionary has complete immutable per-field metadata without reading runtime values", () => {
  assert.equal(contract.schemaVersion, "einzbern.runtime-input-contract.v1");
  assert.equal(contract.commandCatalogAttached, true);
  assert.equal(runtimeInputContract().commandCatalogAttached, false);
  assert.equal(new Set(contract.entries.map((entry) => entry.key)).size, contract.entries.length);
  assert.ok(contract.entries.length >= 59);
  for (const entry of contract.entries) {
    for (const key of ["kind", "name", "classification", "visibility", "semanticType", "transport", "validation", "defaultDescription", "owner", "scope", "source", "persistence", "sensitivity", "sharing", "export", "effect", "restart", "editing", "consumption"]) {
      assert.equal(typeof entry[key], "string", `${entry.key}.${key}`);
      assert.ok(entry[key].length > 0, `${entry.key}.${key}`);
    }
    assert.ok(Object.hasOwn(entry, "defaultValue"), entry.key);
    assert.ok(Object.hasOwn(entry, "pathBase"), entry.key);
    assert.ok(entry.precedence.length > 0, entry.key);
    assert.ok(entry.consumer.length > 0, entry.key);
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.precedence));
    assert.ok(Object.isFrozen(entry.consumer));
    assert.ok(!Object.hasOwn(entry, "effectiveValue"));
    assert.ok(!Object.hasOwn(entry, "rawValue"));
  }
  const original = process.env.EINZBERN_HEAVY_SLOT;
  const sentinel = "not-a-real-lease-never-export-this-marker";
  try {
    process.env.EINZBERN_HEAVY_SLOT = sentinel;
    assert.ok(!JSON.stringify(runtimeInputContract()).includes(sentinel));
  } finally {
    if (original === undefined) delete process.env.EINZBERN_HEAVY_SLOT;
    else process.env.EINZBERN_HEAVY_SLOT = original;
  }
});

test("catalog adapter preserves all operational flag metadata and lifecycle fields use that same catalog", () => {
  assert.deepEqual(contract.commandCatalog, COMMAND_CATALOG);
  assert.deepEqual(contract.entries.filter((entry) => entry.kind === "cli-argument" && entry.classification === "internal-transient").map((entry) => entry.key), ["cli:setup:codex-admission"]);
  for (const entry of contract.entries.filter((item) => item.kind === "cli-argument")) {
    const command = COMMAND_CATALOG.find((item) => item.name === entry.command);
    const flag = command.flags.find((item) => `--${item.name}` === entry.name);
    assert.deepEqual(entry.flag, flag, entry.key);
    assert.notEqual(entry.flag, flag, "immutable copy, not mutation of command metadata");
    assert.equal(entry.classification, entry.key === "cli:setup:codex-admission" ? "internal-transient" : "lifecycle-input", entry.key);
    assert.equal(entry.persistence, "invocation");
  }
  const admission = byKey.get("cli:setup:codex-admission");
  assert.equal(admission.visibility, "integration");
  assert.equal(admission.owner, "owning live Codex client");
  assert.equal(admission.source, "owning client capability/version/trust observations; not authentication");
  assert.equal(admission.scope, "one traditional setup plan/apply");
  assert.equal(admission.defaultValue, null);
  assert.equal(admission.pathBase, "explicit absolute path");
  assert.equal(admission.sensitivity, "context-may-contain-private-data");
  assert.equal(admission.sharing, "never a shared or global setting; input file retained by its caller");
  assert.equal(admission.export, "local plan/receipt only; no raw observation promoted to shared configuration");
  assert.deepEqual(admission.consumer, ["packages/cli/src/index.ts setup handler", "packages/core/src/setup.ts planSetup/applySetup", "packages/core/src/setup-fresh.ts planWiring/applyWiring", "packages/core/src/host-hooks.ts planHostHooks"]);
  assert.match(admission.defaultDescription, /unknown; new native stop entry omitted/u);
  assert.match(admission.validation, /No version range or flag implies support/u);
  assert.match(admission.effect, /Does not grant trust, enable hooks=false, change non-Codex events or enroll a native controller/u);
  for (const command of ["setup", "engine-update", "engine-rollback", "device-clean"]) {
    assert.deepEqual(contract.entries.filter((item) => item.command === command).map((item) => item.name).sort(), COMMAND_CATALOG.find((item) => item.name === command).flags.map((item) => `--${item.name}`).sort(), command);
  }
  const missingHome = COMMAND_CATALOG.map((entry) => entry.name === "device-clean" ? { ...entry, flags: entry.flags.filter((flag) => flag.name !== "home") } : entry);
  assert.throws(() => runtimeInputContract(missingHome), /RUNTIME_INPUT_CATALOG_MISMATCH.*device-clean/u);
  assert.ok(contract.limits.some((item) => item.includes("not every operational CLI payload")));
});

test("bounded product source discovery classifies every literal owned environment name including computed lookup declarations", async () => {
  const paths = [...RUNTIME_INPUT_DISCOVERY.entryFiles];
  for (const directory of RUNTIME_INPUT_DISCOVERY.sourceDirectories) paths.push(...await sourceFiles(directory));
  const discovered = new Map();
  for (const path of paths.filter((item) => !RUNTIME_INPUT_DISCOVERY.excludedFiles.includes(item))) {
    const parsed = ast(await source(path), path);
    const visit = (node) => {
      // The I/O domain error constructor's first argument is a diagnostic code, not
      // a computed environment key. Do not exclude names by suffix: an actual env
      // lookup with the same spelling must still be inventoried.
      const diagnosticCode = ts.isStringLiteral(node) && ts.isNewExpression(node.parent)
        && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "IoPolicyError"
        && node.parent.arguments?.[0] === node;
      if (!diagnosticCode && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^(?:EINZBERN|TCRN)_[A-Z0-9_]+$/u.test(node.text)) {
        const references = discovered.get(node.text) ?? new Set();
        references.add(path);
        discovered.set(node.text, references);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const entries = contract.entries.filter((entry) => entry.kind === "environment" && /^(?:EINZBERN|TCRN)_/u.test(entry.name));
  assert.deepEqual([...discovered.keys()].sort(), entries.map((entry) => entry.name).sort(), "new literal name needs explicit public/internal/test/helper classification; removal needs reconciliation");
  for (const name of ["EINZBERN_HOME", "EINZBERN_HEAVY_LOCK_DIR", "EINZBERN_GATE_RUN_PRIOR", "TCRN_PORTAL_WORK_PAGE_RECORDS"]) assert.ok(discovered.has(name), name);
  assert.ok(RUNTIME_INPUT_DISCOVERY.exclusions.some((item) => item.category === "unknown-dynamic-reads"));
  assert.ok(RUNTIME_INPUT_DISCOVERY.exclusions.some((item) => item.category === "tooling-not-product-startup"));
});

test("device root and the two CLI home conventions stay distinct and preserve consumer precedence", () => {
  const device = resolve(root, "fixture-device");
  const home = resolve(root, "fixture-user");
  assert.equal(deviceHome({ EINZBERN_HOME: device }, home), device);
  assert.equal(deviceHome({ EINZBERN_HOME: "" }, home), resolve(home, ".einzbern"));
  assert.throws(() => deviceHome({ EINZBERN_HOME: "relative-device" }, home), { reasonCode: "DEVICE_HOME_INVALID" });
  const previous = process.env.EINZBERN_HOME;
  try {
    process.env.EINZBERN_HOME = "invalid-relative-env-root";
    assert.equal(machineSettingsPath(home), resolve(home, ".einzbern", "machine-settings.json"));
    assert.equal(deviceCleanHome(home), resolve(home, ".einzbern"));
    assert.throws(() => machineSettingsPath(), { reasonCode: "DEVICE_HOME_INVALID" });
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  }
  assert.match(byKey.get("cli:device-clean:home").pathBase, /user-home/u);
  assert.match(byKey.get("installer:home").pathBase, /device directory/u);
  assert.equal(heavyLockDirectory({ EINZBERN_HOME: device, EINZBERN_HEAVY_LOCK_DIR: "relative-locks" }, home), resolve("relative-locks"));
  assert.equal(heavyLockDirectory({ EINZBERN_HOME: device }, home), resolve(device, "locks"));
});

test("host declarations are untrusted context and internal handoff/lease controls are not editable settings", () => {
  for (const host of ["claude-code", "codex", "dsh"]) assert.equal(hookHost({ EINZBERN_HOST: host, CLAUDE_PROJECT_DIR: "/present" }), host);
  assert.equal(hookHost({ EINZBERN_HOST: "unknown", CLAUDE_PROJECT_DIR: "/present" }), "claude-code");
  assert.equal(hookHost({ EINZBERN_HOST: "", CLAUDE_PROJECT_DIR: "" }), "codex");
  for (const name of ["EINZBERN_SURFACE", "EINZBERN_PROJECT_CONTEXT", "EINZBERN_GATE_RUN_PRIOR", "EINZBERN_HEAVY_SLOT"]) {
    const entry = byKey.get(`env:${name}`);
    assert.equal(entry.classification, "internal-transient", name);
    assert.equal(entry.visibility, "internal", name);
    assert.equal(entry.persistence, "invocation", name);
  }
  assert.equal(byKey.get("env:EINZBERN_HEAVY_SLOT").sensitivity, "transient-token");
  assert.match(byKey.get("env:EINZBERN_SURFACE").validation, /not authentication/u);
  assert.match(byKey.get("env:TCRN_PORTAL_ACTOR").effect, /not authenticated/u);
});

test("Portal argument metadata matches the existing parser including first-value and empty fallback behavior", async () => {
  const text = await source("portal/portal.mjs");
  const body = namedFunction(text, "argument");
  const argument = (argv, key, fallback) => vm.runInNewContext(`${body}\nargument(name, fallback)`, { process: { argv: ["node", "portal.mjs", ...argv] }, name: key, fallback });
  assert.equal(argument(["--port", "0"], "port", "4319"), "0");
  assert.equal(argument(["--port", "5", "--port", "7"], "port", "4319"), "5");
  assert.equal(argument(["--port"], "port", "4321"), "4321");
  assert.equal(argument(["--port=4322"], "port", "4321"), "4321");
  assert.equal(argument(["--port", ""], "port", "4321"), "");
  const expression = text.match(/const port = (Number\(portArgument[^;]+);/u)?.[1];
  assert.ok(expression);
  const readPort = async (portArgument, machine) => vm.runInNewContext(`(async () => (${expression}))()`, { portArgument, machineValue: async () => machine });
  assert.equal(await readPort("0", "4321"), 0);
  assert.equal(await readPort("", "4321"), 4321);
  assert.equal(await readPort("", ""), 4319);
  assert.equal(await readPort("0x10", "4321"), 16, "document numeric coercion rather than inventing a stricter parser");
  assert.equal(byKey.get("env:TCRN_PORTAL_PORT").min, 0);
  assert.equal(byKey.get("env:TCRN_PORTAL_PORT").max, 65535);
  assert.match(byKey.get("portal:port").effect, /--port=value is not/u);
});

test("Portal initial selection uses explicit registered selector, cwd, machine preference, then registry order", async () => {
  const text = await source("portal/portal.mjs");
  const functionText = namedFunction(text, "initialLibrary");
  const libraries = [{ libraryId: "first", projectPath: "/first" }, { libraryId: "second", projectPath: "/second" }, { libraryId: "third", projectPath: "/third" }];
  const select = async (explicit, cwd, preferred) => vm.runInNewContext(`${functionText}\ninitialLibrary()`, {
    libraryArgument: explicit, libraryCatalog: libraries,
    matchLibrary: async (catalog, value) => catalog.find((item) => item.libraryId === value),
    cliResult: async () => ({ ok: true, body: { projectPath: cwd } }),
    machineValue: async () => preferred, process: { cwd: () => "/startup" },
    startupError: (reasonCode) => Object.assign(new Error(reasonCode), { reasonCode }),
  });
  assert.equal((await select("third", "/second", "first")).library.libraryId, "third");
  await assert.rejects(select("unknown", "/second", "first"), { reasonCode: "PORTAL_LIBRARY_UNKNOWN" });
  assert.equal((await select("", "/second", "third")).selectedBy, "working-directory");
  assert.equal((await select("", "/absent", "third")).selectedBy, "machine-default");
  assert.equal((await select("", "/absent", "unknown")).library.libraryId, "first");
  assert.equal(byKey.get("env:TCRN_PORTAL_LIBRARY").precedence.length, 5);
});

test("Portal work budget entries match consumer fallback and positive-safe-integer validation without starting a server", async () => {
  const text = await source("portal/portal.mjs");
  const functionText = namedFunction(text, "workReadBudget");
  const check = (name, value, fallback) => vm.runInNewContext(`${functionText}\nworkReadBudget(name, fallback)`, {
    process: { env: value === undefined ? {} : { [name]: value } }, name, fallback,
    startupError: (reasonCode) => Object.assign(new Error(reasonCode), { reasonCode }),
  });
  for (const match of text.matchAll(/workReadBudget\("(TCRN_PORTAL_WORK_[A-Z_]+)", ([0-9]+)\)/gu)) {
    const name = match[1];
    const fallback = Number(match[2]);
    assert.equal(byKey.get(`env:${name}`).defaultValue, fallback);
    assert.equal(check(name, undefined, fallback), fallback);
    assert.equal(check(name, "1", fallback), 1);
    assert.equal(check(name, String(Number.MAX_SAFE_INTEGER), fallback), Number.MAX_SAFE_INTEGER);
    for (const value of ["", "0", "01", "+1", "1.1", " 1", "1e2", "9007199254740992"]) assert.throws(() => check(name, value, fallback), { reasonCode: "PORTAL_WORK_READ_BUDGET_INVALID" });
  }
});

test("local I/O budget dictionary matches the real helper validation and per-caller defaults", async () => {
  const text = await source("packages/core/src/io-policy.ts");
  const rename = namedFunction(text, "renameRetryBudget");
  const probe = namedFunction(text, "localProbeTimeout");
  const errorNode = ast(text).statements.find((item) => ts.isClassDeclaration(item) && item.name?.text === "IoPolicyError");
  assert.ok(errorNode, "I/O domain error class exists");
  const errorClass = ts.transpile(errorNode.getText(), { target: ts.ScriptTarget.ES2024 });
  const evaluate = (body, expression, env = {}, values = {}) => vm.runInNewContext(`${errorClass}\n${body}\n${expression}`, { exports: {}, process: { env }, RUNTIME_CAPACITY: { timerMilliseconds: 0x7fff_ffff }, ...values });
  assert.equal(evaluate(rename, "renameRetryBudget()"), byKey.get("env:EINZBERN_RENAME_RETRY_BUDGET").defaultValue);
  assert.equal(evaluate(rename, "renameRetryBudget()", { EINZBERN_RENAME_RETRY_BUDGET: "0" }), 0);
  assert.equal(evaluate(rename, "renameRetryBudget(2)", { EINZBERN_RENAME_RETRY_BUDGET: "bad" }), 2);
  for (const value of ["", "-1", "01", "1.5", "9007199254740992"]) assert.throws(() => evaluate(rename, "renameRetryBudget()", { EINZBERN_RENAME_RETRY_BUDGET: value }), /EINZBERN_RENAME_RETRY_BUDGET_INVALID/u);
  assert.equal(evaluate(probe, "localProbeTimeout()"), byKey.get("env:EINZBERN_LOCAL_PROBE_TIMEOUT_MS").defaultValue);
  assert.equal(evaluate(probe, "localProbeTimeout(30000)"), 30000);
  assert.equal(evaluate(probe, "localProbeTimeout(30000)", { EINZBERN_LOCAL_PROBE_TIMEOUT_MS: "1" }), 1);
  assert.equal(evaluate(probe, "localProbeTimeout()", { EINZBERN_LOCAL_PROBE_TIMEOUT_MS: String(0x7fff_ffff) }), 0x7fff_ffff);
  for (const value of ["0", "01", "-1", "2147483648"]) assert.throws(() => evaluate(probe, "localProbeTimeout()", { EINZBERN_LOCAL_PROBE_TIMEOUT_MS: value }), /EINZBERN_LOCAL_PROBE_TIMEOUT_MS_INVALID/u);
});

test("browser preference inventory matches actual read/write keys, valid values and system-theme consumer", async () => {
  const text = await source("portal/index.html");
  const keys = [...new Set([...text.matchAll(/tcrn(?:Read|Write)Preference\("([^"]+)"/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(keys, contract.entries.filter((entry) => entry.kind === "browser-storage").map((entry) => entry.key.replace("browser:", "")).sort());
  const prefix = text.match(/TCRN_PORTAL_PREFERENCE_PREFIX = "([^"]+)"/u)?.[1];
  for (const key of keys) assert.equal(byKey.get(`browser:${key}`).name, `${prefix}${key}`);
  const headScript = text.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  const storage = new Map();
  const context = { window: { localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) } }, document: { documentElement: { dataset: {} } } };
  vm.runInNewContext(headScript, context);
  assert.equal(context.document.documentElement.dataset.tcrnTheme, "light");
  const choices = byKey.get("browser:theme").allowedValues;
  for (const value of [...choices, "system", "invalid"]) {
    storage.set(`${prefix}theme`, value);
    assert.equal(context.window.tcrnReadPreference("theme", choices, null), choices.includes(value) ? value : null);
  }
  context.window.localStorage.getItem = () => { throw new Error("unavailable"); };
  assert.equal(context.window.tcrnReadPreference("theme", choices, "light"), "light");
  const locales = await source("portal/locales.js");
  assert.deepEqual([...locales.matchAll(/^  "([a-zA-Z-]+)": \{/gmu)].map((match) => match[1]).sort(), [...byKey.get("browser:locale").allowedValues].sort());
  assert.match(text, /followSystemTheme = storedTheme === null && machineTheme === "system"/u);
  assert.match(text, /systemTheme\?\.addEventListener\?\.\("change", applySystemTheme\)/u);
});

test("standalone installer flag parity and path/checksum contracts remain separate from setup and engine-update", async () => {
  const text = await source("skill/mana-orchestrate/scripts/install.mjs");
  const flagLiteral = text.match(/const FLAGS = Object\.freeze\((\[[^;]+\])\);/u)?.[1];
  assert.ok(flagLiteral);
  const flags = Array.from(vm.runInNewContext(flagLiteral));
  assert.deepEqual(flags.sort(), contract.entries.filter((entry) => entry.kind === "installer-argument").map((entry) => entry.name).sort());
  const parsed = ast(text);
  const constants = parsed.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ["FLAGS", "VERSION_PATTERN", "DIGEST_PATTERN", "USAGE", "DEVICE_DIRECTORY"].includes(declaration.name.getText()))).map((node) => node.getText()).join("\n");
  const parse = (argv, env = {}) => vm.runInNewContext(`${constants}\n${namedFunction(text, "parseArguments")}\nparseArguments(argv)`, {
    argv, process: { env }, resolve, join: (...parts) => parts.join("/"), isAbsolute: (path) => path.startsWith("/"), homedir: () => "/test-user",
    fail: (reasonCode) => { throw Object.assign(new Error(reasonCode), { reasonCode }); },
  });
  assert.equal(parse(["--version", "2.2.3", "--home", "relative-device"], { EINZBERN_HOME: "invalid-relative" }).home, resolve("relative-device"));
  assert.throws(() => parse(["--version", "2.2.3"], { EINZBERN_HOME: "relative" }), { reasonCode: "DEVICE_HOME_INVALID" });
  assert.equal(parse(["--archive", "release.tar.gz"]).archive, resolve("release.tar.gz"));
  assert.throws(() => parse(["--version", "2.2.3", "--version", "2.2.3"]), { reasonCode: "INSTALL_USAGE" });
  assert.throws(() => parse(["--version=2.2.3"]), { reasonCode: "INSTALL_USAGE" });
  assert.throws(() => parse(["--version", "2.2.3", "--sha256", "bad"]), { reasonCode: "INSTALL_SHA256_INVALID" });
  assert.match(byKey.get("installer:sha256").validation, /archive SHA-256/u);
  assert.match(byKey.get("cli:engine-update:sha256").validation, /install-tree SHA-256/u);
  assert.match(byKey.get("cli:setup:archive").pathBase, /project root/u);
});

test("test seams and unconsumed observability helper are not advertised as working public configuration", async () => {
  const tests = contract.entries.filter((entry) => entry.classification === "test-only");
  assert.equal(tests.length, 4);
  const text = await source("scripts/lib/safe-io.mjs");
  for (const entry of tests) {
    assert.equal(entry.visibility, "test-only");
    assert.equal(entry.consumption, "test-only");
    for (const point of entry.allowedValues) assert.ok(text.includes(`"${point}"`), point);
  }
  const sink = byKey.get("env:TCRN_OTEL_SINK");
  assert.equal(sink.consumption, "helper-only");
  assert.match(sink.effect, /does not invoke/u);
  assert.ok(!(await source("packages/cli/src/index.ts")).includes("emitVerbSpan"), "when wired, update helper-only metadata and consumer test");
  for (const key of ["host:hook-command", "host:codex-hooks-feature", "host:codex-hook-trust"]) {
    const entry = byKey.get(key);
    assert.equal(entry.classification, "managed-integration");
    assert.equal(entry.persistence, "managed-device-file");
    assert.notEqual(entry.owner, "governed-project");
  }
  assert.match(byKey.get("host:codex-hook-trust").validation, /does not manufacture user approval/u);
});

test("dot setup inputs have explicit independent ownership and no invented source defaults", () => {
  const target = byKey.get("cli:setup:execution-target");
  assert.deepEqual(target.allowedValues, ["traditional", "chatgpt-dot"]);
  assert.equal(target.defaultValue, "traditional");
  const input = byKey.get("cli:setup:dot-input");
  assert.equal(input.defaultValue, null);
  assert.equal(input.pathBase, "explicit absolute path");
  assert.equal(input.sensitivity, "context-may-contain-private-data");
  assert.match(input.sharing, /no remote or library/u);
});

test("INIT062 all package flags and backup read startup input are described without invented policy or identity", () => {
  for (const command of COMMAND_CATALOG.filter(entry => /^(?:config-backup-|config-restore-|execution-native-|shared-submit-)/u.test(entry.name))) {
    const entries = contract.entries.filter(entry => entry.command === command.name);
    assert.deepEqual(entries.map(entry => entry.name).sort(), command.flags.map(flag => `--${flag.name}`).sort(), command.name);
    assert.ok(entries.every(entry => entry.defaultValue === null));
  }
  assert.match(byKey.get("portal:config-backup-root").defaultDescription, /not-scanned/u);
  assert.match(byKey.get("cli:execution-native-record:response").defaultDescription, /pending/u);
  assert.match(byKey.get("cli:config-backup-create:request").effect, /actual running package artifact/u);
  assert.match(byKey.get("cli:work-project-context:execution-request").validation, /DotExecutionRequest/u);
});

test("J01/J10 approval binding and retry/history files remain explicit transient inputs", () => {
  assert.equal(byKey.get("cli:setup:approved-plan-digest").semanticType, "digest");
  for (const key of ["cli:execution-native-record:prior", "cli:execution-native-prepare:retry-from", "cli:execution-native-prepare:reconciliation"]) {
    assert.equal(byKey.get(key).semanticType, "path"); assert.equal(byKey.get(key).defaultValue, null);
    assert.equal(byKey.get(key).sensitivity, "context-may-contain-private-data");
  }
});

test("full-core controller defaults and caps at 900000ms while P8 and explicit smaller budgets remain bounded", async () => {
  const text = await source("scripts/task.mjs");
  const body = namedFunction(text, "controllerTimeoutMs");
  const budget = (value, p8Only = false) => vm.runInNewContext(`${body}\ncontrollerTimeoutMs(p8Only)`, {
    process: { env: value === undefined ? {} : { TCRN_TEST_CONTROLLER_TIMEOUT_MS: value } }, p8Only,
    assertion: (condition, reasonCode, detail) => { if (!condition) throw Object.assign(new Error(detail), { reasonCode }); },
  });
  assert.equal(budget(undefined), 900_000);
  assert.equal(budget(undefined, true), 600_000);
  for (const value of ["1", "100", "3000", "599999", "600000", "600001", "899999", "900000", " 100 ", "1e3", "0x64"]) assert.equal(budget(value), Number(value));
  for (const value of ["1", "100", "3000", "600000"]) assert.equal(budget(value, true), Number(value));
  for (const p8Only of [false, true]) for (const value of ["", " ", "0", "-1", "1.5", "900001", "9007199254740992", "Infinity", "-Infinity", "NaN", "abc"]) assert.throws(() => budget(value, p8Only), { reasonCode: "TEST_CONTROLLER_TIMEOUT_INVALID" });
  for (const value of ["600001", "899999", "900000"]) assert.throws(() => budget(value, true), { reasonCode: "TEST_CONTROLLER_TIMEOUT_INVALID" });
  assert.ok(text.includes("const timeoutMs = controllerTimeoutMs(p8Only);"));
  assert.ok(text.includes("}, tests, p8Only);"));
  assert.ok(text.includes('const dogfood = await runTests({ p8Only: true });'));
  assert.ok(text.includes('return runTests();'));
});

test("native IPC environment is invocation-local integration, never shared configuration", () => {
  const input = byKey.get("env:EINZBERN_CODEX_NATIVE_HOOK_SOCKET");
  assert.equal(input.classification, "internal-transient");
  assert.equal(input.persistence, "invocation");
  assert.equal(input.visibility, "integration");
  assert.match(input.validation, /same UID/u);
  assert.match(input.sharing, /never persisted/u);
  assert.match(input.effect, /does not create a client/u);
});

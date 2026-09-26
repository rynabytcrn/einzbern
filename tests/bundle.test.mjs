// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R1, R4, AC1: scripts/bundle.mjs folds the CLI entry and every module it
// reaches into one file, which lists the command catalog from a directory that holds nothing else:
// no node_modules, no dist/build. The file names no module but node: built-ins, carries the files
// the engine reads at load, and still refuses an older Node.js first. The bundled fixture group
// behaves as its modules do when Node.js runs them: an import cycle, export *, live bindings,
// import(), a file read beside a module and the entry's own exports. A bare specifier that is not a
// node: built-in, and what one file cannot keep, are refused with reason codes.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import ts from "typescript";

import { BUNDLE_REASON_CODES, bundleEntry } from "../scripts/lib/bundle.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const bundleScript = join(repositoryRoot, "scripts/bundle.mjs");
const cliEntry = join(repositoryRoot, "scripts/einzbern.mjs");
const fixtureEntry = join(repositoryRoot, "tests/fixtures/bundle/entry.mjs");

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-bundle-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function node(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", ...options });
}

// Bundles `entry` through the script, then copies the bundle on its own into an empty directory.
async function bundleAlone(base, entry, name) {
  const out = join(base, "out", name);
  const written = node([bundleScript, "--entry", entry, "--out", out]);
  assert.equal(written.status, 0, written.stderr);
  const report = JSON.parse(written.stdout);
  assert.equal(report.reasonCode, "BUNDLE_WRITTEN");
  const directory = join(base, "alone");
  await mkdir(directory, { recursive: true });
  await copyFile(out, join(directory, name));
  return { path: join(directory, name), directory, report };
}

// Every module the bundle still names: import and export declarations, import() and require() with
// a literal argument, and the built-ins it loads.
function namedModules(code) {
  const sourceFile = ts.createSourceFile("bundle.mjs", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && ["require", "__einzbernBundleBuiltin"].includes(node.expression.text)))) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function lastLine(text) {
  return text.trim().split("\n").at(-1);
}

test("the CLI entry bundles into one file that runs with no node_modules and no dist/build beside it", async (context) => {
  const base = await scratch(context);
  const { path, directory, report } = await bundleAlone(base, cliEntry, "einzbern.mjs");
  assert.equal(report.entry, "scripts/einzbern.mjs");
  assert.ok(report.modules > 2, "the entry and the engine modules it reaches");
  // The knowledge provenance policy is read when the engine loads. The dispatch defaults were the
  // other file until TCRN-CROSS-STORY-484 R3 retired them (models-tiers.ts holds the default tiers).
  assert.equal(report.files, 1);

  const code = await readFile(path, "utf8");
  const named = namedModules(code);
  assert.deepEqual(named.filter((specifier) => !specifier.startsWith("node:")), [], "no relative and no package import is left");
  assert.ok(named.includes("node:fs"), "built-ins stay outside the file");
  assert.equal(code.includes(repositoryRoot), false, "the bundle names no path of the machine that built it");

  const home = join(base, "home");
  await mkdir(home);
  const env = { ...process.env, HOME: home, EINZBERN_HOME: join(home, "einzbern") };
  const bundled = node([path, "commands"], { cwd: directory, env });
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.equal(JSON.parse(bundled.stdout).reasonCode, "CLI_CATALOG_READY");
  const unbundled = node([cliEntry, "commands"], { cwd: directory, env });
  assert.equal(unbundled.status, 0, unbundled.stderr);
  assert.equal(bundled.stdout, unbundled.stdout, "the bundle lists the same catalog");

  // R4 holds in the bundle too: an older Node.js is refused before any command runs.
  const preload = join(base, "older-node.mjs");
  await writeFile(preload, "Object.defineProperty(process.versions, \"node\", { value: \"22.12.0\" });\n");
  const older = node(["--import", pathToFileURL(preload).href, path, "commands"], { cwd: directory, env });
  assert.equal(older.status, 1);
  assert.equal(older.stdout, "");
  const refusal = JSON.parse(lastLine(older.stderr));
  assert.deepEqual(
    { ok: refusal.ok, reasonCode: refusal.reasonCode, required: refusal.required, actual: refusal.actual },
    { ok: false, reasonCode: "ENGINE_NODE_TOO_OLD", required: "24.0.0", actual: "22.12.0" },
  );
});

test("the bundled fixture behaves as its modules do: a cycle, export *, live bindings, import() and a carried file", async (context) => {
  const base = await scratch(context);
  const { path, directory, report } = await bundleAlone(base, fixtureEntry, "fixture.mjs");
  assert.equal(report.entry, "tests/fixtures/bundle/entry.mjs");
  assert.equal(report.modules, 9);
  assert.equal(report.files, 1);

  const unbundled = node([fixtureEntry], { cwd: directory });
  assert.equal(unbundled.status, 0, unbundled.stderr);
  const bundled = node([path], { cwd: directory });
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.equal(bundled.stdout, unbundled.stdout);
  assert.deepEqual(JSON.parse(bundled.stdout), {
    order: ["cycle-odd", "cycle-even", "square", "circle", "shapes", "counter", "entry", "lazy"],
    cycle: { even4: true, even7: false, odd3: true, evenOfZeroDuringTheCycle: true },
    shapes: { names: ["circleArea", "name", "square"], name: "shapes", square: 9, circle: 13 },
    counter: 2,
    greeting: "hello, bundle",
    lazy: "loaded on demand",
    builtin: "a/b",
    data: { exists: true, content: { carried: "read through new URL(\"./data.json\", import.meta.url)" } },
  });

  // The entry's exports are the bundle's.
  const probe = "const module = await import(process.argv[1]); process.stdout.write(`${JSON.stringify({ keys: Object.keys(module), exported: module.exported })}\\n`);";
  for (const target of [fixtureEntry, path]) {
    const imported = node(["--input-type=module", "-e", probe, pathToFileURL(target).href], { cwd: directory });
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(lastLine(imported.stdout)), { keys: ["exported"], exported: "exported by the entry" });
  }
});

test("a bare specifier that is not a node: built-in is refused with BUNDLE_EXTERNAL_DEPENDENCY", async (context) => {
  const base = await scratch(context);
  const project = join(base, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{\n  \"type\": \"module\"\n}\n");
  await writeFile(join(project, "entry.mjs"), "import { helper } from \"./helper.mjs\";\nhelper();\n");
  const refused = async (source, specifier) => {
    await writeFile(join(project, "helper.mjs"), source);
    await assert.rejects(bundleEntry(join(project, "entry.mjs")), (error) => {
      assert.equal(error.reasonCode, "BUNDLE_EXTERNAL_DEPENDENCY");
      assert.deepEqual(error.details, { specifier, from: "helper.mjs" });
      return true;
    });
  };
  await refused("import pad from \"left-pad\";\nexport function helper() {\n  return pad(\"x\", 2);\n}\n", "left-pad");
  // A built-in named without node: is not kept outside either.
  await refused("import { readFileSync } from \"fs\";\nexport function helper() {\n  return readFileSync;\n}\n", "fs");
  await refused("export async function helper() {\n  return import(\"left-pad\");\n}\n", "left-pad");

  const out = join(base, "out", "bundle.mjs");
  const script = node([bundleScript, "--entry", join(project, "entry.mjs"), "--out", out]);
  assert.equal(script.status, 1);
  assert.equal(script.stdout, "");
  assert.deepEqual(JSON.parse(script.stderr).reasonCode, "BUNDLE_EXTERNAL_DEPENDENCY");
  assert.equal(existsSync(out), false, "nothing is written");
});

test("what one file cannot keep is refused: await outside the entry, a module outside the package, a missing module", async (context) => {
  const base = await scratch(context);
  const project = join(base, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{\n  \"type\": \"module\"\n}\n");
  await writeFile(join(base, "outside.mjs"), "export const value = 1;\n");
  await writeFile(join(project, "late.mjs"), "export const value = await Promise.resolve(1);\n");
  const cases = [
    ["./late.mjs", "BUNDLE_TOP_LEVEL_AWAIT_UNSUPPORTED", { module: "late.mjs" }],
    ["../outside.mjs", "BUNDLE_OUTSIDE_ROOT", { specifier: "../outside.mjs", from: "entry.mjs" }],
    ["./absent.mjs", "BUNDLE_MODULE_NOT_FOUND", { specifier: "./absent.mjs", from: "entry.mjs" }],
    ["./package.json", "BUNDLE_MODULE_UNSUPPORTED", { specifier: "./package.json", from: "entry.mjs" }],
  ];
  for (const [specifier, reasonCode, details] of cases) {
    assert.ok(BUNDLE_REASON_CODES.includes(reasonCode));
    await writeFile(join(project, "entry.mjs"), `import { value } from ${JSON.stringify(specifier)};\nconsole.log(value);\n`);
    await assert.rejects(bundleEntry(join(project, "entry.mjs")), (error) => {
      assert.equal(error.reasonCode, reasonCode, specifier);
      assert.deepEqual(error.details, details);
      return true;
    });
  }

  const usage = node([bundleScript, "--entry", join(project, "entry.mjs")]);
  assert.equal(usage.status, 1);
  assert.equal(JSON.parse(usage.stderr).reasonCode, "BUNDLE_USAGE");
  // The bundle is never written over a file it is built from.
  await writeFile(join(project, "entry.mjs"), "console.log(1);\n");
  const over = node([bundleScript, "--entry", join(project, "entry.mjs"), "--out", join(project, "entry.mjs")]);
  assert.equal(over.status, 1);
  assert.equal(JSON.parse(over.stderr).reasonCode, "BUNDLE_USAGE");
  assert.equal(await readFile(join(project, "entry.mjs"), "utf8"), "console.log(1);\n");
});

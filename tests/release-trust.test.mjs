// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3): release trust is the install-tree digest.
// The signed-manifest and trust root cases this file carried retired with that code; what
// is proved here is the one question left -- are the installed bytes the published bytes --
// through the core module and the einzbern-release-verify entry, and (TCRN-CROSS-STORY-488
// R3) that no signing code came back to answer a larger one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  INSTALL_TREE_DIGEST_VERSION,
  InstallTreeError,
  computeInstallTreeDigest,
  verifyInstallTree,
} from "../dist/build/packages/core/src/index.js";
import { repositoryRoot, toPosixPath } from "../scripts/lib/files.mjs";

const verifier = resolve(repositoryRoot, "scripts/verify-release-trust.mjs");

async function treeFixture(context, files) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-install-tree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

const releaseFiles = () => ({
  "package.json": "{\n  \"name\": \"einzbern\"\n}\n",
  "scripts/einzbern.mjs": "#!/usr/bin/env node\nconsole.log(\"einzbern\");\n",
  "dist/build/index.js": "export {};\n",
  "assets/logo.bin": Buffer.from([0, 1, 2, 13, 10, 255]),
});

function runVerifier(argv) {
  return spawnSync(process.execPath, [verifier, ...argv], { encoding: "utf8" });
}

test("an install tree is admitted when its digest equals the stated one", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const digest = await computeInstallTreeDigest(root);
  assert.equal(digest.schemaVersion, INSTALL_TREE_DIGEST_VERSION);
  assert.match(digest.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(digest.entries.map((entry) => entry.path), ["assets/logo.bin", "dist/build/index.js", "package.json", "scripts/einzbern.mjs"]);
  const verified = await verifyInstallTree(root, digest.sha256);
  assert.deepEqual([verified.ok, verified.reasonCode, verified.files], [true, "INSTALL_TREE_VERIFIED", 4]);

  const admitted = runVerifier(["--tree", root, "--sha256", digest.sha256]);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stderr, "");
  const receipt = JSON.parse(admitted.stdout);
  assert.deepEqual([receipt.admitted, receipt.reasonCode, receipt.actual], [true, "INSTALL_TREE_VERIFIED", digest.sha256]);
});

test("one changed byte refuses the tree and names both digests", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const stated = (await computeInstallTreeDigest(root)).sha256;
  await writeFile(join(root, "dist/build/index.js"), "export {};\n//\n");
  const refused = await verifyInstallTree(root, stated);
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "INSTALL_TREE_DIGEST_MISMATCH");
  assert.equal(refused.expected, stated);
  assert.notEqual(refused.actual, stated);

  const cli = runVerifier(["--tree", root, "--sha256", stated]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  const receipt = JSON.parse(cli.stderr);
  assert.deepEqual([receipt.admitted, receipt.reasonCode], [false, "INSTALL_TREE_DIGEST_MISMATCH"]);
});

test("a symbolic link or other non-regular file in the tree is refused, never followed", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const outside = await treeFixture(context, { "secret.txt": "outside the tree\n" });
  await symlink(join(outside, "secret.txt"), join(root, "scripts", "linked.txt"));
  await assert.rejects(() => computeInstallTreeDigest(root), (error) => error instanceof InstallTreeError && error.reasonCode === "INSTALL_TREE_ENTRY_NOT_REGULAR");
  const cli = runVerifier(["--tree", root, "--sha256", "0".repeat(64)]);
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stderr).reasonCode, "INSTALL_TREE_ENTRY_NOT_REGULAR");
});

test("CRLF and LF text digest the same, and a binary file is measured as it is", async (context) => {
  const lf = await treeFixture(context, { "a.txt": "one\ntwo\n", "b.bin": Buffer.from([0, 13, 10]) });
  const crlf = await treeFixture(context, { "a.txt": "one\r\ntwo\r\n", "b.bin": Buffer.from([0, 13, 10]) });
  const binaryLf = await treeFixture(context, { "a.txt": "one\ntwo\n", "b.bin": Buffer.from([0, 10]) });
  const lfDigest = await computeInstallTreeDigest(lf);
  assert.equal((await computeInstallTreeDigest(crlf)).sha256, lfDigest.sha256, "a text file's line endings do not move the digest");
  assert.equal(lfDigest.entries.find((entry) => entry.path === "a.txt").size, 8);
  assert.notEqual((await computeInstallTreeDigest(binaryLf)).sha256, lfDigest.sha256, "a binary file's CRLF is part of its bytes");
});

test("a malformed stated digest and a missing tree are refused with their own reasons", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  await assert.rejects(() => verifyInstallTree(root, "ABC"), (error) => error.reasonCode === "INSTALL_TREE_DIGEST_INVALID");
  await assert.rejects(() => computeInstallTreeDigest(join(root, "absent")), (error) => error.reasonCode === "INSTALL_TREE_NOT_DIRECTORY");
});

test("the verifier rejects missing, duplicate and unknown arguments", () => {
  for (const [argv, reasonCode] of [
    [[], "RELEASE_VERIFY_ARGUMENTS_REQUIRED"],
    [["--tree", "/x"], "RELEASE_VERIFY_ARGUMENTS_REQUIRED"],
    [["--tree", "/x", "--tree", "/y", "--sha256", "0".repeat(64)], "RELEASE_VERIFY_ARGUMENTS_INVALID"],
    [["--tree", "/x", "--sha256", "0".repeat(64), "--bundle", "/z"], "RELEASE_VERIFY_ARGUMENT_UNKNOWN"],
    [["--tree"], "RELEASE_VERIFY_ARGUMENTS_INVALID"],
  ]) {
    const result = runVerifier(argv);
    assert.equal(result.status, 1, argv.join(" "));
    assert.equal(JSON.parse(result.stderr).reasonCode, reasonCode, argv.join(" "));
  }
});

// TCRN-CROSS-STORY-488 R3 (MIN-235 D15): inspect modules reachable from release, package, P8,
// push-gate and install-verifier entrypoints, plus the package sources the packer loads through
// computed paths. This follows executable relative imports so a signer hidden in a helper stays
// visible, while TypeScript types and comments do not count as release mechanisms.
const RELEASE_EXECUTION_ROOTS = Object.freeze([
  "scripts/release.mjs",
  "scripts/pack-release.mjs",
  "scripts/task.mjs",
  "scripts/push-gate.mjs",
  "scripts/verify-release-trust.mjs",
  "packages/core/src/index.ts",
  "packages/core/src/node-floor.ts",
  "packages/core/src/format-version.ts",
  "packages/core/src/names.ts",
  "packages/cli/src/index.ts",
]);
const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const SIGNING_KEY_APIS = new Set([
  "sign", "verify", "createSign", "createVerify", "createPublicKey", "createPrivateKey",
  "generateKeyPair", "generateKeyPairSync", "KeyObject", "importKey",
]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SIGNING_COMMAND_APIS = new Set(["exec", "execFile", "execFileSync", "execSync", "execa", "run", "runCommand", "runLocalCommand", "spawn", "spawnSync"]);
const SIGNING_COMMANDS = new Set(["cosign", "gpg", "minisign", "openssl"]);
const RELEASE_SIGNING_ARTIFACT = /(?:^|[/.])[^/]*\.(?:sig|asc|sigstore|pem|pub|key|p12|pfx|intoto\.jsonl?)(?:$|[?#])|trust-archive|in-toto\.io\/Statement|slsa\.dev\/provenance/iu;

function moduleSpecifier(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function runtimeModuleSpecifiers(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier !== null) found.push(specifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier !== null) found.push(specifier);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0];
      const staticImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((staticImport || commonJsRequire) && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceScriptKind(path) {
  if (extname(path) === ".tsx") return ts.ScriptKind.TSX;
  if (extname(path) === ".ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

async function resolveRelativeModule(importer, specifier, root) {
  if (!specifier.startsWith(".")) return null;
  const requested = resolve(dirname(importer), specifier);
  const candidates = [requested, ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".json"].map((extension) => `${requested}${extension}`), ...["index.mjs", "index.js", "index.ts"].map((name) => join(requested, name))];
  for (const candidate of candidates) {
    const relativePath = relative(root, candidate);
    if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) continue;
    const metadata = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (metadata?.isFile() && !metadata.isSymbolicLink()) return candidate;
  }
  return null;
}

function unwrapExpression(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isAwaitExpression(node))) node = node.expression;
  return node;
}

function staticModuleLoad(node, names) {
  const expression = unwrapExpression(node);
  if (!ts.isCallExpression(expression) || expression.arguments.length === 0 || !ts.isStringLiteralLike(expression.arguments[0])) return null;
  const callee = expression.expression;
  const loader = ts.isIdentifier(callee) && (callee.text === "require" || callee.text === "import");
  return loader && names.has(expression.arguments[0].text) ? expression.arguments[0].text : null;
}

function importedBindings(sourceFile) {
  const cryptoNamespaces = new Set(["crypto"]);
  const subtleNamespaces = new Set(["subtle"]);
  const signingFunctions = new Set();
  const commandNamespaces = new Set();
  const commandFunctions = new Set(SIGNING_COMMAND_APIS);
  const variableDeclarations = [];

  const addModuleBindings = (moduleName, clause) => {
    if (moduleName && CRYPTO_MODULES.has(moduleName)) {
      if (clause?.name) cryptoNamespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) cryptoNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        const exported = (element.propertyName ?? element.name).text;
        const local = element.name.text;
        if (SIGNING_KEY_APIS.has(exported)) signingFunctions.add(local);
        if (exported === "webcrypto") cryptoNamespaces.add(local);
        if (exported === "subtle") subtleNamespaces.add(local);
      }
    }
    if (moduleName && CHILD_PROCESS_MODULES.has(moduleName)) {
      if (clause?.name) commandNamespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) commandNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        if (SIGNING_COMMAND_APIS.has((element.propertyName ?? element.name).text)) commandFunctions.add(element.name.text);
      }
    }
  };

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      addModuleBindings(moduleSpecifier(node.moduleSpecifier), node.importClause);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      addModuleBindings(moduleSpecifier(node.moduleReference.expression), { name: node.name, namedBindings: undefined });
    } else if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // Resolve the ordinary aliases used for Node's crypto and child-process modules, including
  // require()/import() locals and simple const aliases. This keeps the check about executed
  // mechanism calls instead of matching unrelated words in comments or type declarations.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const local = declaration.name.text;
      const initializer = unwrapExpression(declaration.initializer);
      const loadedCrypto = staticModuleLoad(initializer, CRYPTO_MODULES);
      const loadedChildProcess = staticModuleLoad(initializer, CHILD_PROCESS_MODULES);
      if (loadedCrypto && !cryptoNamespaces.has(local)) { cryptoNamespaces.add(local); changed = true; }
      if (loadedChildProcess && !commandNamespaces.has(local)) { commandNamespaces.add(local); changed = true; }
      if (ts.isIdentifier(initializer)) {
        if (cryptoNamespaces.has(initializer.text) && !cryptoNamespaces.has(local)) { cryptoNamespaces.add(local); changed = true; }
        if (subtleNamespaces.has(initializer.text) && !subtleNamespaces.has(local)) { subtleNamespaces.add(local); changed = true; }
        if (commandNamespaces.has(initializer.text) && !commandNamespaces.has(local)) { commandNamespaces.add(local); changed = true; }
        if (signingFunctions.has(initializer.text) && !signingFunctions.has(local)) { signingFunctions.add(local); changed = true; }
        if (commandFunctions.has(initializer.text) && !commandFunctions.has(local)) { commandFunctions.add(local); changed = true; }
      }
      if (ts.isPropertyAccessExpression(initializer)) {
        const receiver = unwrapExpression(initializer.expression);
        if (initializer.name.text === "webcrypto" && ts.isIdentifier(receiver) && cryptoNamespaces.has(receiver.text) && !cryptoNamespaces.has(local)) { cryptoNamespaces.add(local); changed = true; }
        if (initializer.name.text === "subtle" && ts.isIdentifier(receiver) && cryptoNamespaces.has(receiver.text) && !subtleNamespaces.has(local)) { subtleNamespaces.add(local); changed = true; }
        if (SIGNING_KEY_APIS.has(initializer.name.text) && ts.isIdentifier(receiver) && (cryptoNamespaces.has(receiver.text) || subtleNamespaces.has(receiver.text)) && !signingFunctions.has(local)) { signingFunctions.add(local); changed = true; }
        if (SIGNING_COMMAND_APIS.has(initializer.name.text) && ts.isIdentifier(receiver) && commandNamespaces.has(receiver.text) && !commandFunctions.has(local)) { commandFunctions.add(local); changed = true; }
      }
    }
  }
  return { cryptoNamespaces, subtleNamespaces, signingFunctions, commandNamespaces, commandFunctions };
}

function isCryptoSigningReceiver(node, bindings) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return bindings.cryptoNamespaces.has(expression.text) || bindings.subtleNamespaces.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = unwrapExpression(expression.expression);
  if ((expression.name.text === "crypto" || expression.name.text === "webcrypto") && ts.isIdentifier(receiver) && ["globalThis", "window", "self"].includes(receiver.text)) return true;
  if (expression.name.text === "subtle") return isCryptoSigningReceiver(receiver, bindings);
  if (expression.name.text === "webcrypto") return isCryptoSigningReceiver(receiver, bindings);
  return false;
}

function isCommandInvocation(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.commandFunctions.has(expression.text);
  return ts.isPropertyAccessExpression(expression)
    && bindings.commandFunctions.has(expression.name.text)
    && ts.isIdentifier(expression.expression)
    && bindings.commandNamespaces.has(expression.expression.text);
}

function signingCommandArgument(node) {
  if (!node) return null;
  const argument = unwrapExpression(node);
  const candidate = ts.isArrayLiteralExpression(argument) ? argument.elements[0] : argument;
  if (!candidate || !ts.isStringLiteralLike(candidate)) return null;
  const command = candidate.text.trim().split(/[\s]+/u, 1)[0].split(/[\\/]/u).at(-1).replace(/\.exe$/iu, "");
  return SIGNING_COMMANDS.has(command) ? command : null;
}

function signatureMechanismFindings(root, path, source, sourceFile) {
  const findings = new Set();
  const bindings = importedBindings(sourceFile);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && SIGNING_KEY_APIS.has(ts.isPropertyAccessExpression(expression) ? expression.name.text : (expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : "")) && isCryptoSigningReceiver(expression.expression, bindings)) {
        findings.add("a signing or key call through a crypto namespace");
      }
      if (ts.isIdentifier(expression) && bindings.signingFunctions.has(expression.text)) findings.add("a signing or key primitive imported from node:crypto");
      if (isCommandInvocation(expression, bindings) && signingCommandArgument(node.arguments[0])) findings.add("an external signing command on a release execution path");
    } else if (ts.isNewExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && SIGNING_KEY_APIS.has(expression.name.text) && isCryptoSigningReceiver(expression.expression, bindings)) {
        findings.add("a signing or key call through a crypto namespace");
      }
    }
    if (ts.isStringLiteralLike(node) && RELEASE_SIGNING_ARTIFACT.test(node.text)) {
      findings.add("a signature, provenance or trust-archive artifact path");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...findings].sort().map((finding) => `${toPosixPath(relative(root, path))}: ${finding}`);
}

async function retiredReleaseTrustCode(root) {
  const absoluteRoot = resolve(root);
  const pending = RELEASE_EXECUTION_ROOTS.map((entrypoint) => resolve(absoluteRoot, entrypoint));
  const visited = new Set();
  const sources = new Map();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (source === null) continue;
    sources.set(path, source);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, sourceScriptKind(path));
    for (const specifier of runtimeModuleSpecifiers(sourceFile)) {
      const dependency = await resolveRelativeModule(path, specifier, absoluteRoot);
      if (dependency !== null) pending.push(dependency);
    }
  }
  const findings = [];
  for (const [path, source] of [...sources].sort(([left], [right]) => toPosixPath(left).localeCompare(toPosixPath(right)))) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, sourceScriptKind(path));
    findings.push(...signatureMechanismFindings(absoluteRoot, path, source, sourceFile));
  }
  return findings.sort();
}

test("release execution paths contain no signing mechanism or signature artifacts", async (context) => {
  for (const entrypoint of RELEASE_EXECUTION_ROOTS) assert.ok(await readFile(resolve(repositoryRoot, entrypoint), "utf8"), `${entrypoint} is a live release path`);
  assert.deepEqual(await retiredReleaseTrustCode(repositoryRoot), []);

  const harmless = await treeFixture(context, {
    "scripts/release.mjs": "// signature is a field-name word, not release signing code.\nimport './lib/release-publisher.mjs';\nimport './lib/release-types.ts';\n",
    "scripts/lib/release-publisher.mjs": "import { spawnSync } from 'node:child_process';\nexport const typeName = 'index signature';\nexport const noArgument = () => spawnSync();\n",
    "scripts/lib/release-types.ts": "export type Json = { readonly [field: string]: unknown };\nexport type SignatureMode = 'none';\n",
  });
  assert.deepEqual(await retiredReleaseTrustCode(harmless), [], "comments and TypeScript index-signature types are not mechanisms");

  // Red leg: signing code reachable from the release entrypoint remains a finding, even when it
  // lives in an imported helper rather than in the entrypoint itself. Common aliases for Node's
  // crypto module and the child-process API still name the executed mechanism.
  const planted = await treeFixture(context, {
    "scripts/release.mjs": "import './lib/release-publisher.mjs';\n",
    "scripts/lib/release-publisher.mjs": "import { createSign as makeSigner } from 'node:crypto';\nimport * as cryptoModule from 'node:crypto';\nimport { spawnSync as launch } from 'node:child_process';\nconst cryptoAlias = cryptoModule;\nconst signer = makeSigner;\nexport const signatureAsset = 'einzbern.tar.gz.sig';\nexport function signRelease(bytes, key) { launch('cosign', ['sign', 'candidate.tar.gz']); return cryptoAlias.createSign('sha256').update(signer('sha256').update(bytes).sign(key)); }\n",
  });
  assert.deepEqual(await retiredReleaseTrustCode(planted), [
    "scripts/lib/release-publisher.mjs: a signature, provenance or trust-archive artifact path",
    "scripts/lib/release-publisher.mjs: a signing or key call through a crypto namespace",
    "scripts/lib/release-publisher.mjs: a signing or key primitive imported from node:crypto",
    "scripts/lib/release-publisher.mjs: an external signing command on a release execution path",
  ]);
});

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-156: mechanically re-run evidence blocks labelled `verbatim:<command>`.
// The command is intentionally narrow: evidence may invoke a checked-in Node
// script, never an arbitrary shell pipeline.  The captured stdout is compared
// byte-for-byte (including the final newline) with the fenced block.

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compareCanonicalText } from "./lib/canonical-order.mjs";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";

const execFileAsync = (file, args, options) => new Promise((resolveResult, rejectResult) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      rejectResult(error);
    } else {
      resolveResult({ stdout, stderr });
    }
  });
});
const HISTORICAL_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const EVIDENCE_ROOTS = [
  "docs/reports/init-028-design/evidence/",
  "docs/reports/init-029-component-loop/evidence/",
  "docs/reports/init-053-einzbern/",
];
const HISTORICAL_EVIDENCE = new Map([
  ["docs/reports/init-028-design/evidence/INC-153-restore-and-docs.md", {
    commit: "390eb5a1578dcd1086bde6b7c717ab1553d054b9",
    committedAt: "2026-09-12T09:46:08+08:00",
    bytes: 2758,
    sha256: "e05b14591927af0df67dacf3eaabf4f7c12b4892111e8d350bc69b393aafe139",
    command: "node scripts/verbatim-evidence-proof.mjs inc153-host-role-scan",
    outputBytes: 560,
    outputSha256: "89f414561a0f1d2f13e0431252f9801fc628f677efdc49e5060c3495fc004c9f",
  }],
  ["docs/reports/init-028-design/evidence/INC-155-coverage-integrity.md", {
    commit: "4058d96e83c696c7faf319b1c1d94face4219554",
    committedAt: "2026-09-24T09:51:27+08:00",
    bytes: 12416,
    sha256: "438921486a1154e958a5adefdda3f80c9a80a4bdfb1ec53c637d67f55e58d97a",
    command: "node scripts/coverage-conservation-proof.mjs",
    outputBytes: 2048,
    outputSha256: "6d5b7fe9a7e8b44981e84ea2e544b7ed104697faf2a631bf62a6642933e168ec",
    typescriptVersion: "5.9.3",
  }],
  // TCRN-CROSS-STORY-533. SUB-473 (dc77e6d6) added observedReasonCodes and unreconciledReasons
  // to the absent-source leg of this proof. The block records the proof as it stood before that
  // change, so it replays in a snapshot from before it whose proof printed the block byte for
  // byte; the current proof keeps the new fields.
  ["docs/reports/init-029-component-loop/evidence/STORY-252-ds-css-snapshot.md", {
    commit: "f58a238b2df55bd9c55144ea718cf807dc1dc5f1",
    committedAt: "2026-10-14T06:51:28+08:00",
    bytes: 5188,
    sha256: "677ccd503004af2fb26370e2f5317082b913f10f5799667d27c26f16309a27c0",
    command: "node scripts/ds-component-css-proof.mjs",
    outputBytes: 1167,
    outputSha256: "34649dc46d51fee1367a96f20515f7d186cbac0391c8250cb48019abf477cca9",
  }],
]);
const CURRENT_PORTAL_PROOF_FILES = [
  "portal/index.html",
  "portal/locales.js",
  "portal/portal.mjs",
  "portal/scripts/i18n-proof.mjs",
  "portal/scripts/proof.mjs",
  "portal/tests/portal.test.mjs",
  "portal/tests/ui-presence.test.mjs",
  "portal/tests/disposable-portal-fetch.test.mjs",
  "portal/tests/helpers/disposable-portal-fetch.mjs",
  "packages/core/src/doctor.ts",
  "tests/doctor.test.mjs",
  "scripts/verify-portal.mjs",
  "scripts/verbatim-evidence-meta-proof.mjs",
  "scripts/verbatim-evidence-proof.mjs",
];
const DESIGN_PROOF = "portal/scripts/design-proof.mjs";
// STORY-300. The scan used to carry `-n`, so every match arrived with its line
// number and the evidence block was pinned to where the code sat rather than to
// what it said. Editing anything above a match shifted every number below it and
// the byte comparison went red for a file whose meaning had not changed:
// TCRN-CROSS-INC-153 was refreshed three times in one day for exactly this, and
// the audited week counted twenty-seven such refusals across fifty-four blocks.
//
// What the block exists to establish is which host and role expressions the portal
// contains. That set is what is recorded now: matched text, trimmed, deduplicated
// and canonically ordered. Adding, removing or altering one of these expressions
// still moves the evidence; moving code no longer does.
const HOST_ROLE_SCAN = "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u";
const EXPECTED_DESIGN_LEGS = [
  "token-fidelity",
  "brand-asset-fidelity",
  "portal-brand-token",
  "no-literal-colours",
  "no-inline-style-attributes",
  "interactive-tcrn-class-coverage",
  "vocabulary-column-track-coverage",
  "public-v4-baseline",
  "portal-layout-invariants",
  "editor-focus-boundary",
  "topbar-four-width-single-line",
  "sidenav-v4-style-invariants",
  "ds-control-box-ownership",
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertArrayEqual(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: ${JSON.stringify(actual)}`);
  }
}

async function designProofLegNames() {
  const environment = { ...process.env };
  delete environment.TCRN_DESIGN_SYSTEM_TOKENS;
  const result = await execFileAsync(process.execPath, [resolve(repositoryRoot, DESIGN_PROOF)], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
  });
  const legNames = JSON.parse(result.stdout).legs.map((leg) => leg.leg);
  assertArrayEqual(legNames, EXPECTED_DESIGN_LEGS, "DESIGN_PROOF_LEG_NAMES_CHANGED");
  return { proof: DESIGN_PROOF, legCount: legNames.length, legNames };
}

async function hostRoleScan() {
  const source = await readFile(resolve(repositoryRoot, "portal/index.html"), "utf8");
  const expression = /claude-code|codex|reviewer|role ===|host ===|host \?/u;
  // The whole matching line is kept, trimmed of indentation and deduplicated: the
  // content is what the block establishes, and indentation and position are what
  // used to make it red for changes it was never watching. Sorting canonically
  // removes the last positional term -- reordering two functions is not a change
  // to what the portal supports.
  const found = new Set(source.split("\n").filter((line) => expression.test(line)).map((line) => line.trim()));
  const matches = [...found].sort(compareCanonicalText);
  if (matches.length === 0) throw new Error("HOST_ROLE_SCAN_NO_MATCHES");
  return { scan: HOST_ROLE_SCAN, exitCode: 0, matchCount: matches.length, matches };
}

async function i18nCurrentSummary() {
  const result = await execFileAsync(process.execPath, [resolve(repositoryRoot, "portal/scripts/i18n-proof.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_offline: "true" },
    maxBuffer: 8 * 1024 * 1024,
  });
  const report = JSON.parse(result.stdout);
  const fields = ["source", "keyCount", "localeCount", "expectedStrings", "addedKeyCount", "baselineEqualCount", "gaps", "problems", "unreachable", "missingLocales", "extraLocales"];
  const legs = report.legs.map((leg) => Object.fromEntries([
    ["leg", leg.leg],
    ["ok", leg.ok],
    ["reasonCode", leg.reasonCode],
    ...fields.filter((field) => Object.hasOwn(leg, field)).map((field) => [field, leg[field]]),
  ]));
  return { sourceCommand: "node portal/scripts/i18n-proof.mjs", ok: report.ok, reasonCode: report.reasonCode, legs };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return 0;
}

export function summarizeHistoricalReplayFailure(error, { stage, maxBufferBytes = HISTORICAL_COMMAND_MAX_BUFFER_BYTES } = {}) {
  const errorCode = typeof error?.code === "string" ? error.code : null;
  const exitCode = Number.isInteger(error?.status)
    ? error.status
    : Number.isInteger(error?.code) ? error.code : null;
  const signal = typeof error?.signal === "string" ? error.signal : null;
  const failureKind = errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ? "max-buffer"
    : signal !== null
      ? "signal"
      : exitCode !== null
        ? "child-exit"
        : errorCode !== null ? "system-error" : "exception";
  return {
    stage,
    failureKind,
    exitCode,
    errorCode,
    errorName: typeof error?.name === "string" ? error.name : null,
    signal,
    killed: typeof error?.killed === "boolean" ? error.killed : null,
    stdoutBytes: byteLength(error?.stdout),
    stderrBytes: byteLength(error?.stderr),
    ...(failureKind === "max-buffer" ? { maxBufferBytes } : {}),
  };
}

export async function runHistoricalCommand(args, { cwd, env, maxBufferBytes = HISTORICAL_COMMAND_MAX_BUFFER_BYTES }) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: maxBufferBytes,
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, failure: summarizeHistoricalReplayFailure(error, { stage: "historical-command", maxBufferBytes }) };
  }
}

export async function copyHistoricalTypeScriptRuntime(sourcePackagePath, destinationPackagePath) {
  const packageRoot = await realpath(sourcePackagePath);
  const packageManifest = await readFile(join(packageRoot, "package.json"));
  const manifest = JSON.parse(packageManifest.toString("utf8"));
  if (manifest.main !== "./lib/typescript.js") {
    throw new Error("EVIDENCE_HISTORY_TYPESCRIPT_ENTRY_UNSUPPORTED");
  }
  const runtime = await readFile(join(packageRoot, "lib", "typescript.js"));
  const destinationLibrary = join(destinationPackagePath, "lib");
  await mkdir(destinationLibrary, { recursive: true });
  await Promise.all([
    writeFile(join(destinationPackagePath, "package.json"), packageManifest),
    writeFile(join(destinationLibrary, "typescript.js"), runtime),
  ]);
}

// KB-20261010-INC-155-REPLAY-PINS-WHOLE-LOCKFILE (TCRN-CROSS-EPIC-150 R9 PF-1). A replay
// with a typescriptVersion copies only the TypeScript runtime into its snapshot, so the
// lockfile entries it depends on are the ones that decide that TypeScript: each importer's
// typescript specifier and version, and the packages and snapshots entries for
// typescript@<version>. It used to compare the whole lockfile, which turned it red for every
// dependency change it never loads. The entries are compared as the lines that carry them;
// a lockfile in which any of them cannot be found refuses as a mismatch.
function lockfileKey(line) {
  const match = /^\s*('(?:[^']|'')*'|[^\s'][^:]*?):(?: |$)/u.exec(line);
  if (!match) return null;
  return match[1].startsWith("'") ? match[1].slice(1, -1).replace(/''/gu, "'") : match[1];
}

function typescriptLockEntries(lockText) {
  const importers = [];
  const entries = { packages: new Map(), snapshots: new Map() };
  let section = null;
  let importer = null;
  let group = null;
  let collecting = null;
  for (const line of String(lockText).split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (collecting && indent > collecting.indent) {
      collecting.lines.push(line);
      continue;
    }
    collecting = null;
    const key = lockfileKey(line);
    if (indent === 0) {
      section = key;
    } else if (section === "importers") {
      if (indent === 2) {
        importer = key;
        group = null;
      } else if (indent === 4) {
        group = key;
      } else if (indent === 6 && key === "typescript") {
        collecting = { indent, lines: [] };
        importers.push({ importer, group, lines: collecting.lines });
      }
    } else if ((section === "packages" || section === "snapshots") && indent === 2 && key?.startsWith("typescript@")) {
      collecting = { indent, lines: [line] };
      entries[section].set(key, collecting.lines);
    }
  }
  const field = (lines, name) => {
    const found = lines.map((line) => line.trim()).find((line) => line.startsWith(`${name}: `));
    return found === undefined ? null : found.slice(name.length + 2);
  };
  const decided = importers.map((entry) => ({
    importer: entry.importer,
    group: entry.group,
    specifier: field(entry.lines, "specifier"),
    version: field(entry.lines, "version"),
  }));
  if (decided.length === 0 || decided.some((entry) => entry.specifier === null || entry.version === null)) return null;
  const versions = [...new Set(decided.map((entry) => entry.version))].sort(compareCanonicalText);
  const pick = (map) => versions.map((version) => map.get(`typescript@${version}`)?.join("\n") ?? null);
  const packages = pick(entries.packages);
  const snapshots = pick(entries.snapshots);
  if (packages.includes(null) || snapshots.includes(null)) return null;
  return JSON.stringify({ importers: decided, packages, snapshots });
}

export function historicalTypeScriptDependencyCheck({ typescriptVersion, historicalManifest, currentManifest, installedManifest, historicalLock, currentLock }) {
  const historicalEntries = typescriptLockEntries(historicalLock);
  const matches = historicalManifest?.devDependencies?.typescript === typescriptVersion
    && currentManifest?.devDependencies?.typescript === typescriptVersion
    && installedManifest?.version === typescriptVersion
    && historicalEntries !== null
    && historicalEntries === typescriptLockEntries(currentLock);
  return matches ? { ok: true } : { ok: false, reasonCode: "EVIDENCE_HISTORY_DEPENDENCY_MISMATCH" };
}

function historicalEvidenceSummary() {
  return [...HISTORICAL_EVIDENCE.entries()].map(([path, evidence]) => ({
    path,
    commit: evidence.commit,
    committedAt: evidence.committedAt,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    command: evidence.command,
    outputBytes: evidence.outputBytes,
    outputSha256: evidence.outputSha256,
  }));
}

async function currentPortalProof() {
  const sources = [];
  for (const path of CURRENT_PORTAL_PROOF_FILES) {
    const bytes = await readFile(resolve(repositoryRoot, path));
    sources.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  // TCRN-CROSS-SUB-409 (R14 integration revision, MIN-236 D1): SUB-409 removed the last
  // host or role expression, the old per-host tier duplicate check, from portal/index.html.
  // For the current portal a scan that finds nothing is a fact, recorded the way rg reports
  // it: exit 1 and no lines. Every other failure still refuses: a missing or unreadable file
  // is where rg would exit 2. inc153-host-role-scan keeps refusing a scan that finds nothing,
  // and its historical block replays in its own source snapshot.
  const [scan, i18n] = await Promise.all([
    hostRoleScan().catch((error) => {
      if (error?.message !== "HOST_ROLE_SCAN_NO_MATCHES") throw error;
      return { scan: HOST_ROLE_SCAN, exitCode: 1, matchCount: 0, matches: [] };
    }),
    i18nCurrentSummary(),
  ]);
  if (i18n.ok !== true) throw new Error(`CURRENT_PORTAL_I18N_NOT_GREEN:${i18n.reasonCode}`);
  return {
    schemaVersion: "tcrn.init053-current-portal-proof.v1",
    historicalEvidence: historicalEvidenceSummary(),
    currentSources: sources,
    hostRoleScan: scan,
    i18n,
  };
}

async function runMode(mode) {
  if (mode === "inc140-design-proof") return designProofLegNames();
  if (mode === "inc153-host-role-scan") return hostRoleScan();
  if (mode === "inc149-i18n-current") return i18nCurrentSummary();
  if (mode === "init053-current-portal-proof") return currentPortalProof();
  throw new Error(`EVIDENCE_VERBATIM_MODE_UNKNOWN:${mode}`);
}

async function parseNodeCommand(command, { checkoutRoot = repositoryRoot, commit = "HEAD" } = {}) {
  const tokens = command.trim().split(/\s+/u);
  if (tokens[0] !== "node" || tokens.length < 2 || tokens[1].startsWith("-")) {
    throw new Error(`EVIDENCE_VERBATIM_COMMAND_FORBIDDEN:${command}`);
  }
  const root = await realpath(checkoutRoot);
  const declaredPath = toPosixPath(relative(root, resolve(root, tokens[1])));
  const script = await realpath(resolve(root, tokens[1]));
  const path = toPosixPath(relative(root, script));
  if (!path || path === ".." || path.startsWith("../") || path.startsWith("/") || !/\.(?:mjs|cjs|js)$/u.test(path)) throw new Error(`EVIDENCE_VERBATIM_COMMAND_FORBIDDEN:${command}`);
  // Historical archives have no index: ownership is checked against the pinned
  // source commit in the original object database, not the current checkout.
  const tracked = String(runGit(["ls-tree", "-r", "--name-only", "-z", commit, "--", path], { encoding: "utf8" })).split("\0");
  const declaredTracked = String(runGit(["ls-tree", "-r", "--name-only", "-z", commit, "--", declaredPath], { encoding: "utf8" })).split("\0");
  if (!tracked.includes(path) || !declaredTracked.includes(declaredPath) || !(await stat(script)).isFile()) throw new Error(`EVIDENCE_VERBATIM_COMMAND_FORBIDDEN:${command}`);
  return tokens.slice(1);
}

function firstDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  let offset = 0;
  while (offset < limit && expected[offset] === actual[offset]) offset += 1;
  if (offset === expected.length && offset === actual.length) return null;
  return {
    offset,
    expected: JSON.stringify(expected.slice(Math.max(0, offset - 24), offset + 24)),
    actual: JSON.stringify(actual.slice(Math.max(0, offset - 24), offset + 24)),
  };
}

function parseVerbatimBlocks(source, path, sourcePath = resolve(repositoryRoot, path)) {
  const blocks = [];
  const pattern = /```verbatim:([^\n]+)\n([\s\S]*?)\n```/gu;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0;
    blocks.push({
      path,
      sourcePath,
      line: source.slice(0, offset).split("\n").length,
      command: match[1].trim(),
      expected: `${match[2]}\n`,
    });
  }
  return blocks;
}

async function evidenceBlocks() {
  const overrideFile = process.env.TCRN_VERBATIM_EVIDENCE_FILE;
  if (overrideFile) {
    const sourcePath = resolve(overrideFile);
    const path = process.env.TCRN_VERBATIM_EVIDENCE_LABEL ?? toPosixPath(relative(repositoryRoot, sourcePath));
    return parseVerbatimBlocks(await readFile(sourcePath, "utf8"), path, sourcePath);
  }
  const files = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => EVIDENCE_ROOTS.some((root) => path.startsWith(root)) && path.endsWith(".md"))
    .sort();
  const blocks = [];
  for (const path of files) blocks.push(...parseVerbatimBlocks(await readFile(resolve(repositoryRoot, path), "utf8"), path));
  return blocks;
}

function runGit(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return execFileSync("git", args, { cwd: repositoryRoot, env, ...options });
}

async function replayHistoricalBlock(block, evidence) {
  if (block.command !== evidence.command) {
    return { ok: false, reasonCode: "EVIDENCE_HISTORY_COMMAND_MISMATCH" };
  }
  const sourceBytes = await readFile(block.sourcePath);
  const sourceDigest = sha256(sourceBytes);
  if (sourceBytes.length !== evidence.bytes || sourceDigest !== evidence.sha256) {
    return { ok: false, reasonCode: "EVIDENCE_HISTORY_BYTES_CHANGED", expectedSha256: evidence.sha256, actualSha256: sourceDigest };
  }

  let committedBytes;
  try {
    committedBytes = runGit(["show", `${evidence.commit}:${block.path}`], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return { ok: false, reasonCode: "EVIDENCE_HISTORY_COMMIT_UNAVAILABLE" };
  }
  if (sha256(committedBytes) !== evidence.sha256 || !committedBytes.equals(sourceBytes)) {
    return { ok: false, reasonCode: "EVIDENCE_HISTORY_COMMIT_MISMATCH" };
  }
  const recorded = parseVerbatimBlocks(committedBytes.toString("utf8"), block.path).find((candidate) => candidate.command === evidence.command);
  if (recorded?.expected !== block.expected) {
    return { ok: false, reasonCode: "EVIDENCE_HISTORY_BLOCK_MISMATCH" };
  }

  const scratchRoot = process.env.TMPDIR ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, "tcrn-inc391-history-"));
  let stage = "historical-replay-setup";
  try {
    const historicalRoot = join(scratch, "repo");
    const gitDirectory = join(scratch, "git");
    await mkdir(historicalRoot);
    stage = "historical-git-init";
    runGit(["init", "--bare", "-q", gitDirectory]);
    stage = "historical-archive-create";
    const archive = runGit(["archive", "--format=tar", evidence.commit], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    stage = "historical-archive-extract";
    execFileSync("tar", ["-xf", "-", "-C", historicalRoot], { cwd: repositoryRoot, input: archive, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

    stage = "historical-git-alternates";
    const commonDirectory = resolve(repositoryRoot, String(runGit(["rev-parse", "--git-common-dir"], { encoding: "utf8" })).trim());
    await writeFile(join(gitDirectory, "HEAD"), `${evidence.commit}\n`, "utf8");
    await writeFile(join(gitDirectory, "objects/info/alternates"), `${join(commonDirectory, "objects")}\n`, "utf8");

    if (evidence.typescriptVersion) {
      stage = "historical-dependency-check";
      const historicalManifest = JSON.parse(runGit(["show", `${evidence.commit}:package.json`], { encoding: "utf8" }));
      const currentManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
      const historicalLock = runGit(["show", `${evidence.commit}:pnpm-lock.yaml`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const currentLock = await readFile(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8");
      const installedManifest = JSON.parse(await readFile(resolve(repositoryRoot, "node_modules/typescript/package.json"), "utf8"));
      const dependencies = historicalTypeScriptDependencyCheck({
        typescriptVersion: evidence.typescriptVersion,
        historicalManifest,
        currentManifest,
        installedManifest,
        historicalLock,
        currentLock,
      });
      if (!dependencies.ok) return dependencies;
      stage = "historical-dependency-copy";
      await copyHistoricalTypeScriptRuntime(
        resolve(repositoryRoot, "node_modules/typescript"),
        join(historicalRoot, "node_modules/typescript"),
      );
    }

    const home = join(scratch, "home");
    const einzbernHome = join(scratch, "einzbern");
    const temp = join(scratch, "tmp");
    stage = "historical-command-environment";
    await Promise.all([mkdir(home), mkdir(einzbernHome), mkdir(temp)]);
    const env = {
      ...process.env,
      HOME: home,
      EINZBERN_HOME: einzbernHome,
      TMPDIR: temp,
      npm_config_offline: "true",
      GIT_DIR: gitDirectory,
    };
    delete env.GIT_WORK_TREE;
    stage = "historical-command-parse";
    const args = await parseNodeCommand(block.command, { checkoutRoot: historicalRoot, commit: evidence.commit });
    stage = "historical-command";
    const captured = await runHistoricalCommand(args, {
      cwd: historicalRoot,
      env,
      maxBufferBytes: HISTORICAL_COMMAND_MAX_BUFFER_BYTES,
    });
    if (!captured.ok) return { ok: false, reasonCode: "EVIDENCE_HISTORY_REPLAY_FAILED", ...captured.failure };
    const { result } = captured;
    const outputDigest = sha256(Buffer.from(result.stdout, "utf8"));
    const difference = firstDifference(block.expected, result.stdout);
    const ok = difference === null && result.stderr === ""
      && Buffer.byteLength(result.stdout, "utf8") === evidence.outputBytes
      && outputDigest === evidence.outputSha256;
    return {
      ok,
      mode: "historical-version-replay",
      commit: evidence.commit,
      evidenceSha256: sourceDigest,
      outputBytes: Buffer.byteLength(result.stdout, "utf8"),
      outputSha256: outputDigest,
      ...(!ok ? { reasonCode: difference ? "EVIDENCE_VERBATIM_MISMATCH" : "EVIDENCE_HISTORY_OUTPUT_MISMATCH" } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: "EVIDENCE_HISTORY_REPLAY_FAILED",
      ...summarizeHistoricalReplayFailure(error, { stage }),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyBlocks() {
  const blocks = await evidenceBlocks();
  const results = [];
  for (const block of blocks) {
    const history = HISTORICAL_EVIDENCE.get(block.path);
    if (history) {
      const replay = await replayHistoricalBlock(block, history);
      results.push({ path: block.path, line: block.line, command: block.command, ...replay });
      continue;
    }
    let args;
    try {
      args = await parseNodeCommand(block.command);
    } catch (error) {
      results.push({ ...block, ok: false, reasonCode: "EVIDENCE_VERBATIM_COMMAND_FORBIDDEN", error: String(error.message ?? error) });
      continue;
    }
    try {
      const result = await execFileAsync(process.execPath, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" },
        maxBuffer: 8 * 1024 * 1024,
      });
      const difference = firstDifference(block.expected, result.stdout);
      results.push({
        path: block.path,
        line: block.line,
        command: block.command,
        ok: difference === null && result.stderr === "",
        ...(difference ? { reasonCode: "EVIDENCE_VERBATIM_MISMATCH", difference } : {}),
        ...(result.stderr ? { reasonCode: "EVIDENCE_VERBATIM_STDERR", stderr: result.stderr } : {}),
      });
    } catch (error) {
      const stdout = String(error.stdout ?? "");
      const stderr = String(error.stderr ?? "");
      results.push({
        path: block.path,
        line: block.line,
        command: block.command,
        ok: false,
        reasonCode: "EVIDENCE_VERBATIM_COMMAND_FAILED",
        exitCode: error.status ?? null,
        difference: firstDifference(block.expected, stdout),
        stderr,
        error: String(error.message ?? error),
      });
    }
  }
  const problems = results.filter((result) => !result.ok);
  return {
    ok: problems.length === 0 && blocks.length > 0,
    reasonCode: problems.length === 0 && blocks.length > 0 ? "EVIDENCE_VERBATIM_VERIFIED" : "EVIDENCE_VERBATIM_MISMATCH",
    blockCount: blocks.length,
    problems,
    results,
  };
}

async function main() {
  if (process.argv[2] === "--check") {
    const result = await verifyBlocks();
    process.stdout.write(json(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = await runMode(process.argv[2]);
  process.stdout.write(json(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(json({ ok: false, reasonCode: String(error.message ?? error) }));
    process.exitCode = 1;
  }
}

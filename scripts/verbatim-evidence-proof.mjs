#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-156: mechanically re-run evidence blocks labelled `verbatim:<command>`.
// The command is intentionally narrow: evidence may invoke a checked-in Node
// script, never an arbitrary shell pipeline.  The captured stdout is compared
// byte-for-byte (including the final newline) with the fenced block.

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compareCanonicalText } from "./lib/canonical-order.mjs";
import { repositoryRoot, toPosixPath, walkFiles } from "./lib/files.mjs";

const execFileAsync = promisify(execFile);
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
]);
const CURRENT_PORTAL_PROOF_FILES = [
  "portal/index.html",
  "portal/locales.js",
  "portal/portal.mjs",
  "portal/scripts/i18n-proof.mjs",
  "portal/scripts/proof.mjs",
  "portal/tests/portal.test.mjs",
  "portal/tests/ui-presence.test.mjs",
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
  const result = await execFileAsync(process.execPath, [resolve(repositoryRoot, DESIGN_PROOF)], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, TCRN_DESIGN_SYSTEM_TOKENS: resolve(repositoryRoot, ".inc156-design-system-absent.css") },
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
  const [scan, i18n] = await Promise.all([hostRoleScan(), i18nCurrentSummary()]);
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

function parseNodeCommand(command) {
  const tokens = command.trim().split(/\s+/u);
  if (tokens[0] !== "node" || tokens.length < 2 || tokens[1].startsWith("-")) {
    throw new Error(`EVIDENCE_VERBATIM_COMMAND_FORBIDDEN:${command}`);
  }
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
  try {
    const historicalRoot = join(scratch, "repo");
    const gitDirectory = join(scratch, "git");
    await mkdir(historicalRoot);
    runGit(["init", "--bare", "-q", gitDirectory]);
    const archive = runGit(["archive", "--format=tar", evidence.commit], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", historicalRoot], { cwd: repositoryRoot, input: archive, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

    const commonDirectory = resolve(repositoryRoot, String(runGit(["rev-parse", "--git-common-dir"], { encoding: "utf8" })).trim());
    await writeFile(join(gitDirectory, "HEAD"), `${evidence.commit}\n`, "utf8");
    await writeFile(join(gitDirectory, "objects/info/alternates"), `${join(commonDirectory, "objects")}\n`, "utf8");

    if (evidence.typescriptVersion) {
      const historicalManifest = JSON.parse(runGit(["show", `${evidence.commit}:package.json`], { encoding: "utf8" }));
      const currentManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
      const historicalLock = runGit(["show", `${evidence.commit}:pnpm-lock.yaml`], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
      const currentLock = await readFile(resolve(repositoryRoot, "pnpm-lock.yaml"));
      const installedManifest = JSON.parse(await readFile(resolve(repositoryRoot, "node_modules/typescript/package.json"), "utf8"));
      if (historicalManifest.devDependencies?.typescript !== evidence.typescriptVersion
        || currentManifest.devDependencies?.typescript !== evidence.typescriptVersion
        || installedManifest.version !== evidence.typescriptVersion
        || !historicalLock.equals(currentLock)) {
        return { ok: false, reasonCode: "EVIDENCE_HISTORY_DEPENDENCY_MISMATCH" };
      }
      await mkdir(join(historicalRoot, "node_modules"), { recursive: true });
      await cp(resolve(repositoryRoot, "node_modules/typescript"), join(historicalRoot, "node_modules/typescript"), { recursive: true, dereference: true });
    }

    const home = join(scratch, "home");
    const einzbernHome = join(scratch, "einzbern");
    const temp = join(scratch, "tmp");
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
    const args = parseNodeCommand(block.command);
    const result = await execFileAsync(process.execPath, args, {
      cwd: historicalRoot,
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
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
      exitCode: Number.isInteger(error?.status) ? error.status : null,
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
      args = parseNodeCommand(block.command);
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

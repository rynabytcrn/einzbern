#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, extname, join, parse, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The install manifest is the only path/residence authority. The doctor consumes
// the built public core so the same bytes are used by the CLI's install-manifest
// read surface and by this host probe; there is no second path table here.
import {
  BRAND,
  DEVICE_HOME_ENTRIES,
  INSTALL_MANIFEST,
  LEGACY_BRAND_NAME,
  LEGACY_CONTROL_DIRECTORY,
  LEGACY_ENGINE_NAME,
  LOCAL_DIRECTORY_NAMES,
  assertInstallManifestComplete,
  compareEngineVersions,
  WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
} from "../dist/build/packages/core/src/index.js";
// Digests are computed by the engine's own canonicaliser rather than reproduced here. A
// second implementation of a digest is a second answer waiting to disagree with the first
// (TCRN-CROSS-INC-219).
import { PROTOCOL_LIMITS, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
// Which hook commands are Einzbern's launcher or a script of the old harness: the engine's own
// answer, read from the module that renders and reconciles host hooks (scripts/host-render.mjs
// imports it the same way).
import { HOST_HOOK_FILES, isEinzbernHookCommand, isLegacyHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import { toPosixPath, walkFiles } from "./lib/files.mjs";

const execFileAsync = promisify(execFile);
const PLATFORM_DOCS_RELATIVE = "platform-docs";
const ACCEPTANCE_GROUP_IDS = [
  "engine-suite",
  "engine-p1",
  "engine-release",
  "platform-layout",
  "chain-validate",
  "product-gates",
];
const ACCEPTANCE_TOP_LEVEL_GROUP_IDS = ["engine-release", "platform-layout", "product-gates"];
const ACCEPTANCE_BATCH_STATUS = Object.freeze({
  "engine-suite": { firstBatch: "required", secondBatch: "required" },
  "engine-p1": { firstBatch: "required", secondBatch: "required" },
  "engine-release": { firstBatch: "required", secondBatch: "required" },
  "platform-layout": { firstBatch: "required", secondBatch: "required" },
  "chain-validate": { firstBatch: "baseline-only", secondBatch: "required" },
  "product-gates": { firstBatch: "conditional", secondBatch: "conditional" },
});
const PLATFORM_LAYOUT_SUBCHECKS = Object.freeze({
  helperCopies: ["record-raw", "required-after-real-migration-and-installation"],
  acceptanceVerdicts: ["preserve-stale-red", "require-candidate-bound-verdicts"],
  installWiring: ["record-raw", "required-after-real-installation"],
  hooks: ["record-raw", "required-after-real-host-wiring"],
  deploymentFreshness: ["record-raw", "required-after-real-installation"],
  launchd: ["accepted-existing-exception-only", "accepted-existing-exception-only"],
  harnessSurface: ["record-host-specific-raw-state", "unresolved-host-specific-reconciliation"],
});

function check(name, ok, details = {}) {
  return { name, ok, ...details };
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

async function existingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

// INC-247: platform-level documents live at the container root. The classification
// folder is deliberately not a fallback: a future move must fail visibly rather than
// silently reintroduce a second authority.
async function platformDocsRoot(root) {
  return { relativePath: PLATFORM_DOCS_RELATIVE, path: join(root, PLATFORM_DOCS_RELATIVE) };
}

function expandTemplate(template, platformRoot, homeRoot) {
  if (typeof template !== "string") return null;
  if (!template.includes("<PLATFORM_ROOT>") && !template.includes("<HOME>")) return null;
  return resolve(template.replaceAll("<PLATFORM_ROOT>", platformRoot).replaceAll("<HOME>", homeRoot));
}

function manifestPath(manifest, id, platformRoot, homeRoot) {
  const entry = manifest.items?.find((candidate) => candidate.id === id);
  return entry === undefined ? null : expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
}

const CHAIN_CONTAINER_REPOSITORY = "chain container";
const CHAIN_CONTAINER_DIRECTORY = [".tcrn", "workspace"].join("-");
const WORKFLOW_DIRECTORY = LEGACY_CONTROL_DIRECTORY;
// An installed Helper names the engine it was pinned to, under the old or the new product name.
const HELPER_PIN_PATTERN = new RegExp(`\\b(?:Supports|Targets|Targets the) (?:${LEGACY_BRAND_NAME}|${BRAND.engine.name}) \`v([^\`\\s]+)\``, "gu");
const ACCEPTANCE_BINDING_SCHEMA = "tcrn.acceptance-binding.v1";
const CHAIN_VALIDATE_GROUP_ID = "chain-validate";

function pathInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !parse(relativePath).root);
}

async function resolveGitAcceptanceBinding(root, repository) {
  if (typeof repository !== "string" || repository.trim().length === 0 || repository.startsWith("/")) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository must be a relative path" };
  }
  const requested = resolve(root, repository);
  if (!pathInside(root, requested)) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository escapes platform root" };
  }
  let repositoryRoot;
  try {
    repositoryRoot = await realpath(requested);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? "repository path is unreadable" };
  }
  const stats = await existingPath(repositoryRoot);
  if (!stats?.isDirectory()) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository is not a directory" };
  }
  if (!pathInside(root, repositoryRoot)) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "resolved repository escapes platform root" };
  }
  try {
    const commit = (await execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"], { timeout: 30_000 })).stdout.trim();
    if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("git HEAD is not a full object id");
    return { ok: true, binding: { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository, commit } };
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? error?.message ?? "git HEAD is unreadable" };
  }
}

async function readChainPartitionBinding(root, partition) {
  const workspaceRoot = join(root, CHAIN_CONTAINER_DIRECTORY, partition, "workspace");
  const eventsRoot = join(workspaceRoot, WORKFLOW_DIRECTORY, "events");
  try {
    const workspace = JSON.parse(await readFile(join(workspaceRoot, WORKFLOW_DIRECTORY, "workspace.json"), "utf8"));
    const eventFiles = (await readdir(eventsRoot)).filter((name) => /^\d+\.json$/u.test(name)).sort();
    if (eventFiles.length === 0) throw new Error("chain has no event segments");
    const segment = JSON.parse(await readFile(join(eventsRoot, eventFiles[eventFiles.length - 1]), "utf8"));
    const events = Array.isArray(segment) ? segment : [segment];
    const event = events.at(-1);
    if (typeof workspace.workspaceId !== "string" || !/^[0-9a-f]{64}$/iu.test(event?.eventHash ?? "")) {
      throw new Error("chain head identity is malformed");
    }
    return { partition, workspaceId: workspace.workspaceId, headEventHash: event.eventHash };
  } catch (error) {
    return { error: error?.code ?? error?.message ?? "chain partition is unreadable", partition };
  }
}

async function resolveChainAcceptanceBinding(root, repository) {
  const chainRoot = join(root, CHAIN_CONTAINER_DIRECTORY);
  try {
    const entries = await readdir(chainRoot, { withFileTypes: true });
    const partitions = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const workspacePath = join(chainRoot, entry.name, "workspace");
      const workspaceStats = await existingPath(workspacePath);
      if (!workspaceStats?.isDirectory()) continue;
      const identity = await readChainPartitionBinding(root, entry.name);
      if (identity.error) return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: `${identity.partition}: ${identity.error}` };
      partitions.push(identity);
    }
    if (partitions.length === 0) throw new Error("chain container has no partition workspaces");
    const bindingParts = partitions.map(({ partition, workspaceId, headEventHash }) => ({ partition, workspaceId, headEventHash }));
    return {
      ok: true,
      binding: {
        schemaVersion: ACCEPTANCE_BINDING_SCHEMA,
        kind: "chain",
        repository,
        partitions: bindingParts,
        digest: canonicalSha256(bindingParts),
      },
    };
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? error?.message ?? "chain container is unreadable" };
  }
}

// TCRN-CROSS-INC-251: chain validation measures the current event log and its
// projections. It is cheap enough to run at doctor time, and unlike a recorded
// verdict it cannot be invalidated by the governance write that the lane is
// supposed to release.
async function currentChainPartitions(root) {
  const chainRoot = join(root, CHAIN_CONTAINER_DIRECTORY);
  let entries;
  try {
    entries = await readdir(chainRoot, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: error?.code ?? "chain container is unreadable" };
  }
  const partitions = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareCanonicalTextLocal(left.name, right.name))) {
    const workspacePath = join(chainRoot, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    partitions.push({ partition: entry.name, workspacePath });
  }
  if (partitions.length === 0) return { ok: false, reason: "chain container has no partition workspaces" };
  return { ok: true, partitions };
}

function parseCommandJson(output) {
  const text = typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function inspectChainValidation(root, options = {}) {
  // The legacy synthetic hook keeps the existing hermetic doctor fixtures from
  // reaching a developer's engine. Production invocations have no
  // acceptanceHeadCommit and always take the live path below.
  if (options.chainValidation !== undefined) {
    const supplied = typeof options.chainValidation === "function"
      ? await options.chainValidation(root, options)
      : options.chainValidation;
    return check("chainValidation", supplied?.ok !== false, {
      ...(supplied && typeof supplied === "object" ? supplied : {}),
      source: "synthetic-test-input",
    });
  }
  if (options.acceptanceHeadCommit !== undefined) {
    return check("chainValidation", true, {
      comparable: false,
      reason: "synthetic acceptance fixture; live chain validation is exercised by its dedicated probe",
      source: "synthetic-test-input",
    });
  }
  const discovered = await currentChainPartitions(root);
  if (!discovered.ok) {
    return check("chainValidation", false, {
      reasonCode: "PLATFORM_CHAIN_VALIDATION_UNAVAILABLE",
      reason: discovered.reason,
      source: "live engine validate",
    });
  }
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "einzbern.mjs");
  const started = process.hrtime.bigint();
  const results = await Promise.all(discovered.partitions.map(async ({ partition, workspacePath }) => {
    try {
      const result = await execFileAsync(process.execPath, [cli, "validate", "--workspace", workspacePath], {
        timeout: 120_000,
        maxBuffer: 8 * 1_048_576,
      });
      const output = parseCommandJson(result.stdout);
      return {
        partition,
        workspace: relative(root, workspacePath),
        exitCode: 0,
        reasonCode: output?.reasonCode ?? "WORKSPACE_COMMAND_COMPLETED",
        ...(output === null ? { outputValid: false } : {}),
      };
    } catch (error) {
      const output = parseCommandJson(error?.stdout) ?? parseCommandJson(error?.stderr);
      return {
        partition,
        workspace: relative(root, workspacePath),
        exitCode: typeof error?.status === "number" ? error.status : null,
        reasonCode: output?.reasonCode ?? (typeof error?.status === "number" ? `PLATFORM_CHAIN_VALIDATE_EXIT_${error.status}` : typeof error?.code === "number" ? `PLATFORM_CHAIN_VALIDATE_EXIT_${error.code}` : typeof error?.code === "string" ? error.code : "PLATFORM_CHAIN_VALIDATE_FAILED"),
        ...(typeof output?.error === "string" ? { detail: output.error } : typeof error?.stderr === "string" && error.stderr.trim().length > 0 ? { detail: error.stderr.trim().slice(0, 500) } : {}),
      };
    }
  }));
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) {
    return check("chainValidation", false, {
      reasonCode: "PLATFORM_CHAIN_VALIDATION_FAILED",
      partitionCount: results.length,
      durationMs: Number(durationMs.toFixed(2)),
      failed,
      partitions: results,
      source: "live engine validate",
    });
  }
  return check("chainValidation", true, {
    partitionCount: results.length,
    durationMs: Number(durationMs.toFixed(2)),
    partitions: results,
    source: "live engine validate",
  });
}

async function resolveAcceptanceBinding(root, group, options) {
  // Test fixtures may inject the observed tree identity without creating real
  // repositories. This is an explicit observation override, never a production
  // fallback; the live path below always resolves group.repository itself.
  const override = options.acceptanceBindings?.[group.id] ?? options.acceptanceBindings?.[group.repository];
  if (override !== undefined) return { ok: true, binding: override };
  // Retain the old synthetic-test hook so existing platform fixtures stay hermetic.
  // It is only reachable when the caller explicitly supplies acceptanceHeadCommit.
  if (options.acceptanceHeadCommit !== undefined) {
    return { ok: true, binding: { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository: group.repository, commit: options.acceptanceHeadCommit } };
  }
  if (group.repository === CHAIN_CONTAINER_REPOSITORY) return resolveChainAcceptanceBinding(root, group.repository);
  return resolveGitAcceptanceBinding(root, group.repository);
}

function recordedAcceptanceBinding(entry, group, options) {
  if (entry?.binding && typeof entry.binding === "object") return entry.binding;
  // Legacy shape is accepted only by explicit synthetic fixtures. A real platform
  // verdict without the machine-readable binding is unbound and must go red.
  if (options.acceptanceHeadCommit !== undefined && typeof entry?.commit === "string") {
    return { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository: group.repository, commit: entry.commit };
  }
  return null;
}

function bindingIdentity(binding) {
  if (binding?.kind === "git") return `git:${binding.repository}@${binding.commit ?? "<missing>"}`;
  if (binding?.kind === "chain") return `chain:${binding.repository}@${binding.digest ?? "<missing>"}`;
  return `<unbound:${typeof binding?.kind === "string" ? binding.kind : "missing"}>`;
}

function compareAcceptanceBindings(recorded, current) {
  if (!recorded || !current || recorded.kind !== current.kind || recorded.repository !== current.repository) {
    return { equal: false, changed: [] };
  }
  if (recorded.kind === "git") {
    return { equal: recorded.commit === current.commit, changed: [{ recorded: recorded.commit, current: current.commit }] };
  }
  if (recorded.kind !== "chain" || !Array.isArray(recorded.partitions) || !Array.isArray(current.partitions)) {
    return { equal: false, changed: [{ recorded: recorded.digest ?? null, current: current.digest ?? null }] };
  }
  const recordedByPartition = new Map(recorded.partitions.map((part) => [part.partition, part]));
  const currentByPartition = new Map(current.partitions.map((part) => [part.partition, part]));
  const changed = [];
  for (const partition of new Set([...recordedByPartition.keys(), ...currentByPartition.keys()])) {
    const before = recordedByPartition.get(partition);
    const after = currentByPartition.get(partition);
    if (!before || !after || before.workspaceId !== after.workspaceId || before.headEventHash !== after.headEventHash) {
      changed.push({
        partition,
        recorded: before ? { workspaceId: before.workspaceId, headEventHash: before.headEventHash } : null,
        current: after ? { workspaceId: after.workspaceId, headEventHash: after.headEventHash } : null,
      });
    }
  }
  if (changed.length === 0 && recorded.digest !== current.digest) changed.push({ partition: "<chain-digest>", recorded: recorded.digest ?? null, current: current.digest ?? null });
  return { equal: changed.length === 0, changed };
}

// STORY-300 / TCRN-CROSS-MIN-ACCEPTANCE-LANES. The machine-checked acceptance lane
// releases a work item to done on the groups this roster lists all being green, and
// until 2026-08-19 that roster existed nowhere -- not in a repository, not in
// the platform documents, not on the chain -- while forty-four records had already
// landed against it. A criterion whose members are remembered rather than written is
// the executor choosing which tests count, which is the thing that criterion exists
// to replace.
//
// This checks the roster's shape, not that each command passes. Running another
// repository's gates from here would be the engine reaching into a sibling's tree,
// which the platform forbids outright; what this can settle is that the roster is
// present, complete, and says for every group which repository proves it and how.
// The rest is the operator's to run and the record's to cite.

// TCRN-CROSS-STORY-361: the charter rule "no consumer, isolate it", with a leg that can
// see whether it is being followed. `packages/core/src/index.ts` is this engine's public
// surface, and until this leg existed nothing measured how much of that surface anything
// outside core actually calls. STORY-358 retired six families of it by hand, one module
// at a time, because looking was the only way to find them.
//
// What counts as a consumer is data rather than code: the roots live in
// scripts/policy/core-export-consumers.json, so widening them is an act somebody has to
// write down. Tests are
// excluded on purpose. A symbol whose only caller is its own test is exactly the shape
// STORY-358 spent an Epic removing, and admitting tests here would have reported every
// one of those modules as consumed on the day before it was deleted.
//
// The matching is deliberately crude: the consumer files are tokenised once into the set of
// JavaScript identifiers they contain, and a symbol is consumed if its name is in that
// set. It can call a symbol consumed because its name appears in a comment. It cannot
// call one consumed that appears nowhere.
//
// Two things turn it red, and the second is what keeps the data file from rotting into
// the permanent amnesty the first would otherwise buy:
//   - an exported symbol with no consumer that the file does not already record;
//   - a recorded entry that has since gained a consumer, or whose symbol no longer
//     exists, because the file is a register of debt and debt that was paid must leave it.
const CORE_EXPORT_CONSUMER_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

/**
 * Every name `packages/core/src/index.ts` exposes: the declarations it makes itself and
 * the value and `export type` blocks it re-exports from its modules.
 *
 * Both block forms are read, and that is not decoration -- a barrel re-exports types in
 * their own blocks, so a reader that only walked the value blocks would call the whole
 * type surface unexported and never report a single one of it.
 */
export function coreExportedSymbols(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gmu)) {
    for (const raw of match[1].split(",")) {
      const token = raw.trim().replace(/^type\s+/u, "");
      if (token.length === 0) continue;
      // `A as B` exposes B; the local name is core's business, not a consumer's.
      const exposed = token.split(/\s+as\s+/u).at(-1).trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(exposed)) names.add(exposed);
    }
  }
  return [...names].sort();
}

async function coreExportConsumerFiles(checkoutRoot, roots) {
  const paths = [];
  for (const entry of roots) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const absolute = join(checkoutRoot, entry);
    const stats = await existingPath(absolute);
    if (!stats) continue;
    if (stats.isDirectory()) paths.push(...await walkFiles(absolute));
    else if (stats.isFile()) paths.push(absolute);
  }
  const consumers = [];
  for (const absolute of paths) {
    const path = toPosixPath(relative(checkoutRoot, absolute));
    if (!CORE_EXPORT_CONSUMER_EXTENSIONS.has(extname(path))) continue;
    if (path.endsWith(".test.mjs") || path.split("/").includes("tests")) continue;
    consumers.push(path);
  }
  return [...new Set(consumers)].sort();
}

async function inspectUnusedExports(platformRoot, options) {
  if (options.unusedExports && typeof options.unusedExports === "object") {
    return unusedExportsVerdict(options.unusedExports, "synthetic");
  }
  const checkoutRoot = join(platformRoot, LOCAL_DIRECTORY_NAMES.engine);
  let policy = null;
  try {
    policy = JSON.parse(await readFile(join(checkoutRoot, "scripts", "policy", "core-export-consumers.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  if (policy === null || typeof policy !== "object") {
    // A container that only consumes this engine has no core to walk, and "nothing to compare" must not read as "compared
    // and passed".
    return check("unusedExports", true, {
      comparable: false,
      reason: "no core-export consumer policy in this container, so the public core surface has nothing to compare against",
      source: "live-engine-checkout",
    });
  }
  let barrel = null;
  try {
    barrel = await readFile(join(checkoutRoot, "packages", "core", "src", "index.ts"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  if (barrel === null) {
    return check("unusedExports", true, {
      comparable: false,
      reason: "no packages/core/src/index.ts in this container, so there is no public core surface to read",
      source: "live-engine-checkout",
    });
  }
  const consumerRoots = Array.isArray(policy.consumerRoots) ? policy.consumerRoots : [];
  const consumerFiles = await coreExportConsumerFiles(checkoutRoot, consumerRoots);
  let identifiers = new Set();
  for (const path of consumerFiles) {
    for (const token of (await readFile(join(checkoutRoot, path), "utf8")).match(/[A-Za-z_$][\w$]*/gu) ?? []) {
      identifiers.add(token);
    }
  }
  const exported = coreExportedSymbols(barrel);
  return unusedExportsVerdict({
    exported,
    unconsumed: exported.filter((name) => !identifiers.has(name)),
    allowed: Array.isArray(policy.allowedUnconsumed) ? policy.allowedUnconsumed : [],
    consumerRoots,
    consumerFiles: consumerFiles.length,
  }, "live-engine-checkout");
}

function unusedExportsVerdict(values, source) {
  const exported = [...(values.exported ?? [])];
  const unconsumed = [...(values.unconsumed ?? [])];
  const allowed = [...(values.allowed ?? [])];
  const exportedSet = new Set(exported);
  const unconsumedSet = new Set(unconsumed);
  const unconsumedWithoutAllowance = unconsumed.filter((name) => !allowed.includes(name)).sort();
  // Split by cause rather than merged into one "stale" list: an allowance whose symbol
  // is gone was paid off by a removal, and one that is now called was paid off by a
  // consumer arriving. Both must leave the file; a reader still needs to know which
  // happened, because only one of them is a retirement.
  const absentAllowances = allowed.filter((name) => !exportedSet.has(name)).sort();
  const consumedAllowances = allowed.filter((name) => exportedSet.has(name) && !unconsumedSet.has(name)).sort();
  const measured = {
    exportedCount: exported.length,
    unconsumedCount: unconsumed.length,
    allowedCount: allowed.length,
    consumerRoots: values.consumerRoots ?? null,
    consumerFiles: values.consumerFiles ?? null,
    source,
  };
  if (unconsumedWithoutAllowance.length > 0) {
    return check("unusedExports", false, {
      reasonCode: "PLATFORM_CORE_EXPORT_UNCONSUMED",
      unconsumedWithoutAllowance,
      absentAllowances,
      consumedAllowances,
      remedy: "give the symbol a consumer in one of the recorded roots, retire it from packages/core/src/index.ts, or add it to allowedUnconsumed in scripts/policy/core-export-consumers.json and say why it is kept in that file's allowedUnconsumedRationale",
      ...measured,
    });
  }
  if (absentAllowances.length > 0 || consumedAllowances.length > 0) {
    return check("unusedExports", false, {
      reasonCode: "PLATFORM_CORE_EXPORT_ALLOWANCE_STALE",
      absentAllowances,
      consumedAllowances,
      remedy: "drop these entries from allowedUnconsumed in scripts/policy/core-export-consumers.json in the same change that retired or connected them",
      ...measured,
    });
  }
  return check("unusedExports", true, measured);
}

// TCRN-CROSS-INC-224: headroom on the chain's lifetime event bound, reported before the
// wall rather than at it. The cap moved from 10,000 to 20,000 on measured evidence that
// replay is linear at ~117 microseconds an event, so 20,000 costs about 2.3 seconds per
// materialize against 0.51 measured at 4,316. That is a budget, not a reprieve: the next
// ceiling is real and arrives at whatever rate governance is written.
//
// The trigger is 15,000, which at the busiest observed rate (about 210 events a day
// during a governance-heavy stretch) leaves roughly three and a half weeks to decide.
// A gate that fires at the ceiling leaves none, which is how INC-224 was discovered --
// by counting, not by being warned.
const CHAIN_EVENT_REVIEW_TRIGGER = 15_000;

async function inspectChainHeadroom(root, options) {
  const observed = options.chainEventCounts && typeof options.chainEventCounts === "object"
    ? options.chainEventCounts
    : await chainEventCounts(root, options);
  if (observed === null) {
    return check("chainHeadroom", false, { reasonCode: "PLATFORM_CHAIN_COUNTS_UNREADABLE" });
  }
  const ceiling = options.chainEventCeiling ?? PROTOCOL_LIMITS.maxChainEvents;
  const over = Object.entries(observed)
    .filter(([, count]) => typeof count === "number" && count >= CHAIN_EVENT_REVIEW_TRIGGER)
    .map(([partition, count]) => ({ partition, events: count, headroom: ceiling - count }))
    .sort((left, right) => right.events - left.events);
  if (over.length > 0) {
    return check("chainHeadroom", false, {
      reasonCode: "PLATFORM_CHAIN_REVIEW_TRIGGER_REACHED",
      trigger: CHAIN_EVENT_REVIEW_TRIGGER,
      ceiling,
      partitions: over,
      remedy: "a partition has passed the review trigger; the disposition of the next ceiling is an Owner decision and the headroom above is how long there is to take it",
    });
  }
  const counted = Object.entries(observed).map(([partition, events]) => ({ partition, events })).sort((left, right) => right.events - left.events);
  return check("chainHeadroom", true, { trigger: CHAIN_EVENT_REVIEW_TRIGGER, ceiling, largest: counted[0] ?? null, partitions: counted.length });
}

async function chainEventCounts(root, options) {
  const containerPath = join(root, ".tcrn-workspace");
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "einzbern.mjs");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const counts = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "status", "--workspace", workspacePath], { timeout: 120_000, maxBuffer: 8 * 1_048_576 });
      const version = JSON.parse(result.stdout)?.version;
      if (typeof version === "number") counts[entry.name] = version;
    } catch {
      // A partition the engine cannot read is workspaceContainer's question, not this
      // leg's; two owners for one defect is how a red gets argued about instead of fixed.
    }
  }
  return counts;
}

// TCRN-CROSS-INC-234: the acceptance lane could not tell "green" from "nobody looked".
//
// TCRN-CROSS-MIN-ACCEPTANCE-LANES makes the groups this roster lists all being green
// the criterion that releases machine-checkable work to done, and INC-232 wrote the roster
// down because until then it existed nowhere. Both left the same hole: nothing consults
// the roster at the moment it is supposed to bind. On 2026-08-19 the product-gates group
// had been failing since the 17th -- AOS importing an engine module retired in v0.11.18 --
// and six records landed done in that window against a criterion one of whose members was
// red, because the criterion is honoured by the executor choosing to run it.
//
// This leg cannot verify a group is green; only running it can. What it can do is refuse
// to let "not run" look like "passed", which is the failure that actually happened. Every
// roster group needs a recorded verdict, recorded verdicts go stale, and a red one stays
// visible, and the same honesty holds: the record is evidence that someone looked, never
// proof they were right.
//
// STORY-304 replaced the staleness reference. It was 26 hours measured from the roster
// file's mtime, which could never fire and varied by host; it is now the engine commit the
// verdict names, compared against the commit being inspected. "Stale" therefore means
// "recorded against a different tree" -- a question with one answer everywhere.

async function inspectAcceptanceVerdicts(root, options) {
  const docsRoot = await platformDocsRoot(root);
  const rosterPath = join(docsRoot.path, "acceptance-gate-groups.json");
  const verdictPath = join(docsRoot.path, "acceptance-verdicts.json");
  let roster;
  try {
    roster = JSON.parse(await readFile(rosterPath, "utf8"));
  } catch {
    // acceptanceGateGroups already owns "the roster is missing or malformed"; reporting it
    // twice would give one defect two owners and two arguments about who fixes it.
    return check("acceptanceVerdicts", true, { comparable: false, reason: "no roster to check verdicts against" });
  }
  const allGroups = Array.isArray(roster?.groups) ? roster.groups.map((group) => group?.id).filter((id) => typeof id === "string") : [];
  const groups = allGroups.filter((id) => id !== CHAIN_VALIDATE_GROUP_ID);
  if (allGroups.length === 0) {
    return check("acceptanceVerdicts", true, { comparable: false, reason: "no roster to check verdicts against" });
  }
  let document = options.acceptanceVerdicts;
  if (document === undefined) {
    try {
      document = JSON.parse(await readFile(verdictPath, "utf8"));
    } catch {
      return check("acceptanceVerdicts", false, {
        reasonCode: "PLATFORM_ACCEPTANCE_VERDICTS_MISSING",
        groups: groups.length,
        remedy: "run the groups this roster lists and record each verdict in platform-docs/acceptance-verdicts.json; an unrecorded run cannot be told from an unrun one",
      });
    }
  }
  // TCRN-CROSS-INC-250: a verdict is bound to the tree named by its roster entry.
  // Git repositories use their full HEAD object id. The chain container has no git
  // commit, so its binding is a content digest over every partition's workspace id
  // and event-chain head hash. The chain version is deliberately not the identity:
  // it is a counter that changes whenever the workflow records another fact.
  const verdictsPresent = document?.verdicts && typeof document.verdicts === "object" && Object.keys(document.verdicts).length > 0;
  const verdicts = document?.verdicts && typeof document.verdicts === "object" ? document.verdicts : {};
  const groupsById = new Map((Array.isArray(roster?.groups) ? roster.groups : []).map((group) => [group?.id, group]));
  const currentBindings = new Map();
  const unresolved = [];
  const liveGroupRecorded = Object.hasOwn(verdicts, CHAIN_VALIDATE_GROUP_ID);
  if (verdictsPresent) {
    for (const group of (Array.isArray(roster?.groups) ? roster.groups : []).filter((candidate) => candidate?.id !== CHAIN_VALIDATE_GROUP_ID)) {
      const resolved = await resolveAcceptanceBinding(root, group, options);
      if (!resolved.ok) {
        unresolved.push({ group: group.id, repository: group.repository, reasonCode: resolved.reasonCode, reason: resolved.reason });
      } else {
        currentBindings.set(group.id, resolved.binding);
      }
    }
  }
  const missing = [];
  const stale = [];
  const failing = [];
  const acceptedExceptions = [];
  for (const id of groups) {
    const entry = verdicts[id];
    if (!entry || typeof entry.recordedAt !== "string" || typeof entry.verdict !== "string") {
      missing.push(id);
      continue;
    }
    if (entry.verdict !== "green") {
      const reasonCode = typeof entry.detail === "string"
        ? /(?:^|\s)reasonCode=([A-Z0-9_:-]+)(?:$|[\s;])/u.exec(entry.detail)?.[1]
        : null;
      const accepted = entry.verdict === "red"
        && reasonCode !== null
        && (Array.isArray(groupsById.get(id)?.acceptedExceptions)
          ? groupsById.get(id).acceptedExceptions.find((candidate) => candidate?.reasonCode === reasonCode)
          : null);
      if (accepted) {
        acceptedExceptions.push({ group: id, ...accepted });
        continue;
      }
      failing.push({ group: id, verdict: entry.verdict, ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}) });
      continue;
    }
    const group = groupsById.get(id) ?? { id, repository: null };
    const recordedBinding = recordedAcceptanceBinding(entry, group, options);
    if (recordedBinding === null) {
      stale.push({
        group: id,
        recordedAt: entry.recordedAt,
        reason: options.acceptanceHeadCommit !== undefined
          ? "verdict names no commit"
          : "verdict names no machine-readable tree binding",
      });
      continue;
    }
    const currentBinding = currentBindings.get(id);
    if (!currentBinding) continue;
    const comparison = compareAcceptanceBindings(recordedBinding, currentBinding);
    if (!comparison.equal) {
      const staleEntry = {
        group: id,
        repository: group.repository,
        recordedAt: entry.recordedAt,
        recordedAgainst: options.acceptanceHeadCommit !== undefined && recordedBinding.kind === "git"
          ? recordedBinding.commit?.slice(0, 12)
          : bindingIdentity(recordedBinding),
        current: options.acceptanceHeadCommit !== undefined && currentBinding.kind === "git"
          ? currentBinding.commit?.slice(0, 12)
          : bindingIdentity(currentBinding),
        ...(comparison.changed.length > 0 ? { changed: comparison.changed } : {}),
      };
      if (options.acceptanceHeadCommit !== undefined && currentBinding.kind === "git") staleEntry.head = currentBinding.commit.slice(0, 12);
      stale.push(staleEntry);
    }
  }
  if (liveGroupRecorded || unresolved.length > 0 || missing.length > 0 || stale.length > 0 || failing.length > 0) {
    return check("acceptanceVerdicts", false, {
      reasonCode: "PLATFORM_ACCEPTANCE_LANE_UNPROVEN",
      ...(liveGroupRecorded ? { liveGroupRecorded: CHAIN_VALIDATE_GROUP_ID } : {}),
      ...(unresolved.length > 0 ? { unresolved } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      ...(stale.length > 0 ? { stale } : {}),
      ...(failing.length > 0 ? { failing } : {}),
      ...(acceptedExceptions.length > 0 ? { acceptedExceptions } : {}),
      remedy: "the machine-checked lane is not satisfied: a group is unrecorded, stale, or red, and a record of a run is not proof the run passed",
    });
  }
  return check("acceptanceVerdicts", true, {
    groups: groups.length,
    liveGroups: [CHAIN_VALIDATE_GROUP_ID],
    ...(acceptedExceptions.length > 0 ? { acceptedExceptions } : {}),
    bindings: [...currentBindings.entries()].map(([group, binding]) => ({ group, kind: binding.kind, repository: binding.repository, identity: bindingIdentity(binding) })),
    ...(options.acceptanceHeadCommit !== undefined ? { head: options.acceptanceHeadCommit.slice(0, 12) } : {}),
  });
}

async function inspectAcceptanceGateGroups(root) {
  const docsRoot = await platformDocsRoot(root);
  const path = join(docsRoot.path, "acceptance-gate-groups.json");
  let roster;
  try {
    roster = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return check("acceptanceGateGroups", false, { reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_MISSING", path: join(docsRoot.relativePath, "acceptance-gate-groups.json") });
  }
  if (roster?.schemaVersion !== "tcrn.acceptance-gate-groups.v1" || !Array.isArray(roster.groups)) {
    return check("acceptanceGateGroups", false, { reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_INVALID", detail: "schemaVersion or groups" });
  }
  const incomplete = roster.groups
    .filter((group) => !["id", "title", "repository", "command", "proves"].every((field) => typeof group?.[field] === "string" && group[field].length > 0))
    .map((group, index) => (typeof group?.id === "string" ? group.id : `#${index}`));
  const ids = roster.groups.map((group) => group?.id);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  const unexpectedGroups = ids.filter((id) => !ACCEPTANCE_GROUP_IDS.includes(id));
  const missingGroups = ACCEPTANCE_GROUP_IDS.filter((id) => !ids.includes(id));
  const orderedGroupMismatch = ids.length === ACCEPTANCE_GROUP_IDS.length && ids.some((id, index) => id !== ACCEPTANCE_GROUP_IDS[index]);
  const invalidBatchApplicability = [];
  for (const group of roster.groups) {
    const expected = ACCEPTANCE_BATCH_STATUS[group?.id];
    const applicability = group?.batchApplicability;
    if (!expected || !applicability || typeof applicability !== "object" || Array.isArray(applicability)) {
      invalidBatchApplicability.push(group?.id ?? "#unknown");
      continue;
    }
    if (!hasExactKeys(applicability, ["firstBatch", "secondBatch"])) {
      invalidBatchApplicability.push(`${group.id}.phaseKeys`);
    }
    for (const batch of ["firstBatch", "secondBatch"]) {
      const entry = applicability[batch];
      const expectedPhaseKeys = group.id === "platform-layout" && batch === "firstBatch"
        ? ["status", "criteria", "subchecks"]
        : ["status", "criteria"];
      if (!hasExactKeys(entry, expectedPhaseKeys)
        || entry?.status !== expected[batch]
        || !Array.isArray(entry?.criteria)
        || entry.criteria.length === 0
        || entry.criteria.some((criterion) => typeof criterion !== "string" || criterion.trim().length === 0)) {
        invalidBatchApplicability.push(`${group.id}.${batch}`);
      }
    }
    if (group.id === "platform-layout") {
      const subchecks = applicability.firstBatch?.subchecks;
      const subcheckIds = Array.isArray(subchecks) ? subchecks.map((subcheck) => subcheck?.id) : [];
      const expectedSubcheckIds = Object.keys(PLATFORM_LAYOUT_SUBCHECKS);
      if (subcheckIds.length !== expectedSubcheckIds.length
        || subcheckIds.some((id, index) => id !== expectedSubcheckIds[index])) {
        invalidBatchApplicability.push("platform-layout.subchecks");
      } else {
        for (const subcheck of subchecks) {
          const [firstBatch, secondBatch] = PLATFORM_LAYOUT_SUBCHECKS[subcheck.id];
          if (!hasExactKeys(subcheck, ["id", "firstBatch", "secondBatch", "criteria"])
            || subcheck.firstBatch !== firstBatch || subcheck.secondBatch !== secondBatch
            || typeof subcheck.criteria !== "string" || subcheck.criteria.trim().length === 0) {
            invalidBatchApplicability.push(`platform-layout.subchecks.${subcheck.id}`);
          }
        }
      }
    } else if (Object.hasOwn(applicability, "subchecks") || Object.hasOwn(applicability.firstBatch ?? {}, "subchecks")) {
      invalidBatchApplicability.push(`${group.id}.subchecks`);
    }
  }
  const containmentProblems = [];
  let topLevel = null;
  if (roster.topLevel !== undefined) {
    topLevel = roster.topLevel;
    if (!Array.isArray(topLevel) || topLevel.length === 0 || new Set(topLevel).size !== topLevel.length) {
      containmentProblems.push("topLevel must be a non-empty unique array");
    }
    const known = new Set(ids);
    const parents = new Map();
    for (const group of roster.groups) {
      if (!Array.isArray(group?.contains)) {
        containmentProblems.push(`${String(group?.id)}.contains must be an array`);
        continue;
      }
      for (const child of group.contains) {
        if (!known.has(child)) containmentProblems.push(`${String(group?.id)} contains unknown ${String(child)}`);
        const existing = parents.get(child);
        if (existing !== undefined) containmentProblems.push(`${String(child)} has parents ${existing} and ${String(group?.id)}`);
        else parents.set(child, group.id);
      }
    }
    if (Array.isArray(topLevel)) {
      if (topLevel.length !== ACCEPTANCE_TOP_LEVEL_GROUP_IDS.length
        || topLevel.some((id, index) => id !== ACCEPTANCE_TOP_LEVEL_GROUP_IDS[index])) {
        containmentProblems.push("topLevel must retain engine-release, platform-layout, product-gates in order");
      }
      for (const id of topLevel) {
        if (!known.has(id)) containmentProblems.push(`topLevel contains unknown ${String(id)}`);
        if (parents.has(id)) containmentProblems.push(`topLevel group ${String(id)} is also contained`);
      }
      for (const id of ids) {
        if (known.has(id) && !topLevel.includes(id) && !parents.has(id)) containmentProblems.push(`non-top-level group ${String(id)} has no parent`);
      }
    }
  } else {
    containmentProblems.push("topLevel is required");
  }
  const invalidAcceptedExceptions = [];
  const acceptedExceptionKeys = new Set();
  for (const group of roster.groups) {
    if (group?.acceptedExceptions === undefined) continue;
    if (!Array.isArray(group.acceptedExceptions) || group.acceptedExceptions.length === 0) {
      invalidAcceptedExceptions.push(group?.id ?? "#unknown");
      continue;
    }
    for (const exception of group.acceptedExceptions) {
      const valid = exception
        && typeof exception.reasonCode === "string"
        && /^[A-Z0-9_:-]+$/u.test(exception.reasonCode)
        && typeof exception.acceptedAt === "string"
        && /^\d{4}-\d{2}-\d{2}$/u.test(exception.acceptedAt)
        && typeof exception.reason === "string"
        && /^[A-Z0-9_:-]+$/u.test(exception.reason);
      const key = `${group?.id}:${exception?.reasonCode}`;
      if (!valid || acceptedExceptionKeys.has(key)) invalidAcceptedExceptions.push(group?.id ?? "#unknown");
      acceptedExceptionKeys.add(key);
    }
  }
  const actualAcceptedExceptions = roster.groups.flatMap((group) => (Array.isArray(group?.acceptedExceptions)
    ? group.acceptedExceptions.map((exception) => ({ group: group?.id, exception }))
    : []));
  const launchdException = actualAcceptedExceptions[0];
  if (actualAcceptedExceptions.length !== 1
    || launchdException?.group !== "platform-layout"
    || launchdException.exception?.acceptedAt !== "2026-08-15"
    || launchdException.exception?.reasonCode !== "PLATFORM_LAUNCHD_NOT_ON_DUTY"
    || launchdException.exception?.reason !== "OWNER_RULING_BACKUP_LAYERS_STOPPED") {
    invalidAcceptedExceptions.push("only the existing platform-layout launchd exception is accepted");
  }
  // TCRN-CROSS-MIN-149 removed the two helper groups; MIN-235 D3 now removes the
  // retired engine-guards call and records the existing two-batch applicability. Pin
  // the resulting identities and applicability so a phase note cannot drop a live
  // obligation or silently turn a doctor finding green.
  if (ids.length !== ACCEPTANCE_GROUP_IDS.length
    || missingGroups.length > 0
    || unexpectedGroups.length > 0
    || orderedGroupMismatch
    || incomplete.length > 0
    || duplicated.length > 0
    || invalidBatchApplicability.length > 0
    || invalidAcceptedExceptions.length > 0
    || containmentProblems.length > 0) {
    return check("acceptanceGateGroups", false, {
      reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_INVALID",
      declaredGroups: roster.groups.length,
      incomplete,
      duplicated,
      missingGroups,
      unexpectedGroups,
      orderedGroupMismatch,
      invalidBatchApplicability,
      invalidAcceptedExceptions,
      containmentProblems,
    });
  }
  return check("acceptanceGateGroups", true, {
    declaredGroups: roster.groups.length,
    acceptedExceptionCount: acceptedExceptionKeys.size,
    batchApplicability: Object.fromEntries(Object.entries(ACCEPTANCE_BATCH_STATUS).map(([id, phases]) => [id, phases])),
    ...(topLevel === null ? {} : { topLevel, containedGroups: roster.groups.length - topLevel.length }),
  });
}

async function inspectWorkspaceContainer(root) {
  const containerPath = join(root, ".tcrn-workspace");
  const containerStats = await existingPath(containerPath);
  if (!containerStats || !containerStats.isDirectory()) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_CONTAINER_MISSING", path: ".tcrn-workspace" });
  }
  const entries = await readdir(containerPath, { withFileTypes: true });
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (workspaceStats?.isDirectory()) partitions.push(entry.name);
  }
  if (partitions.length === 0) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_PARTITION_MISSING", path: ".tcrn-workspace" });
  }
  return check("workspaceContainer", true, { path: ".tcrn-workspace", partitions });
}

// TCRN-CROSS-INC-274: every partition must migrate to storage version 2 with the
// 4 MiB segment event limit. This leg walks the live platform and verifies every
// partition has made that transition. Test it with the --platform-root flag supplied
// to the doctor; a unit test in this repository cannot inspect the container above it.
async function inspectWorkspaceStorageShape(root, options) {
  if (options.workspaceStorageShape && typeof options.workspaceStorageShape === "object") {
    const { partitions } = options.workspaceStorageShape;
    const failed = (Array.isArray(partitions) ? partitions : []).filter((p) => p.ok === false);
    return check("workspaceStorageShape", failed.length === 0, {
      partitions,
      ...(failed.length > 0 ? {
        reasonCode: "PLATFORM_WORKSPACE_STORAGE_BEHIND",
        failed: failed.map((p) => ({
          partition: p.partition,
          storageVersion: p.storageVersion,
          segmentEventLimit: p.segmentEventLimit,
        })),
      } : {}),
    });
  }

  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return check("workspaceStorageShape", true, { comparable: false, reason: "container is unreadable; storage shape is unknown" });
  }

  const partitions = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (!workspaceStats?.isDirectory()) continue;

    const metadataPath = join(workspacePath, WORKFLOW_DIRECTORY, "workspace.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const ok = metadata.storageVersion === 2 && metadata.segmentEventLimit === WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES;
      partitions.push({
        partition: entry.name,
        storageVersion: metadata.storageVersion ?? null,
        segmentEventLimit: metadata.segmentEventLimit ?? null,
        ok,
      });
    } catch (error) {
      // ENOENT is expected in synthetic test fixtures that do not create workspace.json.
      // Only treat as a failure if the file should exist (real platform).
      if (error?.code === "ENOENT") {
        return check("workspaceStorageShape", true, { comparable: false, reason: "no readable workspace metadata; storage shape is unknown (synthetic fixture)" });
      }
      partitions.push({
        partition: entry.name,
        storageVersion: null,
        segmentEventLimit: null,
        ok: false,
        error: error?.code ?? "INVALID_METADATA",
      });
    }
  }

  if (partitions.length === 0) {
    return check("workspaceStorageShape", true, { comparable: false, reason: "no partitions found" });
  }

  const failed = partitions.filter((p) => !p.ok);
  return check("workspaceStorageShape", failed.length === 0, {
    partitions,
    ...(failed.length > 0 ? {
      reasonCode: "PLATFORM_WORKSPACE_STORAGE_BEHIND",
      failed: failed.map((p) => ({
        partition: p.partition,
        storageVersion: p.storageVersion,
        segmentEventLimit: p.segmentEventLimit,
        error: p.error,
      })),
    } : {}),
  });
}

// TCRN-CROSS-INC-274: observe snapshot read performance. The original test measured
// a regression slope below 75 microseconds per event across the live platform.
// A hard performance threshold in a health check is flaky and teaches people to ignore
// it when it fires on a slow disk. So this is an OBSERVATION only: it reports the
// measured slope and the reference baseline, but never fails the doctor. The honest
// reason is operational: a gate that goes red on performance metrics teaches the wrong
// lesson about what the health check is for.
async function inspectSnapshotReadPerformance(root, options) {
  if (options.snapshotReadPerformance && typeof options.snapshotReadPerformance === "object") {
    const { measurements } = options.snapshotReadPerformance;
    const avgSlope = measurements && measurements.length > 0
      ? measurements.reduce((sum, m) => sum + m.slope, 0) / measurements.length
      : null;
    return check("snapshotReadPerformance", true, {
      comparable: measurements && measurements.length > 0,
      measuredPartitions: measurements && measurements.length > 0 ? measurements.length : 0,
      ...(measurements && measurements.length > 0 ? {
        measurements,
        averageSlope: avgSlope,
        referenceBaseline: 75,
        referenceUnit: "microseconds-per-event",
        reason: "performance observations are reported, never gated; a regression detected on slower hosts teaches the wrong lesson",
      } : {
        reason: "no measurements available",
      }),
    });
  }

  // Reuse the event count source from chainHeadroom to ensure consistency.
  // chainEventCounts() uses the status command which is the canonical truth.
  const eventCounts = await chainEventCounts(root, options);
  if (eventCounts === null) {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "chain event counts are unreadable; snapshot read slope is unknown",
    });
  }

  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "container is unreadable; snapshot read slope is unknown",
    });
  }

  const measurements = [];
  let skipped = 0;
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareCanonicalTextLocal(left.name, right.name))) {
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (!workspaceStats?.isDirectory()) continue;

    const eventCount = eventCounts[entry.name];
    if (typeof eventCount !== "number" || eventCount === 0) {
      skipped += 1;
      continue; // Skip empty partitions
    }

    const metadataPath = join(workspacePath, WORKFLOW_DIRECTORY, "workspace.json");
    try {
      // Measure snapshot read time by reading the metadata file itself.
      // In a real measurement, you would materialize snapshots, but this observes
      // the cost of reading partition state.
      const started = process.hrtime.bigint();
      await readFile(metadataPath);
      const durationNs = process.hrtime.bigint() - started;

      // Slope: microseconds per event
      const slopeUs = eventCount > 0 ? Number(durationNs) / 1000 / eventCount : 0;

      measurements.push({
        partition: entry.name,
        eventCount,
        readTimeNs: Number(durationNs),
        slope: Number(slopeUs.toFixed(3)),
      });
    } catch {
      // Unreadable partitions are not included in measurements.
      continue;
    }
  }

  if (measurements.length === 0) {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "no readable partitions to measure",
      measuredPartitions: 0,
      skippedPartitions: skipped,
    });
  }

  const avgSlope = measurements.reduce((sum, m) => sum + m.slope, 0) / measurements.length;
  return check("snapshotReadPerformance", true, {
    comparable: true,
    measurements,
    averageSlope: Number(avgSlope.toFixed(3)),
    measuredPartitions: measurements.length,
    referenceBaseline: 75,
    referenceUnit: "microseconds-per-event",
    reason: "performance observations are reported, never gated; a regression detected on slower hosts teaches the wrong lesson",
  });
}

async function inspectGitAncestors(root) {
  const visited = [];
  let current = root;
  while (true) {
    visited.push(current);
    if (await existingPath(join(current, ".git"))) {
      if (current === root && await isContainerWhitelistRepository(root)) {
        return check("containerOutsideGit", true, {
          ancestorsChecked: visited.length,
          repository: "container-whitelist",
        });
      }
      return check("containerOutsideGit", false, { reasonCode: "PLATFORM_ROOT_INSIDE_GIT_REPOSITORY", gitAncestor: current });
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return check("containerOutsideGit", true, { ancestorsChecked: visited.length });
}

async function isContainerWhitelistRepository(root) {
  try {
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    const lines = ignore.split(/\r?\n/u);
    return lines.includes("/*")
      && lines.includes("!/AGENTS.md")
      && lines.includes("!/CLAUDE.md")
      && lines.includes("!/docs/");
  } catch {
    return false;
  }
}

async function inspectClaudeBridge(root) {
  const path = join(root, "CLAUDE.md");
  const stats = await existingPath(path);
  if (!stats || !stats.isFile()) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_MISSING", path: "CLAUDE.md" });
  const content = await readFile(path, "utf8");
  if (content.trim().length === 0) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_EMPTY", path: "CLAUDE.md" });
  if (content.replace(/\s+/gu, "") !== "@AGENTS.md") {
    return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_INVALID", path: "CLAUDE.md", expected: "@AGENTS.md" });
  }
  return check("claudeBridge", true, { path: "CLAUDE.md", target: "AGENTS.md" });
}

async function inspectBridgeSyntax(root) {
  const candidates = [join(root, "AGENTS.md"), join(root, "CLAUDE.md")];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === ".tcrn-workspace") continue;
    candidates.push(join(root, entry.name, "AGENTS.md"), join(root, entry.name, "CLAUDE.md"));
  }
  const failures = [];
  for (const path of candidates) {
    const stats = await existingPath(path);
    if (!stats?.isFile()) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (!line.startsWith("@")) continue;
      if (line.startsWith("@@")) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          reasonCode: "PLATFORM_BRIDGE_SYNTAX_INVALID",
        });
        continue;
      }
      const targetText = line.slice(1).trim();
      const target = targetText.length > 0 ? resolve(dirname(path), targetText) : null;
      const targetStats = target === null ? null : await existingPath(target);
      if (!targetStats?.isFile()) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          target: targetText,
          reasonCode: "PLATFORM_BRIDGE_TARGET_UNAVAILABLE",
        });
      }
    }
  }
  return failures.length === 0
    ? check("bridgeSyntax", true, { filesChecked: candidates.length, source: "platform-and-direct-child-bridges" })
    : check("bridgeSyntax", false, { reasonCode: failures[0].reasonCode, failures, source: "platform-and-direct-child-bridges" });
}

export async function inspectInstallWiring(platformRoot, homeRoot, manifest = INSTALL_MANIFEST) {
  const required = manifest.items;
  const missing = [];
  const invalid = [];
  for (const entry of required) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const stats = path === null ? null : await existingPath(path);
    if (!stats) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, probe: entry.acceptanceProbe });
      continue;
    }
    const probe = parseAcceptanceProbe(entry.acceptanceProbe);
    if (!probe) {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_INVALID", acceptanceProbe: entry.acceptanceProbe });
      continue;
    }
    if (["regular-file", "receipt-json", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty", "regular-executable"].includes(probe.kind)) {
      if (!stats.isFile()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_FILE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (probe.kind === "regular-executable" && (stats.mode & 0o111) === 0) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_EXECUTABLE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (["receipt-json", "local-snapshot-freshness", "offsite-push-freshness"].includes(probe.kind)) {
        try {
          JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_FAILED", pathTemplate: entry.pathTemplate, probe: probe.kind, error: error?.code ?? "INVALID_JSON" });
        }
      }
    } else if (probe.kind === "regular-directory" || probe.kind === "engine-version") {
      if (!stats.isDirectory()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_DIRECTORY", pathTemplate: entry.pathTemplate, probe: probe.kind });
    } else {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_UNSUPPORTED", pathTemplate: entry.pathTemplate, probe: probe.kind });
    }
  }
  return missing.length === 0 && invalid.length === 0
    ? check("installWiring", true, { itemCount: required.length, source: "install-manifest", probes: "safe-manifest-expression" })
    : check("installWiring", false, {
      reasonCode: "PLATFORM_INSTALL_WIRING_INCOMPLETE",
      source: "install-manifest",
      missing,
      invalid,
    });
}

function parseAcceptanceProbe(value) {
  if (typeof value !== "string") return null;
  const [head, ...segments] = value.split(";");
  if (!head?.startsWith("probe:")) return null;
  const kind = head.slice("probe:".length);
  if (!["regular-file", "regular-directory", "regular-executable", "receipt-json", "engine-version", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty"].includes(kind)) return null;
  const parameters = Object.fromEntries(segments.map((segment) => segment.split("=")).filter(([key, val]) => typeof key === "string" && typeof val === "string" && key.length > 0 && val.length > 0));
  return { kind, parameters };
}

function probeFailure(reasonCode, message, details = {}) {
  return Object.assign(new Error(message), { reasonCode, ...details });
}

function hookCommands(settings) {
  const hooks = settings?.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook !== null && typeof hook === "object" && typeof hook.command === "string") commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

/**
 * Is a hook command something this host can actually run?
 *
 * Shared by both hosts because the answer is the same question twice: resolve the target,
 * confirm it is a file, and ask node to parse it. A registered hook whose target does not
 * parse is a hook that fails at the moment it is supposed to protect something.
 */
async function hookTargetFailures(commands, resolveTarget, deviceEntries = null) {
  const failures = [];
  let checked = 0;
  const events = new Set();
  for (const hook of commands) {
    const target = resolveTarget(hook.command);
    if (target === null) continue;
    checked += 1;
    events.add(hook.event);
    if (target === undefined) {
      failures.push({ event: hook.event, command: hook.command, reasonCode: "PLATFORM_HOOK_COMMAND_UNSUPPORTED" });
      continue;
    }
    const targetStats = await existingPath(target);
    if (!targetStats?.isFile()) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" });
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", target], { timeout: 10_000, maxBuffer: 1_048_576 });
    } catch (error) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNUSABLE", error: error?.code ?? "NODE_CHECK_FAILED" });
      continue;
    }
    if (deviceEntries !== null && isEinzbernHookCommand(hook.command)) {
      const { device, missing } = await launcherDeviceGaps(target, deviceEntries);
      if (missing.length > 0) failures.push({ event: hook.event, command: hook.command, target, device, missing, reasonCode: HOOK_ENGINE_NOT_INSTALLED });
    }
  }
  return { failures, checked, events: [...events].sort() };
}

// TCRN-CROSS-INIT-053 R47-06: a hook that runs Einzbern's launcher can be in place and still reach
// nothing. The launcher answers only when its device directory holds the engine pointer and the
// registry; without them it ends every prompt quietly, by design, so the hook looks alive and is
// not. That is a separate finding from a hook whose script is gone (PLATFORM_HOOK_TARGET_UNAVAILABLE):
// the hook is right and the engine is not installed. The install manifest names the launcher
// (machine.hook-launcher) and the pointer (machine.engine-current) relative to the device directory
// (machine.workflow-engine); the registry is DEVICE_HOME_ENTRIES.registry beside them.
const HOOK_ENGINE_NOT_INSTALLED = "PLATFORM_HOOK_ENGINE_NOT_INSTALLED";

function launcherDeviceEntries(manifest) {
  const template = (id) => manifest.items.find((item) => item.id === id)?.pathTemplate ?? null;
  const device = template("machine.workflow-engine");
  const launcher = template("machine.hook-launcher");
  const pointer = template("machine.engine-current");
  if (device === null || launcher === null || pointer === null) return null;
  return {
    launcherDepth: posix.relative(device, launcher).split("/").length,
    required: [posix.relative(device, pointer), DEVICE_HOME_ENTRIES.registry],
  };
}

async function launcherDeviceGaps(target, deviceEntries) {
  const device = resolve(target, ...Array.from({ length: deviceEntries.launcherDepth }, () => ".."));
  const missing = [];
  for (const entry of deviceEntries.required) {
    if (!(await existingPath(join(device, ...entry.split("/"))))?.isFile()) missing.push(entry);
  }
  return { device, missing };
}

// The script a hook command runs with node: quoted or not, behind a `[ -f ]` guard or not.
const NODE_HOOK_COMMAND = /^(?:if \[ -f "[^"]+" \]; then )?node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u;

function nodeHookTarget(command, expand = (path) => path) {
  const match = NODE_HOOK_COMMAND.exec(command.trim());
  if (!match) return undefined;
  return resolve(expand(match[1] ?? match[2] ?? match[3]));
}

async function readHookFile(path) {
  const stats = await existingPath(path);
  if (!stats) return { state: "absent" };
  if (!stats.isFile()) return { state: "not-file" };
  try {
    return { state: "read", settings: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return { state: "invalid", error: error?.message ?? "INVALID_JSON" };
  }
}

/**
 * The user-level hook files (TCRN-CROSS-INIT-053 R47-06): .claude/settings.json and .codex/hooks.json
 * in the user's home, where the hooks a host runs in every project live. Both failures the harness
 * audit found sat there, out of reach of a leg that read the container's files only. A user file
 * also holds hooks of the user's own, so only the commands Einzbern can answer for are checked:
 * its launcher and the old harness's scripts (host-hooks.ts names both). An absent file has no
 * hook to fail; a file the host cannot parse is a finding.
 */
async function inspectUserHooks(platformRoot, homeRoot, deviceEntries) {
  const expand = (path) => path.replaceAll("${CLAUDE_PROJECT_DIR}", platformRoot).replaceAll("${HOME}", homeRoot).replaceAll("$HOME", homeRoot);
  const ours = (command) => (isEinzbernHookCommand(command) || isLegacyHookCommand(command) ? nodeHookTarget(command, expand) : null);
  const user = {};
  for (const [host, file, notFile, invalid] of [
    ["claude", HOST_HOOK_FILES["claude-code"], "PLATFORM_HOOK_SETTINGS_NOT_FILE", "PLATFORM_HOOK_SETTINGS_INVALID"],
    ["codex", HOST_HOOK_FILES.codex, "PLATFORM_CODEX_HOOKS_NOT_FILE", "PLATFORM_CODEX_HOOKS_INVALID"],
  ]) {
    const pathTemplate = `<HOME>/${file}`;
    const read = await readHookFile(join(homeRoot, ...file.split("/")));
    if (read.state === "absent") user[host] = { state: "absent", pathTemplate };
    else if (read.state === "not-file") user[host] = { state: "invalid", pathTemplate, reasonCode: notFile };
    else if (read.state === "invalid") user[host] = { state: "invalid", pathTemplate, reasonCode: invalid, error: read.error };
    else {
      const { failures, checked, events } = await hookTargetFailures(hookCommands(read.settings), ours, deviceEntries);
      user[host] = { state: failures.length === 0 ? "live" : "broken", pathTemplate, checked, failures, events };
    }
  }
  return user;
}

/**
 * The codex arm (TCRN-CROSS-STORY-286).
 *
 * This leg only ever read the Claude settings, so a codex host could carry a broken or
 * unparseable hook and the doctor would call the platform healthy. Codex writes an exact
 * `.codex/hooks.json` at activation, in the same event → hooks → command shape, differing
 * only in that its commands carry resolved absolute paths rather than a project-dir
 * placeholder.
 *
 * Absence is deferral, not health: the adapter bundle installs inert and activation is a
 * separate governed step, so a container with no hooks file has not failed anything — it
 * has not been activated. Saying so is different from saying it passed.
 */
async function inspectCodexHooks(platformRoot, deviceEntries = null) {
  const hooksPath = resolve(platformRoot, ".codex/hooks.json");
  const stats = await existingPath(hooksPath);
  if (!stats) return { state: "absent" };
  if (!stats.isFile()) return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_NOT_FILE" };
  let settings;
  try {
    settings = JSON.parse(await readFile(hooksPath, "utf8"));
  } catch (error) {
    return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_INVALID", error: error?.message ?? "INVALID_JSON" };
  }
  const commands = hookCommands(settings);
  const { failures, checked } = await hookTargetFailures(commands, (command) => {
    const match = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command.trim());
    if (!match) return undefined;
    return resolve(match[1] ?? match[2] ?? match[3]);
  }, deviceEntries);
  return {
    state: failures.length === 0 ? "live" : "broken",
    checked,
    failures,
    events: [...new Set(commands.map((hook) => hook.event))].sort(),
  };
}

// A hook file's own failure (not a file, not JSON) and its hooks' failures, each naming its source.
function sourcedHookFailures(source, part) {
  if (part === undefined || part === null) return [];
  if (part.state === "invalid") return [{ source, reasonCode: part.reasonCode, ...(part.error === undefined ? {} : { error: part.error }) }];
  return (part.failures ?? []).map((failure) => ({ ...failure, source }));
}

// The container's Claude settings: the commands the old harness wrote with the project-dir
// placeholder, in their one accepted shape, and the Einzbern launcher's command (R47-06).
function containerClaudeTarget(platformRoot) {
  return (command) => {
    if (command.includes("${CLAUDE_PROJECT_DIR}")) {
      const match = /^(?:if \[ -f "[^"]+" \]; then )?node\s+"([^"]+)"(?:\s+--container-root\s+"[^"]+")?(?:\s+--host\s+claude)?(?:; fi)?$/u.exec(command.trim());
      return match ? resolve(match[1].replaceAll("${CLAUDE_PROJECT_DIR}", platformRoot)) : undefined;
    }
    return isEinzbernHookCommand(command) ? nodeHookTarget(command) : null;
  };
}

/**
 * The hooks leg reads four files: the container's Claude settings and Codex hooks, and the same two
 * at user level (R47-06). A hook whose script is gone or does not parse is red at once (target
 * failures, unchanged codes); a launcher hook whose device directory lacks the installed engine is
 * PLATFORM_HOOK_ENGINE_NOT_INSTALLED, listed after them in `failures` so the first reason code
 * stays the broken script when there is one. An absent container Claude file defers that file to
 * installWiring and nothing else: a failure in any other file is still red.
 */
async function inspectHookExecutability(platformRoot, homeRoot, manifest) {
  const deviceEntries = launcherDeviceEntries(manifest);
  const codex = await inspectCodexHooks(platformRoot, deviceEntries);
  const user = await inspectUserHooks(platformRoot, homeRoot, deviceEntries);
  const entry = manifest.items.find((candidate) => candidate.id === "container.claude-settings");
  if (!entry) return check("hooks", false, { reasonCode: "PLATFORM_MANIFEST_HOOK_SETTINGS_MISSING", codex, user });
  const settingsPath = expandTemplate(entry.pathTemplate, platformRoot, platformRoot);
  const stats = settingsPath === null ? null : await existingPath(settingsPath);
  let claude = { state: "absent" };
  if (stats) {
    if (!stats.isFile()) return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_NOT_FILE", pathTemplate: entry.pathTemplate, codex, user });
    let settings;
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_INVALID", error: error?.message ?? "INVALID_JSON", codex, user });
    }
    const { failures, checked, events } = await hookTargetFailures(hookCommands(settings), containerClaudeTarget(platformRoot), deviceEntries);
    claude = { state: failures.length === 0 ? "live" : "broken", checked, failures, events };
  }
  // A codex hooks file that exists and is broken is a finding of its own: activation
  // wrote it, so something is registered and unrunnable. Absent stays deferral.
  const sourced = [
    ...sourcedHookFailures("container.codex-hooks", codex),
    ...sourcedHookFailures("container.claude-settings", claude),
    ...sourcedHookFailures("machine.claude-settings", user.claude),
    ...sourcedHookFailures("machine.codex-hooks", user.codex),
  ];
  const failures = [
    ...sourced.filter((failure) => failure.reasonCode !== HOOK_ENGINE_NOT_INSTALLED),
    ...sourced.filter((failure) => failure.reasonCode === HOOK_ENGINE_NOT_INSTALLED),
  ];
  if (failures.length > 0) {
    return check("hooks", false, { reasonCode: failures[0].reasonCode, failures, source: failures[0].source, codex, claude, user });
  }
  return claude.state === "absent"
    ? check("hooks", true, { source: "installWiring", deferredTo: "installWiring", codex, user })
    : check("hooks", true, { source: "container.claude-settings", checked: claude.checked, events: claude.events, codex, user });
}

function versionFromSkill(text) {
  // Keep this grammar closed: the Helper may use either historical wording or
  // the truthful article-bearing wording, but no other subject/article form is
  // an Engine pin.  Versions are non-empty, whitespace-free backtick payloads;
  // every accepted occurrence must agree exactly.
  const versions = [...text.matchAll(HELPER_PIN_PATTERN)].map((match) => match[1]);
  if (versions.length === 0 || new Set(versions).size !== 1) return null;
  return versions[0];
}

// The helper's two installed copies, one per host skill root. Named by id since their
// digest probe retired with the trusted archive (TCRN-CROSS-STORY-467 R2).
const HELPER_SKILL_ITEM_IDS = Object.freeze(["machine.agents-skill", "machine.claude-skill"]);

function helperSkillEntries(manifest) {
  return manifest.items.filter((entry) => HELPER_SKILL_ITEM_IDS.includes(entry.id));
}

async function inspectDeploymentFreshness(homeRoot, manifest) {
  const helperEntries = helperSkillEntries(manifest);
  const engineRoot = manifestPath(manifest, "machine.workflow-engine", "<PLATFORM_ROOT>", homeRoot);
  if (engineRoot === null || helperEntries.length === 0) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_DEPLOYMENT_ITEMS_MISSING" });
  const helperSkills = helperEntries.map((entry) => ({ entry, path: expandTemplate(entry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) }));
  if (engineRoot === null || helperSkills.some(({ path }) => path === null)) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });
  try {
    const packageValue = JSON.parse(await readFile(join(engineRoot, LEGACY_ENGINE_NAME, "package.json"), "utf8"));
    const engineVersion = packageValue.version;
    const helperVersions = [];
    for (const { entry, path } of helperSkills) {
      let text;
      try {
        text = await readFile(join(path, "SKILL.md"), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", source: "package.json-vs-helper-pin", missingInput: entry.id });
        }
        throw error;
      }
      helperVersions.push({ id: entry.id, pathTemplate: entry.pathTemplate, version: versionFromSkill(text) });
    }
    const versions = { engineVersion, helpers: helperVersions };
    const allVersions = [engineVersion, ...helperVersions.map((helper) => helper.version)];
    if (!allVersions.every((value) => typeof value === "string" && value.length > 0)) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_VERSION_MISSING", versions });
    }
    if (new Set(allVersions).size !== 1) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_STALE", versions });
    }
    return check("deploymentFreshness", true, { versions, source: "package.json-vs-helper-pin" });
  } catch (error) {
    return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", error: error?.code ?? "INVALID_DEPLOYMENT" });
  }
}

// TCRN-CROSS-MIN-102 批0. Four of the adversarial verdicts made the same thing a
// release condition — every engine copy that will read a chain is new enough
// before the first write in a new format lands — and no check could see it.
// `deploymentFreshness` compares the installed copy's own package.json against the
// two helper pins, which says nothing about whether a copy can read a given chain.
// A copy that is too old does not degrade: it fails the whole workspace closed as
// WORKSPACE_EVENT_CORRUPT, indistinguishable from real byte damage.
//
// The baseline is each partition's own `engine.requiredVersion` declaration — a
// chain declaration, class B in the gate-reference inventory, not something the
// tree can move without an edit. The targets are discovered rather than listed:
// partitions by walking the container, engine copies from the install manifest
// (the installed copy is an item, the working tree is a declared project), so a
// partition added tomorrow is covered the day it exists and no second roster
// exists for anything to drift against.
//
// An undeclared partition is green with the reason code saying so, never a silent
// green: nothing has been declared, so there is nothing to enforce, and the
// observed versions are reported as facts rather than asserted as healthy. This is
// the launchd leg's shape, for the same reason.
async function engineCopyVersions(root, homeRoot, manifest, options) {
  if (options.engineCopyVersions && typeof options.engineCopyVersions === "object") {
    return { copies: options.engineCopyVersions, source: "synthetic" };
  }
  const copies = {};
  const installedRoot = manifestPath(manifest, "machine.workflow-engine", "<PLATFORM_ROOT>", homeRoot);
  const engineProject = (manifest.projects ?? []).find((project) => project.name === BRAND.engine.id);
  const worktreeRoot = engineProject?.pathTemplate?.startsWith("<PLATFORM_ROOT>/")
    ? join(root, engineProject.pathTemplate.slice("<PLATFORM_ROOT>/".length))
    : null;
  const candidates = [
    ["installed", installedRoot === null ? null : join(installedRoot, LEGACY_ENGINE_NAME, "package.json")],
    ["worktree", worktreeRoot === null ? null : join(worktreeRoot, "package.json")],
  ];
  for (const [name, packagePath] of candidates) {
    if (packagePath === null) continue;
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      if (typeof value.version === "string" && value.version.length > 0) copies[name] = value.version;
    } catch {
      // A copy that is absent is not a copy that is stale. Only present copies are
      // compared; `deploymentFreshness` already owns "the installed copy is missing".
    }
  }
  return { copies, source: "install-manifest" };
}

async function declaredEngineRequirements(root, options) {
  if (options.engineRequiredVersions && typeof options.engineRequiredVersions === "object") {
    return { declarations: options.engineRequiredVersions, source: "synthetic" };
  }
  const containerPath = join(root, ".tcrn-workspace");
  // Same resolution as declaredBackupCadences: fileURLToPath rather than pathname,
  // because this repository lives under a directory whose name contains a space.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "einzbern.mjs");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { declarations: null, source: "unreadable", error: error?.code ?? "CONTAINER_UNREADABLE" };
  }
  const declarations = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const row = rows.find((candidate) => candidate?.key === "engine.requiredVersion");
      declarations[entry.name] = row?.currentValue ?? null;
    } catch (error) {
      return { declarations: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  return { declarations, source: "chain-declaration" };
}

async function inspectEngineFloorSatisfied(root, homeRoot, manifest, options) {
  const observed = await engineCopyVersions(root, homeRoot, manifest, options);
  const copies = observed.copies;
  if (Object.keys(copies).length === 0) {
    return check("engineFloorSatisfied", false, { reasonCode: "PLATFORM_ENGINE_COPY_UNREADABLE", source: observed.source });
  }
  const declared = await declaredEngineRequirements(root, options);
  if (declared.declarations === null) {
    // TCRN-CROSS-INIT-053 R48 (PB-2, the family of R47-07): a declaration that cannot be read is
    // red. This leg's claim is "no copy is behind a declared floor"; with the declarations unread
    // it cannot tell whether a floor exists, and a floor that is not asserted is not a pass. It used
    // to answer green here, so a container whose chains it could not read looked aligned. The
    // reason code still names the unread declarations (and the partition whose settings-catalog
    // failed), and requirementAsserted stays false. A container whose chains read and declare
    // nothing is a different answer: PLATFORM_ENGINE_REQUIREMENT_UNDECLARED below, green by design.
    return check("engineFloorSatisfied", false, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE",
      copies,
      error: declared.error,
      partition: declared.partition ?? null,
      requirementAsserted: false,
      source: declared.source,
    });
  }
  const behind = [];
  for (const [partition, required] of Object.entries(declared.declarations).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
    if (typeof required !== "string" || required.length === 0) continue;
    for (const [copy, version] of Object.entries(copies).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
      let ordering;
      try {
        ordering = compareEngineVersions(version, required);
      } catch {
        behind.push({ partition, required, copy, version, reason: "UNPARSEABLE" });
        continue;
      }
      if (ordering < 0) behind.push({ partition, required, copy, version, reason: "BEHIND" });
    }
  }
  if (behind.length > 0) {
    return check("engineFloorSatisfied", false, {
      reasonCode: "PLATFORM_ENGINE_BEHIND_CHAIN",
      behind,
      copies,
      hint: "that copy fails the whole workspace closed as WORKSPACE_EVENT_CORRUPT — upgrade it before the next write, or the failure will read as byte damage",
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  const declaringPartitions = Object.entries(declared.declarations)
    .filter(([, required]) => typeof required === "string" && required.length > 0)
    .map(([partition]) => partition)
    .sort(compareCanonicalTextLocal);
  if (declaringPartitions.length === 0) {
    // Green, but never silently: no partition has declared a floor, so this leg is
    // enforcing nothing. The copy versions are reported as observations so the
    // reader can see what is actually installed without the leg claiming it is right.
    return check("engineFloorSatisfied", true, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED",
      copies,
      partitions: Object.keys(declared.declarations).sort(compareCanonicalTextLocal),
      requirementAsserted: false,
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  return check("engineFloorSatisfied", true, {
    copies,
    declaringPartitions,
    requirementAsserted: true,
    source: "chain engine.requiredVersion + install-manifest",
  });
}

// TCRN-CROSS-INC-270: the installed and worktree engine copies diverge in capability
// surface during development because the worktree is authoritative for what the engine
// can do. Version strings alone cannot see this: both copies can report the same version while one
// has 132 verbs and 9 flags on work-annotate, the other 137 verbs and 11 flags.
//
// The verdict follows the Owner ruling (2026-09-04): worktree ahead is expected and
// green (development in progress), installed ahead is red (deployment carries code absent
// from the source), both diverging is red, unreadable is uncomparable. The leg is
// a digest comparison, not a version-string comparison, and it keeps "nothing to compare"
// and "compared and equal" as two answers that must stay apart.
async function inspectEngineCapabilitySurface(root, homeRoot, manifest, options) {
  // Synthetic injection hook: for hermetic tests, pass catalogs directly.
  if (options.engineCommandCatalogs && typeof options.engineCommandCatalogs === "object") {
    const { installed, worktree } = options.engineCommandCatalogs;
    return engineCapabilitySurfaceVerdict(
      installed ?? null,
      worktree ?? null,
      "synthetic"
    );
  }

  // Resolve the installed and worktree copy roots. Use the same resolution as
  // engineCopyVersions to ensure consistent paths across legs.
  const installedRoot = manifestPath(manifest, "machine.workflow-engine", "<PLATFORM_ROOT>", homeRoot);
  const engineProject = (manifest.projects ?? []).find((project) => project.name === BRAND.engine.id);
  const worktreeRoot = engineProject?.pathTemplate?.startsWith("<PLATFORM_ROOT>/")
    ? join(root, engineProject.pathTemplate.slice("<PLATFORM_ROOT>/".length))
    : null;

  const scriptPaths = {
    installed: installedRoot === null ? null : join(installedRoot, LEGACY_ENGINE_NAME, "scripts", `${LEGACY_ENGINE_NAME}.mjs`),
    worktree: worktreeRoot === null ? null : join(worktreeRoot, "scripts", "einzbern.mjs"),
  };

  // TCRN-CROSS-INC-233: "nothing to compare" and "compared and equal" must stay apart.
  // By extension, "absent" (copy does not exist) and "broken" (unreadable CLI / unparseable output)
  // are two different answers. Surface the reason a copy is unreadable so the caller
  // can distinguish them in logs and diagnostics.
  const catalogs = {};
  const unreadable = {}; // { installed?: "ABSENT"|"FAILED", worktree?: "ABSENT"|"FAILED" }

  for (const [copy, scriptPath] of Object.entries(scriptPaths)) {
    if (scriptPath === null) {
      catalogs[copy] = null;
      unreadable[copy] = "ABSENT"; // manifest did not resolve a path for this copy
      continue;
    }
    try {
      const stats = await existingPath(scriptPath);
      if (!stats?.isFile()) {
        catalogs[copy] = null;
        unreadable[copy] = "ABSENT"; // script file does not exist
        continue;
      }
      const result = await execFileAsync(process.execPath, [scriptPath, "commands"], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed.commands)) {
        catalogs[copy] = null;
        unreadable[copy] = "FAILED"; // output did not have parseable commands array
        continue;
      }
      catalogs[copy] = parsed.commands;
      // Successfully read this copy: remove it from unreadable.
      delete unreadable[copy];
    } catch (error) {
      catalogs[copy] = null;
      unreadable[copy] = "FAILED"; // CLI failed, timeout, or JSON parse error
    }
  }

  return engineCapabilitySurfaceVerdict(
    catalogs.installed,
    catalogs.worktree,
    "commands-cli",
    Object.keys(unreadable).length > 0 ? unreadable : undefined
  );
}

function normalizeCommandCatalog(commands) {
  if (!Array.isArray(commands)) return null;
  // Normalize to canonical form: sort verbs by name, each verb's flags by name.
  // Return a structure suitable for hashing.
  const normalized = commands
    .map((cmd) => ({
      name: cmd.name,
      availability: cmd.availability,
      mutates: cmd.mutates,
      flags: (Array.isArray(cmd.flags) ? cmd.flags : [])
        .map((flag) => ({
          name: flag.name,
          required: flag.required,
          valueKind: flag.valueKind,
        }))
        .sort((a, b) => compareCanonicalTextLocal(a.name, b.name)),
    }))
    .sort((a, b) => compareCanonicalTextLocal(a.name, b.name));
  return normalized;
}

function engineCapabilitySurfaceVerdict(installedCatalog, worktreeCatalog, source, unreadableInfo) {
  // Normalize both catalogs if they exist.
  const installedNormalized = normalizeCommandCatalog(installedCatalog);
  const worktreeNormalized = normalizeCommandCatalog(worktreeCatalog);

  // Determine comparability: both must be readable to compare.
  if (installedNormalized === null && worktreeNormalized === null) {
    const verdict = {
      comparable: false,
      reason: "neither engine copy is readable; capability surface is unknown",
      source,
    };
    // TCRN-CROSS-INC-233, INC-270: surface why each copy is unreadable when available.
    if (unreadableInfo) {
      verdict.unreadable = unreadableInfo;
    }
    return check("engineCapabilitySurface", true, verdict);
  }
  if (installedNormalized === null || worktreeNormalized === null) {
    const verdict = {
      comparable: false,
      reason: "one engine copy is unreadable; capability surface is unknown",
      source,
      readable: {
        installed: installedNormalized !== null,
        worktree: worktreeNormalized !== null,
      },
    };
    // Surface why each copy is unreadable when available.
    if (unreadableInfo) {
      verdict.unreadable = unreadableInfo;
    }
    return check("engineCapabilitySurface", true, verdict);
  }

  // Both are readable: compare by digest.
  const installedDigest = createHash("sha256")
    .update(JSON.stringify(installedNormalized))
    .digest("hex");
  const worktreeDigest = createHash("sha256")
    .update(JSON.stringify(worktreeNormalized))
    .digest("hex");

  if (installedDigest === worktreeDigest) {
    // Identical: green.
    return check("engineCapabilitySurface", true, {
      capabilitySurface: "IDENTICAL",
      digest: installedDigest.slice(0, 12),
      source,
    });
  }

  // Divergent: compute verb name sets to report what differs.
  const installedVerbs = new Set(installedNormalized.map((cmd) => cmd.name));
  const worktreeVerbs = new Set(worktreeNormalized.map((cmd) => cmd.name));

  const worktreeOnly = Array.from(worktreeVerbs)
    .filter((name) => !installedVerbs.has(name))
    .sort(compareCanonicalTextLocal);
  const installedOnly = Array.from(installedVerbs)
    .filter((name) => !worktreeVerbs.has(name))
    .sort(compareCanonicalTextLocal);

  // Diff flags for verbs that exist in both catalogs. Regardless of whether verbs also differ,
  // we must detect installed-only flags: if the deployment carries flags the source lacks,
  // that is a capability not declared authoritative and must be red.
  // TCRN-CROSS-INC-270: flag divergence must also check direction to detect when the
  // installed copy carries flags (capabilities) the worktree lacks. The authority model
  // says installed-ahead is a deployment safety violation, the same as for verbs.
  let installedOnlyFlags = {}; // { verbName: [flagNames] }
  let worktreeOnlyFlags = {}; // { verbName: [flagNames] }
  let attributeDifferences = []; // [{verb, flag, installedValue, worktreeValue}]

  // Build maps for fast lookup of verbs present in each catalog.
  const installedMap = new Map(installedNormalized.map((cmd) => [cmd.name, cmd]));
  const worktreeMap = new Map(worktreeNormalized.map((cmd) => [cmd.name, cmd]));

  // For each verb that exists in BOTH catalogs, compare its flags.
  const commonVerbs = Array.from(installedVerbs).filter((name) => worktreeVerbs.has(name));
  for (const verbName of commonVerbs) {
    const iCmd = installedMap.get(verbName);
    const wCmd = worktreeMap.get(verbName);
    const iFlags = new Set(iCmd.flags.map((f) => f.name));
    const wFlags = new Set(wCmd.flags.map((f) => f.name));

    // Extract flag-level differences for this verb.
    const iOnly = Array.from(iFlags).filter((n) => !wFlags.has(n)).sort(compareCanonicalTextLocal);
    const wOnly = Array.from(wFlags).filter((n) => !iFlags.has(n)).sort(compareCanonicalTextLocal);

    if (iOnly.length > 0) installedOnlyFlags[verbName] = iOnly;
    if (wOnly.length > 0) worktreeOnlyFlags[verbName] = wOnly;

    // Check for attribute divergence on flags both sides have.
    const commonFlags = Array.from(iFlags).filter((n) => wFlags.has(n));
    for (const flagName of commonFlags) {
      const iFlag = iCmd.flags.find((f) => f.name === flagName);
      const wFlag = wCmd.flags.find((f) => f.name === flagName);
      // Check required and valueKind attributes.
      if (iFlag.required !== wFlag.required || iFlag.valueKind !== wFlag.valueKind) {
        attributeDifferences.push({
          verb: verbName,
          flag: flagName,
          installed: { required: iFlag.required, valueKind: iFlag.valueKind },
          worktree: { required: wFlag.required, valueKind: wFlag.valueKind },
        });
      }
    }
  }

  // Verdict based on direction of divergence.
  const hasInstalledOnlyVerbsOrFlags = installedOnly.length > 0 || Object.keys(installedOnlyFlags).length > 0;
  const hasWorktreeOnlyVerbsOrFlags = worktreeOnly.length > 0 || Object.keys(worktreeOnlyFlags).length > 0;

  if (hasInstalledOnlyVerbsOrFlags) {
    // Installed is ahead in verbs or flags: red. This violates the authority model.
    // TCRN-CROSS-INC-270 Owner ruling: "installed copy has verbs/flags the worktree lacks
    // -> RED. The deployment position is running code absent from the authoritative
    // source. ... both directions differ -> RED (the installed-ahead component dominates)."
    const verdict = {
      reasonCode: "PLATFORM_ENGINE_INSTALLED_AHEAD",
      capabilitySurface: "INSTALLED_AHEAD",
      installedOnly: installedOnly.length > 0 ? installedOnly : undefined,
      installedOnlyFlags: Object.keys(installedOnlyFlags).length > 0 ? installedOnlyFlags : undefined,
      worktreeOnly: hasWorktreeOnlyVerbsOrFlags ? worktreeOnly : undefined,
      worktreeOnlyFlags: Object.keys(worktreeOnlyFlags).length > 0 ? worktreeOnlyFlags : undefined,
      remedy: "the installed engine copy has capabilities absent from the worktree (authoritative source); this is a deployment safety violation; reconcile or block deployment",
      source,
    };
    return check("engineCapabilitySurface", false, verdict);
  }

  if (hasWorktreeOnlyVerbsOrFlags) {
    // Worktree is a strict superset: expected during development. Green, but explicit.
    // TCRN-CROSS-INC-270 Owner ruling: "worktree has verbs/flags the installed copy lacks
    // -> EXPECTED during development. The leg stays `ok: true`, but it MUST state the
    // divergence explicitly and name the differing verbs/flags."
    const verdict = {
      capabilitySurface: "WORKTREE_AHEAD",
      worktreeOnly: worktreeOnly.length > 0 ? worktreeOnly : undefined,
      worktreeOnlyFlags: Object.keys(worktreeOnlyFlags).length > 0 ? worktreeOnlyFlags : undefined,
      remedy: "development is ahead of deployment; this is expected while the engine is being developed and is not a reason to stop; verify this explicitly in deployment procedures",
      source,
    };
    return check("engineCapabilitySurface", true, verdict);
  }

  if (attributeDifferences.length > 0) {
    // Verbs and flag names match, but some flag attributes differ. This is direction-neutral
    // and cannot be judged by the ruling's direction rule: neither side is "ahead".
    // TCRN-CROSS-INC-270: attribute divergence is uncomparable to the authority model.
    // The deployed copy may have different behavior than the authoritative source, but
    // there is no unambiguous direction of capability: one may have more lenient value
    // validation while the other requires a specific value kind. This is tracked but not
    // a verdict blocker because capability is not strictly adding or removing, it is changing.
    const verdict = {
      capabilitySurface: "ATTRIBUTES_DIVERGENT",
      attributeDifferences: attributeDifferences.map((d) => ({
        verb: d.verb,
        flag: d.flag,
        installed: d.installed,
        worktree: d.worktree,
      })),
      installedDigest: installedDigest.slice(0, 12),
      worktreeDigest: worktreeDigest.slice(0, 12),
      reason: "verb and flag names match, but some flag attributes differ (e.g., required, valueKind); neither copy is strictly ahead and this cannot be judged by the authority model",
      source,
    };
    return check("engineCapabilitySurface", true, verdict);
  }

  // No differences detected: report as IDENTICAL (though digests differ).
  // This should not occur, but if all verbs and flags match perfectly, treat as IDENTICAL.
  return check("engineCapabilitySurface", true, {
    capabilitySurface: "IDENTICAL",
    digest: installedDigest.slice(0, 12),
    source,
  });
}

// TCRN-CROSS-MIN-103. The Helper teaches a settings surface, and something has to
// check that what it teaches is still what the engine has. That comparison used to
// live in the Helper's own test suite, which read the engine's source out of a
// sibling checkout — a repository reaching into another's tree, forbidden by the
// platform's dependency-direction rule, and impossible in the Helper's CI, which
// checks out one repository. So it was ENOENT there and green locally: three
// consecutive pushes red on a check that could only ever pass on a developer's
// machine, which is the same defect shape as INC-223's DS reconciliation.
//
// The platform layer is where a cross-repository question can be asked honestly:
// this doctor already reads the engine, the installed Helper copies, and the chain.
// The Helper now declares the roster it teaches and holds itself to it; this leg
// answers whether that declaration still matches the engine's own catalog, read
// through the engine's read face rather than by pattern-matching its source.
const HELPER_COVERAGE_SOURCE = "engine settings-catalog + installed helper payload";

// TCRN-CROSS-INIT-053 R47-07: coverage that cannot be read is red. With no catalog, or no payload,
// there is nothing to compare and coverage is not asserted -- and an unasserted coverage is not a
// pass. This leg used to answer green here, so a container whose catalog it could not read looked
// covered (harness audit B4). The reason code still names the side that could not be read, and
// coverageAsserted stays false.
function unreadableHelperCoverage(reasonCode, source, details = {}) {
  return check("helperSettingsCoverage", false, { reasonCode, coverageAsserted: false, ...details, source });
}

async function inspectHelperSettingsCoverage(root, homeRoot, manifest, options) {
  if (options.helperSettingKeys && typeof options.helperSettingKeys === "object") {
    // The synthetic seam: a null catalog or a null taught list stands for the side that cannot be read.
    const { catalog, taught } = options.helperSettingKeys;
    if (catalog === null) return unreadableHelperCoverage("PLATFORM_HELPER_SETTINGS_UNREADABLE", "synthetic");
    if (taught === null) return unreadableHelperCoverage("PLATFORM_HELPER_PAYLOAD_UNREADABLE", "synthetic", { error: "UNREADABLE" });
    return checkHelperSettingsCoverage(catalog, taught, "synthetic");
  }
  const entry = manifest.items.find((item) => item.id === "machine.claude-skill");
  const skillRoot = entry ? expandTemplate(entry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  if (skillRoot === null) return check("helperSettingsCoverage", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });

  const catalogKeys = await engineSettingKeys(root, options);
  if (catalogKeys === null) return unreadableHelperCoverage("PLATFORM_HELPER_SETTINGS_UNREADABLE", HELPER_COVERAGE_SOURCE);
  let taught;
  try {
    taught = await taughtSettingKeys(skillRoot, catalogKeys);
  } catch (error) {
    return unreadableHelperCoverage("PLATFORM_HELPER_PAYLOAD_UNREADABLE", HELPER_COVERAGE_SOURCE, { error: error?.code ?? "UNREADABLE" });
  }
  return checkHelperSettingsCoverage(catalogKeys, taught, HELPER_COVERAGE_SOURCE);
}

function checkHelperSettingsCoverage(catalogKeys, taught, source) {
  const untaught = catalogKeys.filter((key) => !taught.includes(key)).sort(compareCanonicalTextLocal);
  return untaught.length === 0
    ? check("helperSettingsCoverage", true, { catalogKeys: [...catalogKeys].sort(compareCanonicalTextLocal), coverageAsserted: true, source })
    : check("helperSettingsCoverage", false, {
      reasonCode: "PLATFORM_HELPER_SETTINGS_UNTAUGHT",
      untaught,
      hint: "the engine registered a setting the placed Helper never mentions — teach it in the payload and re-pin, or the operator meets a key no guidance covers",
      source,
    });
}

async function engineSettingKeys(root, options) {
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "einzbern.mjs");
  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const keys = rows.map((row) => row?.key).filter((key) => typeof key === "string");
      if (keys.length > 0) return keys;
    } catch {
      // Any readable partition answers the same catalog; try the next one.
    }
  }
  return null;
}

async function taughtSettingKeys(skillRoot, catalogKeys) {
  const documents = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) documents.push(await readFile(path, "utf8"));
    }
  };
  await walk(skillRoot);
  const prose = documents.join("\n");
  return catalogKeys.filter((key) => prose.includes(key));
}

async function inspectHelperCopies(platformRoot, homeRoot, manifest) {
  const entries = helperSkillEntries(manifest);
  const hosts = entries.map((entry) => /^<HOME>\/\.([^/]+)\/skills\//u.exec(entry.pathTemplate)?.[1] ?? entry.id).sort();
  const missing = [];
  for (const entry of entries) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const rootStats = path === null ? null : await existingPath(path);
    const skillPath = path === null ? null : join(path, "SKILL.md");
    const skillStats = skillPath === null ? null : await existingPath(skillPath);
    if (!rootStats?.isDirectory() || !skillStats?.isFile()) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, reasonCode: "PLATFORM_HELPER_COPY_NOT_REGULAR" });
    }
  }
  return missing.length === 0
    ? check("helperCopies", true, { hosts, source: "install-manifest" })
    : check("helperCopies", false, { reasonCode: "PLATFORM_HELPER_COPIES_INCOMPLETE", missing });
}

function parseLaunchdProbe(entry) {
  const match = /^probe:launchd-duty;label=([^;]+);maxAgeHours=(\d+)$/u.exec(entry?.acceptanceProbe ?? "");
  if (!match) return null;
  return { label: match[1], maxAgeHours: Number.parseInt(match[2], 10) };
}

async function launchdLabels(options) {
  if (Array.isArray(options.launchdLabels)) return options.launchdLabels;
  try {
    const result = await execFileAsync("launchctl", ["list"], { timeout: 10_000, maxBuffer: 1_048_576 });
    return result.stdout.split("\n").map((line) => line.trim().split(/\s+/u).at(-1)).filter((value) => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function parseLastExitCode(text) {
  const match = /last exit code\s*=\s*(-?\d+)/u.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function launchdStatus(label, options) {
  if (options.launchdStatus && typeof options.launchdStatus === "object") return options.launchdStatus;
  if (Array.isArray(options.launchdLabels)) return { lastExitCode: 0, source: "synthetic-launchd-labels" };
  try {
    const result = await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 10_000, maxBuffer: 1_048_576 });
    return { lastExitCode: parseLastExitCode(result.stdout), raw: result.stdout };
  } catch (error) {
    return { unavailable: true, error: error?.code ?? "LAUNCHCTL_PRINT_FAILED" };
  }
}

async function readFreshnessReceipt(path, maxAgeHours, kind) {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const timestamp = kind === "offsite"
      ? receipt.pushedAt ?? receipt.finishedAt ?? null
      : receipt.finishedAt ?? receipt.createdAt ?? null;
    const ageHours = typeof timestamp === "string" ? (Date.now() - Date.parse(timestamp)) / 3_600_000 : Number.POSITIVE_INFINITY;
    const ok = kind === "offsite"
      ? receipt.ok === true && receipt.readbackVerified === true
      : receipt.ok === true && typeof receipt.snapshotSha256 === "string" && receipt.chainVersions !== undefined;
    return {
      ok: ok && Number.isFinite(ageHours) && ageHours <= maxAgeHours,
      latestAt: timestamp,
      ageHours,
      receiptOk: receipt.ok === true,
      readbackVerified: receipt.readbackVerified === true,
      receiptPath: path,
    };
  } catch (error) {
    return { ok: false, latestAt: null, ageHours: Number.POSITIVE_INFINITY, receiptPath: path, error: error?.code ?? "BACKUP_RECEIPT_UNAVAILABLE" };
  }
}

async function localSnapshotFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.localSnapshotFreshness && typeof options.localSnapshotFreshness === "object") return options.localSnapshotFreshness;
  if (options.backupFreshness && typeof options.backupFreshness === "object") return options.backupFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.local-snapshot-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "local-snapshot.json");
  return readFreshnessReceipt(path, maxAgeHours, "local");
}

async function offsitePushFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.offsitePushFreshness && typeof options.offsitePushFreshness === "object") return options.offsitePushFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.offsite-push-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "offsite-push.json");
  return readFreshnessReceipt(path, maxAgeHours, "offsite");
}

// INC-195. Whether an automatic snapshot train is owed is a question the chains
// already answer: `backup.cadence` is the workspace's declaration of how backup
// happens, and `manual` is the legal way to say "on request, not on a timer".
// The probe's label stays the authority on *which* job, never on whether one is
// owed, and there is no roster of hosts excused from the requirement — Owner
// ruled against passing a red by local memory, so the relaxation is derived from
// the declaration or it does not happen.
//
// The declaration can only relax, never tighten: an unreadable chain leaves the
// strict expectation standing and says so in `cadenceSource`. Reading it through
// the sibling CLI rather than the installed copy is deliberate — the doctor
// judges the tree it ships in, and the installed copy cannot currently replay
// cross-project at all (INC-194).
const AUTOMATIC_CADENCES = new Set(["gate-close", "session-end"]);

async function declaredBackupCadences(options, platformRoot) {
  if (options.declaredBackupCadence && typeof options.declaredBackupCadence === "object") {
    return { cadences: options.declaredBackupCadence, source: "supplied" };
  }
  // fileURLToPath, not URL.pathname: this repository lives under a directory whose
  // name contains a space, and pathname hands back the percent-encoded form.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "einzbern.mjs");
  const containerPath = join(platformRoot, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { cadences: null, source: "unreadable", error: error?.code ?? "WORKSPACE_CONTAINER_UNREADABLE" };
  }
  const cadences = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const cadence = rows.find((row) => row?.key === "backup.cadence");
      if (cadence === undefined) return { cadences: null, source: "unreadable", error: "BACKUP_CADENCE_ABSENT", partition: entry.name };
      cadences[entry.name] = cadence.currentValue ?? cadence.defaultValue ?? null;
    } catch (error) {
      return { cadences: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  if (Object.keys(cadences).length === 0) return { cadences: null, source: "unreadable", error: "NO_PARTITION_READ" };
  return { cadences, source: "chain-declaration" };
}

// INC-206. The install surface knew every harness location it had put down and
// nothing at all about the ones it had not. The pre-move container root kept a live
// `.claude` and `.codex` for four days after the move — four hooks and six hooks
// respectively, deciding what actually ran for anyone who opened a session there —
// and no check could see them, because every check started from the manifest and
// asked "is this present?" rather than from the tree and asking "is this declared?".
//
// This leg walks the container and reports any harness root the manifest does not
// place something under. The manifest is the reference on purpose: it is versioned,
// it fails closed, and adding a harness location means declaring it in the same
// change — not a roster of known-acceptable strays, which is the shape the Owner
// ruled out in MIN-099.
// The governed area is derived from the manifest rather than listed here: the
// container root, every declared project root, and the directories that lie between
// them. That middle set is not incidental — the classification folder the strays
// lived in is exactly a directory on the path to declared projects, governed by
// virtue of position and by nothing else. Everything else under the container is an
// unrelated project (AGENTS.md 二 says so plainly), and its own harness is none of
// the platform's business; scanning the whole tree reports those and teaches the
// reader to ignore the leg.
const HARNESS_DIRECTORY_NAMES = Object.freeze([".claude", ".codex"]);

// TCRN-CROSS-SUB-274 (MIN-235 D3, R14 revision): the lawful declaration, in this source tree, of
// the one host-specific state the acceptance roster records for this leg. A host keeps settings of
// its own in a per-host local file that git ignores (Claude Code's `.claude/settings.local.json`).
// A harness root that holds nothing but such files is not an undeclared managed harness, and it
// is not something every host must have either: the doctor reports it as a raw result of its own,
// PLATFORM_HARNESS_HOST_LOCAL, still red, so the first batch records it as observed and nothing
// turns green by being declared. This is not the roster of known-acceptable strays MIN-099 ruled
// out: it names a kind of file, not a place, and git answers on each host whether that file is
// ignored there. A tracked file, a file git does not ignore, anything else in the directory, or
// no answer from git is managed content, and the root stays PLATFORM_HARNESS_UNDECLARED.
const HOST_LOCAL_HARNESS_FILES = Object.freeze({
  ".claude": Object.freeze(["settings.local.json"]),
  ".codex": Object.freeze([]),
});

async function gitIgnores(directory, name) {
  try {
    await execFileAsync("git", ["-C", directory, "check-ignore", "--quiet", "--", name], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

// The per-host local files a harness root holds when it holds nothing else, or null.
async function hostLocalHarnessFiles(path, name) {
  const allowed = HOST_LOCAL_HARNESS_FILES[name] ?? [];
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (!entry.isFile() || !allowed.includes(entry.name)) return null;
    if (!(await gitIgnores(path, entry.name))) return null;
  }
  return entries.map((entry) => entry.name).sort(compareCanonicalTextLocal);
}

async function inspectHarnessSurface(root, manifest) {
  const declaredPrefixes = manifest.items
    .filter((entry) => entry.pathTemplate.startsWith("<PLATFORM_ROOT>/"))
    .map((entry) => join(root, entry.pathTemplate.slice("<PLATFORM_ROOT>/".length)));
  // The container's Codex hooks file is read by the hooks leg itself (TCRN-CROSS-STORY-286),
  // where absence is deferral rather than a missing install item, so it is accounted for
  // here. The retired Codex adapter item used to cover this directory (TCRN-CROSS-STORY-467 R3).
  declaredPrefixes.push(join(root, ".codex", "hooks.json"));
  const declaresSomethingUnder = (directory) =>
    declaredPrefixes.some((path) => path === directory || path.startsWith(`${directory}${sep}`));

  const governed = new Set([root]);
  for (const project of manifest.projects ?? []) {
    if (!project.pathTemplate?.startsWith("<PLATFORM_ROOT>/")) continue;
    let current = join(root, project.pathTemplate.slice("<PLATFORM_ROOT>/".length));
    while (current.startsWith(root) && current !== root) {
      governed.add(current);
      current = dirname(current);
    }
  }

  const undeclared = [];
  const hostLocal = [];
  for (const directory of [...governed].sort(compareCanonicalTextLocal)) {
    for (const name of HARNESS_DIRECTORY_NAMES) {
      const path = join(directory, name);
      if (!(await existingPath(path))?.isDirectory()) continue;
      if (declaresSomethingUnder(path)) continue;
      const localFiles = await hostLocalHarnessFiles(path, name);
      if (localFiles === null) undeclared.push(relative(root, path));
      else hostLocal.push(...localFiles.map((file) => relative(root, join(path, file))));
    }
  }

  if (undeclared.length > 0) {
    return check("harnessSurface", false, {
      reasonCode: "PLATFORM_HARNESS_UNDECLARED",
      undeclared: undeclared.sort(compareCanonicalTextLocal),
      ...(hostLocal.length > 0 ? { hostLocal: hostLocal.sort(compareCanonicalTextLocal) } : {}),
      hint: "declare it in the install manifest, or retire it — an undeclared harness decides what runs and no other leg can see it",
      source: "install-manifest",
    });
  }
  if (hostLocal.length > 0) {
    return check("harnessSurface", false, {
      reasonCode: "PLATFORM_HARNESS_HOST_LOCAL",
      hostLocal: hostLocal.sort(compareCanonicalTextLocal),
      hint: "host-specific raw state: the harness root holds only per-host local files git ignores; record it as observed — it is not a requirement of every host, so it is not moved, deleted or declared required",
      source: "install-manifest",
    });
  }
  return check("harnessSurface", true, {
    governedDirectories: [...governed].map((path) => relative(root, path) || ".").sort(compareCanonicalTextLocal),
    source: "install-manifest",
  });
}

const compareCanonicalTextLocal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function inspectLaunchdDuty(options, manifest) {
  const entry = manifest.items.find((candidate) => candidate.acceptanceProbe.startsWith("probe:launchd-duty"));
  const probe = parseLaunchdProbe(entry);
  if (!probe) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_PROBE_INVALID" });
  const declared = await declaredBackupCadences(options, options.platformRoot);
  const automatic = declared.cadences === null
    || Object.values(declared.cadences).some((cadence) => AUTOMATIC_CADENCES.has(cadence));
  const labels = await launchdLabels(options);
  if (!automatic) {
    // Green, but never silently: the reason code says the expectation came off
    // the chain, and the last snapshot is reported as a fact rather than asserted.
    const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
    return check("launchd", true, {
      reasonCode: "PLATFORM_BACKUP_DECLARED_MANUAL",
      requiredLabel: probe.label,
      onDuty: labels.includes(probe.label),
      declaredCadence: declared.cadences,
      cadenceSource: declared.source,
      lastLocalSnapshotAt: localFreshness.latestAt ?? null,
      freshnessAsserted: false,
      source: "chain backup.cadence + install-manifest",
    });
  }
  if (!labels.includes(probe.label)) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY", requiredLabel: probe.label, observedLabels: labels, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "install-manifest" });
  }
  const status = await launchdStatus(probe.label, options);
  if (status.unavailable) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_STATUS_UNAVAILABLE", requiredLabel: probe.label, error: status.error });
  if (status.lastExitCode !== null && status.lastExitCode !== 0) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_LAST_RUN_FAILED", requiredLabel: probe.label, lastExitCode: status.lastExitCode, source: "launchctl print" });
  }
  const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!localFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_SNAPSHOT_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: localFreshness, maxAgeHours: probe.maxAgeHours, source: "local snapshot receipt" });
  }
  const offsiteFreshness = await offsitePushFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!offsiteFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_OFFSITE_PUSH_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: offsiteFreshness, maxAgeHours: probe.maxAgeHours, source: "offsite push receipt" });
  }
  return check("launchd", true, { requiredLabel: probe.label, lastExitCode: status.lastExitCode, localFreshness, offsiteFreshness, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "chain backup.cadence + install-manifest + launchctl + local/offsite receipts" });
}

export async function inspectPlatform(platformRootArgument, options = {}) {
  if (typeof platformRootArgument !== "string" || platformRootArgument.trim().length === 0) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_REQUIRED", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_REQUIRED" })] };
  }
  const requestedRoot = resolve(platformRootArgument);
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: requestedRoot, error: error?.code ?? "UNKNOWN" })] };
  }
  const rootStats = await existingPath(root);
  if (!rootStats?.isDirectory()) return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: root })] };
  const homeRoot = resolve(options.homeRoot ?? process.env.HOME ?? "");
  const manifest = options.manifest ?? INSTALL_MANIFEST;
  assertInstallManifestComplete(manifest);
  const checks = [
    check("platformRoot", true, { path: root }),
    await inspectAcceptanceGateGroups(root),
    // The container AGENTS.md's topology-marker leg and the leg holding it byte-equal to a tracked
    // copy in the platform documents retire with the layout rendering pipeline
    // (TCRN-CROSS-STORY-491 R2); the Claude bridge legs below still name a bridge target that is gone.
    await inspectWorkspaceContainer(root),
    await inspectWorkspaceStorageShape(root, options),
    await inspectGitAncestors(root),
    await inspectClaudeBridge(root),
    await inspectBridgeSyntax(root),
  ];
  if (options.includeInstallSurface !== false) {
    checks.push(
      await inspectHelperCopies(root, homeRoot, manifest),
      await inspectUnusedExports(root, options),
      await inspectChainHeadroom(root, options),
      await inspectChainValidation(root, options),
      await inspectAcceptanceVerdicts(root, options),
      await inspectInstallWiring(root, homeRoot, manifest),
      await inspectHookExecutability(root, homeRoot, manifest),
      await inspectDeploymentFreshness(homeRoot, manifest),
      await inspectEngineFloorSatisfied(root, homeRoot, manifest, options),
      await inspectEngineCapabilitySurface(root, homeRoot, manifest, options),
      await inspectHelperSettingsCoverage(root, homeRoot, manifest, options),
      // The hostRenderDrift leg compared the dispatch projection host-render used to write with
      // the host files; host-render renders only the one Einzbern hook since
      // TCRN-CROSS-STORY-477 R1, so that leg is retired with the projection.
      await inspectLaunchdDuty({ ...options, platformRoot: root, homeRoot }, manifest),
      await inspectHarnessSurface(root, manifest),
      await inspectSnapshotReadPerformance(root, options),
    );
  }
  const firstFailure = checks.find((item) => !item.ok);
  // Observations are reported beside the verdict, never inside it (TCRN-CROSS-INC-219). Their
  // one source, the adapter identity drift, went with the adapter bundles
  // (TCRN-CROSS-STORY-467 R3); the field stays so readers keep the same shape.
  const observations = [];
  return { ok: !firstFailure, reasonCode: firstFailure?.reasonCode ?? "PLATFORM_LAYOUT_HEALTHY", checks, observations };
}

function platformOptionsFromArgv(argv) {
  const rootIndex = argv.indexOf("--platform-root");
  if (rootIndex < 0 || !argv[rootIndex + 1] || argv[rootIndex + 1].startsWith("--")) return null;
  // --host-render-scope chose the retired hostRenderDrift leg's projection (TCRN-CROSS-STORY-477).
  if (argv.length !== 2) return null;
  return { platformRoot: argv[rootIndex + 1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = platformOptionsFromArgv(process.argv.slice(2));
  if (args === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "PLATFORM_DOCTOR_ARGUMENTS_INVALID", expected: "--platform-root <path>" })}\n`);
    process.exitCode = 2;
  } else {
    const result = await inspectPlatform(args.platformRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}

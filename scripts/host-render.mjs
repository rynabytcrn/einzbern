#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R3, R4, R5: render Einzbern's one hook into a host's own files, in the
// user's home or in a project (packages/core/src/host-hooks.ts). The old harness's hooks, deny
// rules and inert key come out of the same file, and Codex's config.toml keeps its hooks switch on.
// The dispatch projection this script used to write (models and efforts in the host settings and
// agent files) and the CLAUDE.md bridge are gone; CLAUDE.md's import section is the managed
// sections' (TCRN-CROSS-STORY-478).
// TCRN-CROSS-STORY-470 R5: --library <path> renders the writable-roots scope instead
// (packages/core/src/host-writable-roots.ts).
//
//   node scripts/host-render.mjs --host <claude-code|codex> --scope user [--plan-only] [--at <instant>]
//   node scripts/host-render.mjs --host <claude-code|codex> --scope project --root <project> [--plan-only] [--at <instant>]
//   node scripts/host-render.mjs --host <claude-code|codex> --root <project> --library <library> [--plan-only] [--at <instant>]

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { applyWritableRoots, deviceHome, planWritableRoots } from "../dist/build/packages/core/src/index.js";
import { HOST_HOOK_FILE_HOSTS, HOST_HOOK_SCOPES, applyHostHooks, planHostHooks, readHostHooks } from "../dist/build/packages/core/src/host-hooks.js";
import { readAgentsNavigation } from "../dist/build/packages/core/src/machine-settings.js";

// TCRN-CROSS-STORY-548 R1: only the hosts with a hook file are rendered; DSH has none.
export const HOST_RENDER_HOSTS = HOST_HOOK_FILE_HOSTS;
export const HOST_RENDER_SCOPES = HOST_HOOK_SCOPES;
export const HOST_RENDER_WRITABLE_ROOTS_SCOPE = "writable-roots";
const VALUE_FLAGS = Object.freeze(["host", "scope", "root", "library", "at"]);
const SWITCH_FLAGS = Object.freeze(["plan-only"]);

function failure(reasonCode, message, details = {}) {
  throw Object.assign(new Error(message), { reasonCode, ...details });
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !value.isWellFormed()) {
    failure("HOST_RENDER_INPUT_INVALID", `${label} must be non-empty well-formed text`);
  }
  return value;
}

function hostName(host) {
  text(host, "host");
  if (!HOST_RENDER_HOSTS.includes(host)) failure("HOST_RENDER_HOST_UNKNOWN", `host must be one of ${HOST_RENDER_HOSTS.join(", ")}`);
  return host;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

// TCRN-CROSS-STORY-477 R1, R3, R4, R5: the one hook in the host's file at the given scope. The user
// scope renders into the home directory (.claude/settings.json, .codex/hooks.json there), the project
// scope into the project; Codex's config.toml is always the user's. The originals are backed up in
// the device directory first, and rendering again changes nothing.
export async function renderHostHooks({ host, scope, root = undefined, home = homedir(), device = deviceHome(), platform = process.platform, at = undefined, planOnly = false } = {}) {
  hostName(host);
  if (!HOST_RENDER_SCOPES.includes(scope)) failure("HOST_RENDER_SCOPE_INVALID", `scope must be one of ${HOST_RENDER_SCOPES.join(", ")}`);
  if (scope === "project") text(root, "root");
  else if (root !== undefined) failure("HOST_RENDER_SCOPE_CONFLICT", "--root names a project; the user scope renders into the home directory");
  const navigation = scope === "user" ? await readAgentsNavigation(device) : null;
  const expectation = planHostHooks({ host, scope, deviceHome: device, platform, navigation });
  const plan = await readHostHooks(expectation, { root: scope === "user" ? home : root, home });
  const summary = {
    scope,
    host,
    root: plan.root,
    command: expectation.groups.UserPromptSubmit?.[0]?.hooks[0]?.command ?? null,
    removed: { hooks: plan.removedHooks, denyRules: plan.removedDenyRules, keys: plan.removedKeys, trustStates: plan.removedTrustStates },
  };
  if (planOnly) {
    return {
      reasonCode: "HOST_RENDER_PLAN_READY",
      ...summary,
      files: plan.files.map((file) => ({
        path: file.path,
        changed: file.changed,
        beforeSha256: file.before === null ? null : digest(file.before),
        afterSha256: file.after === null ? null : digest(file.after),
      })),
    };
  }
  const applied = await applyHostHooks(plan, { at: text(at, "at") });
  const wrote = applied.reasonCode === "HOST_HOOKS_WRITTEN";
  return {
    reasonCode: wrote ? "HOST_RENDER_COMMITTED" : "HOST_RENDER_ALREADY_CURRENT",
    ...summary,
    wrote,
    backupDir: applied.backupDir,
    files: applied.files.map(({ path, changed }) => ({ path, changed })),
  };
}

// TCRN-CROSS-STORY-470 R5, AC4: the writable-roots scope. When the library sits outside the project
// at `root`, the host's own project settings name it (Claude Code permissions.additionalDirectories
// in .claude/settings.local.json, Codex [sandbox_workspace_write] writable_roots in
// .codex/config.toml), with everything else in the file kept and the original first backed up in
// the device directory; a library inside the project needs nothing (packages/core/src/
// host-writable-roots.ts). An installer runs this per host; workspace-relocate does it itself.
export async function renderWritableRoots({ host, root, library, at, planOnly = false } = {}) {
  hostName(host);
  const plan = await planWritableRoots({ projectRoot: text(root, "root"), libraryPath: text(library, "library"), hosts: [host] });
  const warnings = plan.files.filter((file) => file.trackedByGit).map((file) => ({
    reasonCode: "HOST_WRITABLE_ROOTS_TRACKED_BY_GIT",
    file: file.path,
    message: `${file.path} is tracked by Git and may publish this device's library path if committed`,
  }));
  const summary = {
    scope: HOST_RENDER_WRITABLE_ROOTS_SCOPE,
    host,
    projectRoot: plan.projectRoot,
    libraryPath: plan.libraryPath,
    libraryInsideProject: plan.libraryInsideProject,
    warnings,
  };
  if (planOnly) {
    return {
      reasonCode: "HOST_RENDER_PLAN_READY",
      ...summary,
      files: plan.files.map(({ before, after, ...entry }) => ({ ...entry, beforeSha256: before === null ? null : digest(before), afterSha256: digest(after) })),
    };
  }
  const applied = await applyWritableRoots(plan, { at: text(at, "at") });
  const wrote = applied.reasonCode === "HOST_WRITABLE_ROOTS_WRITTEN";
  return { reasonCode: wrote ? "HOST_RENDER_COMMITTED" : "HOST_RENDER_ALREADY_CURRENT", ...summary, wrote, backupDir: applied.backupDir, files: applied.files };
}

// Every argument is one of the flags above, given once; anything else, the retired dispatch
// projection's --workspace, --settings, --mode, --repo-root, --hooks-only and --backup-dir among
// them, is refused before anything is read or written.
function parseArguments(argv) {
  const values = new Map();
  const switches = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.startsWith("--") ? argument.slice(2) : null;
    if (name !== null && SWITCH_FLAGS.includes(name)) {
      if (switches.has(name)) failure("HOST_RENDER_ARGUMENT_DUPLICATE", `${argument} is given more than once`);
      switches.add(name);
      continue;
    }
    if (name === null || !VALUE_FLAGS.includes(name)) failure("HOST_RENDER_ARGUMENT_UNKNOWN", `${argument} is not a host-render argument`, { argument });
    if (values.has(name)) failure("HOST_RENDER_ARGUMENT_DUPLICATE", `${argument} is given more than once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) failure("HOST_RENDER_ARGUMENT_MISSING", `${argument} needs a value`);
    values.set(name, value);
    index += 1;
  }
  return { values, planOnly: switches.has("plan-only") };
}

async function render(argv) {
  const { values, planOnly } = parseArguments(argv);
  const at = values.get("at") ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  if (values.has("library") || values.get("scope") === HOST_RENDER_WRITABLE_ROOTS_SCOPE) {
    if (values.has("scope") && values.get("scope") !== HOST_RENDER_WRITABLE_ROOTS_SCOPE) {
      failure("HOST_RENDER_SCOPE_CONFLICT", `--library renders the ${HOST_RENDER_WRITABLE_ROOTS_SCOPE} scope only`);
    }
    if (!values.has("host") || !values.has("root") || !values.has("library")) {
      failure("HOST_RENDER_ARGUMENT_MISSING", `--host, --root, and --library are required for the ${HOST_RENDER_WRITABLE_ROOTS_SCOPE} scope`);
    }
    return renderWritableRoots({ host: values.get("host"), root: values.get("root"), library: values.get("library"), at, planOnly });
  }
  if (!values.has("host") || !values.has("scope")) failure("HOST_RENDER_ARGUMENT_MISSING", `--host and --scope (${HOST_RENDER_SCOPES.join(" or ")}) are required`);
  if (values.get("scope") === "project" && !values.has("root")) failure("HOST_RENDER_ARGUMENT_MISSING", "--scope project needs --root <project>");
  return renderHostHooks({ host: values.get("host"), scope: values.get("scope"), root: values.get("root"), at, planOnly });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await render(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "HOST_RENDER_FAILED", error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}

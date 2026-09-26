#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2, R5 (MIN-227 D4, D5, D23): the stable hook launcher. The installer
// places this file as engine/hook.mjs in the device directory, beside engine/einzbern.mjs
// (scripts/einzbern-launcher.mjs), and the one hook a host runs for Einzbern names it
// (packages/core/src/host-hooks.ts):
//
//   node "<device directory>/engine/hook.mjs" user-prompt-submit
//
// Most prompts are typed where no library is, so one question is answered before anything else
// loads: does this device's registry hold the prompt's directory? The launcher reads the registry
// and, at most, one repository's Git configuration; it starts no process (no git: problem list #6)
// and opens no library, and a directory no entry matches ends the hook with exit code 0 and
// nothing written (R2). The match is a fast subset of the engine's resolveLibrary
// (packages/core/src/registry.ts): the nearest registered project the directory lies in, otherwise
// the remote of the Git working tree the directory is in (origin, else the first remote by name),
// in the registry's one spelling (normalizeGitRemote, kept identical). A match reads
// engine/current and imports that version's hook entry (scripts/einzbern-hook.mjs), whose
// runHookEvent confirms the library through resolveLibrary and decides what is printed (D5).
//
// It imports nothing but node: built-ins, so no engine update changes it, and a host file naming it
// stays current across updates and rollbacks. Every failure ends the hook with exit code 0 and one
// line on stderr: a hook never blocks a session. The same file runs on macOS, Linux and Windows
// (R5): paths are the platform's own, and the engine's entry is imported through the file URL
// pathToFileURL builds, never a string joined by hand.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The most the launcher reads from stdin; a larger hook input is refused. */
export const HOOK_STDIN_MAX_BYTES = 1_048_576;
const DEVICE_DIRECTORY = ".einzbern";
const REGISTRY_FILE = "registry.json";
const REGISTRY_SCHEMA_VERSION = "einzbern.registry.v1";
const ENGINE_DIRECTORY = "engine";
const CURRENT_FILE = "current";
const CURRENT_SCHEMA_VERSION = "einzbern.engine-current.v1";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HOOK_ENTRY = Object.freeze(["scripts", "einzbern-hook.mjs"]);

class HookLaunchError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "HookLaunchError";
    this.reasonCode = reasonCode;
  }
}

/** The device directory: EINZBERN_HOME when it is set and non-empty, otherwise .einzbern in the user's home (device-home.ts). */
export function deviceDirectory(env = process.env, home = homedir()) {
  const configured = env.EINZBERN_HOME;
  return typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(home, DEVICE_DIRECTORY);
}

function registryEntry(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value.projectPath === "string" && typeof value.libraryPath === "string" &&
    (value.gitRemote === null || typeof value.gitRemote === "string");
}

/** The entries of the device's registry: none when it has no registry file; HOOK_REGISTRY_INVALID when the file is not one. */
export function registryEntries(device) {
  let text;
  try {
    text = readFileSync(join(device, REGISTRY_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new HookLaunchError("HOOK_REGISTRY_INVALID", `the registry cannot be read (${error?.code ?? "error"})`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HookLaunchError("HOOK_REGISTRY_INVALID", "the registry is not JSON");
  }
  if (value === null || typeof value !== "object" || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.entries) ||
    !value.entries.every(registryEntry)) {
    throw new HookLaunchError("HOOK_REGISTRY_INVALID", `the registry is not an ${REGISTRY_SCHEMA_VERSION} registry`);
  }
  return value.entries;
}

/**
 * One remote in one spelling, so an https and an ssh clone of the same repository compare equal.
 * The same steps as normalizeGitRemote in packages/core/src/registry.ts, which wrote the
 * registry's gitRemote; tests/hook-launcher.test.mjs holds the two to the same answers.
 */
export function normalizeGitRemote(remote) {
  let value = remote.trim();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  value = value.replace(/^[^@/]+@/u, "");
  // scp-like ssh: host:owner/repo
  value = value.replace(/^([^/:]+):(?!\d+\/)/u, "$1/");
  value = value.replace(/^([^/:]+):\d+\//u, "$1/");
  value = value.replace(/\/+$/u, "").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  const slash = value.indexOf("/");
  return slash < 0 ? value.toLowerCase() : `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
}

function within(path, parent) {
  if (path === parent) return true;
  return path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function entryKind(path) {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return null;
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

// A .git file (a linked worktree or a submodule) names the git directory; a linked worktree's git
// directory names, in commondir, the repository directory that holds the shared config.
function linkedConfigPath(workingTree, dotGit) {
  const text = readFileSync(dotGit, "utf8");
  if (!text.startsWith("gitdir: ")) return null;
  const gitDirectory = resolve(workingTree, text.slice("gitdir: ".length).replace(/[\r\n]+$/u, ""));
  let common = gitDirectory;
  try {
    common = resolve(gitDirectory, readFileSync(join(gitDirectory, "commondir"), "utf8").replace(/[\r\n]+$/u, ""));
  } catch {
    // No commondir: the git directory is the repository's own (a submodule, or a plain gitdir file).
  }
  return join(common, "config");
}

/** The config file of the Git repository `directory` is in: the nearest .git above it, a directory or a gitdir file; null outside one. */
export function gitConfigPath(directory) {
  let current = directory;
  for (;;) {
    const dotGit = join(current, ".git");
    const kind = entryKind(dotGit);
    if (kind === "directory") return join(dotGit, "config");
    if (kind === "file") return linkedConfigPath(current, dotGit);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The remotes a Git config file defines, in the order they appear, each with its urls (an empty
 * url clears the ones before it, as git reads it); null when git would refuse the file. The syntax
 * is git-config's: [remote "name"] sections and the older [remote.name], keys in any case, values
 * with quotes, the \" \\ \n \t \b escapes and a backslash continuing the line, and # or ;
 * comments. An include is not followed, and a url.<base>.insteadOf rewrite is not applied.
 */
export function gitConfigRemotes(text) {
  const source = String(text).replace(/^﻿/u, "").replace(/\r\n/gu, "\n");
  const remotes = new Map();
  let position = 0;
  let section = null;
  const blank = (char) => char === " " || char === "\t";
  const skipLine = () => {
    while (position < source.length && source[position] !== "\n") position += 1;
    position += 1;
  };
  const readSection = () => {
    position += 1;
    let name = "";
    while (position < source.length && /[A-Za-z0-9.-]/u.test(source[position])) {
      name += source[position];
      position += 1;
    }
    if (name.length === 0) return null;
    if (source[position] === "]") {
      position += 1;
      const dot = name.indexOf(".");
      return dot < 0 ? { name: name.toLowerCase(), subsection: null } : { name: name.slice(0, dot).toLowerCase(), subsection: name.slice(dot + 1).toLowerCase() };
    }
    if (!blank(source[position])) return null;
    while (blank(source[position])) position += 1;
    if (source[position] !== "\"") return null;
    position += 1;
    let subsection = "";
    for (;;) {
      const char = source[position];
      position += 1;
      if (char === undefined || char === "\n") return null;
      if (char === "\"") break;
      if (char === "\\") {
        const next = source[position];
        position += 1;
        if (next === undefined || next === "\n") return null;
        subsection += next;
      } else {
        subsection += char;
      }
    }
    if (source[position] !== "]") return null;
    position += 1;
    return { name: name.toLowerCase(), subsection };
  };
  const readValue = () => {
    let value = "";
    let quoted = false;
    let comment = false;
    let spaces = 0;
    for (;;) {
      const char = source[position];
      position += 1;
      if (char === undefined || char === "\n") return quoted ? null : value;
      if (comment) continue;
      if (blank(char) && !quoted) {
        if (value.length > 0) spaces += 1;
        continue;
      }
      if (!quoted && (char === "#" || char === ";")) {
        comment = true;
        continue;
      }
      value += " ".repeat(spaces);
      spaces = 0;
      if (char === "\\") {
        const next = source[position];
        position += 1;
        if (next === "\n") continue;
        const escaped = { t: "\t", b: "\b", n: "\n", "\\": "\\", "\"": "\"" }[next];
        if (escaped === undefined) return null;
        value += escaped;
      } else if (char === "\"") {
        quoted = !quoted;
      } else {
        value += char;
      }
    }
  };
  while (position < source.length) {
    const char = source[position];
    if (blank(char) || char === "\n") {
      position += 1;
      continue;
    }
    if (char === "#" || char === ";") {
      skipLine();
      continue;
    }
    if (char === "[") {
      section = readSection();
      if (section === null) return null;
      continue;
    }
    if (!/[A-Za-z]/u.test(char)) return null;
    let key = "";
    while (position < source.length && /[A-Za-z0-9-]/u.test(source[position])) {
      key += source[position];
      position += 1;
    }
    while (blank(source[position])) position += 1;
    let value = null;
    if (source[position] === "=") {
      position += 1;
      value = readValue();
      if (value === null) return null;
    } else if (position >= source.length || source[position] === "\n") {
      position += 1;
    } else {
      return null;
    }
    if (section?.name === "remote" && section.subsection !== null) {
      const urls = remotes.get(section.subsection) ?? [];
      remotes.set(section.subsection, urls);
      if (key.toLowerCase() === "url") {
        // git refuses a url key without a value.
        if (value === null) return null;
        if (value.length === 0) urls.length = 0;
        else urls.push(value);
      }
    }
  }
  return remotes;
}

/**
 * The url `git remote get-url` gives for the working tree `directory` is in: that of origin, else
 * of the first remote by name, and a remote left without a url answers with its name, as git
 * does; null outside a working tree or without a remote.
 */
export function repositoryRemote(directory) {
  const config = gitConfigPath(directory);
  if (config === null) return null;
  let text;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    return null;
  }
  const remotes = gitConfigRemotes(text);
  if (remotes === null || remotes.size === 0) return null;
  const name = remotes.has("origin") ? "origin" : [...remotes.keys()].sort()[0];
  return remotes.get(name)?.[0] ?? name;
}

/**
 * The registry entry for `directory` (a real path): the nearest registered project it lies in,
 * otherwise the entry with its working tree's remote; null when none. Starts no process.
 */
export function matchRegistry(entries, directory) {
  let nearest = null;
  for (const entry of entries) {
    if (within(directory, entry.projectPath) && (nearest === null || entry.projectPath.length > nearest.projectPath.length)) nearest = entry;
  }
  if (nearest !== null) return nearest;
  if (!entries.some((entry) => typeof entry.gitRemote === "string")) return null;
  const remote = repositoryRemote(directory);
  if (remote === null) return null;
  const normalized = normalizeGitRemote(remote);
  return entries.find((entry) => entry.gitRemote === normalized) ?? null;
}

/** The file URL of a version's hook entry under `engineDirectory`, written for `platform` (R5). */
export function hookEntryUrl(engineDirectory, version, platform = process.platform) {
  const paths = platform === "win32" ? win32 : posix;
  return pathToFileURL(paths.join(engineDirectory, version, ...HOOK_ENTRY), { windows: platform === "win32" }).href;
}

function currentVersion(engineDirectory) {
  let current;
  try {
    current = JSON.parse(readFileSync(join(engineDirectory, CURRENT_FILE), "utf8"));
  } catch (error) {
    throw new HookLaunchError("HOOK_ENGINE_CURRENT_INVALID", error?.code === "ENOENT" ? "no engine version is current" : "engine/current cannot be read");
  }
  if (current?.schemaVersion !== CURRENT_SCHEMA_VERSION || typeof current.version !== "string" || !VERSION_PATTERN.test(current.version)) {
    throw new HookLaunchError("HOOK_ENGINE_CURRENT_INVALID", "engine/current does not name an engine version");
  }
  return current.version;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > HOOK_STDIN_MAX_BYTES) throw new HookLaunchError("HOOK_INPUT_TOO_LARGE", `the hook input is larger than ${HOOK_STDIN_MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HookLaunchError("HOOK_INPUT_INVALID", "the hook input is not JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new HookLaunchError("HOOK_INPUT_INVALID", "the hook input is not a JSON object");
  return payload;
}

async function launch(argv, env) {
  const event = argv[0];
  if (typeof event !== "string" || event.length === 0) throw new HookLaunchError("HOOK_EVENT_MISSING", "the hook command names no event");
  const payload = await readInput();
  const device = deviceDirectory(env);
  const entries = registryEntries(device);
  if (entries.length === 0) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 && isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const directory = realpathSync.native(cwd);
  const entry = matchRegistry(entries, directory);
  if (entry === null) return null;
  const engine = join(device, ENGINE_DIRECTORY);
  const hook = await import(hookEntryUrl(engine, currentVersion(engine)));
  if (typeof hook.runHookEvent !== "function") throw new HookLaunchError("HOOK_ENTRY_INVALID", "the current engine's hook entry has no runHookEvent");
  const output = await hook.runHookEvent({ event, payload, libraryPath: entry.libraryPath, cwd: directory });
  return typeof output === "string" && output.length > 0 ? output : null;
}

function report(error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "HOOK_LAUNCH_FAILED";
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 0;
}

function launchedDirectly() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return typeof process.argv[1] === "string" && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  process.on("uncaughtException", report);
  process.on("unhandledRejection", report);
  try {
    const output = await launch(process.argv.slice(2), process.env);
    if (output !== null) process.stdout.write(output);
  } catch (error) {
    report(error);
  }
  process.exitCode = 0;
}

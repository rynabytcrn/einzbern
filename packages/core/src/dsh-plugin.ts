// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-548 R4, AC4: what this device's DSH profiles say about the Mana Orchestrate
// plugin, read and never written. DSH keeps no hook file Einzbern writes (host-hooks.ts,
// HOST_HOOKS_HOST_NOT_FILE_BASED); its plugin runs the stable launcher itself, so what doctor and
// the setup plan can tell is whether each profile carries the plugin, which version, and whether
// the launcher the plugin would run is the one this device directory holds.
//
//   detected      <home>/.dsh/profiles/ is a directory
//   installed     the profile's package.json lists dsh-mana-orchestrate in its dependencies
//   version       <profile>/node_modules/dsh-mana-orchestrate/package.json's version, or null
//   hookPath      <deviceHome>/engine/hook.mjs, deviceHome being the plugin entry's deviceHome in
//                 <profile>/cordis.patch.yml; empty or unreadable is the plugin's default, which is
//                 EINZBERN_HOME or ~/.einzbern
//
// The engine has no YAML reader, so cordis.patch.yml is read line by line, only as far as the
// plugin entry's deviceHome; whatever that reading cannot find is the plugin's default. Causes:
// DSH_PLUGIN_MISSING (a profile without the plugin), DSH_PLUGIN_HOOK_PATH_MISMATCH (the plugin would
// run another launcher than this device directory's) and DSH_PROFILE_UNREADABLE (a profile whose
// package.json cannot be read).

import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { deviceHome as defaultDeviceHome } from "./device-home.js";
import { hookLauncherPath } from "./host-hooks.js";

export const DSH_PLUGIN_PACKAGE = "dsh-mana-orchestrate" as const;
export const DSH_PLUGIN_ENTRY_ID = "mana-orchestrate" as const;
export const DSH_PLUGIN_REASON_CODES = Object.freeze([
  "DSH_PLUGIN_MISSING",
  "DSH_PLUGIN_HOOK_PATH_MISMATCH",
  "DSH_PROFILE_UNREADABLE",
] as const);
export type DshPluginReasonCode = typeof DSH_PLUGIN_REASON_CODES[number];

export interface DshPluginInput {
  // The user's home, which holds .dsh/profiles/.
  readonly home: string;
  // The device directory whose launcher the plugin should run.
  readonly deviceHome: string;
  readonly platform?: NodeJS.Platform;
  // Where EINZBERN_HOME is read for the plugin's default; this process's environment by default.
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface DshProfileInspection {
  readonly name: string;
  readonly installed: boolean;
  readonly version: string | null;
  // The launcher the plugin would run; null when the profile does not carry the plugin.
  readonly hookPath: string | null;
  // null when the profile does not carry the plugin.
  readonly hookPathMatches: boolean | null;
  readonly causes: readonly DshPluginReasonCode[];
}

export interface DshPluginInspection {
  readonly detected: boolean;
  readonly profilesRoot: string;
  readonly profiles: readonly DshProfileInspection[];
  // Every profile's causes, each named once.
  readonly causes: readonly DshPluginReasonCode[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function unquote(value: string): string {
  const trimmed = value.replace(/\s+#.*$/u, "").trim();
  const quoted = /^(["'])(.*)\1$/u.exec(trimmed);
  return quoted === null ? trimmed : quoted[2] ?? "";
}

/**
 * The deviceHome the plugin entry of a cordis.patch.yml names, or "" when it names none or the
 * text cannot be read this far. An entry starts at a list item; it is the plugin's when it has
 * `id: mana-orchestrate` or `name: dsh-mana-orchestrate`.
 */
export function dshPatchDeviceHome(text: string): string {
  const entries: string[][] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*-\s+\S/u.test(line) && /^\s*-\s+(id|name):/u.test(line)) entries.push([]);
    entries.at(-1)?.push(line.replace(/^(\s*)-\s+/u, "$1  "));
  }
  for (const entry of entries) {
    const ours = entry.some((line) => {
      const match = /^\s*(id|name):\s*(.*)$/u.exec(line);
      if (match === null) return false;
      const value = unquote(match[2] ?? "");
      return (match[1] === "id" && value === DSH_PLUGIN_ENTRY_ID) || (match[1] === "name" && value === DSH_PLUGIN_PACKAGE);
    });
    if (!ours) continue;
    for (const line of entry) {
      const match = /^\s*deviceHome:\s*(.*)$/u.exec(line);
      if (match !== null) return unquote(match[1] ?? "");
    }
    return "";
  }
  return "";
}

function pluginDeviceHome(configured: string, input: DshPluginInput): string {
  if (configured.length > 0) {
    if (configured === "~" || configured.startsWith("~/")) return join(input.home, configured.slice(1));
    return isAbsolute(configured) ? configured : resolve(input.home, configured);
  }
  return defaultDeviceHome(input.env ?? process.env, input.home);
}

async function inspectProfile(root: string, name: string, input: DshPluginInput, expected: string): Promise<DshProfileInspection> {
  const directory = join(root, name);
  let manifest: unknown;
  try {
    manifest = await readJson(join(directory, "package.json"));
  } catch {
    return { name, installed: false, version: null, hookPath: null, hookPathMatches: null, causes: ["DSH_PROFILE_UNREADABLE"] };
  }
  const dependencies = isObject(manifest) && isObject(manifest["dependencies"]) ? manifest["dependencies"] : {};
  if (!Object.hasOwn(dependencies, DSH_PLUGIN_PACKAGE)) {
    return { name, installed: false, version: null, hookPath: null, hookPathMatches: null, causes: ["DSH_PLUGIN_MISSING"] };
  }
  let version: string | null = null;
  try {
    const installed = await readJson(join(directory, "node_modules", DSH_PLUGIN_PACKAGE, "package.json"));
    if (isObject(installed) && typeof installed["version"] === "string") version = installed["version"];
  } catch {
    version = null;
  }
  let configured = "";
  try {
    configured = dshPatchDeviceHome(await readFile(join(directory, "cordis.patch.yml"), "utf8"));
  } catch {
    configured = "";
  }
  let hookPath: string | null = null;
  try {
    hookPath = hookLauncherPath(pluginDeviceHome(configured, input), input.platform ?? process.platform);
  } catch {
    hookPath = null;
  }
  const hookPathMatches = hookPath !== null && hookPath === expected;
  return { name, installed: true, version, hookPath, hookPathMatches, causes: hookPathMatches ? [] : ["DSH_PLUGIN_HOOK_PATH_MISMATCH"] };
}

/** Each DSH profile on this device and what it says about the plugin. Reads; writes nothing. */
export async function inspectDshPlugin(input: DshPluginInput): Promise<DshPluginInspection> {
  const profilesRoot = join(input.home, ".dsh", "profiles");
  if (!(await isDirectory(profilesRoot))) return { detected: false, profilesRoot, profiles: [], causes: [] };
  const expected = hookLauncherPath(input.deviceHome, input.platform ?? process.platform);
  const names: string[] = [];
  for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
    // node_modules beside the profiles is DSH's shared install, not a profile.
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    names.push(entry.name);
  }
  names.sort();
  const profiles: DshProfileInspection[] = [];
  for (const name of names) profiles.push(await inspectProfile(profilesRoot, name, input, expected));
  const causes = [...new Set(profiles.flatMap((profile) => profile.causes))];
  return { detected: true, profilesRoot, profiles, causes };
}

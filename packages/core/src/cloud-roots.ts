// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-470 R2, AC5 (MIN-227 D19, D21): whether a library sits in a folder a cloud
// client synchronises. Being cloud-hosted is the user's flag, kept in the device's registry; this
// table only suggests it when a library is registered or created, from the places macOS and
// Windows put their cloud folders. Linux has no convention, so nothing is suggested there. The
// table is data and may grow.
//
// Paths are compared as real paths: a cloud folder is often reached through a symbolic link
// (~/OneDrive, ~/Dropbox), and the registry stores what the link points at.

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { DIRECTORY } from "./names.js";

/** A cloud folder root: `root` itself, or, with `childPrefix`, each child of `root` whose name starts with it. */
export interface CloudRootRule {
  readonly provider: string;
  readonly root: string;
  readonly childPrefix?: string;
}

export interface CloudRootContext {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export interface CloudRootMatch {
  readonly provider: string;
  // The cloud folder the path is in (for a child rule, the child).
  readonly cloudRoot: string;
}

function currentContext(): CloudRootContext {
  return { platform: process.platform, env: process.env, home: homedir() };
}

function pathModule(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** The cloud folder roots of a platform. */
export function cloudRootRules(context: CloudRootContext = currentContext()): readonly CloudRootRule[] {
  const path = pathModule(context.platform);
  if (context.platform === "darwin") {
    return [
      { provider: "cloud-storage", root: path.join(context.home, "Library", "CloudStorage"), childPrefix: "" },
      { provider: "icloud-drive", root: path.join(context.home, "Library", "Mobile Documents", "com~apple~CloudDocs") },
      { provider: "onedrive", root: context.home, childPrefix: "OneDrive" },
      { provider: "dropbox", root: path.join(context.home, "Dropbox") },
    ];
  }
  if (context.platform === "win32") {
    const rules: CloudRootRule[] = [];
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const value = context.env[name];
      if (value !== undefined && value !== "") rules.push({ provider: "onedrive", root: value });
    }
    const profile = context.env.USERPROFILE;
    if (profile !== undefined && profile !== "") {
      rules.push({ provider: "icloud-drive", root: path.join(profile, "iCloudDrive") });
      rules.push({ provider: "dropbox", root: path.join(profile, "Dropbox") });
    }
    return rules;
  }
  return [];
}

/** The cloud folder a real path is in, or null. Windows paths compare without regard to case. */
export function matchCloudRoot(realPath: string, context: CloudRootContext = currentContext()): CloudRootMatch | null {
  const path = pathModule(context.platform);
  const fold = (value: string): string => (context.platform === "win32" ? value.toLowerCase() : value);
  const candidate = path.resolve(realPath);
  for (const rule of cloudRootRules(context)) {
    const root = path.resolve(rule.root);
    const relation = path.relative(fold(root), fold(candidate));
    if (relation.startsWith("..") || path.isAbsolute(relation)) continue;
    if (rule.childPrefix === undefined) return { provider: rule.provider, cloudRoot: root };
    const [child] = relation.split(path.sep);
    if (child === undefined || child === "" || !child.startsWith(fold(rule.childPrefix))) continue;
    const original = path.relative(root, candidate).split(path.sep)[0] ?? child;
    return { provider: rule.provider, cloudRoot: path.join(root, original) };
  }
  return null;
}

/** Whether to suggest the cloud-hosted flag for a library at `realPath`. */
export function suggestCloudHosted(realPath: string, context: CloudRootContext = currentContext()): boolean {
  return matchCloudRoot(realPath, context) !== null;
}

/** @deprecated Legacy per-project helper; current setup uses defaultSharedLibraryPath.
 * Where a project's library goes in a cloud folder by default: <cloud root>/Ether/<project name>. */
export function defaultCloudLibraryPath(cloudRoot: string, projectName: string, platform: string = process.platform): string {
  return pathModule(platform).join(cloudRoot, DIRECTORY.cloudDefaultParent, projectName);
}

// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateMachineSettingsFile } from "./machine-settings.js";
import { deviceHome } from "./device-home.js";

const PORTABLE_PATH_BINDINGS = ["paths.artifacts", "paths.knowledgeArticles"] as const;
export function isPortablePathBinding(value: string): boolean {
  const [name, ...parts] = value.split("/");
  return PORTABLE_PATH_BINDINGS.some(key => name === `binding:${key}`) &&
    parts.every(part => part.length > 0 && part !== "." && part !== ".." && !/[\\\u0000-\u001f\u007f:]/u.test(part));
}
/** Shared declarations carry only the logical name; the existing machine settings own location. */
export function resolvePortablePath(root: string, value: string, home: string = deviceHome()): string {
  if (!value.startsWith("binding:")) return isAbsolute(value) ? resolve(value) : resolve(root, value);
  const [key, ...suffix] = value.slice("binding:".length).split("/");
  if (!isPortablePathBinding(value)) throw Object.assign(new Error("unknown portable path binding"), { reasonCode: "PATH_BINDING_INVALID" });
  let file: unknown;
  try { file = JSON.parse(readFileSync(join(home, "machine-settings.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const path = file === undefined ? undefined : validateMachineSettingsFile(file).values[key!];
  if (typeof path !== "string" || !isAbsolute(path)) throw Object.assign(new Error(`${key} is not configured on this device`), { reasonCode: "PATH_BINDING_UNCONFIGURED", key });
  return resolve(path, ...suffix);
}

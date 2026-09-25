// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-466 AC1 / TCRN-CROSS-SUB-265: a write tripwire, loaded with
// `node --import <this file>`. Every node:fs and node:fs/promises call that could create,
// change or remove something is refused with TRIPWIRE_WRITE_BLOCKED when its target lies
// inside EINZBERN_TRIPWIRE_ROOT. Reads pass. The patched functions are pushed into the ESM
// live bindings, so `import { writeFile } from "node:fs/promises"` is covered too.
//
// It is a proof instrument, not a sandbox: it proves a process run under it wrote nothing
// under the root through the fs module. A descriptor opened for reading elsewhere cannot be
// turned into a write under the root, because opening under the root for writing is itself
// refused.

import fs from "node:fs";
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootSetting = process.env.EINZBERN_TRIPWIRE_ROOT;

function realRoot(value) {
  const absolute = resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function asPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : null;
}

function underRoots(roots, value) {
  const path = asPath(value);
  if (path === null) return false;
  const absolute = resolve(path);
  return roots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`));
}

const WRITE_FLAG_BITS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;

function writesByFlags(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return (flags & WRITE_FLAG_BITS) !== 0;
  return /[wax+]/u.test(String(flags));
}

function blocked(operation, target) {
  const error = new Error(`TRIPWIRE_WRITE_BLOCKED: ${operation} ${String(asPath(target) ?? target)}`);
  error.code = "TRIPWIRE_WRITE_BLOCKED";
  error.reasonCode = "TRIPWIRE_WRITE_BLOCKED";
  return error;
}

// Which argument positions name a target that must not be written.
const PATH_TARGETS = Object.freeze({
  appendFile: [0],
  chmod: [0],
  chown: [0],
  copyFile: [1],
  cp: [1],
  lchmod: [0],
  lchown: [0],
  link: [1],
  lutimes: [0],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  symlink: [1],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  writeFile: [0],
});

export function installTripwire(roots) {
  const guarded = roots.map(realRoot);
  const wrap = (holder, name, positions, label) => {
    const original = holder[name];
    if (typeof original !== "function") return;
    holder[name] = function tripwired(...args) {
      for (const position of positions) {
        if (underRoots(guarded, args[position])) throw blocked(label, args[position]);
      }
      return original.apply(this, args);
    };
  };
  for (const [name, positions] of Object.entries(PATH_TARGETS)) {
    wrap(fs, name, positions, name);
    wrap(fs, `${name}Sync`, positions, `${name}Sync`);
    wrap(fsPromises, name, positions, `promises.${name}`);
  }
  for (const [holder, name, label] of [[fs, "open", "open"], [fs, "openSync", "openSync"], [fsPromises, "open", "promises.open"]]) {
    const original = holder[name];
    holder[name] = function tripwiredOpen(path, flags, ...rest) {
      if (writesByFlags(flags) && underRoots(guarded, path)) throw blocked(label, path);
      return original.call(this, path, flags, ...rest);
    };
  }
  const createWriteStream = fs.createWriteStream;
  fs.createWriteStream = function tripwiredStream(path, ...rest) {
    if (underRoots(guarded, path)) throw blocked("createWriteStream", path);
    return createWriteStream.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  return guarded;
}

if (typeof rootSetting === "string" && rootSetting.length > 0) {
  installTripwire(rootSetting.split(delimiter).filter((entry) => entry.length > 0));
}

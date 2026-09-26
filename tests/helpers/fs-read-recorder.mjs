// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 AC2 / TCRN-CROSS-SUB-312: a read recorder, loaded with
// `node --import <this file>`. Every node:fs and node:fs/promises call that opens, reads, lists or
// stats a path inside EINZBERN_READ_RECORD_ROOT (one or more roots, separated like PATH) is
// appended to EINZBERN_READ_RECORD_FILE as one line, `<call>\t<path>`, before it runs; nothing is
// refused. An empty record shows a process never touched the root, and the same run pointed at a
// process that does read there shows the recorder sees it. The patched functions are pushed into
// the ESM live bindings, so `import { readFile } from "node:fs/promises"` is recorded too. Like
// the write tripwire (fs-write-tripwire.mjs) it is a proof instrument for the fs module, not a
// sandbox.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootSetting = process.env.EINZBERN_READ_RECORD_ROOT;
const recordFile = process.env.EINZBERN_READ_RECORD_FILE;

// The reading calls: in node:fs as a callback and a Sync function, and in node:fs/promises.
const READS = Object.freeze(["open", "readFile", "readdir", "opendir", "stat", "lstat", "access"]);

function asPath(value) {
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : null;
}

function rootsOf(value) {
  const roots = new Set();
  for (const entry of value.split(delimiter).filter((item) => item.length > 0)) {
    const absolute = resolve(entry);
    roots.add(absolute);
    try {
      roots.add(fs.realpathSync(absolute));
    } catch {
      // A root that does not exist yet is recorded by the path it was given.
    }
  }
  return [...roots];
}

export function installReadRecorder(roots, file) {
  const guarded = rootsOf(roots.join(delimiter));
  const append = fs.appendFileSync;
  let recording = false;
  const record = (call, target) => {
    const path = asPath(target);
    if (recording || path === null) return;
    const absolute = resolve(path);
    if (!guarded.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) return;
    recording = true;
    try {
      append(file, `${call}\t${absolute}\n`);
    } finally {
      recording = false;
    }
  };
  const wrap = (holder, name, call) => {
    const original = holder[name];
    if (typeof original !== "function") return;
    holder[name] = function recorded(...args) {
      record(call, args[0]);
      return original.apply(this, args);
    };
  };
  for (const name of READS) {
    wrap(fs, name, name);
    wrap(fs, `${name}Sync`, `${name}Sync`);
    wrap(fsPromises, name, `promises.${name}`);
  }
  wrap(fs, "existsSync", "existsSync");
  wrap(fs, "createReadStream", "createReadStream");
  syncBuiltinESMExports();
  return guarded;
}

if (typeof rootSetting === "string" && rootSetting.length > 0 && typeof recordFile === "string" && recordFile.length > 0) {
  installReadRecorder(rootSetting.split(delimiter), resolve(recordFile));
}

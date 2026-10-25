// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { RUNTIME_CAPACITY } from "../lib/runtime-capacity.mjs";

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export function parseSourceTree(bytes) {
  if (!Buffer.isBuffer(bytes) || !isUtf8(bytes)) throw new Error("Invalid Git tree encoding");
  if (bytes.length && bytes.at(-1) !== 0) throw new Error("Incomplete Git tree");
  const entries = [], seen = new Set();
  for (const record of bytes.toString("utf8").split("\0").slice(0, -1)) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Invalid Git tree entry");
    const [, mode, type, oid, path] = match;
    if (path.startsWith("/") || /[\0\r\n\\]/u.test(path) || path.split("/").some((part) => ["", ".", ".."].includes(part)) || seen.has(path)) throw new Error("Invalid Git source path");
    if (!(type === "blob" && ["100644", "100755", "120000"].includes(mode) || type === "commit" && mode === "160000")) throw new Error("Invalid Git source mode/type");
    seen.add(path);
    entries.push({ mode, type, oid, path });
  }
  return entries;
}

// Body framing is in bytes: newlines, multibyte UTF-8 and NUL inside an object
// cannot become protocol delimiters. Every requested object has exactly one frame.
export function parseBlobBatch(bytes, oids) {
  if (!Buffer.isBuffer(bytes) || oids.some((oid) => !oidPattern.test(oid))) throw new Error("Invalid Git batch input");
  const blobs = new Map();
  let offset = 0;
  for (const oid of oids) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error("Truncated Git batch header");
    const header = bytes.subarray(offset, end);
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/u.exec(header.toString("ascii"));
    if (!match || !header.equals(Buffer.from(match[0], "ascii")) || match[1] !== oid) throw new Error("Unexpected Git batch object");
    const size = Number(match[2]);
    offset = end + 1;
    if (!Number.isSafeInteger(size) || size > bytes.length - offset - 1) throw new Error("Truncated Git batch body");
    const body = bytes.subarray(offset, offset + size);
    offset += size;
    if (bytes[offset++] !== 10) throw new Error("Missing Git batch body delimiter");
    blobs.set(oid, body);
  }
  if (offset !== bytes.length) throw new Error("Unexpected trailing Git batch bytes");
  return blobs;
}

export function readSourceBlobs(root, ref, include = () => true, run = execFileSync) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || /[\0\r\n]/u.test(ref)) throw new Error("Invalid Git source ref");
  // Bound aggregation by the executing runtime, not an arbitrary repository budget.
  const options = { maxBuffer: RUNTIME_CAPACITY.bufferBytes };
  const entries = parseSourceTree(run("git", ["-C", root, "ls-tree", "-r", "-z", ref, "--"], options)).filter((entry) => include(entry.path));
  const oids = [...new Set(entries.filter((entry) => entry.type === "blob").map((entry) => entry.oid))];
  const bytes = run("git", ["-C", root, "cat-file", "--batch"], { ...options, input: oids.map((oid) => `${oid}\n`).join("") });
  const blobs = parseBlobBatch(bytes, oids);
  return entries.map((entry) => ({ ...entry, bytes: entry.type === "blob" ? blobs.get(entry.oid) : null }));
}

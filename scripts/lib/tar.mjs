// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R2 (MIN-227 D23): the one ustar writer and reader of this repository. The
// source archive (scripts/task.mjs archive) and the release archive (scripts/pack-release.mjs) are
// both written here, so the rules that make an archive reproducible live in one place.
//
// The writer is deterministic: the same records give the same bytes on every machine and at every
// time. Entries are ordered by path, compared by UTF-8 bytes (compareCanonicalText); every header
// carries mtime 0, owner and group 0 (named root) and a mode of 0644, or 0755 for a file that
// starts with "#!"; only regular files are written, each path whole in the 100-byte name field;
// and the archive ends in two zero blocks. These are the bytes scripts/lib/p8-workflow-rc.mjs
// rebuilds independently for P8, and tests/pack-release.test.mjs holds the two equal.
//
// The reader takes such an archive back into records. It refuses what the writer never writes and
// an unpacker must not follow: a link, a device, a pax or GNU extension header, a path that is
// absolute or climbs out, a duplicate path, a header whose checksum does not add up, and an
// archive cut short. A directory entry (which other ustar writers add) is accepted and skipped.

import { compareCanonicalText } from "./canonical-order.mjs";

export const TAR_BLOCK_BYTES = 512;
export const TAR_NAME_MAX_BYTES = 100;
// The largest size eleven octal digits hold: 8 GiB less one byte.
const TAR_SIZE_MAX = 0o77777777777;
const TAR_MAGIC = "ustar\0";
const TAR_VERSION = "00";
const TAR_OWNER = "root";
const REGULAR = "0";
const DIRECTORY = "5";

export const TAR_REASON_CODES = Object.freeze([
  "TAR_ARCHIVE_INVALID",
  "TAR_ENTRY_UNSUPPORTED",
  "TAR_PATH_DUPLICATE",
  "TAR_PATH_INVALID",
  "TAR_PATH_TOO_LONG",
  "TAR_RECORD_INVALID",
]);

export class TarError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "TarError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new TarError(reasonCode, message, details);
}

/** The mode a file is archived with: 0755 when it starts with "#!", otherwise 0644. */
export function tarMode(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21 ? 0o755 : 0o644;
}

/**
 * `path` when it is a relative POSIX path that stays inside the archive's root: no leading slash
 * or drive, no backslash or NUL, and no empty, "." or ".." segment; otherwise TAR_PATH_INVALID.
 */
export function tarPath(path) {
  const invalid = typeof path !== "string" || path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..");
  if (invalid) fail("TAR_PATH_INVALID", `${JSON.stringify(String(path))} is not a relative path inside the archive`, { path: String(path) });
  return path;
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeField(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail("TAR_RECORD_INVALID", `${JSON.stringify(value)} does not fit a ${length}-byte header field`);
  bytes.copy(header, offset);
}

function checksum(header) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum;
}

function entryBlocks(record) {
  const size = record.bytes.length;
  const header = Buffer.alloc(TAR_BLOCK_BYTES, 0);
  writeField(header, 0, TAR_NAME_MAX_BYTES, record.path);
  writeField(header, 100, 8, octal(record.mode, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, REGULAR);
  writeField(header, 257, 6, TAR_MAGIC);
  writeField(header, 263, 2, TAR_VERSION);
  writeField(header, 265, 32, TAR_OWNER);
  writeField(header, 297, 32, TAR_OWNER);
  writeField(header, 148, 8, `${checksum(header).toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES, 0);
  return [header, record.bytes, padding];
}

/**
 * A ustar archive of `records`, each {path, bytes, mode?}: `bytes` a Buffer or Uint8Array, `mode`
 * 0o644 or 0o755 (tarMode(bytes) when left out). The same records give the same bytes, in any
 * order they are passed.
 */
export function writeUstar(records) {
  if (records === null || typeof records !== "object" || typeof records[Symbol.iterator] !== "function") {
    fail("TAR_RECORD_INVALID", "the records to archive must be an iterable of {path, bytes, mode}");
  }
  const normalized = [...records].map((record) => {
    if (record === null || typeof record !== "object" || !(record.bytes instanceof Uint8Array)) {
      fail("TAR_RECORD_INVALID", "each record needs a path and its bytes");
    }
    const path = tarPath(record.path);
    if (Buffer.byteLength(path, "utf8") > TAR_NAME_MAX_BYTES) {
      fail("TAR_PATH_TOO_LONG", `${path} is longer than the ${TAR_NAME_MAX_BYTES} bytes of a ustar name`, { path });
    }
    const bytes = Buffer.from(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    if (bytes.length > TAR_SIZE_MAX) fail("TAR_RECORD_INVALID", `${path} is larger than a ustar entry holds`, { path });
    const mode = record.mode ?? tarMode(bytes);
    if (mode !== 0o644 && mode !== 0o755) fail("TAR_RECORD_INVALID", `${path} has mode ${String(mode)}; an entry is 0644 or 0755`, { path });
    return { path, bytes, mode };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].path === normalized[index - 1].path) {
      fail("TAR_PATH_DUPLICATE", `${normalized[index].path} is archived twice`, { path: normalized[index].path });
    }
  }
  return Buffer.concat([...normalized.flatMap(entryBlocks), Buffer.alloc(2 * TAR_BLOCK_BYTES, 0)]);
}

function readText(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function readOctal(block, offset, length, what) {
  const text = readText(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(text)) fail("TAR_ARCHIVE_INVALID", `a header's ${what} is not an octal number`);
  return Number.parseInt(text, 8);
}

function isZero(bytes) {
  return bytes.every((byte) => byte === 0);
}

/**
 * The regular files of the ustar archive `archive` (a Buffer), in archive order, each
 * {path, mode, bytes}; `mode` holds the permission bits of the header.
 */
export function readUstar(archive) {
  if (!(archive instanceof Uint8Array)) fail("TAR_ARCHIVE_INVALID", "the archive must be bytes");
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (bytes.length % TAR_BLOCK_BYTES !== 0) fail("TAR_ARCHIVE_INVALID", `the archive is not a whole number of ${TAR_BLOCK_BYTES}-byte blocks`);
  const files = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    if (offset + TAR_BLOCK_BYTES > bytes.length) fail("TAR_ARCHIVE_INVALID", "the archive ends before its end-of-archive blocks");
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZero(header)) {
      if (!isZero(bytes.subarray(offset))) fail("TAR_ARCHIVE_INVALID", "the archive holds data after its end-of-archive block");
      if (bytes.length - offset < 2 * TAR_BLOCK_BYTES) fail("TAR_ARCHIVE_INVALID", "the archive ends with one zero block instead of two");
      return files;
    }
    if (readOctal(header, 148, 8, "checksum") !== checksum(header)) fail("TAR_ARCHIVE_INVALID", "a header's checksum does not match its bytes");
    if (readText(header, 257, 6) !== TAR_MAGIC.slice(0, 5) || header[262] !== 0) fail("TAR_ARCHIVE_INVALID", "a header is not a ustar header");
    const name = readText(header, 0, TAR_NAME_MAX_BYTES);
    const prefix = readText(header, 345, 155);
    const type = String.fromCharCode(header[156]);
    const size = readOctal(header, 124, 12, "size");
    const start = offset + TAR_BLOCK_BYTES;
    const end = start + size;
    if (end > bytes.length) fail("TAR_ARCHIVE_INVALID", `${name} is cut short`, { path: name });
    offset = start + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const joined = prefix === "" ? name : `${prefix}/${name}`;
    if (type === DIRECTORY) {
      tarPath(joined.endsWith("/") ? joined.slice(0, -1) : joined);
      continue;
    }
    if (type !== REGULAR && type !== "\0") {
      fail("TAR_ENTRY_UNSUPPORTED", `${joined} is an entry of type ${JSON.stringify(type)}; only regular files and directories are read`, { path: joined, type });
    }
    const path = tarPath(joined);
    if (seen.has(path)) fail("TAR_PATH_DUPLICATE", `${path} is in the archive twice`, { path });
    seen.add(path);
    files.push({ path, mode: readOctal(header, 100, 8, "mode") & 0o777, bytes: Buffer.from(bytes.subarray(start, end)) });
  }
}

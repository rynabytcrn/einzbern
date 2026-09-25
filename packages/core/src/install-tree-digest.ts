// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3): release trust is one question -- are the
// installed bytes the bytes that were published? The signature chain, trust root,
// in-toto build statement, transaction log and test-root restriction that used to answer
// larger questions are retired. What remains is a digest over an install tree that the
// publisher states and the installer checks.
//
// The digest walks the tree, sorts files by their POSIX relative path, and records each
// file's path, size and sha256. A text file is hashed with CRLF line endings normalised to
// LF (D21), so a checkout that converted line endings on Windows still matches; a file is
// text when it holds no NUL byte and decodes as UTF-8. Symbolic links and special files
// are refused rather than followed or skipped, so a digest always describes regular
// files only. The tree digest is the sha256 of the canonical JSON of the entry list.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";

export const INSTALL_TREE_DIGEST_VERSION = "einzbern.install-tree-digest.v1" as const;
export const INSTALL_TREE_REASON_CODES = Object.freeze([
  "INSTALL_TREE_DIGEST_INVALID",
  "INSTALL_TREE_DIGEST_MISMATCH",
  "INSTALL_TREE_ENTRY_NOT_REGULAR",
  "INSTALL_TREE_NOT_DIRECTORY",
] as const);
export type InstallTreeReasonCode = typeof INSTALL_TREE_REASON_CODES[number];

export class InstallTreeError extends Error {
  readonly reasonCode: InstallTreeReasonCode;

  constructor(reasonCode: InstallTreeReasonCode, message: string) {
    super(message);
    this.name = "InstallTreeError";
    this.reasonCode = reasonCode;
  }
}

export interface InstallTreeEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface InstallTreeDigest {
  readonly schemaVersion: typeof INSTALL_TREE_DIGEST_VERSION;
  readonly sha256: string;
  readonly files: number;
  readonly entries: readonly InstallTreeEntry[];
}

export interface InstallTreeVerification {
  readonly ok: boolean;
  readonly reasonCode: "INSTALL_TREE_VERIFIED" | "INSTALL_TREE_DIGEST_MISMATCH";
  readonly expected: string;
  readonly actual: string;
  readonly files: number;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The bytes a digest is taken over: text with CRLF read as LF, anything else as is. */
export function normalizedInstallBytes(bytes: Buffer): Buffer {
  if (!isText(bytes)) return bytes;
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

async function collect(root: string, relative: string, entries: InstallTreeEntry[]): Promise<void> {
  const directory = relative === "" ? root : join(root, relative);
  const names = (await readdir(directory)).sort(compareCanonicalText);
  for (const name of names) {
    const path = relative === "" ? name : `${relative}/${name}`;
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    if (stats.isDirectory()) {
      await collect(root, path, entries);
    } else if (stats.isFile()) {
      const bytes = normalizedInstallBytes(await readFile(absolute));
      entries.push({ path, size: bytes.length, sha256: sha256(bytes) });
    } else {
      throw new InstallTreeError("INSTALL_TREE_ENTRY_NOT_REGULAR", `${path} is not a regular file`);
    }
  }
}

/** Digest an install tree: every regular file under `root`, by sorted relative path. */
export async function computeInstallTreeDigest(root: string): Promise<InstallTreeDigest> {
  const stats = await lstat(root).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new InstallTreeError("INSTALL_TREE_NOT_DIRECTORY", "install tree root is not a directory");
  }
  const entries: InstallTreeEntry[] = [];
  await collect(root, "", entries);
  entries.sort((left, right) => compareCanonicalText(left.path, right.path));
  const digest = createHash("sha256")
    .update(canonicalJson({ schemaVersion: INSTALL_TREE_DIGEST_VERSION, entries }), "utf8")
    .digest("hex");
  return Object.freeze({
    schemaVersion: INSTALL_TREE_DIGEST_VERSION,
    sha256: digest,
    files: entries.length,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

/** Compare an install tree with the digest its publisher stated. */
export async function verifyInstallTree(root: string, expectedSha256: string): Promise<InstallTreeVerification> {
  if (typeof expectedSha256 !== "string" || !DIGEST_PATTERN.test(expectedSha256)) {
    throw new InstallTreeError("INSTALL_TREE_DIGEST_INVALID", "the expected digest must be 64 lowercase hexadecimal characters");
  }
  const actual = await computeInstallTreeDigest(root);
  const ok = actual.sha256 === expectedSha256;
  return Object.freeze({
    ok,
    reasonCode: ok ? "INSTALL_TREE_VERIFIED" : "INSTALL_TREE_DIGEST_MISMATCH",
    expected: expectedSha256,
    actual: actual.sha256,
    files: actual.files,
  });
}

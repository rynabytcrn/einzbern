// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R5, AC3 (MIN-227 D21): the one way a manifest or any other small file
// that readers must never see half-written is replaced. The bytes go to a temporary file in
// the same directory, which is flushed and then renamed over the target; a reader sees the
// old file or the new one and nothing in between. A process that dies before the rename
// leaves the old file and a `.tmp-*` sibling, which every reader ignores.
//
// On Windows a rename onto a file another process (an indexer, an antivirus scanner, a sync
// client) holds open fails with EPERM, EACCES or EBUSY for a moment, so those three are
// retried with backoff; anything else, or running out of retries, is reported with a reason
// code after this attempt's temporary file is removed.

import { randomBytes } from "node:crypto";
import { open, rename as renameFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const ATOMIC_TEMPORARY_PREFIX = ".tmp-" as const;
export const ATOMIC_FILE_REASON_CODES = Object.freeze([
  "ATOMIC_WRITE_INTERRUPTED",
  "ATOMIC_WRITE_RENAME_FAILED",
] as const);
export type AtomicFileReasonCode = typeof ATOMIC_FILE_REASON_CODES[number];

export class AtomicFileError extends Error {
  readonly reasonCode: AtomicFileReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: AtomicFileReasonCode, message: string, details: Readonly<Record<string, string>>) {
    super(message);
    this.name = "AtomicFileError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface AtomicWriteOptions {
  // How many times a transient rename failure is retried (default 8).
  readonly retries?: number;
  // The first backoff in milliseconds; it doubles up to 500 (default 10).
  readonly retryDelayMs?: number;
  // Test seams: the rename itself, the wait between attempts, and a simulated process death
  // after the temporary file is complete and before the rename.
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly crashAt?: "after-temporary-write";
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Whether a directory entry is an atomic write's temporary file, which readers skip. */
export function isAtomicTemporaryName(name: string): boolean {
  return name.startsWith(ATOMIC_TEMPORARY_PREFIX);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function syncDirectory(directory: string): Promise<void> {
  // Durability of the rename itself. Opening a directory for sync is not possible on every
  // platform (Windows refuses it); the rename has already happened either way.
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // best effort
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Replace `path` with `bytes` so that no reader ever observes a partial file. */
export async function writeFileAtomic(path: string, bytes: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `${ATOMIC_TEMPORARY_PREFIX}${basename(path)}-${randomBytes(6).toString("hex")}`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  if (options.crashAt === "after-temporary-write") {
    // A simulated death: the temporary file stays behind, exactly as a real one would leave it.
    throw new AtomicFileError("ATOMIC_WRITE_INTERRUPTED", `${path}: interrupted before the rename`, { path, temporary });
  }
  const rename = options.rename ?? renameFile;
  const sleep = options.sleep ?? delay;
  const retries = options.retries ?? 8;
  let wait = options.retryDelayMs ?? 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      break;
    } catch (error) {
      const code = String((error as { code?: string }).code ?? "UNKNOWN");
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= retries) {
        await rm(temporary, { force: true });
        throw new AtomicFileError("ATOMIC_WRITE_RENAME_FAILED", `${path}: rename failed (${code}) after ${attempt + 1} attempt(s)`, {
          path,
          code,
          attempts: String(attempt + 1),
        });
      }
      await sleep(wait);
      wait = Math.min(wait * 2, 500);
    }
  }
  await syncDirectory(directory);
}

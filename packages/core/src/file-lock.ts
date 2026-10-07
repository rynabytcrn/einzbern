// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R1 (MIN-227 D3): writers are serialised by an engine-held file
// lock, not by a caller-supplied expected version. A writer creates the lock file
// exclusively, does its read-build-append under it, and removes it; a second writer
// waits with backoff until the first is done. There is nothing for a caller to pass and
// nothing to retry: the engine reads the latest state inside the lock.
//
// A lock is stale when its holder is provably gone (same host, process not alive) or
// when it is older than staleMs. A stale lock is broken under a short-lived breaker
// file, and only after the breaker holder re-reads the lock and finds the same owner
// it judged stale, so two waiters can never both break and one of them remove the
// other's fresh lock. The mechanism uses exclusive create, read and unlink only; it
// does not depend on permission bits.

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rm, stat } from "node:fs/promises";

export const FILE_LOCK_SCHEMA_VERSION = "einzbern.file-lock.v1" as const;
export const FILE_LOCK_REASON_CODES = Object.freeze([
  "FILE_LOCK_LOST",
  "FILE_LOCK_TIMEOUT",
] as const);
export type FileLockReasonCode = typeof FILE_LOCK_REASON_CODES[number];

export class FileLockError extends Error {
  readonly reasonCode: FileLockReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: FileLockReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "FileLockError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface FileLockOptions {
  // Optional caller wait budget. Omission waits until ownership becomes available.
  readonly timeoutMs?: number;
  // A lock older than this is stale whatever its holder (default 10 min).
  readonly staleMs?: number;
  // Test seams: the clock and the liveness probe.
  readonly now?: () => number;
  readonly processAlive?: (pid: number) => boolean;
}

export interface FileLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

interface LockOwner {
  readonly schemaVersion: typeof FILE_LOCK_SCHEMA_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly hostname: string;
  readonly createdAt: string;
}

const DEFAULT_STALE_MS = 600_000;
const BREAKER_STALE_MS = 10_000;

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function parseOwner(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<LockOwner> | null;
    if (value === null || typeof value !== "object" || value.schemaVersion !== FILE_LOCK_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) || typeof value.token !== "string" || typeof value.hostname !== "string" ||
      typeof value.createdAt !== "string") {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

async function readOwner(path: string): Promise<{ readonly owner: LockOwner | null; readonly ageMs: number; readonly text: string } | null> {
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { owner: parseOwner(text), ageMs: Date.now() - metadata.mtimeMs, text };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

// Break a lock judged stale, under the breaker, only if it still carries the text that
// was judged. Returns whether the stale lock is gone.
async function breakStaleLock(path: string, judgedText: string): Promise<boolean> {
  const breaker = `${path}.breaker`;
  if (!await createExclusive(breaker, `${process.pid}\n`)) {
    const existing = await stat(breaker).catch(() => null);
    if (existing !== null && Date.now() - existing.mtimeMs > BREAKER_STALE_MS) {
      await rm(breaker, { force: true });
    }
    return false;
  }
  try {
    const current = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    });
    if (current === null) return true;
    if (current !== judgedText) return false;
    await rm(path, { force: true });
    return true;
  } finally {
    await rm(breaker, { force: true });
  }
}

/**
 * Take the lock at `lockPath`, waiting with backoff while another holder has it.
 * The returned release removes the lock only if it still carries this holder's token.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLock> {
  const timeoutMs = options.timeoutMs;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const token = randomBytes(16).toString("hex");
  const owner: LockOwner = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token,
    hostname: hostname(),
    createdAt: new Date(now()).toISOString(),
  };
  const content = `${JSON.stringify(owner)}\n`;
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  let wait = 5;
  for (;;) {
    if (await createExclusive(lockPath, content)) {
      let released = false;
      return {
        path: lockPath,
        token,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          const current = await readOwner(lockPath);
          if (current === null || current.owner?.token !== token) {
            throw new FileLockError("FILE_LOCK_LOST", `${lockPath} is no longer held by this writer`, { lockPath });
          }
          await rm(lockPath, { force: true });
        },
      };
    }
    const held = await readOwner(lockPath);
    if (held !== null) {
      const deadHolder = held.owner !== null && held.owner.hostname === hostname() && !processAlive(held.owner.pid);
      if (deadHolder || held.ageMs > staleMs) {
        if (await breakStaleLock(lockPath, held.text)) continue;
      }
    }
    if (deadline !== undefined && now() >= deadline) {
      const holderPid = held?.owner?.pid;
      throw new FileLockError("FILE_LOCK_TIMEOUT", `${lockPath} is held by another writer`, {
        lockPath,
        holderPid: holderPid === undefined ? "unknown" : String(holderPid),
      });
    }
    await delay(wait + Math.floor(Math.random() * wait));
    wait = Math.min(wait * 2, 200);
  }
}

/** Run `operation` while holding the lock at `lockPath`. */
export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lock = await acquireFileLock(lockPath, options);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    // The operation's own failure is what the caller needs; a release problem after it
    // must not replace it.
    await lock.release().catch(() => undefined);
    throw error;
  }
  await lock.release();
  return result;
}

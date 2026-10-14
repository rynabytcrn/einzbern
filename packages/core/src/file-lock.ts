// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R1 (MIN-227 D3): writers are serialised by an engine-held file
// lock, not by a caller-supplied expected version. A writer creates the lock file
// exclusively and removes it when done; a second writer waits with backoff until the
// first is done, and there is nothing for a caller to pass. TCRN-CROSS-STORY-529: a
// library write reads and builds before it takes the lock (appendEvents in workspace.ts);
// under it the write only checks that no stream moved since that read, then appends. One
// that finds a stream moved reads and builds again, and one other writers outran four
// times reads under the lock. What each write holds the lock for: specs/cli-catalog-v1.md.
//
// A lock is reclaimable only when a well-formed owner on this host is provably
// dead. Age is never ownership evidence. Foreign, malformed and unknown owners
// remain untouched. Reclamation takes the same exclusive, token-owned lock on the
// breaker path and rechecks the original owner under it. If a breaker itself was
// abandoned, that same protocol recovers it under its own breaker; a living breaker
// is never displaced. This keeps concurrent reclaimers serialised after a crash,
// without an unguarded age-based unlink of the breaker.

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rm } from "node:fs/promises";

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
  // Deprecated compatibility option: age no longer authorizes ownership removal.
  readonly staleMs?: number;
  // TCRN-CROSS-STORY-529 (TCRN-CROSS-SUB-480): what the holder runs, recorded in the lock file so a
  // waiter that runs out of time can name it. A caller gives "einzbern <verb>", never the verb's
  // arguments, so no path reaches a refusal through it.
  readonly command?: string;
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
  // TCRN-CROSS-SUB-480: optional, so einzbern.file-lock.v1 stays as it is; a reader that predates the
  // field ignores it, as parseOwner ignores every field it does not check.
  readonly command?: string;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH establishes absence. Permission and unknown probe failures do not.
    return (error as { code?: string }).code !== "ESRCH";
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
      !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" || !/^[a-f0-9]{32}$/u.test(value.token) ||
      typeof value.hostname !== "string" || value.hostname.length === 0 ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

async function readOwner(path: string): Promise<{ readonly owner: LockOwner | null; readonly text: string } | null> {
  try {
    const text = await readFile(path, "utf8");
    return { owner: parseOwner(text), text };
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

function isDeadOwner(owner: LockOwner | null, processAlive: (pid: number) => boolean): boolean {
  if (owner === null || owner.hostname !== hostname()) return false;
  try { return processAlive(owner.pid) === false; }
  catch { return false; } // Unknown liveness is never permission to remove an owner.
}

// All breaker paths use the same owner format, exclusion and token-safe release.
// Recursion occurs only for existing provably dead owners, not for ordinary waits.
async function breakStaleLock(path: string, judgedText: string, options: FileLockOptions,
  processAlive: (pid: number) => boolean): Promise<boolean> {
  const breaker = await acquireFileLock(`${path}.breaker`, options);
  try {
    const current = await readOwner(path);
    if (current === null) return true;
    if (current.text !== judgedText || !isDeadOwner(current.owner, processAlive)) return false;
    await rm(path, { force: true });
    return true;
  } finally {
    await breaker.release();
  }
}

/**
 * Take the lock at `lockPath`, waiting with backoff while another holder has it.
 * The returned release removes the lock only if it still carries this holder's token.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLock> {
  const timeoutMs = options.timeoutMs;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const token = randomBytes(16).toString("hex");
  const owner: LockOwner = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token,
    hostname: hostname(),
    createdAt: new Date(now()).toISOString(),
    ...(typeof options.command === "string" && options.command.length > 0 ? { command: options.command } : {}),
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
      if (isDeadOwner(held.owner, processAlive)) {
        // Nested recovery shares the caller's remaining wait budget. Omission still
        // has no deadline, including while another reclaimer owns the breaker.
        const recoveryOptions = { ...options, ...(deadline === undefined ? {} : { timeoutMs: Math.max(0, deadline - now()) }) };
        if (await breakStaleLock(lockPath, held.text, recoveryOptions, processAlive)) continue;
      }
    }
    if (deadline !== undefined && now() >= deadline) {
      // TCRN-CROSS-SUB-480: the holder as its lock file names it -- its process, the command it runs
      // and since when it holds the lock; "unknown" for what an older or unreadable owner leaves out.
      const holderPid = held?.owner?.pid;
      const holderCommand = held?.owner?.command;
      throw new FileLockError("FILE_LOCK_TIMEOUT", `${lockPath} is held by another writer`, {
        lockPath,
        holderPid: holderPid === undefined ? "unknown" : String(holderPid),
        holderCommand: typeof holderCommand === "string" && holderCommand.length > 0 ? holderCommand : "unknown",
        heldSince: held?.owner?.createdAt ?? "unknown",
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

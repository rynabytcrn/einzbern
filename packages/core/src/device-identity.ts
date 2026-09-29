// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-468 R1 (MIN-227 D20): this device's identity. The first time the engine
// needs it, it writes `device.json` in the device directory with a random 32-hex-digit id and
// a display name derived from the host name; from then on the same id is read back. A
// reinstall that loses the device directory gets a new id, and the streams the old id wrote
// stay in every library, readable, under their own directory.
//
// Creation is exclusive: the complete file is linked into place, so two processes that both
// find no device file agree on one id rather than each using its own.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readdir, rm } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";

import { assertCanonicalJson, assertStrictInstant, canonicalJson, isDeviceId } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { deviceFilePath, deviceHome } from "./device-home.js";

export const DEVICE_SCHEMA_VERSION = "einzbern.device.v1" as const;
export const DEVICE_DISPLAY_NAME_MAX_LENGTH = 64;
export const DEVICE_IDENTITY_REASON_CODES = Object.freeze([
  "DEVICE_DISPLAY_NAME_INVALID",
  "DEVICE_FILE_INVALID",
] as const);
export type DeviceIdentityReasonCode = typeof DEVICE_IDENTITY_REASON_CODES[number];

export class DeviceIdentityError extends Error {
  readonly reasonCode: DeviceIdentityReasonCode;

  constructor(reasonCode: DeviceIdentityReasonCode, message: string) {
    super(message);
    this.name = "DeviceIdentityError";
    this.reasonCode = reasonCode;
  }
}

export interface DeviceIdentity {
  readonly schemaVersion: typeof DEVICE_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly displayName: string;
  readonly createdAt: string;
}

const DEVICE_FIELDS = ["createdAt", "deviceId", "displayName", "schemaVersion"];

function fail(reasonCode: DeviceIdentityReasonCode, message: string): never {
  throw new DeviceIdentityError(reasonCode, message);
}

function validDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DEVICE_DISPLAY_NAME_MAX_LENGTH &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** A readable name from a host name: the first label kept, control characters dropped, bounded. */
export function displayNameFromHostname(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/\.local$/iu, "").trim();
  const bounded = cleaned.slice(0, DEVICE_DISPLAY_NAME_MAX_LENGTH).trim();
  return bounded.length > 0 ? bounded : "device";
}

export function validateDeviceIdentity(value: unknown, where = "device.json"): DeviceIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("DEVICE_FILE_INVALID", `${where} is not an object`);
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join("\u0000") !== DEVICE_FIELDS.join("\u0000")) fail("DEVICE_FILE_INVALID", `${where} fields are not exact`);
  if (record.schemaVersion !== DEVICE_SCHEMA_VERSION) fail("DEVICE_FILE_INVALID", `${where} schemaVersion must be ${DEVICE_SCHEMA_VERSION}`);
  if (!isDeviceId(record.deviceId)) fail("DEVICE_FILE_INVALID", `${where} deviceId must be 32 lowercase hex digits`);
  if (!validDisplayName(record.displayName)) fail("DEVICE_FILE_INVALID", `${where} displayName is not a bounded single-line name`);
  try {
    assertStrictInstant(record.createdAt);
  } catch {
    fail("DEVICE_FILE_INVALID", `${where} createdAt must be a strict instant`);
  }
  return Object.freeze({
    schemaVersion: DEVICE_SCHEMA_VERSION,
    deviceId: record.deviceId,
    displayName: record.displayName,
    createdAt: String(record.createdAt),
  });
}

function parseDevice(text: string, where: string): DeviceIdentity {
  let parsed: unknown;
  try {
    parsed = assertCanonicalJson(text);
  } catch {
    fail("DEVICE_FILE_INVALID", `${where} is not canonical JSON`);
  }
  return validateDeviceIdentity(parsed, where);
}

const DEVICE_TEMP_NAME = /^\.tmp-device-[a-f0-9]{12}$/u;
const DEVICE_PUBLISH_WAIT_MS = 1_000;

function sameFile(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hasTemporaryDeviceLink(directory: string, expected: { readonly dev: number; readonly ino: number }): Promise<boolean> {
  const entries = await readdir(directory);
  for (const entry of entries) {
    if (!DEVICE_TEMP_NAME.test(entry)) continue;
    try {
      const candidate = await lstat(join(directory, entry));
      if (candidate.isFile() && sameFile(candidate, expected)) return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  return false;
}

/** The link count of `path` while it is still the observed regular file; null once it is gone or is another file. */
async function observedLinkCount(path: string, observed: { readonly dev: number; readonly ino: number }): Promise<number | null> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, observed)) return null;
  return current.nlink;
}

/**
 * A just-published device file briefly has its staging hard link as a second link: the creator
 * links the staging file into place and only then removes the staging name. That removal can
 * land after this reader's lstat and before its scan for the staging name ends, so a scan that
 * finds none is followed by one more lstat (TCRN-CROSS-INC-395). Removing the staging name is
 * the last step of a publication, so one that finished meanwhile now shows as the same file with
 * one link. A second link still there with no staging name beside it is not a publication and
 * fails closed.
 */
async function waitForDevicePublication(path: string, observed: { readonly dev: number; readonly ino: number }): Promise<boolean> {
  const deadline = Date.now() + DEVICE_PUBLISH_WAIT_MS;
  while (Date.now() < deadline) {
    const links = await observedLinkCount(path, observed);
    if (links === 1) return true;
    if (links !== 2) return false;
    if (!(await hasTemporaryDeviceLink(dirname(path), observed))) return (await observedLinkCount(path, observed)) === 1;
    await delay(5);
  }
  return false;
}

/** This device's identity, or null when the device directory has none yet. A damaged file fails closed. */
export async function readDevice(home: string = deviceHome()): Promise<DeviceIdentity | null> {
  const path = deviceFilePath(home);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
  }
  if (info.nlink !== 1) {
    if (info.nlink !== 2 || !(await waitForDevicePublication(path, info))) {
      fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
    }
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
    }
  }
  let handle;
  let text: string;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
    if (opened.nlink !== 1) {
      if (opened.nlink !== 2 || !(await waitForDevicePublication(path, opened))) {
        fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
      }
      const settled = await handle.stat();
      if (!settled.isFile() || settled.nlink !== 1) fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
    }
    text = await handle.readFile("utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    if ((error as { code?: string }).code === "ELOOP") fail("DEVICE_FILE_INVALID", `${path} must be a single-link regular file`);
    throw error;
  } finally {
    await handle?.close();
  }
  return parseDevice(text, path);
}

function nowInstant(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export interface ReadOrCreateDeviceOptions {
  readonly home?: string;
  // Test seams: the creation time and the host name the display name comes from.
  readonly now?: string;
  readonly hostname?: string;
}

/**
 * This device's identity, created on first use. `created` says whether this call wrote it.
 * A device file that exists but does not validate is an error, never silently replaced: a new
 * id would orphan the streams the old one wrote as if they were another device's.
 */
export async function readOrCreateDevice(options: ReadOrCreateDeviceOptions = {}): Promise<{ readonly device: DeviceIdentity; readonly created: boolean }> {
  const home = options.home ?? deviceHome();
  const existing = await readDevice(home);
  if (existing !== null) return { device: existing, created: false };
  await mkdir(home, { recursive: true });
  const createdAt = options.now ?? nowInstant();
  assertStrictInstant(createdAt);
  const device: DeviceIdentity = Object.freeze({
    schemaVersion: DEVICE_SCHEMA_VERSION,
    deviceId: randomBytes(16).toString("hex"),
    displayName: displayNameFromHostname(options.hostname ?? systemHostname()),
    createdAt,
  });
  const path = deviceFilePath(home);
  const temporary = join(home, `.tmp-device-${randomBytes(6).toString("hex")}`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(canonicalJson(device));
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    await link(temporary, path);
    created = true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") {
      // A file system without hard links: fall back to an exclusive create of the final name.
      try {
        const direct = await open(path, "wx");
        try {
          await direct.writeFile(canonicalJson(device));
          await direct.sync();
          created = true;
        } finally {
          await direct.close();
        }
      } catch (fallback) {
        if ((fallback as { code?: string }).code !== "EEXIST") throw fallback;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  const settled = await readDevice(home);
  if (settled === null) fail("DEVICE_FILE_INVALID", `${path} vanished after it was created`);
  return { device: settled, created: created && settled.deviceId === device.deviceId };
}

/** Rename this device. The id does not change. */
export async function setDeviceDisplayName(displayName: string, home: string = deviceHome()): Promise<DeviceIdentity> {
  if (!validDisplayName(displayName)) {
    fail("DEVICE_DISPLAY_NAME_INVALID", `a display name is 1-${DEVICE_DISPLAY_NAME_MAX_LENGTH} characters on one line without surrounding space`);
  }
  const { device } = await readOrCreateDevice({ home });
  const next: DeviceIdentity = Object.freeze({ ...device, displayName });
  await writeFileAtomic(deviceFilePath(home), canonicalJson(next));
  return next;
}

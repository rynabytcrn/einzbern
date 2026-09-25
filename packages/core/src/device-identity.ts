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
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { join } from "node:path";

import { assertStrictInstant, canonicalJson, isDeviceId } from "../../protocol/src/index.js";
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
    parsed = JSON.parse(text);
  } catch {
    fail("DEVICE_FILE_INVALID", `${where} is not JSON`);
  }
  return validateDeviceIdentity(parsed, where);
}

/** This device's identity, or null when the device directory has none yet. A damaged file fails closed. */
export async function readDevice(home: string = deviceHome()): Promise<DeviceIdentity | null> {
  const path = deviceFilePath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
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

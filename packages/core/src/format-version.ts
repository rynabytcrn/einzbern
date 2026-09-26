// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-471 R1 (MIN-227 D22): which libraries this engine may open. A library's manifest
// names its format and the lowest engine version that may open it; each stream manifest names the
// format its writer wrote. An engine refuses a library whose format is newer than the newest it
// reads (LIBRARY_FORMAT_UNSUPPORTED) or whose minimum engine version is above its own
// (ENGINE_TOO_OLD) before it takes a lock, reads the device cache or writes anything, so an older
// engine meets a newer library with a reason code and never damages it.
//
// Only those two fields are read, and they are read before the rest of a manifest is judged: a
// newer format may change the rest of the manifest, and an older engine must still say "upgrade
// the engine" rather than "the manifest is invalid". A field that is not well formed is left to
// the manifest's own validation.
//
// Engine versions compare by semantic-version precedence without any dependency: major, minor and
// patch as whole numbers of any length; a pre-release below its release; pre-release identifiers
// numerically when both are digits, otherwise in ASCII order, digits below letters; and a list of
// identifiers below a longer one it begins.
//
// This module imports nothing, so every other module may import it.

/** The newest library format this engine reads, and the one it writes. */
export const ENGINE_FORMAT_VERSION = 1 as const;

export const FORMAT_VERSION_REASON_CODES = Object.freeze([
  "ENGINE_TOO_OLD",
  "LIBRARY_FORMAT_UNSUPPORTED",
] as const);
export type FormatVersionReasonCode = typeof FORMAT_VERSION_REASON_CODES[number];

export class FormatVersionError extends Error {
  readonly reasonCode: FormatVersionReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: FormatVersionReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "FormatVersionError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

// The version shape library and stream manifests accept: x.y.z with an optional pre-release.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

export interface EngineVersionParts {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
}

// A whole number as its digits without leading zeros, so numbers of any length compare exactly.
function digits(value: string): string {
  return value.replace(/^0+(?=\d)/u, "");
}

/** The parts of an engine version, or null when the value is not one. */
export function parseEngineVersion(value: unknown): EngineVersionParts | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: digits(match[1] ?? ""),
    minor: digits(match[2] ?? ""),
    patch: digits(match[3] ?? ""),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

export function isEngineVersion(value: unknown): value is string {
  return parseEngineVersion(value) !== null;
}

function compareWholeNumbers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareWholeNumbers(digits(left), digits(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic-version precedence: negative when `left` comes first, zero when equal, positive after. */
export function compareSemver(left: string, right: string): number {
  const a = parseEngineVersion(left);
  const b = parseEngineVersion(right);
  if (a === null || b === null) throw new RangeError(`${a === null ? left : right} is not an engine version`);
  const core = compareWholeNumbers(a.major, b.major) || compareWholeNumbers(a.minor, b.minor) || compareWholeNumbers(a.patch, b.patch);
  if (core !== 0) return Math.sign(core);
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (const [index, identifier] of a.prerelease.entries()) {
    const other = b.prerelease[index];
    if (other === undefined) return 1;
    const order = compareIdentifiers(identifier, other);
    if (order !== 0) return Math.sign(order);
  }
  return a.prerelease.length < b.prerelease.length ? -1 : 0;
}

/** The two fields of a library or stream manifest an engine reads before it opens anything. */
export interface LibraryVersionFields {
  readonly formatVersion?: unknown;
  readonly minEngineVersion?: unknown;
}

export interface EngineSupportOptions {
  // The version of the engine that would open the library.
  readonly engineVersion: string;
  // The newest format that engine reads; this engine's own by default.
  readonly supportedFormat?: number;
  // What the message names: a library root, or a stream.
  readonly where?: string;
  // Facts carried beside the reason code, such as the device of a stream.
  readonly details?: Readonly<Record<string, string>>;
}

/** Why an engine may not open a library with these fields, or null when it may. */
export function librarySupportRefusal(fields: LibraryVersionFields, options: EngineSupportOptions): FormatVersionError | null {
  const supported = options.supportedFormat ?? ENGINE_FORMAT_VERSION;
  const where = options.where ?? "the library";
  const format = fields.formatVersion;
  if (typeof format === "number" && Number.isSafeInteger(format) && format > supported) {
    return new FormatVersionError(
      "LIBRARY_FORMAT_UNSUPPORTED",
      `${where} is in library format ${format}; engine ${options.engineVersion} reads formats up to ${supported}: upgrade the engine to open it`,
      { ...options.details, required: String(format), supported: String(supported) },
    );
  }
  const minimum = fields.minEngineVersion;
  if (isEngineVersion(minimum) && isEngineVersion(options.engineVersion) && compareSemver(minimum, options.engineVersion) > 0) {
    return new FormatVersionError(
      "ENGINE_TOO_OLD",
      `${where} needs engine ${minimum} or later; this engine is ${options.engineVersion}: upgrade the engine to open it`,
      { ...options.details, required: minimum, actual: options.engineVersion },
    );
  }
  return null;
}

/** Refuse, before anything is locked, read from the cache or written, a library this engine may not open. */
export function assertLibrarySupported(fields: LibraryVersionFields, options: EngineSupportOptions): void {
  const refusal = librarySupportRefusal(fields, options);
  if (refusal !== null) throw refusal;
}

export const HEAVY_RUNS_SETTING: "execution.maxConcurrentHeavyRuns";
export const HEAVY_RUNS_DEFAULT: 1;
export const HEAVY_RUNS_MIN: 1;
export const HEAVY_RUNS_MAX: 16;
export const HEAVY_SLOT_VARIABLE: "EINZBERN_HEAVY_SLOT";
export const HEAVY_LOCK_DIRECTORY_VARIABLE: "EINZBERN_HEAVY_LOCK_DIR";
export const HEAVY_RUNS_REASON_CODES: readonly ["HEAVY_SLOT_OPTIONS_INVALID", "HEAVY_SLOT_TIMEOUT", "MACHINE_SETTINGS_FILE_INVALID", "MACHINE_SETTING_VALUE_INVALID"];
export const DEVICE_DIRECTORY: ".einzbern";
export const LOCKS_DIRECTORY: "locks";
export const MACHINE_SETTINGS_FILE: "machine-settings.json";
export const MACHINE_SETTINGS_SCHEMA_VERSION: "tcrn.machine-settings.v1";
export const LOCK_SCHEMA_VERSION: "einzbern.file-lock.v1";

export class HeavyRunsError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(reasonCode: string, message: string, details?: Readonly<Record<string, unknown>>);
}

export interface HeavySlot {
  readonly held: boolean;
  readonly inherited: boolean;
  readonly slot: number | null;
  readonly path: string;
  readonly token: string;
  release(): void;
}

export interface HeavySlotOptions {
  readonly command: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly stderr?: { write(text: string): unknown };
  readonly processAlive?: (pid: number) => boolean;
}

export function deviceDirectory(env?: NodeJS.ProcessEnv, home?: string): string;
export function heavyLockDirectory(env?: NodeJS.ProcessEnv, home?: string): string;
export function heavySlotPath(directory: string, slot: number): string;
export function heavyRunsValue(value: unknown): number;
export function maxConcurrentHeavyRuns(env?: NodeJS.ProcessEnv, home?: string): number;
export function acquireHeavySlot(options: HeavySlotOptions): Promise<HeavySlot>;

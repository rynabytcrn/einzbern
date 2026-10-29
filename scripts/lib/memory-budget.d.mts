// SPDX-License-Identifier: Apache-2.0
export const MEMORY_POLICY_SETTING: "execution.memoryPolicy";
export const MEMORY_LEASE_VARIABLE: "EINZBERN_MEMORY_LEASE";
export const MiB: number;
export class MemoryBudgetError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(reasonCode: string, details?: Readonly<Record<string, unknown>>);
}
export interface MemoryPolicy {
  readonly enabled: boolean;
  readonly profiles?: Readonly<Record<string, { readonly fixedMiB?: number; readonly workerMiB?: number; readonly maxWorkers?: number }>>;
  readonly reserveMiB: number;
  readonly budgetMiB: number;
  readonly fixedMiB: number;
  readonly workerMiB: number;
  readonly maxWorkers: number;
  readonly maxUsedPercent: number;
  readonly maxStallPercent: number;
  readonly sampleMaxAgeMs: number;
}
export interface MemoryLease {
  readonly workers: number;
  readonly bytes: number;
  readonly token: string;
  readonly directory: string;
  refresh(): { workers: number; bytes: number; token: string } | null;
  release(): void;
}
export function parseMemoryPolicy(text: string): MemoryPolicy;
export function readMemoryPolicy(deviceHome: string): MemoryPolicy | null;
export function memoryPhase(env?: NodeJS.ProcessEnv): { workers: number; bytes: number; token: string } | null;
export function memoryTestArguments(args: readonly string[], env?: NodeJS.ProcessEnv): readonly string[];
export function acquireMemoryBudget(options: { deviceHome: string; directory: string; command: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<MemoryLease | null>;
export function memoryWorkerCheck(env?: NodeJS.ProcessEnv): void;

export function acquireMemoryChild(command: string, env?: NodeJS.ProcessEnv): Promise<MemoryLease | null>;

export function memoryGateCommand(command: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): readonly string[];

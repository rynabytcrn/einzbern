// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export interface RecallObservation {
  readonly correlationId: string;
  readonly elapsedMs: number;
  readonly cpuMicros: number;
  readonly logicalEventBytes: number;
  readonly segmentReads: number;
  readonly materializations: number;
  readonly recallCalls: number;
  readonly cacheReasons: readonly string[];
  readonly stages: readonly { name: string; startMs: number; endMs: number }[];
  readonly checkpoint: string | null;
}
interface Counters { logicalEventBytes: number; segmentReads: number; materializations: number; recallCalls: number; cacheReasons: string[]; stages: { name: string; startMs: number; endMs: number }[]; checkpoint: string | null }
const active = new AsyncLocalStorage<Counters>();
export function observeEventRead(bytes: number): void {
  const counters = active.getStore();
  if (counters !== undefined) { counters.logicalEventBytes += bytes; counters.segmentReads += 1; }
}
export function observeMaterialization(): void { const counters = active.getStore(); if (counters !== undefined) counters.materializations += 1; }
export function observeRecall(reason: string): void {
  const counters = active.getStore();
  if (counters !== undefined) { counters.recallCalls += 1; counters.cacheReasons.push(reason); }
}
/** Opt-in request-local counters. Logical bytes are not OS I/O, network bytes or token cost. */
export async function withRecallObservation<T>(operation: () => Promise<T>, completed?: (observation: RecallObservation) => void): Promise<{ value: T; observation: RecallObservation }> {
  const counters: Counters = { logicalEventBytes: 0, segmentReads: 0, materializations: 0, recallCalls: 0, cacheReasons: [], stages: [], checkpoint: null };
  const correlationId = randomUUID();
  const started = performance.now();
  const cpu = process.cpuUsage();
  const finish = (): RecallObservation => {
    const used = process.cpuUsage(cpu);
    const observation = { correlationId, elapsedMs: performance.now() - started, cpuMicros: used.user + used.system, ...counters };
    completed?.(observation);
    return observation;
  };
  try {
    const value = await active.run(counters, operation);
    return { value, observation: finish() };
  } catch (error) {
    finish();
    throw error;
  }
}

export function observeCacheReason(reason: string): void {
  const counters = active.getStore();
  if (counters !== undefined) counters.cacheReasons.push(reason);
}

export function observeCheckpoint(checkpoint: string | null): void { const counters = active.getStore(); if (counters !== undefined) counters.checkpoint = checkpoint; }
export async function observeStage<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const counters = active.getStore();
  if (counters === undefined) return operation();
  const startMs = performance.now();
  try { return await operation(); } finally { counters.stages.push({ name, startMs, endMs: performance.now() }); }
}

// SPDX-License-Identifier: Apache-2.0
import type { AsyncLocalStorage } from "node:async_hooks";

export interface RecallObservation {
  readonly correlationId: string;
  readonly elapsedMs: number;
  /** CPU values are process deltas. Awaited spans can overlap other requests;
   * they are attributable to these boundaries only in serial measurements. */
  readonly cpuScope: "process-wide-delta";
  readonly cpuMicros: number;
  readonly logicalEventBytes: number;
  readonly segmentReads: number;
  readonly eventReadsBySource: readonly { readonly scope: "live" | "archive"; readonly streamId: string | null; readonly bytes: number; readonly segments: number }[];
  readonly metadataReadBytes: number;
  readonly cacheReadBytes: number;
  readonly cacheWriteBytes: number;
  readonly metadataCpuMicros: number;
  readonly metadataElapsedMs: number;
  readonly segmentHashCpuMicros: number;
  readonly segmentHashElapsedMs: number;
  readonly cacheHashCpuMicros: number;
  readonly cacheHashElapsedMs: number;
  readonly eventValidationCpuMicros: number;
  readonly eventValidationElapsedMs: number;
  readonly materializations: number;
  readonly recallCalls: number;
  readonly replayedEvents: number;
  readonly replayCpuMicros: number;
  readonly replayElapsedMs: number;
  readonly cacheReasons: readonly string[];
  readonly stages: readonly { name: string; startMs: number; endMs: number; cpuMicros: number }[];
  readonly checkpoint: string | null;
}
interface Counters {
  logicalEventBytes: number;
  segmentReads: number;
  eventReadsBySource: { scope: "live" | "archive"; streamId: string | null; bytes: number; segments: number }[];
  metadataReadBytes: number;
  cacheReadBytes: number;
  cacheWriteBytes: number;
  metadataCpuMicros: number;
  metadataElapsedMs: number;
  segmentHashCpuMicros: number;
  segmentHashElapsedMs: number;
  cacheHashCpuMicros: number;
  cacheHashElapsedMs: number;
  eventValidationCpuMicros: number;
  eventValidationElapsedMs: number;
  materializations: number;
  recallCalls: number;
  replayedEvents: number;
  replayCpuMicros: number;
  replayElapsedMs: number;
  cacheReasons: string[];
  stages: { name: string; startMs: number; endMs: number; cpuMicros: number }[];
  checkpoint: string | null;
}
let active: AsyncLocalStorage<Counters> | undefined;
export function observeEventRead(bytes: number, streamId: string | null = null, scope: "live" | "archive" = "live"): void {
  const counters = active?.getStore();
  if (counters === undefined) return;
  counters.logicalEventBytes += bytes;
  counters.segmentReads += 1;
  let source = counters.eventReadsBySource.find(entry => entry.streamId === streamId && entry.scope === scope);
  if (source === undefined) {
    source = { scope, streamId, bytes: 0, segments: 0 };
    counters.eventReadsBySource.push(source);
  }
  source.bytes += bytes;
  source.segments += 1;
}
export function observeMetadataBytes(bytes: number): void { const counters = active?.getStore(); if (counters !== undefined) counters.metadataReadBytes += bytes; }
export function observeCacheRead(bytes: number): void { const counters = active?.getStore(); if (counters !== undefined) counters.cacheReadBytes += bytes; }
export function observeCacheWrite(bytes: number): void { const counters = active?.getStore(); if (counters !== undefined) counters.cacheWriteBytes += bytes; }
export function observeMaterialization(): void { const counters = active?.getStore(); if (counters !== undefined) counters.materializations += 1; }
export function observeRecall(reason: string): void {
  const counters = active?.getStore();
  if (counters !== undefined) { counters.recallCalls += 1; counters.cacheReasons.push(reason); }
}
/** Opt-in request-local counters. Logical bytes are not OS I/O, network bytes or token cost. */
export async function withRecallObservation<T>(operation: () => Promise<T>, completed?: (observation: RecallObservation) => void): Promise<{ value: T; observation: RecallObservation }> {
  const counters: Counters = {
    logicalEventBytes: 0, segmentReads: 0, eventReadsBySource: [], metadataReadBytes: 0,
    cacheReadBytes: 0, cacheWriteBytes: 0, metadataCpuMicros: 0, metadataElapsedMs: 0,
    segmentHashCpuMicros: 0, segmentHashElapsedMs: 0, cacheHashCpuMicros: 0, cacheHashElapsedMs: 0,
    eventValidationCpuMicros: 0, eventValidationElapsedMs: 0,
    materializations: 0, recallCalls: 0, replayedEvents: 0, replayCpuMicros: 0, replayElapsedMs: 0,
    cacheReasons: [], stages: [], checkpoint: null,
  };
  const { AsyncLocalStorage } = await import("node:async_hooks");
  active ??= new AsyncLocalStorage<Counters>();
  const correlationId = crypto.randomUUID();
  const started = performance.now();
  const cpu = process.cpuUsage();
  const finish = (): RecallObservation => {
    const used = process.cpuUsage(cpu);
    const observation = { correlationId, elapsedMs: performance.now() - started, cpuScope: "process-wide-delta" as const, cpuMicros: used.user + used.system, ...counters };
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
  const counters = active?.getStore();
  if (counters !== undefined) counters.cacheReasons.push(reason);
}

export function observeCheckpoint(checkpoint: string | null): void { const counters = active?.getStore(); if (counters !== undefined) counters.checkpoint = checkpoint; }
export async function observeStage<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const counters = active?.getStore();
  if (counters === undefined) return operation();
  const startMs = performance.now();
  const cpu = process.cpuUsage();
  try { return await operation(); } finally { const used = process.cpuUsage(cpu); counters.stages.push({ name, startMs, endMs: performance.now(), cpuMicros: used.user + used.system }); }
}

type AuthorityWork = "metadata" | "segmentHash" | "cacheHash" | "eventValidation";

function recordAuthorityWork(counters: Counters, kind: AuthorityWork, started: number, cpu: NodeJS.CpuUsage): void {
  const used = process.cpuUsage(cpu);
  counters[`${kind}CpuMicros`] += used.user + used.system;
  counters[`${kind}ElapsedMs`] += performance.now() - started;
}

/** These component spans measure metadata, validation and cache work.
 * Synchronous hash/parse spans do not overlap one another; awaited metadata CPU is meaningful in serial probes
 * and may include other requests' work when they overlap in this process.
 * None of these values is additive with the enclosing stage's CPU or elapsed. */
export function observeAuthorityWork<T>(kind: AuthorityWork, operation: () => T): T {
  const counters = active?.getStore();
  if (counters === undefined) return operation();
  const started = performance.now(), cpu = process.cpuUsage();
  try { return operation(); } finally { recordAuthorityWork(counters, kind, started, cpu); }
}

export async function observeMetadataRead<T>(operation: () => Promise<T>): Promise<T> {
  const counters = active?.getStore();
  if (counters === undefined) return operation();
  const started = performance.now(), cpu = process.cpuUsage();
  try { return await operation(); } finally { recordAuthorityWork(counters, "metadata", started, cpu); }
}

/** Reducer invocations are synchronous and disjoint, so their CPU is counted once.
 * The surrounding replay stage also includes checkpoint I/O and consolidation. */
export function observeReplay<T>(events: number, operation: () => T): T {
  const counters = active?.getStore();
  if (counters === undefined) return operation();
  counters.replayedEvents += events;
  const started = performance.now();
  const cpu = process.cpuUsage();
  try {
    return operation();
  } finally {
    const used = process.cpuUsage(cpu);
    counters.replayCpuMicros += used.user + used.system;
    counters.replayElapsedMs += performance.now() - started;
  }
}

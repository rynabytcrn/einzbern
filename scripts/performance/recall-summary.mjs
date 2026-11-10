// SPDX-License-Identifier: Apache-2.0
/** Fractional timestamps use Date.parse; intervals are half-open. Repeated results
 * count as logs, not additional events/recalls/resources. Nested spans use union. */
export function summarizeRecall(records, { from = -Infinity, to = Infinity } = {}) {
  const boundary = value => typeof value === "number" ? value : Date.parse(value);
  const start = boundary(from), end = boundary(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error("Invalid observation window");
  const selected = records.filter(record => { const at = Date.parse(record.at); return at >= start && at < end; });
  const events = new Map();
  for (const record of selected) {
    const observation = record.observation;
    if (observation?.correlationId && !events.has(observation.correlationId)) events.set(observation.correlationId, observation);
  }
  const observations = [...events.values()];
  const reasonCounts = {};
  const outcomeCounts = {};
  const eventOutcomes = new Map();
  for (const record of selected) {
    const reason = record.reasonCode ?? "unknown";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    const outcome = record.outcome ?? "unknown";
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    if (record.observation?.correlationId) eventOutcomes.set(record.observation.correlationId, outcome);
  }
  const eventOutcomeCounts = {};
  for (const outcome of eventOutcomes.values()) eventOutcomeCounts[outcome] = (eventOutcomeCounts[outcome] ?? 0) + 1;
  const spanUnion = spans => {
    const sorted = spans.map(span => [span.startMs, span.endMs]).sort((a, b) => a[0] - b[0]);
    let total = 0, end = -Infinity;
    for (const [start, stop] of sorted) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
    return total;
  };
  return { reasonCounts, outcomeCounts, eventOutcomeCounts, eventCount: events.size, recallCount: observations.reduce((n, o) => n + o.recallCalls, 0), resultLogCount: selected.length,
    logicalEventBytes: observations.reduce((n, o) => n + o.logicalEventBytes, 0),
    cpuMicros: observations.reduce((n, o) => n + o.cpuMicros, 0),
    elapsedMs: observations.reduce((n, o) => n + o.elapsedMs, 0),
    stageUnionMs: observations.reduce((n, o) => n + spanUnion(o.stages), 0),
    uncorrelatedLogCount: selected.filter(r => !r.observation?.correlationId).length,
    osIoBytes: null, networkBytes: null, tokens: null, cost: null };
}

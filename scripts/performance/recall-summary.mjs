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

/** Resource samples are grouped by input, never pooled across small/large corpora
 * or queries. Failures remain in the report and prevent a passing comparison. */
export function summarizePairedSamples(records) {
  const quantiles = values => {
    if (values.length === 0 || values.some(value => !Number.isFinite(value))) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
  };
  const metrics = {
    lifecycleElapsedMs: row => row.lifecycleElapsedMs,
    operationElapsedMs: row => row.sample.operationElapsedMs,
    operationCpuMicros: row => row.sample.operationCpuMicros,
    processCpuMicros: row => row.sample.processCpuMicros,
    osCpuSeconds: row => row.osUserSeconds === null || row.osSystemSeconds === null ? null : row.osUserSeconds + row.osSystemSeconds,
    maxRssKiB: row => row.sample.maxRss,
    osMaxRssBytes: row => row.osMaxRssBytes,
    logicalEventBytes: row => row.sample.logicalEventBytes,
    segmentReads: row => row.sample.segmentReads,
    materializations: row => row.sample.materializations,
  };
  const failures = records.filter(row => row.exit !== 0 || row.parseError !== null || row.sample === undefined);
  const cases = [...new Set(records.map(row => row.queryIndex))].map(queryIndex => {
    const selected = records.filter(row => row.queryIndex === queryIndex);
    const successful = selected.filter(row => !failures.includes(row));
    const groups = Object.fromEntries(["baseline", "candidate", "candidate-observed"].map(mode => {
      const rows = successful.filter(row => row.mode === mode);
      return [mode, { n: rows.length, logSummary: summarizeRecall(rows.flatMap(row => row.resultLogs ?? [])),
        ...Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, quantiles(rows.map(value))])) }];
    }));
    const matchingPairs = [...new Set(selected.map(row => row.pair))].every(pair => {
      const rows = successful.filter(row => row.pair === pair);
      return rows.length === 3 && new Set(rows.map(row => row.mode)).size === 3
        && rows.every(row => typeof row.sample.authorityHead === "string")
        && new Set(rows.map(row => row.sample.query)).size === 1
        && new Set(rows.map(row => row.sample.at)).size === 1
        && new Set(rows.map(row => row.sample.semanticSha256)).size === 1
        && new Set(rows.map(row => row.sample.authorityHead)).size === 1;
    });
    const complete = selected.length === 45 && Object.values(groups).every(group => group.n === 15) && matchingPairs;
    const noRegression = name => {
      const baseline = groups.baseline[name], candidate = groups.candidate[name];
      return !complete || baseline === null || candidate === null ? null
        : candidate.p50 <= baseline.p50 && candidate.p95 <= baseline.p95;
    };
    const baselineBytes = groups.baseline.logicalEventBytes, candidateBytes = groups.candidate.logicalEventBytes;
    return {
      queryIndex, query: successful[0]?.sample.query ?? null, complete, matchingPairs, groups,
      failures: selected.filter(row => failures.includes(row)).map(row => ({ pair: row.pair, mode: row.mode, exit: row.exit, parseError: row.parseError })),
      logicalBytesRatio: baselineBytes === null || candidateBytes === null || baselineBytes.p50 === 0 ? null : candidateBytes.p50 / baselineBytes.p50,
      thresholds: {
        logicalBytesAtMost55Percent: !complete || baselineBytes === null || candidateBytes === null ? null : candidateBytes.p95 <= baselineBytes.p95 * 0.55,
        ...Object.fromEntries(["lifecycleElapsedMs", "operationElapsedMs", "operationCpuMicros", "processCpuMicros", "osCpuSeconds", "maxRssKiB", "osMaxRssBytes"].map(name => [name, noRegression(name)])),
      },
    };
  });
  return { percentileMethod: "nearest rank: sorted[ceil(p*n)-1], p=0.50/0.95", samples: records.length, failedSamples: failures.length, cases,
    observerComparison: "candidate-observed is the same input in a fresh process; negative differences do not establish negative observation overhead",
    osIoBytes: null, networkBytes: null, tokens: null, cost: null };
}

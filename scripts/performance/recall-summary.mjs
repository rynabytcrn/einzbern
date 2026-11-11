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
export function summarizePairedSamples(records, { groups: expectedGroups = 15, startPair = 0, queryIndexes } = {}) {
  if (!Number.isSafeInteger(expectedGroups) || expectedGroups < 1 || !Number.isSafeInteger(startPair) || startPair < 0
    || !Number.isSafeInteger(startPair + expectedGroups)) throw new Error("Invalid expected pair range");
  if (queryIndexes !== undefined && (!Array.isArray(queryIndexes) || queryIndexes.length === 0
    || new Set(queryIndexes).size !== queryIndexes.length || queryIndexes.some(index => !Number.isSafeInteger(index) || index < 0))) {
    throw new Error("Invalid expected query indexes");
  }
  const modes = ["baseline", "candidate", "candidate-observed"];
  const expectedPairIds = Array.from({ length: expectedGroups }, (_, index) => startPair + index);
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
  const failures = records.filter(row => row.exit !== 0 || row.parseError !== null || row.sample === null || typeof row.sample !== "object"
    || row.sample.error != null || (row.sample.exitCode !== undefined && row.sample.exitCode !== 0));
  const cases = [...new Set([...(queryIndexes ?? []), ...records.map(row => row.queryIndex)])].map(queryIndex => {
    const selected = records.filter(row => row.queryIndex === queryIndex);
    const successful = selected.filter(row => !failures.includes(row));
    const groups = Object.fromEntries(modes.map(mode => {
      const rows = successful.filter(row => row.mode === mode);
      return [mode, { n: rows.length, logSummary: summarizeRecall(rows.flatMap(row => row.resultLogs ?? [])),
        ...Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, quantiles(rows.map(value))])) }];
    }));
    const pairChecks = expectedPairIds.map(pair => {
      const rows = selected.filter(row => row.pair === pair);
      return { pair, missingModes: modes.filter(mode => !rows.some(row => row.mode === mode)),
        duplicateModes: modes.filter(mode => rows.filter(row => row.mode === mode).length > 1),
        unexpectedModes: rows.filter(row => !modes.includes(row.mode)).map(row => row.mode) };
    });
    const unexpectedPairIds = [...new Set(selected.filter(row => !expectedPairIds.includes(row.pair)).map(row => row.pair))];
    const actualOrder = selected.map(row => `${row.pair}:${row.mode}`);
    const expectedOrder = expectedPairIds.flatMap(pair => (pair % 2 === 0 ? modes : ["candidate", "baseline", "candidate-observed"]).map(mode => `${pair}:${mode}`));
    const orderMatches = JSON.stringify(actualOrder) === JSON.stringify(expectedOrder);
    const same = values => values.length > 0 && new Set(values.map(value => JSON.stringify(value))).size === 1;
    const matchingPairs = expectedPairIds.every(pair => {
      const rows = successful.filter(row => row.pair === pair);
      return rows.length === 3 && new Set(rows.map(row => row.mode)).size === 3
        && rows.every(row => typeof row.sample.authorityHead === "string")
        && new Set(rows.map(row => row.sample.query)).size === 1
        && new Set(rows.map(row => row.sample.at)).size === 1
        && new Set(rows.map(row => row.sample.semanticSha256)).size === 1
        && new Set(rows.map(row => row.sample.authorityHead)).size === 1;
    });
    // Baseline deliberately reads/materializes twice. Compare physical counts
    // within each mode and candidate against observer-on, not baseline to candidate.
    const physical = row => [row.sample.segmentReads, row.sample.materializations, row.sample.logicalEventBytes, row.sample.reads];
    const readInput = row => row.sample.reads === undefined ? null : JSON.stringify([...new Set(row.sample.reads.map(read => JSON.stringify([read.file, read.bytes])))].sort());
    const inputChecks = {
      query: successful.every(row => typeof row.sample.query === "string") && same(successful.map(row => row.sample.query)),
      at: successful.every(row => typeof row.sample.at === "string") && same(successful.map(row => row.sample.at)),
      entry: same(successful.map(row => row.sample.entry)),
      authorityHead: successful.length > 0 && successful.every(row => typeof row.sample.authorityHead === "string") && same(successful.map(row => row.sample.authorityHead)),
      semantic: successful.length > 0 && successful.every(row => typeof row.sample.semanticSha256 === "string") && same(successful.map(row => row.sample.semanticSha256)),
      readInput: same(successful.map(readInput)),
      physicalCountsPresent: successful.every(row => Number.isFinite(row.sample.segmentReads) && Number.isFinite(row.sample.materializations) && Number.isFinite(row.sample.logicalEventBytes)
        && (row.sample.reads === undefined || (row.sample.reads.length === row.sample.segmentReads && row.sample.reads.reduce((total, read) => total + read.bytes, 0) === row.sample.logicalEventBytes))),
      physicalCountsByMode: modes.every(mode => same(successful.filter(row => row.mode === mode).map(physical))),
      loadedSourcesByMode: modes.every(mode => same(successful.filter(row => row.mode === mode).map(row => [row.sample.loadedSourceSha256, row.sample.loadedSourceBytes]))),
      candidateObservedCounts: same(successful.filter(row => row.mode !== "baseline").map(physical)),
    };
    const expectedQuery = queryIndexes === undefined || queryIndexes.includes(queryIndex);
    const complete = expectedQuery && selected.length === expectedGroups * modes.length && selected.every(row => !failures.includes(row))
      && Object.values(groups).every(group => group.n === expectedGroups) && matchingPairs && Object.values(inputChecks).every(Boolean)
      && unexpectedPairIds.length === 0 && pairChecks.every(pair => pair.missingModes.length === 0 && pair.duplicateModes.length === 0 && pair.unexpectedModes.length === 0) && orderMatches;
    const noRegression = name => {
      const baseline = groups.baseline[name], candidate = groups.candidate[name];
      return !complete || baseline === null || candidate === null ? null
        : candidate.p50 <= baseline.p50 && candidate.p95 <= baseline.p95;
    };
    const baselineBytes = groups.baseline.logicalEventBytes, candidateBytes = groups.candidate.logicalEventBytes;
    return {
      queryIndex, query: successful[0]?.sample.query ?? null, complete, matchingPairs, groups, inputChecks,
      pairing: { expectedQuery, expectedPairIds, pairChecks, unexpectedPairIds, actualOrder, expectedOrder, orderMatches },
      input: { at: successful[0]?.sample.at ?? null, entry: successful[0]?.sample.entry ?? null, authorityHead: successful[0]?.sample.authorityHead ?? null,
        semanticSha256: successful[0]?.sample.semanticSha256 ?? null, readInput: successful.length === 0 ? null : readInput(successful[0]) },
      percentileRanks: Object.fromEntries(Object.entries(groups).map(([mode, group]) => [mode, { n: group.n, p50: Math.ceil(group.n * 0.5), p95: Math.ceil(group.n * 0.95) }])),
      failures: selected.filter(row => failures.includes(row)).map(row => ({ pair: row.pair, mode: row.mode, exit: row.exit, parseError: row.parseError })),
      logicalBytesRatio: baselineBytes === null || candidateBytes === null || baselineBytes.p50 === 0 ? null : candidateBytes.p50 / baselineBytes.p50,
      thresholds: {
        logicalBytesAtMost55Percent: !complete || baselineBytes === null || candidateBytes === null ? null : candidateBytes.p95 <= baselineBytes.p95 * 0.55,
        ...Object.fromEntries(["lifecycleElapsedMs", "operationElapsedMs", "operationCpuMicros", "processCpuMicros", "osCpuSeconds", "maxRssKiB", "osMaxRssBytes"].map(name => [name, noRegression(name)])),
      },
    };
  });
  return { percentileMethod: "nearest rank: sorted[ceil(p*n)-1], p=0.50/0.95", expectedGroups, startPair, queryIndexes: queryIndexes ?? null,
    complete: cases.length > 0 && cases.every(entry => entry.complete), samples: records.length, failedSamples: failures.length, cases,
    observerComparison: "candidate-observed is the same input in a fresh process; negative differences do not establish negative observation overhead",
    osIoBytes: null, networkBytes: null, tokens: null, cost: null };
}

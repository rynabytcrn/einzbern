// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { validateHostCapabilities, hostSelectionSupported, executionDecisionEligibility } from "../dist/build/packages/core/src/host-capabilities.js";
import { requestFor, selection } from "./helpers/host-native-fixture.mjs";
const base = requestFor({ id: "work:fixture", revision: 1 }).capabilities;
test("host dimensions remain independent; optional enumeration is not a launch prerequisite", () => {
  assert.equal(hostSelectionSupported(validateHostCapabilities(base), selection), true);
  assert.equal(hostSelectionSupported({ ...base, requestedSelectionSupported: "unknown" }, selection), true);
  assert.equal(hostSelectionSupported({ ...base, requestedSelectionSupported: "unsupported" }, selection), false);
  assert.equal(hostSelectionSupported({ ...base, selectionControl: "host-managed" }, { kind: "host-managed" }), true);
  assert.throws(() => validateHostCapabilities({ ...base, hostKind: "dot" }), /host-managed/u);
  assert.equal(hostSelectionSupported({ ...base, hostKind: "dot", selectionControl: "host-managed" }, { kind: "host-managed" }), true);
});
test("T15 versioned eligibility maps allowed/degraded without changing legacy admitted/refused", () => {
  for (const status of ["allowed", "degraded"]) assert.equal(executionDecisionEligibility({ schemaVersion: "tcrn.host-execution-decision.v1", status }), "executable");
  for (const schemaVersion of ["tcrn.dot-admission.v1", "tcrn.execution-admission.v1"]) {
    assert.equal(executionDecisionEligibility({ schemaVersion, status: "admitted" }), "executable");
    assert.equal(executionDecisionEligibility({ schemaVersion, status: "refused" }), "not-executable");
    assert.equal(executionDecisionEligibility({ schemaVersion, status: "degraded" }), "uninterpretable");
  }
  assert.equal(executionDecisionEligibility({ schemaVersion: "unknown", status: "allowed" }), "uninterpretable");
});

const permutations = values => values.length < 2 ? [values] : values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map(rest => [value, ...rest]));
const observed = (support, observedAt, chosen = selection) => ({ selection: chosen, support, observedAt });
test("selection support keeps nanosecond order and reduces equal-instant observations independently of input order", () => {
  const now = "2026-10-21T00:00:01Z";
  const earlier = "2026-10-21T00:00:00.000000001Z", later = "2026-10-21T00:00:00.000000002Z";
  const equivalent = ["2026-10-21T00:00:00.1Z", "2026-10-21T00:00:00.100000000Z", "2026-10-21T01:00:00.100+01:00"];
  for (const chosen of [selection, { kind: "host-managed" }]) {
    for (const [observations, expected] of [
      [[observed("supported", earlier, chosen), observed("unsupported", later, chosen)], false],
      [[observed("unsupported", earlier, chosen), observed("supported", later, chosen)], true],
      [[observed("supported", equivalent[0], chosen), observed("unsupported", equivalent[1], chosen), observed("unknown", equivalent[2], chosen)], false],
      [[observed("supported", equivalent[0], chosen), observed("unknown", equivalent[1], chosen)], true],
      [[observed("unsupported", equivalent[0], chosen), observed("unknown", equivalent[1], chosen)], false],
    ]) {
      for (const selectionObservations of permutations(observations)) {
        for (const combinations of [undefined, [selection.tuple]]) {
          const capabilities = { ...base, combinations, selectionObservations };
          const before = structuredClone(selectionObservations);
          for (const role of ["requested", "fallback"]) assert.equal(hostSelectionSupported(capabilities, chosen, role, now), expected);
          assert.deepEqual(capabilities.selectionObservations, before, "support checks must not reorder caller observations");
        }
      }
    }
  }
  const unknown = { ...base, selectionObservations: [observed("unknown", earlier)] };
  assert.equal(hostSelectionSupported(unknown, selection, "fallback", now), false);
  assert.equal(hostSelectionSupported(unknown, selection, "requested", now), true);
  assert.equal(hostSelectionSupported({ ...unknown, combinations: [selection.tuple] }, selection, "fallback", now), true);
  assert.equal(hostSelectionSupported({ ...base, selectionObservations: [observed("supported", "0000-01-01T00:00:00.000000001Z")] }, selection, "fallback", "0000-01-01T00:00:00.000000002Z"), true);
});
test("selection observation freshness includes exactly five minutes and excludes a one-nanosecond future or expired observation", () => {
  const now = "2026-10-21T00:05:00.000000002Z";
  for (const [observedAt, fresh] of [
    ["2026-10-21T00:00:00.000000001Z", false],
    ["2026-10-21T00:00:00.000000002Z", true],
    ["2026-10-21T00:00:00.000000003Z", true],
    [now, true],
    ["2026-10-21T00:05:00.000000003Z", false],
  ]) {
    assert.equal(hostSelectionSupported({ ...base, selectionObservations: [observed("supported", observedAt)] }, selection, "fallback", now), fresh, observedAt);
    assert.equal(hostSelectionSupported({ ...base, combinations: [selection.tuple], selectionObservations: [observed("unsupported", observedAt)] }, selection, "fallback", now), !fresh, observedAt);
  }
  const unrelated = { kind: "explicit", tuple: { ...selection.tuple, model: "unrelated-fixture" } };
  const observations = [observed("supported", now), observed("unsupported", now, unrelated)];
  for (const selectionObservations of permutations(observations)) assert.equal(hostSelectionSupported({ ...base, selectionObservations }, selection, "fallback", now), true);
  assert.equal(hostSelectionSupported({ ...base, requestedSelectionSupported: "unsupported", selectionObservations: [observed("supported", now)] }, selection, "requested", now), false);
});

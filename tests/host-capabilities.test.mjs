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

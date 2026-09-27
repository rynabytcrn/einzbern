// SPDX-License-Identifier: Apache-2.0
// The engine push-gate child list is data so the acceptance containment declaration
// can be checked against the executable wiring without importing a side-effectful gate.

import { TextDecoder } from "node:util";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const P8_FAILURE_TERMINAL_FIELDS = Object.freeze(["command", "error", "ok", "reasonCode", "schemaVersion"]);
const P8_FAILURE_TERMINAL_SCHEMA = "tcrn.p8-child-failure.v1";

export const ENGINE_PUSH_GATE_CHILDREN = Object.freeze([
  Object.freeze({ reasonCode: "PUSH_GATE_P1_FAILED", script: "verify:p1" }),
  Object.freeze({ reasonCode: "PUSH_GATE_P8_FAILED", script: "verify:p8" }),
]);

export function pushGateChildConclusion(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.signal !== null ||
    result.exitCode === null ||
    result.error !== null ||
    !Number.isSafeInteger(result.exitCode)
  ) {
    return "not-verifiable";
  }
  return result.exitCode === 0 ? "verified" : "blocked";
}

/** Recognize a failed P8 terminal without changing the child conclusion to green. */
export function inspectP8FailureTerminal({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exitCode = null, signal = null, error = null } = {}) {
  const findings = [];
  if (!Number.isSafeInteger(exitCode) || exitCode === 0 || signal !== null || error !== null) {
    findings.push({ code: "P8_FAILURE_TERMINAL_EXIT_INVALID", location: "$.exit" });
  }
  let stdoutText = "";
  let stderrText = "";
  try {
    stdoutText = typeof stdout === "string" ? stdout : strictUtf8.decode(stdout);
  } catch {
    findings.push({ code: "CHILD_STDOUT_UTF8_INVALID", location: "$.stdout" });
  }
  try {
    stderrText = typeof stderr === "string" ? stderr : strictUtf8.decode(stderr);
  } catch {
    findings.push({ code: "CHILD_STDERR_UTF8_INVALID", location: "$.stderr" });
  }
  if (stderrText.length > 0) findings.push({ code: "CHILD_STDERR_NOT_EMPTY", location: "$.stderr", bytes: Buffer.byteLength(stderrText) });
  const lines = stdoutText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    findings.push({ code: lines.length > 1 ? "CHILD_TERMINAL_DUPLICATE_OR_EXTRA_OUTPUT" : "CHILD_TERMINAL_MISSING", location: "$.stdout", lineCount: lines.length });
  }
  let receipt = null;
  if (lines.length === 1) {
    try {
      receipt = JSON.parse(lines[0]);
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("terminal must be a JSON object");
    } catch {
      findings.push({ code: "CHILD_TERMINAL_JSON_INVALID", location: "$.stdout[0]" });
    }
  }
  if (receipt !== null) {
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...P8_FAILURE_TERMINAL_FIELDS].sort())) {
      findings.push({ code: "P8_FAILURE_TERMINAL_FIELDS_INVALID", location: "$" });
    }
    if (receipt.schemaVersion !== P8_FAILURE_TERMINAL_SCHEMA || receipt.command !== "p8" || receipt.ok !== false) {
      findings.push({ code: "P8_FAILURE_TERMINAL_SHAPE_INVALID", location: "$" });
    }
    if (typeof receipt.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(receipt.reasonCode) || receipt.reasonCode === "P8_WORKFLOW_RC_VERIFIED") {
      findings.push({ code: "P8_FAILURE_TERMINAL_REASON_INVALID", location: "$.reasonCode" });
    }
    if (typeof receipt.error !== "string" || receipt.error.length === 0) {
      findings.push({ code: "P8_FAILURE_TERMINAL_MESSAGE_INVALID", location: "$.error" });
    }
  }
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "P8_FAILURE_TERMINAL_VALID" : "P8_FAILURE_TERMINAL_INVALID",
    terminalReasonCode: receipt?.reasonCode ?? null,
    findings,
  };
}

function containmentError(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  return error;
}

function groupMap(declaration) {
  if (declaration?.schemaVersion !== "tcrn.gate-containment.v1" || !Array.isArray(declaration.groups)) {
    throw containmentError("GATE_CONTAINMENT_INVALID", "schemaVersion or groups");
  }
  const groups = new Map();
  for (const group of declaration.groups) {
    if (!group || typeof group.id !== "string" || group.id.length === 0 || groups.has(group.id) || !Array.isArray(group.contains)) {
      throw containmentError("GATE_CONTAINMENT_INVALID", "duplicate or malformed group");
    }
    groups.set(group.id, group);
  }
  return groups;
}

function commandText(group) {
  if (typeof group.command === "string" && group.command.trim().length > 0) return group.command.trim();
  if (typeof group.executable === "string" && Array.isArray(group.argv)) return [group.executable, ...group.argv].join(" ");
  throw containmentError("GATE_CONTAINMENT_COMMAND_MISSING", group.id);
}

/**
 * Build the one-run execution plan from the containment declaration.
 * `selected` contains only top-level roots. Every other reachable group is
 * represented once with its root and containment path, so a caller cannot
 * accidentally run a parent and then flatten its children a second time.
 */
export function buildContainedExecutionPlan(declaration) {
  const groups = groupMap(declaration);
  const roots = Array.isArray(declaration.topLevel) ? [...declaration.topLevel] : [];
  const order = Array.isArray(declaration.executionOrder) ? [...declaration.executionOrder] : roots;
  if (roots.length === 0 || new Set(roots).size !== roots.length || JSON.stringify(order) !== JSON.stringify(roots)) {
    throw containmentError("GATE_CONTAINMENT_ROOT_ORDER_INVALID", "executionOrder must equal unique topLevel roots");
  }
  const selected = [];
  const covered = [];
  const seen = new Set();
  const active = new Set();
  const visit = (id, rootId, path) => {
    const group = groups.get(id);
    if (!group) throw containmentError("GATE_CONTAINMENT_UNKNOWN_GROUP", id);
    if (active.has(id)) throw containmentError("GATE_CONTAINMENT_CYCLE", id);
    if (seen.has(id)) throw containmentError("GATE_CONTAINMENT_DUPLICATE_REACHABILITY", id);
    seen.add(id);
    active.add(id);
    const record = { id, command: commandText(group), rootId, path: [...path, id] };
    if (id === rootId) selected.push({ ...record, selected: true, coveredBy: null, reason: "top-level acceptance root" });
    else covered.push({ ...record, selected: false, coveredBy: rootId, reason: "covered by selected parent/root" });
    for (const child of group.contains) visit(child, rootId, [...path, id]);
    active.delete(id);
  };
  for (const rootId of roots) visit(rootId, rootId, []);
  if (seen.size !== groups.size) {
    const unreachable = [...groups.keys()].filter((id) => !seen.has(id));
    throw containmentError("GATE_CONTAINMENT_UNREACHABLE_GROUP", unreachable.join(","));
  }
  const pushGate = groups.get("engine-release");
  const declaredPushChildren = pushGate?.contains ?? [];
  const expectedPushChildren = ENGINE_PUSH_GATE_CHILDREN.map(({ script }) => script).map((script) => script === "verify:p1" ? "engine-p1" : "engine-p8");
  if (JSON.stringify(declaredPushChildren) !== JSON.stringify(expectedPushChildren)) {
    throw containmentError("GATE_CONTAINMENT_PUSH_CHILDREN_DRIFT", `${declaredPushChildren.join(",")} != ${expectedPushChildren.join(",")}`);
  }
  return Object.freeze({
    schemaVersion: "tcrn.gate-execution-plan.v1",
    roots: Object.freeze(selected),
    selected: Object.freeze(selected),
    coveredBy: Object.freeze(covered),
    all: Object.freeze([...selected, ...covered]),
  });
}

export function pushGateExecutionPlan(declaration) {
  const plan = buildContainedExecutionPlan(declaration);
  const root = plan.selected.find((entry) => entry.id === "engine-release");
  const childIds = new Set((plan.coveredBy.filter((entry) => entry.rootId === "engine-release")).map((entry) => entry.id));
  const children = ENGINE_PUSH_GATE_CHILDREN.map((entry) => ({ ...entry, id: [...childIds].find((id) => commandText(declaration.groups.find((group) => group.id === id)) === `pnpm ${entry.script}`) ?? null }));
  if (!root || children.some((entry) => entry.id === null)) throw containmentError("GATE_CONTAINMENT_PUSH_PLAN_INVALID", "engine-release child command mapping");
  return Object.freeze({ ...plan, pushGateChildren: Object.freeze(children) });
}

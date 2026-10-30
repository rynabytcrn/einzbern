// SPDX-License-Identifier: Apache-2.0

import { compareCanonicalText } from "../../../scripts/lib/canonical-order.mjs";
import type { WorkKind, WorkRecord } from "./index.js";

const rank = new Map<WorkKind, number>([
  ["Initiative", 0], ["Epic", 1], ["Story", 2], ["Subtask", 3],
  ["Review", 4], ["Incident", 5], ["Release", 6], ["Knowledge", 7],
]);

// Internal shared order: both full validation and create-prefix insertion use it.
export function compareWorkOrder(left: WorkRecord, right: WorkRecord): number {
  const project = compareCanonicalText(left.projectId, right.projectId);
  if (project !== 0) {
    return project;
  }
  const kind = (rank.get(left.kind) ?? 99) - (rank.get(right.kind) ?? 99);
  return kind === 0 ? compareCanonicalText(left.id, right.id) : kind;
}

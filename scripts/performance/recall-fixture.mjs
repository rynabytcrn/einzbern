// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { initializeLibrary, createProject, createWork } from "../../dist/build/packages/core/src/index.js";
const root = resolve(process.argv[2]);
const at = "2026-11-10T12:00:00Z";
await initializeLibrary({ root, createdAt: at });
const state = await createProject(root, { occurredAt: at, externalKey: "PERF-PROJECT", name: "Performance fixture" });
const projectId = state.projects[0].id;
const initiative = await createWork(root, { occurredAt: at, projectId, externalKey: "PERF-INIT", kind: "Initiative", parentId: null, title: "Recall performance", goal: "Compare validated reads", scope: "## Goal\nCompare Recall performance.\n\n## Requirements\nPreserve integrity." });
const initId = initiative.work.find(w => w.externalKey === "PERF-INIT").id;
const epic = await createWork(root, { occurredAt: at, projectId, externalKey: "PERF-EPIC", kind: "Epic", parentId: initId, title: "Recall performance", goal: "Compare request state reuse" });
const epicId = epic.work.find(w => w.externalKey === "PERF-EPIC").id;
for (let n = 0; n < 20; n += 1) await createWork(root, { occurredAt: at, projectId, externalKey: `PERF-STORY-${n}`, kind: "Story", parentId: epicId, title: `Recall performance ${n}`, goal: "Preserve semantics", acceptance: "Given identical input, results agree", body: "Performance validation fixture. ".repeat(100) });
console.log(JSON.stringify({ root, projectId, records: 22 }));

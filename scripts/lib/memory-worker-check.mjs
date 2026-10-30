// SPDX-License-Identifier: Apache-2.0
// Re-evaluate pressure before newly scheduled Node test files load their workload.
import { memoryWorkerCheck } from "./memory-budget.mjs";
memoryWorkerCheck();

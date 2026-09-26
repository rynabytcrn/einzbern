// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: export * from two modules that both export name, beside a local name that takes
// precedence over both.

import { record } from "./log.mjs";

export * from "./square.mjs";
export * from "./circle.mjs";

export const name = "shapes";

record("shapes");

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Bundle fixture entry (tests/bundle.test.mjs). Run as it is, and as a bundle copied on its own into
// an empty directory, it prints the same line: an import cycle, export * beside a local export of
// the same name, a live let binding, default and namespace imports, import() of a module and of a
// built-in, a file read beside the module through new URL(..., import.meta.url), a top-level await
// and an export of the entry's own.

import { existsSync, readFileSync } from "node:fs";

import { order, record } from "./log.mjs";
import { even } from "./cycle-even.mjs";
import { evenOfZeroDuringTheCycle, odd } from "./cycle-odd.mjs";
import * as shapes from "./shapes.mjs";
import greet, { counter, increment } from "./counter.mjs";

record("entry");
increment();
increment();
const lazy = await import("./lazy.mjs");
const path = await import("node:path");
const data = new URL("./data.json", import.meta.url);

export const exported = "exported by the entry";

const result = {
  order,
  cycle: { even4: even(4), even7: even(7), odd3: odd(3), evenOfZeroDuringTheCycle },
  shapes: { names: Object.keys(shapes).sort(), name: shapes.name, square: shapes.square(3), circle: shapes.circleArea(2) },
  counter,
  greeting: greet("bundle"),
  lazy: lazy.value,
  builtin: path.posix.join("a", "b"),
  data: { exists: existsSync(data), content: JSON.parse(readFileSync(data, "utf8")) },
};
process.stdout.write(`${JSON.stringify(result)}\n`);

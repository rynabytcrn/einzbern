#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R1: bundle an entry and the modules it reaches into one ES module that runs
// without node_modules (scripts/lib/bundle.mjs says how). Build first: the CLI entry imports
// dist/build.
//
//   node scripts/bundle.mjs --entry <file> --out <file>
//
// Prints {"ok":true,"reasonCode":"BUNDLE_WRITTEN",...} on stdout, or a reason code and its details
// on stderr with exit code 1.

import { resolve } from "node:path";

import { BundleError, writeBundle } from "./lib/bundle.mjs";

const USAGE = "usage: node scripts/bundle.mjs --entry <file> --out <file>";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--entry" && flag !== "--out") || value === undefined || value.startsWith("--") || values.has(flag)) {
      throw new BundleError("BUNDLE_USAGE", USAGE);
    }
    values.set(flag, value);
  }
  if (!values.has("--entry") || !values.has("--out")) throw new BundleError("BUNDLE_USAGE", USAGE);
  return { entry: resolve(values.get("--entry")), out: resolve(values.get("--out")) };
}

try {
  const { entry, out } = parseArguments(process.argv.slice(2));
  const result = await writeBundle(entry, out);
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "BUNDLE_WRITTEN", ...result })}\n`);
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "BUNDLE_INTERNAL_ERROR";
  const details = error?.details !== null && typeof error?.details === "object" ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}

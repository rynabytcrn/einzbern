// SPDX-License-Identifier: Apache-2.0
// The runner and wiring audit use the same file predicate, including nested tests.
export function selectTestFiles(paths, suite) {
  const prefix = { core: "tests/", portal: "portal/tests/" }[suite];
  if (!prefix) throw new Error(`Unknown test suite: ${suite}`);
  return paths.filter((path) => path.startsWith(prefix) && path.endsWith(".test.mjs"));
}

// Explicit CI input only. Ordinary test/H1/P8 never consult inherited environment.
export function validateSelectedTests(selected, source) {
  if (!Array.isArray(selected) || !selected.length || JSON.stringify(selected) !== JSON.stringify([...new Set(selected)].sort()) || selected.some((path) => !source.includes(path)) || selectTestFiles(selected, "core").length !== selected.length) {
    throw new Error("Invalid exact CI core test roster");
  }
  return [...selected];
}
export function coreTestArgv(tests) { return ["--test", ...tests]; }

// SPDX-License-Identifier: Apache-2.0
// The runner and wiring audit use the same file predicate, including nested tests.
export function selectTestFiles(paths, suite) {
  const prefix = { core: "tests/", portal: "portal/tests/" }[suite];
  if (!prefix) throw new Error(`Unknown test suite: ${suite}`);
  return paths.filter((path) => path.startsWith(prefix) && path.endsWith(".test.mjs"));
}

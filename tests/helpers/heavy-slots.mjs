// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT5 (TCRN-CROSS-SUB-502, J5-12): a gates-run or verify-p1 a test starts takes
// its heavy-run slot (scripts/lib/heavy-runs.mjs) in a directory of the test's own, under its fixture's
// temporary directory, and never the slot of a run around the test. An EINZBERN_HEAVY_LOCK_DIR set
// around the tests names a directory other heavy runs on the machine share, so a run that took its slot
// there would wait behind each of them; an EINZBERN_HEAVY_SLOT set around them is the token of the run
// that started the tests, which a run inside a test has no claim to. Both are replaced here for the
// processes a test starts, and for the heavy runs it runs in this process, through runCli.

import { join } from "node:path";

import { HEAVY_LOCK_DIRECTORY_VARIABLE, HEAVY_SLOT_VARIABLE } from "../../scripts/lib/heavy-runs.mjs";

/** The slot directory of a fixture whose temporary directory is `base`. */
export function heavyLockDirectoryUnder(base) {
  return join(base, "heavy-locks");
}

/**
 * The environment for a gates-run or verify-p1 process a test starts: `env` with its heavy-run slots in
 * `directory` and without the slot token of a run around the test.
 */
export function privateHeavyEnvironment(directory, env = process.env) {
  const isolated = { ...env, [HEAVY_LOCK_DIRECTORY_VARIABLE]: directory };
  delete isolated[HEAVY_SLOT_VARIABLE];
  return isolated;
}

/**
 * For the rest of `context`'s test, the same for the heavy runs this process runs itself: a gates-run a
 * test runs in-process through runCli takes its slot in `directory`, as does every process started
 * meanwhile with this process's environment. After the test the two variables are put back as they
 * were, unless something has changed them since, which then puts back its own.
 */
export function usePrivateHeavySlots(context, directory) {
  const previous = { directory: process.env[HEAVY_LOCK_DIRECTORY_VARIABLE], slot: process.env[HEAVY_SLOT_VARIABLE] };
  process.env[HEAVY_LOCK_DIRECTORY_VARIABLE] = directory;
  delete process.env[HEAVY_SLOT_VARIABLE];
  context.after(() => {
    if (process.env[HEAVY_LOCK_DIRECTORY_VARIABLE] !== directory || process.env[HEAVY_SLOT_VARIABLE] !== undefined) return;
    for (const [name, value] of [[HEAVY_LOCK_DIRECTORY_VARIABLE, previous.directory], [HEAVY_SLOT_VARIABLE, previous.slot]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

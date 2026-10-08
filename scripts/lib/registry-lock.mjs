// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INIT-053 R45 (U11, PP-1): Atelier holds the device registry lock through the engine's own
// modules, the same file lock and registry path that register, unregister and repoint take. The portal
// reaches them through this bridge, as it reaches the names module through names.mjs, so nothing in the
// portal tree names an engine package path. The bridge re-exports the builds: the device directory's
// source imports ./names.js, which only the build has beside it. scripts/pack-release.mjs stages both
// builds beside the names build and points this bridge at them, so the release bundle carries one copy
// of each.
export { withFileLock } from "../../dist/build/packages/core/src/file-lock.js";
export { registryPath } from "../../dist/build/packages/core/src/device-home.js";

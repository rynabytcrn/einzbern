// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INIT-053 R45 (PP-1): the portal suite stands in for another process on the device that
// unregisters a library or brings up the coordination chain. It reaches the engine through this helper,
// outside the portal tree, as it reaches the protocol through library-forge.mjs; the portal's dependency
// audit keeps the portal tree itself free of engine package paths. Each export is the defining module's
// build, the U03 precedent.
export { unregisterLibrary } from "../../dist/build/packages/core/src/registry.js";
export { ensureProjectCoordination } from "../../dist/build/packages/core/src/project-chain.js";

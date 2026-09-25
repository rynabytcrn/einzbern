// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-466: scripts read every product, directory and legacy name from the
// core names module, never from a literal of their own. This bridge imports the
// TypeScript source directly (Node strips its types, and the module imports nothing) so
// that scripts which load before a build, scripts/task.mjs and the libraries it imports
// among them, do not depend on dist/build.
export * from "../../packages/core/src/names.ts";

// SPDX-License-Identifier: Apache-2.0

import * as path from "node:path";

/** Lexical containment, including the root itself; filesystem callers must also check real paths. */
export function pathIsInside(
  parent: string,
  candidate: string,
  paths: Pick<typeof path, "relative" | "sep" | "isAbsolute"> = path,
): boolean {
  const relation = paths.relative(parent, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relation));
}

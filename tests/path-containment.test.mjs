// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { pathIsInside } from "../dist/build/packages/core/src/path-containment.js";

for (const [platform, paths, root] of [["POSIX", posix, "/project"], ["Windows", win32, "C:\\project"]]) {
  test(`${platform} containment accepts dot-prefixed children but rejects parent segments and siblings`, () => {
    for (const child of [".", "child", "..cache", "..cache/source.md", "...", "nested/../..cache"]) {
      assert.equal(pathIsInside(root, paths.resolve(root, child), paths), true, child);
    }
    for (const escape of ["..", "../outside", "../project-other", "nested/../../outside"]) {
      assert.equal(pathIsInside(root, paths.resolve(root, escape), paths), false, escape);
    }
  });
}

test("Windows containment rejects different drives and UNC roots", () => {
  assert.equal(pathIsInside("C:\\project", "D:\\project\\child", win32), false);
  assert.equal(pathIsInside("C:\\project", "\\\\server\\share\\project", win32), false);
  const root = "\\\\server\\share\\project";
  assert.equal(pathIsInside(root, root, win32), true);
  assert.equal(pathIsInside(root, `${root}\\..cache\\source.md`, win32), true);
  for (const outside of ["\\\\server\\share", "\\\\server\\share\\outside", "\\\\server\\other\\project", "\\\\other\\share\\project", "C:\\project"]) {
    assert.equal(pathIsInside(root, outside, win32), false, outside);
  }
});

// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: reached only through import(), so it is evaluated when first imported.

import { record } from "./log.mjs";

record("lazy");

export const value = "loaded on demand";

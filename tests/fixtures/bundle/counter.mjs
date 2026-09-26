// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: a let export the importer reads after this module changed it (a live binding),
// and a default export.

import { record } from "./log.mjs";

record("counter");

export let counter = 0;

export function increment() {
  counter += 1;
}

export default function greet(name) {
  return `hello, ${name}`;
}

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { runLibraryCatalogWorker } from "../dist/build/packages/cli/src/library-catalog-worker.js";

await runLibraryCatalogWorker();

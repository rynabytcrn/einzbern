#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// S279 exercised the retired dispatch-tier product catalog. Its source and
// policy are no longer current acceptance targets. Never restore them for a proof.
process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: "S279_PROOF_RETIRED", error: "dispatch-tier catalog mutation proof is obsolete; no mutation or build was performed" })}\n`);
process.exitCode = 1;

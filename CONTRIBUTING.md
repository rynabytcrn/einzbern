# Contributing

Use the pinned Node and pnpm versions. Do not enable package lifecycle scripts,
add an unpinned executable, introduce telemetry, or make a project command
implicitly access the network.

## Fork-first, batch-end contribution workflow

1. Fetch the upstream main branch and start a work branch from that exact commit,
   not an unmaintained fork default branch. Record the upstream base and keep the
   fork's main as a synchronization branch, not a place for experimental changes.
   Inspect divergent commits before synchronizing; do not silently force-push them away.
2. Complete the batch, collect related failures together, review the integrated
   changes and regenerate affected proof artifacts once. Run the relevant focused
   checks and `pnpm privacy:staged` before making new content public. Preserve red
   evidence; do not turn a partial pass into acceptance or weaken a gate to publish.
3. Complete the relevant full local acceptance for the frozen candidate, retaining
   actual failures and blockers. Commit and push the authorized candidate to a
   separate branch in the contributor fork, then open or update the upstream PR.
   Fork hosting remains the contribution route; fork CI is not a prerequisite and
   is not re-enabled by this change. This does not prohibit separately authorized
   optional fork CI. Do not import local JSON as evidence of cloud execution.
4. For an existing PR, collect the next complete batch on a staging branch rather
   than publishing each intermediate fix. Update its branch to the validated
   candidate without changing its SHA afterward. Prefer a fast-forward; history
   rewrites require explicit authorization. Inspect the upstream PR's actual
   `ci-light` and `verify` results and retained bytes for that exact head.
5. Recheck upstream before handoff. If it moved, inspect the integration difference
   and incorporate it into a candidate before affected validation. Changed inputs
   invalidate affected evidence. Local acceptance and limited CI do not replace
   branch protection or prove an uncreated merge commit has already been tested.

PR ci-light checks the contributor head; the main run checks its actual merge
result. Both scan full HEAD-reachable privacy history, so PR runs cannot hide
base-history failures. Public hosting metadata is classified only under the
scanner's explicit narrow rules; source, message payloads and private values
remain scanned. Check the real main result after merging rather than assuming
that tree equality proves unchanged commit metadata.

Do not add gratuitous duplicate full trains around one frozen candidate. Complete
required full local validation; `ci-light` is not its substitute. Run a separate
formal H1 or release gate when the accepted scope requires that distinct contract,
and bind every receipt to its actual candidate. `pnpm preflight` remains available
for explicitly required independent local preflight: it creates a separate clone,
scrubs private environment and sibling variables, and collects P1 and lessons
without fail-fast. Do not automatically duplicate local preflight with local P1
just because an old recipe listed both. Never turn partial or blocked evidence
into readiness. See [CI coverage](docs/ci-verification.md).

`pnpm verify:privacy` judges the checked-out HEAD-reachable public surface. The retired
`verify:privacy:history` command is not an additional gate; retained historical tags
may contain retired bytes, and this workflow does not certify those tags.

Dependencies must be exact versions, compatible with Apache-2.0 distribution,
and added to the offline dependency policy. Source files
that accept comments must include `SPDX-License-Identifier: Apache-2.0`.

Release admission must fail closed when an unpacked release tree's install-tree
digest differs from the digest stated for it (`specs/release-trust-v1.md`).

## Proof budget, surface caps and coverage conservation are retired

The proof-to-product ratio with its policy file, the `proofBudget` surface caps, the
governance leg (licences, lifecycle scripts, the vulnerability snapshot and Git history
hygiene) and coverage conservation with its baseline and waivers are retired by
TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3). No P1 leg judges them any more, and
`git log` on this file keeps the text of the rules and their recorded exceptions.

## Host evidence is retired — `docs/verification/host/claude-code.json` (OD-C3, 2026-07-20; window retired 2026-09-18)

`scripts/host-evidence.mjs` used to drive the real Claude Code binary against a
real installation of the adapter payload and write
`docs/verification/host/claude-code.json`. TCRN-CROSS-STORY-358 (commit
`84c318c26b788b81b7acd74adfe26d3cd3ca328e`, 2026-09-06) deleted that script along
with the adapter install/activate/remove surface it observed. There is no
producer left to run and no `host-evidence` script in `package.json` any more.
If a failure message or an older document tells you to re-run it, that
instruction is itself the defect — do not follow it.

The receipt file was not deleted. It is still release evidence, not a
verification gate, in one sense that holds and one that no longer does:

- Its **absence still blocks a release**. `scripts/push-gate.mjs`'s
  `host-evidence-provenance` stage requires the file to exist, parse, and
  declare `supersededBy` (a non-empty string) and `currentClaim: "none"`, so it
  can never be silently re-presented as a live claim. This is the one condition
  OD-C3 actually stated, and it is the only one still satisfiable.
- Its **freshness is no longer checked**. The stage carried a thirty-day window
  from 2026-08-19 (`c5d58ca`) until TCRN-CROSS-INC-328 / TCRN-CROSS-MIN-204 D1
  (2026-09-18) retired it: with the producer gone, the window's only
  remediation, `pnpm host-evidence`, did not exist either, and the window kept
  expiring against a tree that had not changed.

Live evidence for the host surface that still exists is `platform-doctor.mjs`'s
hooks leg, which checks that every hook the installed container registers for
either host runs a file that parses, rather than a dated JSON file — see
`docs/verification/host/capability-manifest.json` for what is and is not
claimed today. Nothing in any gate group observes hooks actually firing on a
real host; that gap is named here rather than implied away by either the
retired window or the hooks leg that replaces it.

## Documentation

The human-facing root documents are single-language and follow the house style in
`docs/style/house-style.md`. `README.md` is written in Simplified Chinese and is
authoritative; every other root document is English. The twenty locale mirrors and
the `tcrn-doc-synced-to` pins that held them to their English sources retired in
TCRN-CROSS-STORY-360, together with `scripts/policy/doc-coverage.json` — every edit
to an English source had to re-translate and re-pin four files, and the pins were
stale in the tree at the moment they were removed. `pnpm push-gate` still fails
closed on a version left behind in `README.md` prose and on the CJK emphasis rule.

When to cut a release, and what the version number is allowed to track, are in
`docs/versioning/release-policy.md`.

## Package-manager configuration

pnpm 11 reads non-registry settings from `pnpm-workspace.yaml`, not `.npmrc`.
The workspace declares offline, frozen-lockfile and ignored lifecycle scripts as defaults.
`.npmrc` remains for npm bootstrap policy; it is not evidence that pnpm adopted those values.
`tests/ci-bootstrap.test.mjs` reads the effective pnpm values to guard this boundary.
Only intentional dependency acquisition may override offline mode; the CI bootstrap names
`--config.offline=false` explicitly and keeps the lockfile frozen and scripts disabled.
See [pnpm configuration migration](https://github.com/pnpm/pnpm.io/blob/main/docs/migration.md).

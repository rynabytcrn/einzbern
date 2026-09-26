# Contributing

Use the pinned Node and pnpm versions. Do not enable package lifecycle scripts,
add an unpinned executable, introduce telemetry, or make a project command
implicitly access the network.

Before proposing a change:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm verify:p1
```

Before pushing a public branch, run `pnpm preflight`. It creates an independent
`git clone --no-local --no-hardlinks`, scrubs private `TCRN_*` and sibling-checkout
variables, and runs the P1 and lessons gates without fail-fast so all red legs are
visible in the same receipt. The preflight probe contract is executable: do not use
zsh command modifiers, shell conjunctions, `PIPESTATUS`, `ref:path` probes, `tail`,
`head`, or `grep` as a verdict. `pnpm verify:privacy` judges the checked-out
HEAD-reachable public surface. The separate history diagnostic it used to name,
`verify:privacy:history`, retired with the rest of the ticket-numbered `verify:*`
roster in TCRN-CROSS-STORY-359; retained historical tags may still contain retired
bytes, and no gate in this repository judges them.

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

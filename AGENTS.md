# AGENTS.md — Einzbern agent entry

This repository is the governance engine. `CONTRIBUTING.md` is the manual; this file is
the canonical agent reference, and it covers one thing the manual does not: which instrument
answers which question here, and how each of them lies when it is stale.

## Four rules you must not miss

The first four numbered sections below are the engine's core operating rules. The fifth
section covers background-resource reclaim and is an additional teardown obligation.

### 1. Enumerate capability from the command catalog, never from prose

`commands` emits the schema-valid, byte-stable catalog: every verb, its flags, each
flag's `valueKind`, whether the verb mutates, and its availability. **That output is the
only authority on what exists.** Documentation — this file included — can be behind the
code; the catalog is what the engine enforces. Reading a verb's name in a document and
assuming its flags is how an agent writes a command that has never been valid.

The catalog does not carry the *legal values* a flag accepts. Those come from the source.
Work-status transitions, for one, are `planned → ready → active → done` for a record that
already exists — but `work-create --status` sets the birth state directly, so a new item
that is already being worked starts at `ready` or `active` rather than being walked there.
A `planned` item cannot go straight to `active`, and the engine refuses with `INVALID_TRANSITION` rather
than guessing what you meant.

### 2. Probe with reads, never with writes

The catalog marks every verb `mutates` or not. Firing a mutating verb "to see what it
does" is not discovery: aimed at a live chain it performs its mutation, and terminal
transitions do not come back. When a mutating verb genuinely has to be exercised to be
understood, exercise it in a scratch workspace created for that purpose and discarded
after.

Probe evidence must come from the command's structured result, not a shell-shaped shortcut:
use argv execution and parse JSON reason codes. Do not use zsh colon modifiers, `ref:path`
lookups, `|tail`/`|head`, `PIPESTATUS`, or `grep` as a verdict. The public-world replay is
`pnpm preflight`; it supplies the scrubbed environment, isolated checkout, and collect-all
ordering that a local one-liner cannot prove.

### 3. There is no code graph here — and know which copy, *on which host*, you are driving

This repository is not indexed by codegraph (the product repositories on this platform
are). Its instruments are the command catalog and the test suite. The MCP facade that
`v0.6.0` added and `v0.11.18` retired is gone from the tree; guidance naming
the MCP facade script is describing a file that no longer exists, and the CLI
is the only transport.

The freshness trap that a stale index is elsewhere, a stale *copy* is here: the working
tree in this repository and the installed copy a governed session actually drives are two
different things and routinely sit at different versions. Before concluding that a verb
does or does not exist, check which one you just ran.

**Since 2026-07-29 that question has a second half: which host.** This platform's governed
chains no longer all live on one machine — one partition's truth was relocated to another
host, and there is now an installed engine copy on each. Two copies means two version
numbers and two catalogs, so "does this verb exist" is a question about the copy you are
actually invoking, and `commands` must be asked of *that* one. Which partition is where,
with a runnable recheck command per partition, is stated in the platform root's `AGENTS.md`
section 三 — do not infer it from this repository's working tree.

### 3b. The old relocation verbs are gone, a library moves with `workspace-relocate`, and old-layout workspaces open read-only

`relocation-plan`, `relocation-inspect`, `relocation-vacate`, `relocation-adopt` and
`relocation-abort` were retired by `TCRN-CROSS-STORY-358` along with
`packages/core/src/workspace-relocation.ts` and `docs/adr/0003-workspace-relocation.md`.
Do not look for them in the catalog. `git tag attic-2026-09` holds the retired code and its
47-case test block.

A library moves with `workspace-relocate --workspace <library> --to <place> --at <instant>`
(TCRN-CROSS-STORY-470 R3, `packages/core/src/relocate.ts`): the target must not exist or be
empty and must not contain or sit inside the library; the copy is checked file by file and
replayed to the same heads; this device's registry then points at it, and the old place keeps
`TOMBSTONE.json`, still reads, and refuses every write with `LIBRARY_TOMBSTONED` naming the
new place. Another device learns the new place from its own registry (`library-register`).

Since TCRN-CROSS-STORY-469 this engine writes libraries (`.ether`) only. An old-layout
workspace (the old control directory, named in `docs/wiki/Glossary.md`) opens read-only
through `packages/core/src/legacy-workspace.ts`: its reads replay the old chain from genesis
without writing a byte, whatever address it now sits at, and every write refuses with
`LEGACY_WORKSPACE_READ_ONLY`. The relocation admission that used to gate those reads is gone
with the old writer; a `relocations` array in `workspace.json` is still parsed and checked,
and `activeBinding` still names the root the knowledge store is bound to. Moving a library is
the job of `workspace-relocate`, not of a ledger; an old-layout workspace is imported into a
library with `library-import-legacy` (TCRN-CROSS-STORY-468 R6), never relocated.

### 4. Verify "did it reach elsewhere" against the authority, and compare full values

- Whether a branch or tag reached the remote: ask the server (`git ls-remote`). Do **not**
  use `git log --not --remotes` — under a narrow fetch refspec it can never see a newly
  pushed branch.
- Comparing commits: compare **full** SHAs. An 8-character local id against a
  7-character server-truncated one reports a difference that does not exist.
- Dating something: measure against a reference that does not move (a file's own write
  time, an upstream timestamp), never against the wall clock as it is right now. A
  measurement anchored to "now" invalidates itself a few hours later.

### 5. Background loads: write the reclaim in the same breath as the spawn

Never start a long-running detached task without its teardown in the same command or flow
(`trap 'kill 0' EXIT`, or capture the process **group** and kill it). Verify the group is
empty at teardown. Killing the direct child is not enough — a package-manager shim chain
lets the real binary reparent to init and survive. A daemon a tool registers itself is not
a leak; the test is whether anything owns the record of it.

## A boundary that is easy to cross by accident

- **Only the engine may write inside a control tree.** Everything under a workspace control
  directory (the old-layout name is in `docs/wiki/Glossary.md`)
  is written in the engine's canonical byte form. An editor that reformats on save, a
  linter, a prettifier, or an agent reaching for a file-write tool breaks the chain, and
  then *reading* it stops working too. Inspecting those files is fine; saving them never
  is. **A remote tree is not an exception**: `cat >`, `sed -i` or `rsync` over SSH is the
  same act with the same outcome, and a write to a chain that lives on another host must be
  performed by the engine *on that host*.

## Native dispatch boundary

The dispatch adapter (`scripts/dispatch-adapter.mjs`), the dispatch-telemetry hook and
the `dispatch-*` verbs are retired (TCRN-CROSS-STORY-467 R3); the dispatch settings remain
readable through `settings-catalog` and `scripts/host-render.mjs` until the host wiring
is redecided. When a caller resolves the host, task class, mode, model, and effort, it
does so from the live workspace immediately before the host call, then passes the
resolved model and effort to the native tool. Read the bound Story with `work-show` when
the call carries a work id; a missing or changed work, scope, configuration,
model, or effort is a refusal. An unrelated chain append is not a dispatch
failure, because the dispatch decision depends on the relevant record and
configuration rather than the entire chain head.

The old brief validator, pre-call receipt/task-name wrapper, structured handoff,
and mirrored stage-completion store are retired. They are not required inputs,
exports, hooks, or helper steps. Native role/provider fields that a host does not
expose remain `unknown`; they never become authority by prompt self-claim. For
Codex native dispatch, fresh task-pack, rework, decision, and acceptance rounds
still require an explicit new instance and `forkTurns: "none"`; these are
Codex-host constraints. Claude Code follows its prompt for host details, so
whether its Agent tool starts a fresh instance or `SendMessage` continues one is
prompt-defined. Native call/turn telemetry records facts without authenticating
the host or provider.

## Platform conventions

This repository sits inside the TCRN Platform working tree. Cross-repo conventions —
constraint classification and evolution, direction and track choices, sourcing and vetting
of outside code, delivery cadence — live in the platform root's `AGENTS.md` and `docs/`.
The one that governs changes to this repository most directly: **replacing old behaviour
requires a residual-applicability analysis first** — does the old path still hold for some
supported user, host, or model? If it does, the change is conditional (a version-gated
operation, an enable event) rather than a deletion. This engine already works that way;
the convention names the practice so it survives outside the engine too.

# Coding style: evidence and adoption

Research snapshot: 2026-11-06. This report explains the choices behind the
[shared coding guide](../../specs/coding-style-v1.md). It is maintainer background,
not additional context every coding session must load.

## What the evidence supports

Community complaints repeatedly describe unnecessary abstractions, compatibility
layers, scope expansion, excessively defensive branches, and reviews that pursue
theoretical issues after the requested behavior works. These are useful questions
to ask of a codebase, not proof that a particular repository has those defects or
that an AI model authored them.

| Evidence | Observation | Limit and consequence |
| --- | --- | --- |
| [Codex overengineering discussion](https://www.reddit.com/r/codex/comments/1vk7p9q/i_am_tired_of_codex_over_engineering_everything/) | Firsthand reports of unrequested refactors and expanding complexity across tasks. | Self-selected reports; use them to inspect scope and indirection, not to estimate a failure rate. |
| [Implementation and review complaints](https://www.reddit.com/r/codex/comments/1v5dn0i/what_prompts_or_agentsmd_rules_keep_codex_from/) | Distinguishes duplicate helpers and compatibility layers from pedantic review of intentional behavior. | A proposed prompt is not a validated cure. Preserve project context and require a concrete consequence for a finding. |
| [Lean-code benchmark discussion](https://www.reddit.com/r/codex/comments/1wgzmul/coding_benchmarks_should_also_reward_the_leanest/) | Functional success alone does not capture maintenance burden. | The smallest line count is not an appropriate replacement metric. |
| [Hora and Robbes, MSR 2026](https://arxiv.org/abs/2602.00409) | In 2,168 JavaScript, TypeScript and Python repositories, agent commits more often modify tests and introduce mocks. | Presence of a mock does not prove a bad test. Exercise the real behavior and isolate only the boundary that needs a double. |
| [Jin and Chen, 2026](https://link.springer.com/article/10.1007/s10515-026-00638-5) | Requirement-conformance experiments find correct code misclassified as defective; requests for elaborate explanations can worsen judgments. | Benchmark tasks are not all production reviews. Executable evidence should decide a runnable claim. |
| [Borg et al., 2026](https://link.springer.com/article/10.1007/s10664-026-10889-1) | A preregistered two-phase experiment with 151 participants found no significant downstream maintenance-time or code-quality difference. | A bounded Java task cannot establish long-term equivalence. It does contradict a blanket claim that AI assistance necessarily makes maintenance worse. |
| [Sawada et al., EASE 2026](https://arxiv.org/abs/2605.06464) | Their sample of over 1,000 files shows less frequent maintenance of agent-generated files; most subsequent maintenance is human. | Frequency alone cannot establish quality or ease of maintenance. The future human reader still matters. |
| [Mockus et al., ESEM 2026](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.93) | Character-level provenance across more than 400,000 Meta diffs shows AI use varies with code centrality and other context. | Naive AI-versus-human comparisons confound context with authorship. Do not attribute E/M code smells to a model from their appearance. |

These sources span practitioner feedback, an observational test study, a review
experiment, a controlled maintenance experiment and production observations.
They are a targeted sample, not a systematic review or a vote of all developers.
None measures the effect of the new E/M guide.

## Projects worth reading, with boundaries

There is no agreed ranking of beautiful code. The
[2019 HN discussion](https://news.ycombinator.com/item?id=21373852) recommends SQLite
alongside very compact snippets that serve different goals. The
[2016 discussion](https://news.ycombinator.com/item?id=11005003) specifically praises
Redis. The [2021 Go discussion](https://news.ycombinator.com/item?id=25812021)
recommends the standard library and also criticizes parts constrained by legacy
compatibility. These nominations justify reading concrete modules, not endorsing
every file of a famous project.

| Project and inspected source | Useful practice | What E/M adopts |
| --- | --- | --- |
| [SQLite 3.46.0 `src/hash.c`](https://github.com/sqlite/sqlite/blob/version-3.46.0/src/hash.c), [architecture](https://sqlite.org/arch.html), [testing](https://sqlite.org/testing.html) | Operations and ownership are explicit. Comments explain the hash constant and failure behavior. Fault and boundary testing supports reliability. | Preserve contracts and meaningful checks; explain non-obvious invariants. Do not copy SQLite's test volume, C pointer naming or formatting as universal rules. |
| [Redis 7.2.6 `src/adlist.c`](https://github.com/redis/redis/blob/7.2.6/src/adlist.c) | List creation, emptying, release and insertion have recognizable domain names. The allocation failure contract is visible beside the operation. | Cohesive operations, direct control flow and explicit failure semantics. This small module is evidence for a practice, not a whole-repository quality score. |
| [Go 1.23 `src/io/multi.go`](https://github.com/golang/go/blob/go1.23.0/src/io/multi.go), [Effective Go](https://go.dev/doc/effective_go) | Reader composition keeps EOF/error handling visible. Comments explain buffer reuse, GC and specific historical bugs. Formatting follows a tool and language idioms. | Explain actual tradeoffs; retain useful recovery behavior; use the project's tools. Do not translate Go conventions mechanically into TypeScript. Effective Go's own notice says it does not cover all modern language features. |

The common feature is understandable intent and consequences, not uniform file
size, the absence of validation, a particular paradigm, or clever compression.
The inspected release tags make the examples reproducible; they are not claims
about the latest release of each project.

## E/M baseline

Inspected candidates: E `0f9945564799fba6697a9230a634733753cc80c8`,
M `f16a095ecb4c469b1a0286065a2a3bb6d0bb33f9`. This is a targeted style review of
representative core, CLI, packaging and generated-helper paths, supported by the
preceding code audit. It does not certify every line of both repositories.

| Area | Existing strengths | Readability or maintenance issue | Disposition |
| --- | --- | --- | --- |
| Core contracts, including `format-version.ts`, `skill-copies.ts` and configuration backup modules | Typed values, explicit reason codes, ownership and compatibility contracts; real filesystem tests. | Some comments retain extensive implementation history; some predicates and operations are compressed. | Preserve the actual contracts. Explain current intent locally; keep task history in its records. Avoid blanket removal of guards or comments. |
| `packages/cli/src/config-backup-commands.ts` | One command-family entry, closed input envelopes and centralized backup/restore behavior. | Several statements share a line; nested ternaries choose request fields and recovery modes; a conditional chooses which effectful function to invoke. | Expand those paths in place. Keep the same exported API, validation order and errors rather than creating a new dispatch framework. |
| CLI `index.ts`, `workspace.ts`, `knowledge-core.ts` | Existing command-family and domain modules offer useful boundaries. | Large coordination modules require selective reading. Their length alone does not prove a bug or justify a rewrite. | Use a real feature/change to identify the next independently changing responsibility. No arbitrary file/function-length gate. |
| M distribution | The Skill, installer, documentation and archiver have E-owned generation sources. | Editing M independently would create drift. The archiver's recursive walk and output were compressed into long lines. | Refactor the E template and regenerate M; retain deterministic ordering, hashes and entry validation. |
| Existing formatting and lint tasks | Text/JSON normalization, JavaScript syntax checks, forbidden constructs and TypeScript checks exist. | They do not measure control-flow clarity or enforce a full source formatter. `docs/style/house-style.md` describes documentation, not code. | State the tools' actual scope; add one shared coding guide and contributor navigation, without claiming an automated aesthetics score. |

The baseline focused run passed 123 existing tests before the code changes.
The refactor preserves algorithms and sequencing. No runtime speedup, human
comprehension-time improvement, token saving or model-compliance rate has been
measured. Those outcomes remain unknown until directly evaluated.

## Distribution and recurrence prevention

E owns `specs/coding-style-v1.md`. Its Skill description includes coding and review
in managed projects; its navigation names the guide in the actual engine bundle.
The engine package explicitly includes the guide. M is regenerated from E's
immutable source and distributes the same navigation. Traditional host copies
and independently configured dot targets use that Skill; hooks and AGENTS keep
their existing routing responsibility rather than carrying another rule body.

The guide combines a small set of defaults with project-specific tools and
language idioms. Existing behavior tests, type checks and package/reference
checks provide deterministic enforcement where they can. Readability remains an
evidence-based maintenance judgment in the existing review, not an extra stage.

New installation and upgrade candidates must carry the guide and resolve its
navigation after relocation. Tests of those paths demonstrate distribution;
they do not demonstrate that a particular hosted model read or obeyed the text.
An arbitrary host must actually load the Skill and expose the engine references
before it can benefit from the same instructions. Current user instructions and
the host's higher-priority rules still apply.

# Coding style

Use this guide when writing, refactoring or reviewing code in an Einzbern-managed
project. It is the shared Mana Orchestrate default across hosts and models. Read
it for a coding task, not for installation, recall or record keeping alone.

The goal is code a maintainer can follow, change and test without reconstructing
unnecessary machinery. Correct behavior and required security boundaries come
first. The current task, explicit project conventions and language idioms take
precedence over these defaults; preserve local consistency when several forms
are equally clear. This guide does not authorize unrelated rewrites or introduce
another approval, agent, review round or work item.

## Before changing code

Read the affected entry point, its callers, nearby tests and the project's
formatter/linter configuration. Identify the observable behavior to preserve or
change. Find the existing owner of the behavior before adding another helper,
configuration setting or dependency. A suspicious runnable path is a reason to
exercise it; distinguish observed failure, static proof and a readability choice.

## Write for the next reader

- **Keep the main path visible.** Put sequential operations in execution order.
  Use early returns for simple exits and ordinary branches for distinct cases.
  Expand nested conditionals or expressions that hide side effects. Do not pack
  several operations onto one line or compress code to reduce a line count.
- **Name domain facts and actions.** Prefer names that explain what a value means
  and what a function does. Short names are fine in a small, obvious scope.
  Comments explain a contract, ordering constraint, ownership rule or measured
  tradeoff that the code cannot express; do not narrate every statement.
- **Keep related behavior together.** Split a module or function when it has
  independently changing responsibilities or a useful boundary. Do not fragment
  a clear sequence merely to satisfy a length target. A helper should give the
  reader a meaningful operation, not another place to look for a single obvious
  expression. Prefer existing library facilities and concrete types; introduce
  abstraction when current callers or a real boundary benefit from it.
- **Make data and effects explicit.** Keep parsing, validation, computation and
  I/O distinguishable. Use the repository's existing separation rather than
  adding layers to every small function. At external boundaries validate actual
  input; inside a validated domain use the resulting types and invariants.
  Preserve checks required by trust, concurrency, persistence or compatibility.
- **Preserve failure meaning.** A fallback needs an expected failure it can
  legitimately handle. Do not turn unreadable, malformed or incomplete data into
  an empty success. Retain the project's error contract and resource cleanup.
  A recovery branch should expose its condition and result to its caller.
- **Spend runtime work deliberately.** Choose an appropriate algorithm and data
  representation; avoid redundant reads, copies and work in hot paths. Measure
  a real workload before adding caching, concurrency or specialized machinery.
  Preserve required ordering. Report input, environment and observations with a
  performance claim; fewer lines or branches alone do not prove a speedup.
- **Use the local tools for mechanics.** Apply the configured formatter and
  linter to changed code. Follow the language's conventions rather than imposing
  another language's syntax style. Without a formatter, match nearby readable
  code; adding a new tool or reformatting the whole repository is a separate
  implementation choice, not a prerequisite to completing a small change.

## Verify the change, then finish

Run the affected public behavior and relevant existing checks. For a bug fix,
exercise the failing input and the expected outcome. For a refactor, compare the
same observable results and important failure paths. Test through real parsers,
files or interfaces when practical; use a test double for an expensive or
unavailable boundary without replacing the behavior under test. Assertions
should describe an outcome, not merely repeat the implementation.

In the existing review, ask whether the reader can locate the behavior, follow
the data and effects, understand errors, and make the intended change without
unnecessary indirection. Explain a readability improvement with the actual
code and its maintenance consequence. Do not turn an equally valid naming or
layout preference, an arbitrary complexity score, or an imagined future case
into a defect. Reuse valid evidence and stop when the task's checks are met;
the existing [batch procedure](batch-execution-v1.md) governs approved batches.

## Maintainer notes

This file is the authoritative shared guide. E renders the Skill navigation and
packages this file with the engine; M carries the generated navigation. Hooks
and AGENTS route to the Skill and do not duplicate this guide. Repository tools
can enforce formatting, types and tested behavior; distribution of the same
guide does not prove that every model followed it. Record actual session or
behavior evidence before claiming model compliance or a productivity gain.

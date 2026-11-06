# Work practices

AGENTS carries principles and a Skill entry. Fallback Hook text points to the same Skill. The Skill owns action selection. Use automatic recall output as evidence. Use current prompt recall when it covers the task. When recall is absent, incomplete or the task changes, use `recall --view agent --query "<task>"` with the current UTC instant and applicable library. Reuse equivalent results within the same responsibility.

Load only the reference and language needed by the enabled principle and current task. A reference does not authorize delegation or introduce a batch to an ordinary task.

| Task | Reference (relative to this file) |
| --- | --- |
| Writing, refactoring or reviewing code | [Coding style](coding-style-v1.md) |
| Approved batch, dispatch or acceptance | [Batch execution](batch-execution-v1.md), including [recording checks and reusing results](batch-execution-v1.md#recording-checks-and-reusing-results) |
| Resource, worktree or branch cleanup | [Resource cleanup](resource-cleanup-v1.md) |
| Noninteractive shell operations | [Unattended execution](unattended-execution-v1.md) |
| Configured design authority | [Design consumption](design-consumption-v1.md) |
| Installation and persistent paths | [Portable installed paths](installed-paths-v2.md) |
| Configuration and model policy | [Configuration contract](configuration-contract-v1.md) |

## Read only the material needed for the decision

Agent recall delivers the complete selected context when it fits in 32768 UTF-8
bytes with its JSON envelope. An `over-budget` result gives the required byte
count and a diagnostic reference. To read full diagnostics or recover that
context, keep the original arguments, omit `--view agent` and redirect the full
response to a local file. Compare the observed library head and knowledge
snapshot before treating a replay as equivalent. Use a JSON tool to select
the needed fields or extract byte-bounded segments from long values. Apply
the host's smaller limit when one exists.

Read the live work and applicable inherited requirements for your responsibility.
Use `work-show` for the full record and `work-content-context` for digest-pinned
segments. Keep raw receipts available and pass only the required fields to the
model when the full receipt duplicates them. For readback and reuse within one
responsibility, follow [the batch procedure](batch-execution-v1.md#one-execution-record-and-its-references).

Installation files and generated text must be portable: use a path relative to its declared base, resolved at runtime. Never embed the installer's home, checkout or device directory. In knowledge cards use stable project/work/decision identifiers and repository-relative evidence locations; a relative path without its project or base is ambiguous. Preserve provenance rather than guessing a replacement for an unknown historical path.

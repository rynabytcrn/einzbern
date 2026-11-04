# Work practices

AGENTS carries principles and a Skill entry. Fallback Hook text points to the same Skill. The Skill owns action selection; automatic recall output is evidence, not a second instruction source. Use current prompt recall when it covers the task; run recall when it is absent, incomplete or the task changed. Do not repeat an equivalent query merely because multiple entry points mention the Skill.

Load only the reference and language needed by the enabled principle and current task. A reference does not authorize delegation or introduce a batch to an ordinary task.

| Task | Reference (relative to this file) |
| --- | --- |
| Approved batch, dispatch or acceptance | [Batch execution](batch-execution-v1.md) |
| Resource, worktree or branch cleanup | [Resource cleanup](resource-cleanup-v1.md) |
| Noninteractive shell operations | [Unattended execution](unattended-execution-v1.md) |
| Configured design authority | [Design consumption](design-consumption-v1.md) |
| Installation and persistent paths | [Portable installed paths](installed-paths-v2.md) |
| Configuration and model policy | [Configuration contract](configuration-contract-v1.md) |

Installation files and generated text must be portable: use a path relative to its declared base, resolved at runtime. Never embed the installer's home, checkout or device directory. In knowledge cards use stable project/work/decision identifiers and repository-relative evidence locations; a relative path without its project or base is ambiguous. Preserve provenance rather than guessing a replacement for an unknown historical path.

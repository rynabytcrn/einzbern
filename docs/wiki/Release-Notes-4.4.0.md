# Einzbern 4.4.0

Einzbern and Mana Orchestrate ship in lockstep at 4.4.0.

| Module | Release notes |
| --- | --- |
| Codex handoff and report delivery | [Codex handoff and report delivery](Release-Notes-4.4.0-Codex-handoff-and-report-delivery.md) |
| Recoverable storage and installation | [Recoverable storage and installation](Release-Notes-4.4.0-Recoverable-storage-and-installation.md) |
| Shared coding guidance and agent context | [Shared coding guidance and agent context](Release-Notes-4.4.0-Shared-coding-guidance-and-agent-context.md) |
| Release and verification correctness | [Release and verification correctness](Release-Notes-4.4.0-Release-and-verification-correctness.md) |

## Getting this version

Update Mana Orchestrate from its normal installation source and use its supported
Einzbern update procedure with version `4.4.0`. New installations use the same
versioned engine package and generated Skill. Engine updates refresh the normal
hook registrations and managed guidance; installing the Skill alone does not
switch an existing engine.

The Codex guards use recorded peer-batch facts and the host's native hook support.
Host trust still applies to newly registered commands. Check actual hook activation
before treating a configuration file or a successful engine update as proof that
these guards ran. They do not automatically send reports or guarantee model termination.

The complete notes are retained in `docs/releases/4.4.0.md` at tag `v4.4.0`.

[All releases](Release-Notes.md)

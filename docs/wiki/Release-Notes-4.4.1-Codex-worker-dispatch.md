# Einzbern 4.4.1 — Codex worker dispatch

- Keep implementation workers on the native subagent entry in the approved
  two-conversation workflow. Scoped dispatch preparation and peer receipts reject
  independent conversation creation or forks presented as worker dispatches.
- Deny a registered coordinator's incorrect create or fork before the tool runs,
  including native calls inside code mode. Ordinary unbound conversations and
  correctly associated native subagents retain their normal behavior.

[Version directory](Release-Notes-4.4.1.md)

[Durable coordinator roles and recovery](Release-Notes-4.4.1-Durable-coordinator-roles-and-recovery.md) · [Installation and native hook readiness](Release-Notes-4.4.1-Installation-and-native-hook-readiness.md) · [Compatibility and verification](Release-Notes-4.4.1-Compatibility-and-verification.md)

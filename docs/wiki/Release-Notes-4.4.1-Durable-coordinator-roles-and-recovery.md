# Einzbern 4.4.1 — Durable coordinator roles and recovery

- Keep registered main/coordinator roles across turns, summaries, process restarts
  and subsequent batches. A terminal batch does not automatically retire its role.
- Report missing, unreadable, malformed or mismatched material for a known role
  as a visible dispatch failure. Recover or retire bindings through the existing
  governed peer-record lifecycle rather than silently treating them as unbound.

[Version directory](Release-Notes-4.4.1.md)

[Codex worker dispatch](Release-Notes-4.4.1-Codex-worker-dispatch.md) · [Installation and native hook readiness](Release-Notes-4.4.1-Installation-and-native-hook-readiness.md) · [Compatibility and verification](Release-Notes-4.4.1-Compatibility-and-verification.md)

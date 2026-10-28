# 3.4.0 — Codex native collection

- Add an opt-in isolated Codex native controller and private hook bridge through
  the normal versioned hook entry, with parent tool schemas available before
  initialization and an explicit public admission input for setup.
- Bind the dedicated collector to its fixed batch, native agent, attempt, turn
  and session. Read fresh native state, preserve failed, cancelled and unknown
  outcomes, and return raw facts and result locations once.
- Keep waits outside SubagentStop in the same live collector, with bounded
  queries, transport settlement, controls and shutdown. Preserve unresolved child
  responsibility and reject unsafe, substituted or unverified artifacts.
- Require actual capability and trust observations before adding the Codex event.
  Default Desktop callback, automatic command trust, old-version upgrade and
  rollback, other-user isolation and complete comparative total cost remain
  separately unverified. Non-Codex and dot targets receive no Codex hook.

[3.4.0 module directory](Release-Notes-3.4.0.md) · [All releases](Release-Notes.md)

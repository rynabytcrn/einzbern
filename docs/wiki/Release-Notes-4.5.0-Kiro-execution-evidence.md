# Einzbern 4.5.0 — Kiro execution evidence

- Add an explicit Kiro CLI runner that uses the existing login, preserves the
  requested model and default effort, reserves a private evidence destination
  before launch, and records process exit separately from model and native
  terminal observations. It does not turn policy selection into permission.
- Retain the observed guided CLI and IDE current-work, rules and recall cases,
  isolated engine writeback and fresh-session continuation. The IDE observations
  cover Default and custom agents at container and subproject roots in the
  tested multi-root workspaces.
- Preserve the limits of those observations: historical free-prompt gaps,
  Default IDE automatic Skill loading, full IDE Hook semantics, provider backend
  identity, actual timeout arguments and precise per-task costs remain explicit.

[Version directory](Release-Notes-4.5.0.md)

[Kiro host integration](Release-Notes-4.5.0-Kiro-host-integration.md) · [Specs source and refresh](Release-Notes-4.5.0-Specs-source-and-refresh.md) · [Compatibility and delivery](Release-Notes-4.5.0-Compatibility-and-delivery.md)

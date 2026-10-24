# Einzbern 3.3.0: Recoverable dot rules and private sources

[Release notes](Release-Notes.md) > [Einzbern 3.3.0](Release-Notes-3.3.0.md)

Previous: [Atelier and work context](Release-Notes-3.3.0-Atelier-and-Work-Context.md) | Next: [Compatibility and rollout boundaries](Release-Notes-3.3.0-Compatibility-and-Rollout-Boundaries.md)

- Store private versioned dot extension source declarations and reconstruct
  declared rule, checker and entry files through the existing preview, ownership,
  backup and readback path. Reconstructed files remain inert; edited or unowned
  content stays pending for review.
- Verify explicitly classified Git commit references against actual objects at
  each consuming operation while preserving decoded-content privacy checks.
  A saved declaration or local digest is not identity authentication or a reusable
  permission to execute source content.
- Add the optional, default-off privacy/publication principle and keep rule
  enablement, rendered bytes and actual host-session reads separate.
- Clarify completion of already authorized PR review fixes in dot's autonomy
  guidance. Recognize the exact preceding owned template during update while
  continuing to protect user edits, source bindings and recovery copies.

---

[Module directory](Release-Notes-3.3.0.md)

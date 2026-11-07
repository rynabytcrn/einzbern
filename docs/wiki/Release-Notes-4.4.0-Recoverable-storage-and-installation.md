# Recoverable storage and installation

Einzbern / Mana Orchestrate 4.4.0.

- Check relocation destinations and writable boundaries before publishing new
  storage pointers. Retain recovery information when a later step fails, including
  failures after pointer publication, and expose the actual recovery state.
- Clarify device uninstall ownership and preserve shared libraries and unrelated
  host content. Keep installed paths relative to their declared runtime base.
- Ship the same generated guidance, hook registrations and diagnostics to fresh
  installations, updates, repairs and migrations without restoring old collectors.

[Back to 4.4.0](Release-Notes-4.4.0.md)

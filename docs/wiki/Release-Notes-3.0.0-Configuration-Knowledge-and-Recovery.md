# Einzbern 3.0.0: Configuration, knowledge and recovery

[Release notes](Release-Notes.md) › [Einzbern 3.0.0](Release-Notes-3.0.0.md)

Previous: [Breaking configuration changes and migration](Release-Notes-3.0.0-Breaking-Configuration-and-Migration.md) · Next: [Hosts and installation](Release-Notes-3.0.0-Hosts-and-Installation.md)

- Device, library and project descriptors expose ownership, persistence, effective
  source and read-only historical declarations. Atelier resolves the selected
  library's state rather than retaining the previous library's model-page state.
- The public knowledge-capture CLI passes the explicit host through language-policy
  selection. Non-Codex legacy language behavior remains distinct from strict Codex
  device policy; no cross-host fallback or automatic non-Codex policy migration is added.
- Paginated knowledge consumers retain legal same-ID versions and derive a canonical
  digest for the entire result, not the last page. Invalid/repeated-page responses
  still refuse rather than silently dropping records.
- Consolidated repairs cover segmented storage and replay integrity, cache recovery,
  portable containment, lock ordering, relocation/setup rollback, configuration
  validation, governance attribution and public CLI/Portal error contracts.

---

[Module directory](Release-Notes-3.0.0.md)

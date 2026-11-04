# Einzbern 4.1.0: Managed harness updates

- Refresh existing registered instruction outputs when updating or rolling back
  the engine. The selected engine renders navigation, enabled built-in rules and
  variables, so updates use its catalog instead of the initiating process's text.
- Preserve Owner text, local edits, user-owned or removed sections, disabled
  rules, generation-disabled outputs and independent dot targets. Report pending
  sections and unavailable outputs individually while refreshing other outputs.
- Detect catalog body corrections even when a rule's version is unchanged.
  Rule listing reports outdated text and doctor distinguishes it from user edits.
- Complete upgrades initiated by older update code through the newly installed
  managed writer, as documented in Mana's update guide.

[Version contents](Release-Notes-4.1.0.md) · [Empirical acceptance principles](Release-Notes-4.1.0-Empirical-acceptance-principles.md) · [Recoverable configuration backups](Release-Notes-4.1.0-Recoverable-configuration-backups.md)

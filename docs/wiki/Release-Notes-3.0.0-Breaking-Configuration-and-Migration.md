# Einzbern 3.0.0: Breaking configuration changes and migration

[Release notes](Release-Notes.md) › [Einzbern 3.0.0](Release-Notes-3.0.0.md)

Previous: [Next public release: 3.0.0 preparation](Release-Notes-3.0.0-Release-Scope.md) · Next: [Configuration, knowledge and recovery](Release-Notes-3.0.0-Configuration-Knowledge-and-Recovery.md)

- New project writes to `models.*` and `quota.*` are refused with
  `SETTINGS_KEY_DEVICE_LEVEL`. Configure the device's explicitly named host policy
  instead. Previously valid calls such as `settings-set models.escalation.enabled=false`
  therefore require a caller change; historical readability is not write compatibility.
- Historical model and quota events remain readable but no longer select execution
  policy. No host policy is silently created or copied from another host. Existing
  authorization for governed configuration changes must name the actual target.
- New shared artifact/article path declarations use portable relative paths or local
  bindings, not absolute device paths. Historical path events are not rewritten.
  Variable export and managed projection refresh are explicit and target-owned.

See [the 3.0.0 migration preparation](../releases/3.0.0-migration.md) for the
one-time configuration boundary, routine dispatch limitations and rollback cautions.

---

[Module directory](Release-Notes-3.0.0.md)

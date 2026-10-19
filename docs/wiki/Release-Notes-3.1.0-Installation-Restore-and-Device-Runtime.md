# Einzbern 3.1.0: Installation, restore and device runtime

[Release notes](Release-Notes.md) › [Einzbern 3.1.0](Release-Notes-3.1.0.md)

Previous: [Shared library and project memory](Release-Notes-3.1.0-Shared-Library-and-Project-Memory.md) · Next: [Compatibility and upgrades](Release-Notes-3.1.0-Compatibility-and-Upgrades.md)

- `Ether` is the shared library folder name. Its parent is chosen by the user and
  may be on a local disk, an external disk or in a synchronization folder; cloud
  detection does not restrict the location. Later projects reuse the saved library.
- New installations and restores keep device-specific cache, locks and backups
  under `Ether/.einzbern/<device-id>/`. Device identity, the registry, host policy
  and installed engine versions remain local to each device.
- Storage relocation has a plan and an explicit apply step. Same-volume moves and
  verified cross-volume copying preserve data and support interrupted-operation
  recovery; changed or unowned destinations are refused before source cleanup.

---

[Module directory](Release-Notes-3.1.0.md)

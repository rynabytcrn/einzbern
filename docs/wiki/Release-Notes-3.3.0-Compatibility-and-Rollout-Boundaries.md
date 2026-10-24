# Einzbern 3.3.0: Compatibility and rollout boundaries

[Release notes](Release-Notes.md) > [Einzbern 3.3.0](Release-Notes-3.3.0.md)

Previous: [Recoverable dot rules and private sources](Release-Notes-3.3.0-Recoverable-Dot-Rules-and-Private-Sources.md)

- Release Einzbern and its generated Mana Orchestrate skill together at 3.3.0,
  retaining the existing format-3 library and legacy behavior in projects that
  have not enabled the new content policy.
- Separate the shared-library engine floor from project content opt-in. Native
  readiness checks require current delivery and writer observations, and refuse
  conflicting late increments or an unverified floor downgrade.
- Publishing or installing this release does not enable production work-content
  policy, change the shared-library floor, install dot rules or update other
  devices. Complete real-host, writer-inventory, offline-copy and late-increment
  rollout acceptance remains unverified until actual observations establish it.

---

[Module directory](Release-Notes-3.3.0.md)

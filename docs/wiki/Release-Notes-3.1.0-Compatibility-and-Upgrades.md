# Einzbern 3.1.0: Compatibility and upgrades

[Release notes](Release-Notes.md) › [Einzbern 3.1.0](Release-Notes-3.1.0.md)

Previous: [Installation, restore and device runtime](Release-Notes-3.1.0-Installation-Restore-and-Device-Runtime.md) · Next: [Documentation and lockstep delivery](Release-Notes-3.1.0-Documentation-and-Lockstep-Delivery.md)

- This release supports library format 3 for shared-library provenance and scoped
  chain identities. Existing format-1 and format-2 libraries remain readable;
  they are not silently consolidated or upgraded by this release.
- Update every device that will use a shared format-3 library before migration.
  The previous public 3.0.0 engine supports format 2 and cannot open format 3.
  Review the migration plan and keep a verified library/device backup first.
- Rolling an engine back does not downgrade a format-3 library. Recovery with an
  older engine requires a compatible preserved library; do not rewrite event
  history or lower a manifest's format number to bypass a reader refusal.
- Local 3.0.3, 3.0.4 and 3.0.5 installation candidates were not public releases.
  The public comparison baseline for 3.1.0 is 3.0.0.

---

[Module directory](Release-Notes-3.1.0.md)

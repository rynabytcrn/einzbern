# Einzbern 3.3.1: Dot health-check applicability

[Release notes](Release-Notes.md) > [Einzbern 3.3.1](Release-Notes-3.3.1.md)

Previous: [Complete installed contracts](Release-Notes-3.3.1-Complete-Installed-Contracts.md)

- Support explicit `doctor --execution-target chatgpt-dot` applicability: run the
  six shared device/library checks and report traditional hooks and Skill copies
  as not applicable, without counting them as passes or installing them.
- Preserve the default traditional eight-check response and common failure
  detection. Device health does not attest dot rule files, provenance, actual
  session reads or native admission; their independent checks remain required.

---

[Module directory](Release-Notes-3.3.1.md)

# Einzbern 3.3.0: Requirements and acceptance evidence

[Release notes](Release-Notes.md) > [Einzbern 3.3.0](Release-Notes-3.3.0.md)

Previous: [Structured work and lifecycle](Release-Notes-3.3.0-Structured-Work-and-Lifecycle.md) | Next: [Atelier and work context](Release-Notes-3.3.0-Atelier-and-Work-Context.md)

- Track stable requirement, source and acceptance identities and versions.
  Allocate implementation and verification responsibilities to direct children,
  preserving shared inheritance and exact source references.
- Record approved content changes and their effects on live descendants and
  acceptance evidence. Allocation-only changes and formerly shared requirements
  remain subject to the same decision and impact checks.
- Bind completion evidence to its requirement, acceptance, structural content
  version and code candidate. Preserve explicitly supplied and historical
  digests; changed meaning cannot silently reuse an earlier result.
- Accept the equivalent ordering of exactly two implementation/verification
  responsibilities without changing stored digests. Failed and unverified
  observations still block completion under the same matching rule.
- Keep machine linkage, source/behavior review and Owner visual evidence distinct.
  Identifiers and matching hashes do not establish the truth of a source or the
  semantic correctness of a result.

---

[Module directory](Release-Notes-3.3.0.md)

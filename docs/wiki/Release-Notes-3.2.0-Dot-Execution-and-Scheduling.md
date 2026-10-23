# Einzbern 3.2.0: dot execution and scheduling

[Release notes](Release-Notes.md) › [Einzbern 3.2.0](Release-Notes-3.2.0.md)

Previous: [Model policy and configuration recovery](Release-Notes-3.2.0-Model-Policy-and-Configuration-Recovery.md) · Next: [Verification and release integrity](Release-Notes-3.2.0-Verification-and-Release-Integrity.md)

- Add source-bound native execution, shared submission and configuration guidance
  for dot while preserving existing host paths. Requested work, returned reports,
  observed terminal outcomes and acceptance remain distinct states.
- Evaluate context patrol and daily backup state using actual scheduler identity,
  causal action observations and fresh readbacks. An unknown create, pause or
  resume result requires reconciliation; duplicate observations do not establish
  multiple scheduler instances.
- Scheduling support evaluates state and prerequisites. It does not create an
  automation or establish real scheduler integration by itself. Fixture results
  and observed host results remain separate; full real-host fallback and the
  complete supported-host matrix are not claimed by this release.

---

[Module directory](Release-Notes-3.2.0.md)

# Einzbern 3.2.0: Model policy and configuration recovery

[Release notes](Release-Notes.md) › [Einzbern 3.2.0](Release-Notes-3.2.0.md)

Previous: [Native execution and authorized fallback](Release-Notes-3.2.0-Native-Execution-and-Authorized-Fallback.md) · Next: [dot execution and scheduling](Release-Notes-3.2.0-Dot-Execution-and-Scheduling.md)

- Save an approved model-policy choice separately from temporary execution, with
  per-host compare-and-swap, idempotent operation receipts, bounded lock waiting
  and read-only outcome reconciliation after an uncertain save result.
- Offer optional fallback recommendations from supported candidates and available
  evidence. Missing recommendation or quota telemetry does not establish missing
  execution capability, and unknown cost or actual model identity stays unknown.
- Add shared configuration backup, retention and restore contracts with explicit
  project and device scope, verification evidence and recovery boundaries.
  Preserve pending backup inventory and restore responsibility when evidence is
  incomplete.

---

[Module directory](Release-Notes-3.2.0.md)

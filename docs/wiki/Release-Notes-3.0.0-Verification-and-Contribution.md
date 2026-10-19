# Einzbern 3.0.0: Verification and contribution workflow

[Release notes](Release-Notes.md) › [Einzbern 3.0.0](Release-Notes-3.0.0.md)

Previous: [Hosts and installation](Release-Notes-3.0.0-Hosts-and-Installation.md)

- Fork, PR and main P1 now scan full reachable Git history, not a PR-only increment.
  Narrow structural classification of public noreply identity headers and standard
  merge-account slots does not exempt names, branch/body payloads or secret patterns.
  Previously reviewed exact historical exceptions remain unchanged.
- Batch fixes and generated outputs before candidate freeze. Verify the candidate
  in the fork before advancing the contribution PR, then retain the upstream checks
  under their own commit identities. This does not authorize repeated unrelated CI.
- Baseline merge `8c6af763c338e815922036391a481fe58bc7d713` has complete P1 and
  isolated package/install/setup/doctor receipts. These are valid baseline evidence,
  not a future 3.0.0 release receipt. Original formal P8/H1 receipts keep their
  original commits; private PF3/U18 and native acceptance remain explicitly scoped.

---

[Module directory](Release-Notes-3.0.0.md)

# Einzbern 3.2.0: Verification and release integrity

[Release notes](Release-Notes.md) › [Einzbern 3.2.0](Release-Notes-3.2.0.md)

Previous: [dot execution and scheduling](Release-Notes-3.2.0-Dot-Execution-and-Scheduling.md) · Next: [Skill guidance and compatibility](Release-Notes-3.2.0-Skill-Guidance-and-Compatibility.md)

- Derive CI task selection from the complete change set, explicit consumer
  mappings and a verified comparison baseline. Shared runtime, policy, dependency,
  unknown or incomplete changes use full verification; manual and release checks
  remain full.
- Include executable template interpolations, tagged calls, referenced bindings
  and indirect intrinsic mutation in frozen consumer auditing. Later document
  changes cannot inherit an unchanged audit after a consumer starts reading them.
- Keep the consumer audit valid across a normal release version update while
  preserving every non-version source byte and full release verification. Include
  the merged native execution and fallback root tests in the Portal consumer map.
- Independently rederive the final verification plan and bind selected task
  coverage, retained bytes and official artifact transport to the same commit,
  run and attempt. Missing, failed, cancelled or mismatched evidence stays a
  failure; selective success is distinct from full P1 coverage.
- Retain bounded controller diagnostics and actual failed-task output across Core
  and Portal verification. Preserve normal and failure Actions summaries. The
  artifact upload/download updates are verified through the official transport.
- Recognize bounded public Dependabot terminal signoff metadata in privacy checks
  while retaining source, archive and reachable-history verification.

---

[Module directory](Release-Notes-3.2.0.md)

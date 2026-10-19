# Einzbern 3.0.0: Hosts and installation

[Release notes](Release-Notes.md) › [Einzbern 3.0.0](Release-Notes-3.0.0.md)

Previous: [Configuration, knowledge and recovery](Release-Notes-3.0.0-Configuration-Knowledge-and-Recovery.md) · Next: [Verification and contribution workflow](Release-Notes-3.0.0-Verification-and-Contribution.md)

- New installed `execution-prepare` and `execution-record` commands automate
  task/project/policy binding and private create-new evidence records from
  machine-supplied observations and actual process returns. Refusals, unavailable
  observations and nonzero exits remain explicit. The existing `execution-evidence`
  validator remains read-only. These commands do not install native collectors,
  launch agents or authenticate caller evidence; unsupported host modes must be
  reported once, not converted into repeated user JSON/approval chores.
- DeepSeek Harness is recognized as `dsh` for recall and host configuration. Its
  plugin owns hook invocation; Einzbern does not install a DSH hook file. This does
  not certify an automated DSH development-dispatch adapter.
- Installer handling rejects invalid absolute roots and preserves the primary
  install error when cleanup also fails. Generated Mana Orchestrate content must
  be regenerated from the final engine and released with the same version.
- Preserve the helper's tracked `skill/mana-orchestrate/scripts/create-skill-archive.mjs`
  through the formal generator's explicit `--keep-extra` option.

---

[Module directory](Release-Notes-3.0.0.md)

# Codex handoff and report delivery

Einzbern / Mana Orchestrate 4.4.0.

- Install Codex PostToolUse and Stop hooks through the same setup, update and
  repair path as the existing engine hooks. Keep SubagentStop collectors retired.
- Use validated peer-batch receipts to stop a main conversation from repeatedly
  querying its coordinator after a successful handoff in the same turn. Explicit
  Owner input starts a new turn; unrelated targets and coordinator work remain available.
- Remind a coordinator to follow Mana Orchestrate when its recorded batch is
  terminal and ready to report but no delivery has been attempted. Repeated Stop
  and uncertain delivery outcomes end normally. A local final reply is not a
  cross-conversation send; retain the actual message receipt.
- Keep these guards conditional on existing batch evidence. They add no project
  fields, global polling quotas, automatic messages or model-stop guarantees.

[Back to 4.4.0](Release-Notes-4.4.0.md)

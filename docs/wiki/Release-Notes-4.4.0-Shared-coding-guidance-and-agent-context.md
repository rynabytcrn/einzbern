# Shared coding guidance and agent context

Einzbern / Mana Orchestrate 4.4.0.

- Publish the engine-owned coding guide through the existing Skill navigation
  and packaged references for supported hosts and models. Prefer readable control
  flow, explicit boundaries and changes justified by current behavior.
- Simplify configuration-backup and archive control flow while retaining their
  safety and recovery contracts. Keep generated helper files tied to their engine source.
- Bound agent-facing CLI context explicitly and retain a way to obtain complete
  evidence. A smaller response alone does not establish lower session cost.

[Back to 4.4.0](Release-Notes-4.4.0.md)

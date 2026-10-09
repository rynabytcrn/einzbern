# Einzbern 2.0.1 发行说明：迁移

[发行说明](Release-Notes.md) › [Einzbern 2.0.1](Release-Notes-2.0.1.md) › 模块 3/4：迁移

上一模块：[Atelier](Release-Notes-2.0.1-Atelier.md) · 下一模块：[发行与仓库工具](Release-Notes-2.0.1-Release-and-Repository-Tooling.md)

## A migration binds a project's configuration to the old chain's project its mapping row names

A migration binds a project's configuration to the old chain's project its mapping row names,
instead of creating a project of setup's own beside it (TCRN-CROSS-STORY-517, INIT-053 R50; fixes
TCRN-CROSS-STORY-489). A mapping row takes `projectId` (`project:` and 24 hexadecimal digits); a
malformed one, or one on a coordination row, refuses with `SETUP_ANSWER_INVALID` on `projectId`. The
plan gives every partition `projectId` and `projectCandidates`, the old chain's live projects as
`{id, name, externalKey, work}`, and blocks with `SETUP_ANSWER_INVALID`, listing them, when a row's
project is not live in its old chain (or in a library migrated before), or when the `--project`
partition's row has `chainRole` `project`, its old chain holds live projects and the row names none;
a row without `chainRole` may name one and otherwise keeps the former behaviour. The registry entry
records the row's project as `projectId`, and a project chain's identity as `primaryProjectId`,
which an identity migrated without one gets on the next run and an identity naming another stops
with `SETUP_LIBRARY_CONFLICT`; the `--project` partition's language and managed sections go to that
project. Running the migration again with the coordination row and the project's row, now naming its
project, repairs a library an earlier migration gave a second project: the plan and the
`SETUP_APPLIED` receipt carry `migration.projectBinding` (`partition`, `library`, `from`, `to`,
`retirement`), and the former project, when setup created it (external key `SETUP-CONFIG-`) and
nothing but its language and managed-section records is in it, loses them and is deleted once the
binding has moved; otherwise it is kept and `retirement.holds` says why. No CLI verb is added.
`docs/wiki/Migrating-from-TCRN-Workflow.md` and the skill's `references/migrate.md` describe the
field, the candidates, the blockers and the repair.

## The Wiki migration page says which libraries record who wrote an event

The Wiki migration page says which libraries record who wrote an event, instead of saying every
record a migration writes is signed `agent:setup` (TCRN-CROSS-STORY-518, INIT-053 R50; fixes
TCRN-CROSS-STORY-489). An event's payload carries `actor` only in a library whose chain enabled
actor attestation (its old chain carries `attestation.actor.enabled`), from that event on: there the
language, managed-section, chain-identity and settings records a migration writes carry
`agent:setup`, Atelier's writes carry `TCRN_PORTAL_ACTOR` (default `agent:portal`) and the CLI's
carry `--actor`; the coordination library migrated from cross-project is one. A library whose old
chain never enabled it, such as TCRN-TMS, records no writer: the chain identity and settings records
setup writes there hold only `operation` and `record`, and Atelier and the CLI take their actor
without writing it into the event; a record that names its operator in its own value, such as a gate
release, still does. `event-list` shows whether a library's event payloads carry `actor`. The engine
is unchanged: it writes no actor before attestation is enabled, has no verb that enables it for an
existing library, and leaves old events' bytes as they are.

---

[返回模块目录](Release-Notes-2.0.1.md) · 上一模块：[Atelier](Release-Notes-2.0.1-Atelier.md) · 下一模块：[发行与仓库工具](Release-Notes-2.0.1-Release-and-Repository-Tooling.md)

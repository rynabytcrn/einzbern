# Einzbern 2.0.3 发行说明：Atelier

[发行说明](Release-Notes.md) › [Einzbern 2.0.3](Release-Notes-2.0.3.md) › 模块 4/7：Atelier

上一模块：[工作租约](Release-Notes-2.0.3-Work-Leases.md) · 下一模块：[Mana Orchestrate 技能](Release-Notes-2.0.3-Mana-Orchestrate-Skill.md)

## Atelier starts only with `TCRN_PORTAL_ACTOR` set

Atelier starts only with `TCRN_PORTAL_ACTOR` set (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-454,
EPIC-149 R1). The variable has no default any more: unset or empty, Atelier refuses to start with
one JSON line on stderr whose `reasonCode` is `PORTAL_ACTOR_REQUIRED`, and exit code 2. The
launchers it generates name no actor; they pass the variable on from the environment they run in and
refuse the same way without it. Every write Atelier makes runs the engine with
`EINZBERN_SURFACE=atelier`, so the configuration events it appends record `surface: atelier` beside
that actor.

## The work page shows each lease on the leased item's row with its holder and expiry, and its release button releases the lease by force as `TCRN_PORTAL_ACTOR`

The work page shows each lease on the leased item's row (an Initiative's or an Epic's on its group
heading) with its holder and expiry, and its release button releases the lease by force as
`TCRN_PORTAL_ACTOR` (TCRN-CROSS-STORY-528, TCRN-CROSS-SUB-459, EPIC-149 R1). Atelier's own writes
are held by another actor's lease like any other, so it releases that lease first.

## The Atelier tests, and the release pack test that starts the packed Atelier, now set `TCRN_PORTAL_ACTOR` to a test value, `agent:test-portal`

The Atelier tests, and the release pack test that starts the packed Atelier, now set
`TCRN_PORTAL_ACTOR` to a test value, `agent:test-portal` (TCRN-CROSS-STORY-526, TCRN-CROSS-SUB-454,
EPIC-149 R1).

---

[返回模块目录](Release-Notes-2.0.3.md) · 上一模块：[工作租约](Release-Notes-2.0.3-Work-Leases.md) · 下一模块：[Mana Orchestrate 技能](Release-Notes-2.0.3-Mana-Orchestrate-Skill.md)

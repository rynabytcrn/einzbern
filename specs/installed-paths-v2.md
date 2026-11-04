# Portable installed paths

Installed artifacts must not embed the installer's home, checkout or device directory.
Persistent filesystem references use forward-slash relative paths with an explicit base.
Runtime APIs resolve those references on the current device; resolved diagnostic values and
arguments are observations, not portable configuration to copy into another installation.

| Stored reference | Base |
| --- | --- |
| Registry project, library and migration paths | Directory containing registry.json |
| Skill copy paths | Directory containing skills.json |
| Path-valued machine settings | Directory containing machine-settings.json |
| Shared library/runtime pointer and transport receipts | Device directory |
| Claude additionalDirectories | Project root |
| Codex writable_roots | Directory containing .codex/config.toml |
| Hook launcher | EINZBERN_HOME when set; otherwise the device's relative location from the current home |
| Dot binding root | Target root (stored as a dot) |
| Other dot bindings and AGENTS readback | Dot target root |
| Dot options root | Directory containing the options JSON file |
| Dot options engine and Skill sources | Directory containing the options JSON file |

Registry, Skill records, machine settings and shared-storage pointers write v2 formats.
Readers accept legacy v1 records and resolve their absolute paths for compatibility; supported
writes normalize them. Repair normalizes an intact legacy registry and Skill record even when
its content and destinations did not otherwise change. Old engines that only understand v1
must be updated before consuming these device records; restoring an older engine also needs
its matching device configuration backup. Shared event history is not rewritten.

Moving an installation preserves bindings when the relative layout is preserved. A different
layout requires re-registration or setup repair with the newly selected locations. Relative
paths cannot represent different Windows volumes; refuse that binding instead of silently
persisting an absolute fallback. Native Windows relocation remains a separate verification.

Preserve user-owned text, modified sections and historical evidence byte-for-byte. Do not
rewrite an unknown path in a knowledge card by guessing its project. New knowledge should name
a stable project/work/decision identifier and a repository-relative evidence location. Runtime
identity and path resolution do not turn an unverified remote sync into a verified one.

Fresh-install acceptance scans all generated files for the actual fixture and source roots,
checks relative symlinks, moves the complete installation, then runs its installed CLI, doctor
and generated Hook command. This demonstrates observed execution, not just a text match.

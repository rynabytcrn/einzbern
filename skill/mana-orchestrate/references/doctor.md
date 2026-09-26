# Doctor: check an installation and handle what fails

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

`doctor` only reads. Run `doctor --project <dir>` inside a project, where `--project` is the root
of the project, or plain `doctor` to check this device alone. It returns eight items, each
`{check, ok, reasonCode, detail}`; the same eight come back as `selfCheck` after every `setup`
apply. Run the engine verbs below the way SKILL.md says to invoke the engine.

## Report

Show all eight checks in one short table, ok or not. For each check that is not ok, quote its
reasonCode and detail as they are, say in one plain sentence what it means, and give the handling
below. Fix nothing before the user agrees.

## The eight checks

### engine-version

This device's current engine is installed intact and is new enough for the library. A library
that needs a newer engine (`ENGINE_TOO_OLD`): update with `update.md`. A pointer to the current
engine that cannot be read (`ENGINE_CURRENT_INVALID`): repair.

### hooks-present

Both hosts' settings carry the Einzbern hook command. When it is missing or changed: repair.

### skill-copies

The skill copies for both hosts match what this device recorded for them. When a copy is missing
or differs: repair, which backs up a copy the user changed before it replaces it.

### registry

This device's registry maps the project to its library, and the library found is the one it
recorded. No entry for the project (`LIBRARY_NOT_REGISTERED`): restore with `restore.md`, or
install with `install.md` when the project has no library yet. No library at the recorded place,
or another one (`LIBRARY_NOT_FOUND`, `LIBRARY_REGISTRY_MISMATCH`): find the right library, or let
a cloud drive finish syncing, then restore. A library that moved (`LIBRARY_TOMBSTONED`, naming the
new place): restore from the new place.

### library-format

This engine can open the library's format. A library newer than this engine
(`LIBRARY_FORMAT_UNSUPPORTED`, `ENGINE_TOO_OLD`): update with `update.md`. Never edit the library's
manifest.

### device-stream

This device's own event stream in the library is in order and belongs to this device alone. When
it is not: stop and report it to the user. Do not edit, move, or copy anything inside the
library, and do not copy this device's directory to another device.

### managed-sections

The managed sections in the project's instruction files match their records. A section changed by
hand waits as pending: ask the user once whether to overwrite it, keep it, or stop managing it,
and apply the choice with the managed-section verb that the engine's `commands` catalog lists. A
section whose markers were removed stays removed. A file with a broken marker
(`MANAGED_SECTION_MALFORMED`, whose detail names the line) is not written at all until the user
fixes that line.

### cloud-flag

The cloud-drive flag matches where the library sits. When it does not: ask whether the library's
folder is synced by a cloud drive, then repair with `--cloud true` or `--cloud false`.

Any other reasonCode: quote it with its detail, apply the handling of its check, and if that does
not fit, stop and ask the user.

## Questions (one screen)

Doctor asks nothing before it runs. After the report, gather every decision the failed checks
need, such as a managed-section choice, the cloud-drive answer, or update against repair, into
one screen. The list is the same on both hosts: Claude Code asks it in one AskUserQuestion call,
Codex asks it in the conversation as one numbered message. Never guess an answer.

## Fix, then check again

A fix that writes files runs as its `setup` mode, with `--project <dir>` and `--at <UTC>`, the
current instant written `YYYY-MM-DDTHH:MM:SSZ`. Plan it without `--yes`, which returns
`SETUP_PLAN_READY`; as the final confirmation, show the files the plan lists and ask once; apply
with `--yes true` only on a clear yes. Then run `doctor` again and report the new result.

## Flags

| Purpose | Command or flag |
| --- | --- |
| Check this device and the project | `doctor --project <dir>` |
| Check this device only | `doctor` |
| Put back hooks, skill copies, the engine pointer | `setup --mode repair` |
| Move to a newer engine | `setup --mode update` |
| Cloud-drive answer | `--cloud true` or `--cloud false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

Doctor never writes. The fixes never commit, push, edit `.gitignore`, or delete anything, and
neither do you during this task.

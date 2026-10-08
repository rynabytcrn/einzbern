# Doctor: check an installation and handle what fails

Load this reference only during an install-type task (install, restore, update, repair, rollback,
migrate, uninstall, or doctor); do not load it for any other work.

`doctor` only reads. Run `doctor --project <dir>` inside a project, where `--project` is the root
of the project, or plain `doctor`, which takes the current directory as the project. It answers
`DOCTOR_READY` with `ok` and eight items, each `{check, ok, reasonCode, detail}`; the same eight come
back as `selfCheck.checks` after every `setup` apply. Run the engine verbs below the way SKILL.md
says to invoke the engine.

## Report

Show all eight checks in one short table, ok or not. A check that is not ok has one reasonCode of
its own, and `detail.causes` names what made it so; quote both, and the rest of the detail, as they
are. Say in one plain sentence what it means and give the handling below. Fix nothing before the
user agrees.

## The eight checks

### engine-version

This device's current engine is installed intact and this Node.js is new enough. Not ok:
`DOCTOR_ENGINE_NOT_READY`. No engine is current (`ENGINE_CURRENT_MISSING`): install one with
`install.md`. The pointer to the current engine cannot be read (`ENGINE_CURRENT_INVALID`) or its
version directory is gone (`ENGINE_VERSION_MISSING`): update with `update.md`, or roll back. The
stable entry is missing (`ENGINE_ENTRY_MISSING`): repair. Node.js is older than the engine needs
(`ENGINE_NODE_TOO_OLD`): the user upgrades Node.js.

### hooks-present

Both hosts' settings carry the one Einzbern hook, as the engine renders it, and the launcher it
runs is there. Not ok: `DOCTOR_HOOKS_MISMATCH`. Missing (`HOOK_MISSING`), more than one
(`HOOK_DUPLICATED`), changed (`HOOK_NOT_AS_EXPECTED`), a hook of the old platform left in place
(`HOOK_LEGACY_PRESENT`), or no launcher (`HOOK_LAUNCHER_MISSING`): repair. A settings file that is
a symbolic link (`HOST_HOOKS_FILE_UNSUPPORTED`) is left alone; ask the user what to do with it.

### skill-copies

The skill copies for both hosts match what this device recorded for them. Not ok:
`DOCTOR_SKILL_COPIES_MISMATCH`. No record (`SKILL_COPIES_NOT_RECORDED`), an unreadable record
(`SKILL_COPIES_RECORD_INVALID`), or a copy that is missing or differs (`SKILL_COPIES_DRIFTED`):
repair, which backs up a copy the user changed before it replaces it. The old helper's copies are
still there (`SKILL_COPIES_LEGACY_PRESENT`): `migrate.md`.

### registry

This device's registry maps the project to its library, and the library found is the one it
recorded. Not ok: `DOCTOR_REGISTRY_UNRESOLVED`. No entry for the project
(`LIBRARY_NOT_REGISTERED`): restore with `restore.md`, or install with `install.md` when the
project has no library yet. No library at the recorded place, or another one
(`LIBRARY_NOT_FOUND`, `LIBRARY_REGISTRY_MISMATCH`): find the right library, or let a cloud drive
finish syncing, then restore. A registry or manifest that does not read
(`LIBRARY_REGISTRY_INVALID`, `LIBRARY_MANIFEST_INVALID`): stop and report it.

### library-format

This engine, and the engine this device has current, can open the library's format. Not ok:
`DOCTOR_LIBRARY_UNSUPPORTED`. A library newer than the engine (`LIBRARY_FORMAT_UNSUPPORTED`,
`ENGINE_TOO_OLD`): update with `update.md`. Never edit the library's manifest.

### device-stream

This device's own event stream in the library can be written. Not ok:
`DOCTOR_DEVICE_STREAM_UNWRITABLE`. The library was moved (`LIBRARY_TOMBSTONED`, naming the new
place): restore from there. The library's lock is held by another process (`FILE_LOCK_TIMEOUT`):
try again when it is done. The folder cannot be written (`STREAM_DIRECTORY_UNWRITABLE`,
`AKASHA_DIRECTORY_MISSING`): stop and report it to the user. Do not edit, move, or copy anything
inside the library, and do not copy this device's directory to another device.

### managed-sections

The managed sections in the project's instruction files match their records. Not ok:
`DOCTOR_MANAGED_SECTIONS_MISMATCH`. A section changed by hand waits as pending
(`MANAGED_SECTION_PENDING`, the sections listed in `detail.pending`): ask the user once whether to
overwrite it, keep it, or stop managing it, and apply the choice with the managed-section verb that
the engine's `commands` catalog lists. `RESTORE_SECTIONS_DIVERGED`'s `detail.section` (comma-separated
when multiple) and doctor's `detail.pending` name managed sections as `<file>#<section id>` (for
example, `AGENTS.md#navigation`); pass only the part after `#` (here, `navigation`) to
`rule-resolve --section`, because a file-prefixed value writes nothing (`keep` and `unmanage` return
`MANAGED_SECTION_INPUT_INVALID`, and `overwrite` returns `MANAGED_SECTION_ACTION_INVALID` because
the engine does not write that section), so remove the prefix and retry with the same choice. A
section whose markers were removed stays removed. A file
with a broken marker (`MANAGED_SECTION_MALFORMED`, whose detail names the line) is not written at
all until the user fixes that line. A file the engine cannot write sections into, because it is a
symbolic link (`CLAUDE.md` pointing at `AGENTS.md`, say) or another kind of non-regular file, or is
not UTF-8 text (`MANAGED_SECTION_FILE_UNSUPPORTED`, the file named in `detail.problems`), turns
the check red only while the library records a section in it; with none recorded, the file is
listed in `detail.skipped` and the check stays ok. Leave such a file alone and ask the user what
to do with it.

### cloud-flag

The cloud-drive flag matches where the library sits. Not ok, as a hint only:
`DOCTOR_CLOUD_FLAG_MISMATCH` (`CLOUD_FLAG_DIFFERS_FROM_SUGGESTION`). Ask whether the library's
folder is synced by a cloud drive, then repair with `--cloud true` or `--cloud false`.

A check that met an error carrying no reason code of its own names `DOCTOR_CHECK_FAILED` among its
causes; when the check stopped on it, `detail.error` holds the message, and the checks after it
still ran. The cause is not known, so no fix above applies: quote the detail as it is, fix
nothing, and report it to the user.

Any other cause: quote it with its detail, apply the handling of its check, and if that does not
fit, stop and ask the user.

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

## A hook that answers nothing

The hook answers a prompt only in a project this device's registry holds; anywhere else it ends
with exit code 0 and prints nothing. When that directory lies in a known container the registry
does not cover (a library, an old-layout workspace or an old platform container), the launcher
also appends one line to `log/hook.ndjson` in the device directory, which is `.einzbern` in the
user's home unless `EINZBERN_HOME` names another place. Each line is one JSON object with
`schemaVersion` (`einzbern.hook-log.v1`), `at`, `event`, `cwd`, `container`, `marker` (`library`
or `legacy`) and `reasonCode`:

| reasonCode | What it means | Fix |
| --- | --- | --- |
| `HOOK_REGISTRY_ABSENT` | This device has no registry, or an empty one: Einzbern was never set up here. | the `setup` mode the project needs |
| `HOOK_PROJECT_UNREGISTERED` | The directory is in an old-layout workspace or platform container that no registered project holds. | `setup --mode migrate` |
| `HOOK_LIBRARY_UNREGISTERED` | The directory's library is not in this device's registry. | `setup --mode restore` |

Read the last few lines to see why the latest prompts got nothing. The file grows only while
prompts keep landing in such a place, and deleting it loses nothing. No new line means the
directory is in no known container, or the hook never ran: check `hooks-present`.

## Flags

| Purpose | Command or flag |
| --- | --- |
| Check this device and the project | `doctor --project <dir>` |
| Check with the current directory as the project | `doctor` |
| Put back the hooks, the skill copies, the launchers, the registry entry | `setup --mode repair` |
| Move to a newer engine | `setup --mode update` |
| Cloud-drive answer | `--cloud true` or `--cloud false` |
| Yes at the final confirmation | `--yes true` |

## Boundaries

Doctor never writes. The fixes never commit, push, edit `.gitignore`, or delete anything, and
neither do you during this task.

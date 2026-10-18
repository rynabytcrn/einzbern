# Running the portal's checks

The portal's suite starts real processes: a governed scratch workspace, the real
CLI, the real portal server. That is the point — the property under test is that
the portal's numbers come from the engine and not from a stub.

It is therefore **a sibling step, never a nested one**. `scripts/task.mjs` holds
an exclusive output session for the length of its run, so a CLI spawned from
inside `pnpm test` cannot acquire one and returns nothing. Run them in sequence:

```sh
pnpm test          # the engine suite
pnpm portal:test   # the portal suite, in its own session
pnpm portal:proof  # design + i18n + dependency audit
```

`portal:proof` validates the checked-in design-system snapshots, their declared
digests, the locale contract, and the product's literal translation references.
It runs without a sibling design-system checkout and fails on missing or drifting
inputs. Upstream synchronization is a separate, explicitly scheduled comparison;
absence of that checkout is never a successful skip of these local checks.

R43 regression inputs: independent libraries with equal names and distinct
design/build/language/model settings; coordination work referencing both;
undecided/coordination-only/selected edits and stable-reference filtering;
missing registration and deleted targets; A→B save→reload→A isolation; stale
work revision and selection epoch; navigation anchors, full identity disclosure
and Escape focus return. Existing five-language/theme and narrow-width browser
matrices apply to the new controls. These are cases within existing acceptance.

Project-chain regressions cover the actual fresh coordination registration
(project directory equals library directory), switching back from a concrete
project, absent prose output, and stale unregistered targets across every
mutation family. Portal mutation transactions hold the device registry lock
through the CLI write; register/unregister/repoint use that same lock. Selection
is excluded while a target write holds it, and requests waiting on the lock
revalidate their selection epoch and stable binding. The CLI retains its own
library lock and work-revision check. This is process coordination, not human
authentication. Run these tests with the rebuilt current core; source presence
alone is not evidence that they passed.

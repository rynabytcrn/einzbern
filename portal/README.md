# Atelier

Atelier is Einzbern's local, zero-dependency portal for the parts of Einzbern a person
configures most: workspace settings, the canonical `AGENTS.md` prose, and a
reconciliation check between the two.

The portal ships inside the engine, beside `scripts/einzbern.mjs`, and runs from any
installed engine copy or checkout. There is no package dependency to install and nothing
to build.

```bash
node <engine>/portal/portal.mjs                      # the library of this directory's project
node <engine>/portal/portal.mjs --library <library>  # or a registered library by path or id
# → http://127.0.0.1:4319/
```

Atelier opens the libraries this device has registered (`library-register`, read back
through `library-list` from the device directory's `registry.json`). The page lists
every registered library by its project path and library id and switches the live CLI
read/write target from its selector. It starts on the library `--library` names;
without it, on the library `library-resolve` finds from the directory it was started
in, then on the machine's default library, then on the first registered one.

## What it is

Two files do the work: `index.html` (a self-contained page — inline CSS and JS,
no bundler, no framework, no external request) and `portal.mjs` (a Node server
using only the standard library). The portal reads the registry through the CLI;
it does not import the engine or write a library itself.

## The boundary it keeps

The portal owns no governance logic. Every settings read and write is a child
process call to the public CLI (`settings-catalog`, `settings-set`), so a value
on screen is the engine's answer and a write is answered with the engine's own
receipt — reason code, chain version, receipt digest, head event hash. The
portal never imports an engine package, never touches a control tree, and never
writes a chain file itself. `scripts/dependency-audit.mjs` proves the first of
those over the whole repository and fails if any source file imports an engine
internal.

`AGENTS.md` is ordinary repository prose, so the prose surface edits it with
plain file I/O: the file in the selected library's registered project, never one
inside a library. It is the one canonical home for custom rules; per the platform
convention it defines *how work is done*, never *who may decide*.

## Why a process rather than a bare page

Opening `index.html` from disk would drop the three things that make this more
than a mockup: a live catalog instead of a snapshot, a real receipt instead of a
rendered guess, and a reconciliation that actually runs. Governed writes name an
actor the process declares and are serialised by the engine's own lock — a browser
cannot supply the first.

## Safety

The server binds `127.0.0.1` only. Each run mints a token, injects it into the
page, and refuses any mutating request without it, so another page in the same
browser cannot post to it. The acting identity is declared at startup
(`TCRN_PORTAL_ACTOR`, default `agent:portal`); a browser payload can never
nominate who wrote to a chain.

## Languages

The portal ships copy for every locale the platform supports — `zh-CN`, `en`,
`ja`, `ko`, `fr`. The locale contract originates in `@tcrn/ui-copy-state` and is
frozen into `locale-contract.mjs`, the same arrangement `tokens.css` already uses
for the token bytes: the design system is the source of truth at development time
and is not present at runtime. A running portal reads nothing outside its own
directory, so nobody has to check out the design system to open a settings page. That contract marks all five `copyCoverage: "required"`, so
`scripts/i18n-proof.mjs` fails on a missing key rather than filing it as a gap.
The picker follows the browser's languages on first run and remembers the
choice; each locale also points `--tcrn-type-family-ui` at its script's family,
following the design system's own pattern.

Engine reason codes are never used as interface labels (the contract sets
`rawEnumLabelsAllowed: false`). They appear in the receipt panel, marked as
evidence, where reproducing them verbatim is the point.

## Surfaces

- **Config** — the registered settings catalog; commit one change and keep its receipt beside the CLI readback.
- **Prose** — read and write the canonical `AGENTS.md`.
- **Reconcile** — every setting key the prose claims, checked against the keys the engine registers; red when prose names one that does not exist.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--library` | `TCRN_PORTAL_LIBRARY`, else the working directory's library | A registered library (its path or id, or its project's path) to open first |
| `--port` | `TCRN_PORTAL_PORT`, else the `portal.port` machine setting, else `4319` | Loopback port (`0` picks a free one) |
| `TCRN_PORTAL_ACTOR` | `agent:portal` | Actor recorded on governed writes |
| `TCRN_WORKFLOW_CLI` | `scripts/einzbern.mjs` beside the portal | CLI entry point |

## Launchers

The launcher generator writes ordinary, reviewable files into `--output-dir`, an
existing directory that defaults to the one holding `portal/` (the engine copy the
portal runs from); no setup step runs it. Paths are absolute and the files are
never symlinks:

```bash
node <engine>/portal/scripts/generate-launchers.mjs \
  --output-dir "/path/to/launchers" \
  --library "/path/to/project/.ether" \
  --port 4319
```

`--library` is optional: a launcher without it opens the library of the directory
it runs in, then the machine's default library, then the first registered one.
The partition, container, prose-root and workspace arguments of the old portal are
gone (TCRN-CROSS-STORY-482 R3); neither the generator nor `portal.mjs` reads them,
so regenerate a launcher that still passes them with the command above.

This generates `atelier.command` for macOS,
`atelier.sh` for Linux, and `atelier.cmd` for
Windows. The Windows launcher shape is generated here; full Windows-host
runtime validation remains a separate verification item.

The portal's remote creation is intentionally not part of this local
installation. It remains `未证——归门户仓建 remote/Owner` until the explicit
publication ceremony.

## Checks

```bash
npm run proof             # design + i18n + dependency audit + tests
npm test                  # portal against a real governed scratch workspace
npm run design:proof      # tokens byte-identical to @tcrn/ui-tokens; no literal colours
npm run i18n:proof        # locale set, key coverage, placeholder consistency
npm run audit:dependencies
npm run demo:e2e
```

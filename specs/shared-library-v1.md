# Shared library and centralized installation

A format-3 library may hold coordination and development projects together. Its global chain
identity has role `shared`; each existing project's identity, settings and configuration retain
explicit project scope. No directory name implies a project binding. The default folder name is `Ether`. The user chooses its parent on any filesystem;
`storage-configure` records the selected location on this device. Fresh setup reuses a shared library and declares a separate project.
An explicit location remains an explicit choice. Engine 3.0.0, which reads through format 2,
refuses the new format before taking a write lock.

`workspace-consolidate --mapping <file> --to <empty directory> --actor <actual actor>
--decided-in <decision> --at <instant>` plans; `--yes true` applies. The mapping explicitly names
one coordination primary and every source's project-path/project-id/role bindings. It preserves
the primary library ID so device-policy decisions remain resolvable. The root manifest commits
`artifacts/consolidation/index.json` by SHA-256. The index records source manifests, heads,
version vectors, project bindings, file inventory, actor, instant and decision reference.

The sources' original Akasha segments, manifests and crest data are immutable provenance under
`artifacts/consolidation/<source-id>/`. The original root manifest is named `source.json` there:
these archives are not separately writable libraries. Event IDs, hashes, timestamps, actors and
knowledge bodies are not re-authored. Replay validates each source independently (including its
actor-enablement boundary), maps its library defaults into its declared project scopes, then
replays subsequent shared-library writes. The shared engine requirement is the maximum of the source minimum versions; each original
declaration remains in its source archive. Other library-only setting disagreements and record-ID
collisions fail closed. Native stream vectors remain native; the shared head also commits the
provenance index. Export includes original events and provenance, separately from subsequent
native events. The registry resolves old project-reference library IDs to the shared identity.

A device journal binds preparation, verification, source guards, registry publication and host
wiring. Locks cover all source writers in stable order. A target stays guarded until publication;
a retry accepts only unchanged sources and transaction-owned files. The registry is replaced once,
with a backup and comparison against the captured source entries. Host wiring replaces exactly
those old library write roots, preserving unrelated paths and settings. A changed source, occupied
target, symlink, conflicting project binding or altered archive refuses publication.

Project-scoped recall in a shared library filters work, minutes and cards; the global shared
identity remains authoritative even when a project-specific identity is effective. A fresh shared
library's global workspace/role cards remain visible to every project. Legacy libraries keep their
library-wide corpus when a project selects configuration. Workspace/role knowledge imported from a
former project library keeps its original metadata, with its migration scope derived from the
committed source binding; it does not become another project's knowledge by accident. Explicit
whole-library reads remain available. Original knowledge chain references validate against the
preserved source streams, and a subsequent card update is a normal new crest event.

`storage-configure --library <shared library> --runtime <device-specific directory> --at <instant>
--decided-in <decision>` plans; `--yes true` relocates cache, locks and backups and writes the
persistent device pointer. Forwarding directory links preserve historical evidence paths without
keeping another data copy. Device identity, credentials, registry, engine installations and host
model policies remain device-local. A runtime directory belongs to one device; devices do not
share a write lock or identity through cloud sync. The local pointer is not a cloud-sync receipt.

The shared root retains `akasha/`, `crest/`, `config/` and `artifacts/`. Device runtime
uses `Ether/.einzbern/<device-id>/` and is excluded from library snapshots and record
relocation. Device identities, registries, host policies and installed engines remain local.
`storage-consolidate` plans and applies verified library/runtime relocation, preserves
source receipts and evidence, and retires only the exact verified old roots.
`library-readme-refresh` archives the previous generated README before replacing it.

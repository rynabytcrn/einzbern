<!-- SPDX-License-Identifier: Apache-2.0 -->

# Admitted work templates V1

## Boundary

`tcrn.template.v1` describes a work-record template as data. A template file is
an external edit surface and has no authority until the engine admits it into a
workspace event chain. The engine remains responsible for the kind-independent
scope floor, extension binding, replay registration, and frozen coupling roster;
the admitted template owns its heading order.

## Definition and admission

The canonical JSON definition contains `schemaVersion`, a stable `id`, positive
`version`, `appliesTo`, ordered `headings`, optional acceptance/reference heading
sets, and the frozen `couplings` set. `template-validate --template <file>` only
validates the external document. `template-admit` reads the same canonical file
and appends `template.admitted` through the workspace engine, recording the full
definition plus an owner-attested receipt containing the template digest,
version, owner, admission time, and receipt digest.

The event-derived registration is `template:<id>-<version>`. It is the only
source that can make a template extension known to replay. A required template
extension without a matching admission, or with a mismatched digest or receipt,
fails closed.

## Work binding and scope

`work-create --template-receipt <json>` binds a receipt to one admitted
`template@version` extension. The binding carries the template and receipt
digests and is projected by `work-show`; no user-facing arbitrary extension
registration verb exists. Bound work must match the template's `appliesTo` set
and its scope must use the admitted ordered headings. The engine floor remains
kind-independent: the four purpose anchors, legacy evidence/fix/decision
elements, non-empty acceptance content, and reference-only credential and
attachment sections are still checked.

The engine ships no built-in definitions. Every template is an external document
that `template-admit` admits, so a bound record's heading order comes from the
admitted file and from nowhere else. TCRN-CROSS-STORY-358 retired the
`BUILTIN_TEMPLATES` catalogue -- `story.feature.v1` (the legacy ten headings plus
`Non-goals`), `initiative.v1`, `release.v1`, `epic.v1`, `inc.defect.v1` and
`inc.governance.v1` -- because no engine path, CLI verb or script ever admitted
one; the kind-independent scope floor described above is unaffected. A template's
reference sections accept only `ref:`, `vault:`, `credential:`, `secret:`,
`attachment:`, or HTTPS references; inline credentials are rejected. The
`owner-decider-minutes` coupling is frozen by the engine in
`TEMPLATE_COUPLING_ROSTER` and an admitted template may declare it. Work without
a template binding remains the pre-template path, so historical records do not
become invalid merely for lacking a binding.

## Refusal surface

Malformed definitions, duplicate admissions, unknown or inapplicable bindings,
scope/template mismatches, and plaintext reference values fail closed with a
`TEMPLATE_*` reason code. Admission is append-only and uses the workspace CAS and
actor-attestation rules; publication, remote creation, and release operations
are outside this contract.

## Current minimum-content contract (INIT-068)

The historical four-anchor floor and ten-heading contract described above are not
current global admission requirements (STORY-473 retired them). V1 remains a legacy
reader/admission format; Story goal/acceptance compatibility is preserved. The new
`tcrn.template.v2` declares `contentSchema: tcrn.work-content.v1`, uses the existing
registry/receipt/binding and permits empty headings. Its lifecycle contract is
[work-content-v1](work-content-v1.md), not a mandatory body layout. A bound v2 record
must carry matching typed content even when it is an incomplete planned draft.

# Supported Modes

## Development

Development mode is supported on Node 24.16.0 and pnpm 11.3.0 with the committed
lockfile. Project commands are offline and telemetry-free. Dependency
acquisition is a separate, explicit operation with lifecycle scripts disabled.

Development mode does not imply release provenance, external-runtime
compatibility, or production support.

## Release

Release mode is admitted only when `einzbern-release-verify`
(`scripts/verify-release-trust.mjs`) finds that an unpacked release tree's
install-tree digest equals the one stated for it. A changed byte, a symbolic link
or any other non-regular file in the tree is rejected.

P1 defines and tests this admission boundary. It does not publish a release.

## P8 Release

`0.11.14` is the current accepted release candidate. Its compatibility manifest declares
`supportedAosReleases: []`; it is not a supported AOS release pair. P8 produces
deterministic source and release artifacts; publication is the Owner-signed
annotated tag and the GitHub Release that carries them.

The `0.11.14` release candidate records `supportedAosReleases: []`; it does not
enable a live compatibility pair, connected mode, or AOS mutation.

## Protocol V1

P2 freezes Protocol V1 and provides offline conformance fixtures. This is not a
supported live external-runtime pair. P3 local-work-graph capability remains
unavailable until the canonical acceptance marker is created by a later accepted
route.

## Invocation surfaces

All compatibility verbs are binary-invocable. Their authority requirements still
form a fail-closed security boundary.

- `compatibility-validate` and `compatibility-unavailable` are binary-invocable:
  the shipped binary `einzbern` can run them directly. They read no host
  authority and change no state.
- `compatibility-plan` and `compatibility-dry-run` required a Compatibility
  Admission Authority delivered through the operator-pins bundle
  (`--authority-pins`). That channel is retired with the rest of the authority
  family (TCRN-CROSS-STORY-467 R2).

No receipt body, secret or ambient authority is accepted from argv, prompt text
or environment variables. The structured MCP stdio surface that once
offered an alternative to shell history was retired in `v0.11.18`; the CLI is the
only transport, so an operator who wants paths and public digests kept out of
shell history handles that in how the CLI is invoked.

The command catalog (`commands` verb) records both planning verbs as `cli`.
Fixture-only artifact maintenance remains the only non-CLI surface.

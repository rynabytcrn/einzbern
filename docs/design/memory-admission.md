# Device memory admission

This opt-in policy extends the existing heavy-run semaphore. It does not change
agent-count caps, impose an OS memory limit, generate memory pressure, or promise
that unrelated applications cannot exhaust memory after admission.

## Configure the baseline

Use `machine-settings-set --key execution.memoryPolicy --value '<JSON>' --at <UTC>`
(the existing `--home` device-directory option is also supported). An unset policy
preserves legacy execution. An example for a device with enough measured headroom:

```json
{
  "enabled": true,
  "reserveMiB": 2048,
  "budgetMiB": 4096,
  "fixedMiB": 512,
  "workerMiB": 1024,
  "maxWorkers": 4,
  "maxUsedPercent": 90,
  "maxStallPercent": 1,
  "sampleMaxAgeMs": 2000,
  "profiles": {
    "test": { "fixedMiB": 512, "workerMiB": 1024, "maxWorkers": 4 },
    "node:test-controller": { "fixedMiB": 256, "workerMiB": 1024, "maxWorkers": 4 },
    "portal:test": { "fixedMiB": 256, "workerMiB": 512, "maxWorkers": 4 }
  }
}
```

Omitted numeric fields use the values above. All numeric fields are integers;
`reserveMiB` may be zero. Profiles override only fixed cost, per-worker cost and
worker cap for a named managed command. They are estimates supplied by the user,
not a claim that all workloads cost the same. Unrecognized fields refuse. A policy
restored from a configuration backup is re-evaluated against the **destination's**
current memory on every admission; no source-machine measurement is restored.
No existing user's settings are enabled by installation of this feature.

## Measurement and decision

The pinned Node runtime's `process.availableMemory()` supplies process-available
memory and `process.constrainedMemory()` bounds physical capacity when the OS
reports a process/container limit. See the [Node process API](https://nodejs.org/docs/latest-v24.x/api/process.html#processavailablememory).
Linux also reads `/proc/pressure/memory` (full stall avg10). macOS uses only the
read-only `/usr/bin/memory_pressure -Q` query, constraining available memory with
its system free percentage. macOS does not report a PSI stall percentage; this is
explicitly `null`, not a fake zero. Missing, malformed, stale or future required
observations refuse this opt-in heavy operation. Unsupported platforms refuse;
ordinary unconfigured work is unaffected.

The planner applies both the configured budget ceiling and current headroom after
system reserve. It subtracts existing commitments, but subtracts from current
headroom only their **unspent** portion. Only uniquely attributable resident bytes are credited (Linux private clean/dirty
pages). Summed RSS can double-count shared pages and is never used as that credit.
When private attribution is unavailable, including the current macOS adapter, credit
is zero and admission is deliberately conservative. RSS remains a sampled peak
observation, not a physical-page accounting claim. Fixed cost is subtracted
before dividing by per-worker peak estimate, and the configured worker cap still
applies. One worker not fitting is a refusal, not forced serial execution.

## Shared local resource domain

Budget checking and reservation occur under one exclusive local mutex, with an
atomically replaced state file. The domain is the existing heavy lock directory:
by default the device home's `locks`, or the explicitly shared
`EINZBERN_HEAVY_LOCK_DIR`. Different homes are not automatically one domain.
Root reservations in a shared domain must agree on the device policy; different
policies refuse rather than each applying a separate machine-wide budget.

Nested managed operations subdivide their parent's reservation, retaining the
parent's fixed cost. Sibling operations under one envelope serialize. A Node test
controller is a leaf envelope; it cannot start another governed heavy workload
inside its already occupied worker budget. This intentionally conservative first
version does not lend a parent's active worker budget to grandchildren. Independent
test fixtures must explicitly isolate their simulated device/domain; production
callers cannot treat inheritance as unlimited extra capacity.

A process identity includes PID and observed start time. The monitor periodically
observes the process tree and retains identities previously seen, so reparenting is
not proof of termination. Release requires observed quiescence, no child leases,
and no surviving previously observed descendants. Root exit, token age or a stale
mutex never grants takeover. Unknown state keeps the reservation. A stale mutex
or unconfirmed process tree requires investigation and supported operator recovery;
this MVP does not silently delete it or create another domain to evade it.

## Execution coverage and runtime pressure

Existing heavy entry points acquire the additional budget only when enabled.
Core test bootstrap and portal tests translate the admitted worker number to
Node's actual `--test-concurrency` argument. The core bootstrap acquires a leaf
reservation so sibling controllers cannot multiply the permitted workers.
A worker preload rechecks pressure before each newly scheduled test file loads.
Already running work is not killed by this policy. A new worker may start its
minimal runtime and then refuse before loading its test workload; this is not an
OS-level suspension of process creation.

Gate runs re-evaluate before every gate. The closed gate adapters cover direct
Node tests and this engine's instrumented task, release and portal entry points.
An unknown custom command refuses with `MEMORY_EXECUTOR_UNSUPPORTED`; it does not
receive a decorative environment variable and a false enforcement claim. Existing
test selection, required gate set and assertions are not reduced to fit memory.

The one-second observer is best-effort and does not kill tasks. Phase/worker checks
remain the enforcement points; a synchronous native operation can delay an
observer. This is intentionally not live arbitrary-runner resizing or a bandwidth
benchmark/autotuner.

## Evidence and backup boundary

Active reservations live in `locks/memory-budget.json`. Successfully released
runs produce private `locks/memory-receipts/<run-token>.json` records: command,
admitted workers, reserved bytes, sampled process-tree RSS peak and duration.
The peak is labelled sampled, not an exact kernel peak. Use these records to
review workload estimates; the first version does not automatically increase a
budget or rewrite the user's policy from a single sample.

Only `execution.memoryPolicy` joins the existing device-preference backup
allowlist. Observations, leases, transient inheritance and run receipts are not
configuration backup inputs. Identity, registry and write binding are unchanged.
The existing backup verifier and restore setter validate the policy; unknown
fields never become arbitrary file restoration.

## Verification limits

Tests cover pure arithmetic, missing/unknown observations, multi-process races,
nested reservations, uncertain release, and real Node worker concurrency with
explicit synthetic platform telemetry in isolated subprocesses. Synthetic telemetry
is not a claim of native macOS or Linux PSI availability. Real environment support
must be reported separately; this development sandbox does not expose Linux PSI.

## Registered runtime locations and gate entry forms

Default lock directories follow the same registered storage-location pointer as the
engine. A formal migration may leave a device-home forwarding link; admission
checks that it names the registered runtime locks directory, then shares its
canonical path between the heavy count, memory state and inherited references.
Unregistered forwarding, linked overrides, mismatched targets and unsafe directory
ownership or writable modes are refused.

The closed package-runner adapter accepts the project-pinned Corepack pnpm entry
as well as bare pnpm, with optional silent run syntax. Existing package scripts
are admitted only when their declaration names an already instrumented engine
entry point. Wrong pins, other project roots, executable/directory overrides,
extra script arguments and arbitrary scripts remain unsupported.


### Distributed executor identity

A gate's working directory is the target resolved by the normal gate planner, not
an engine installation path. The source build freezes the instrumented executor
closure as generated metadata; the release ships `scripts/lib/memory-executors.json`
and binds its bytes in the release manifest. Both the external module and CLI
bundle consume that metadata. The target package declaration and the enumerated
runner/admission files must match its SHA-256 identities before a package or direct
engine runner is admitted. A same-named script, unrelated directory, changed runner
or missing/corrupt metadata is not sufficient. This is a closed compatibility and
integrity check, not a new authorization source or an OS memory sandbox.

Under the test controller, a verified pinned package invocation of the existing
managed task entry follows the same nested-task policy boundary as direct Node.
Other package scripts retain the inherited-stdio/detached-process restrictions.
A distributed CLI gate caller is recognized only at its manifest-covered entry;
the normal registered child-process group and private-pipe handling still applies.

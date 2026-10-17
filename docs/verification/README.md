# Verification artifacts

## INIT-053 owner-return inventories: historical snapshots

The four `init053-owner-return-{scope,copy,component,limit}-inventory.json` files are historical audit snapshots from the `epic151-r11-pf-init053` owner-return pack. Their `comparisonBaseCommit`, recorded source-file hashes, counts and excerpts describe that recorded audit, not the current checkout.

Keep the snapshots unchanged. They are retained for historical review and their existing privacy/hash controls; they are not a generated current-state contract, an exhaustive list of current defects, or evidence that the current source passes those checks. No reproducible current-inventory generator is shipped for these four files. Do not refresh their source hashes merely to match a later checkout or relabel them as current verification.

For a new audit, record the actual reviewed commit and command, stdout, stderr and exit code in a separately dated report. Describe any unavailable sources and verification limits. A replacement generator or an updated inventory requires its own documented scope; historical snapshot preservation does not claim to supply one.

This classification resolves the maintenance ambiguity without rewriting old audit evidence or relaxing the privacy checks that protect it.

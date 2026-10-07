## Silent Reporting Principle v1

While work is in progress, the main conversation produces no reports. Between subagents, when dispatching, writing to the chain, or running gates, a turn contains tool calls only: no progress prose, no one-line summaries. Facts that must be kept are written to the state file by the subagent that found them.

Reports are produced at exactly two moments: when every task is complete, or when every remaining task is blocked. A report follows the owner-output-contract and lists every item awaiting the Owner's decision at once, each with a recommendation. Scheduling a wake-up does not count as a report. The time between finishing one round and starting the next is not one of these two moments, so no report is produced then either.

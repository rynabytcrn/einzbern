# Knowledge conflict projection direction

The integrated engine repair adopts the following deterministic comparison contract. This is a new implementation choice under the integrated plan, not a reconstruction of missing historical MIN-267 wording.

For two live cards from different originating writers, compare the original crest record’s `metadata.updatedAt` instant, then canonical card ID when the timestamps are equal. Query the earlier card using the later card's subject, exactly as the creation conflict guard queries existing cards. Do not also query in reverse. The existing scorer, fields, tokenization and threshold remain unchanged.

Crest records expose per-device sequence numbers, not a global creation clock. Workspace-chain positions are not crest visibility records, and legacy cards have no event. For legacy or incomplete histories without the original record, use the earliest available record instant, explicitly not a proven creation time. The timestamp/ID order is therefore only a deterministic comparison order. It does not prove concurrent writer visibility or establish a causal ordering between devices. Refreshing a card does not change the order while its original event is available.

Example: the earlier subject is `Amber rotation`; the later subject is `Cobalt deployment`, with summary `Amber rotation; Amber rotation`. Forward score is zero; reverse score is sixteen. The reverse-only match must not create an unresolved conflict. A later `Amber rotation guide` subject does create a directional conflict.

Existing coexist acknowledgements, supersession, removal, duplicate projection and INIT-family filtering retain their existing semantics. Results must be invariant under input enumeration order, including equal timestamps.

Completion hints independently cap their ranked candidate list at five; query-result capacity does not control this user-facing hint.

## Deferred scoring change (BL33)

This repair changes comparison direction only. The existing `[一-鿿]+` tokenization and substring occurrence scoring remain unchanged, including its limitations: a single Han character can score; a contiguous Han run is one token; separating the characters produces separate tokens. With subject `中文`, queries `中` and `中文` each score 8, while `中 文` scores 16. With subject `中中`, query `中` reaches 16 through repeated occurrences. These are compatibility observations, not endorsements of the algorithm or claims that BL33 is fixed. Revising tokenization, scoring text or thresholds is explicitly deferred to a separately specified algorithm change.

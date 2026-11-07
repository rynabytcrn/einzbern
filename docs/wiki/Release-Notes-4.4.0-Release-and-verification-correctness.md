# Release and verification correctness

Einzbern / Mana Orchestrate 4.4.0.

- Preserve failed release subpackage enumeration as a failure instead of treating
  it as an empty successful result. Bind output sessions to the actual linked
  worktree while keeping release preparation on a physical Git checkout.
- Document behavior-based acceptance and reuse successful checks when their
  relevant inputs are unchanged. Keep the complete required release validation
  and actual publication evidence separate from local fixtures.

[Back to 4.4.0](Release-Notes-4.4.0.md)

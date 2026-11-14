# pi-multi-pass: found below par

QA's living checklist for pi-multi-pass (rule 24). Each item is one past failure or complaint, written as
a check, with the case and its source. The owner's items are in his words with the date. A reviewer
runs every item that a change touches; at most 20 items.

- Owner, 2026-11-02: "can you fix the fall back loop ? if it need fixing since we change subs".
  Check: a turn that hits a limit moves down the chain and carries on, and the `/pool` view marks the
  entries the rotation skips: `tests/chatgpt-limit-continue-check.mjs` and
  `tests/antigravity-chain-entries-check.mjs` pass (PATCHES.md, Ops #758).
- Every account shows in `/subs limit-check`, Claude accounts included: `tests/subs-limits-check.mjs`
  passes. Case: accounts were missed (PATCHES.md, subs-limits).
- A turn the provider's classifier declines moves on to the next model instead of stopping:
  `tests/refusal-fallback-check.mjs` passes. Case: PATCHES.md, refusal-fallback.
- A run an add-on starts with a custom message keeps the user's prompt on pi 1.5: `tests/custom-message-turn-check.mjs`
  passes. Case: the pi 1.5.2 upgrade, Ops #858 (2026-11-12).
- After an upstream sync every patch's check still passes, and each patch is one commit listed in
  PATCHES.md. Case: PATCHES.md, "When a sync conflicts".

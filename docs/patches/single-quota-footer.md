[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### single-quota-footer  ·  status: local
**Why:** the selector persisted a `multi-pass-quota` snapshot while the limits feature updated
`multi-pass-limits`. pi-web-ui joins these distinct status slots, showing duplicate quota with different
percentages (e.g. a fresh 60% next to the older selector's 61%). They were not appended indefinitely,
but the second persistent snapshot was confusing and stale.
**Behavior:** only `multi-pass-limits` publishes persistent quota text. Selector reasoning remains in
notifications and routing trace. Clear the retired `multi-pass-quota` key on limits refresh, including
after reload, so existing UI state is cleaned up. Repeated refreshes replace the same summary.
Keep the chain/preset `multi-pass` status and other extensions' status entries unchanged.
**Hooks in `extensions/multi-sub.ts`:** `PoolManager.resetFirstHost().report` no longer publishes a
footer entry; `getCurrentModelLimits()` removes the legacy key before updating the canonical one.
**Files:** `extensions/multi-sub.ts`, `tests/reset-first-check.mjs`
**Test:** `node tests/reset-first-check.mjs` reproduces the two-slot bug before this fix and asserts
one quota slot after chain fallback, manual selection, repeated fresh checks, run completion, legacy
state cleanup and switching to unsupported Anthropic. Uses actual production code and pi-web-ui's
keyed replacement/removal semantics; unrelated status entries are preserved.
**Compat:** no configuration change. `/reload` activates the fix and clears the older quota slot.

[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative, including the sibling checkout relative to the repository root.

### limits-reading  ·  status: local
**Why:** model routing (owner's plan, Show&Tell d_udizqai7oz, slice S2; Ops #866) decides by each
allowance's used share and reset. Its reader (pi-queue `readingsFromLimits`, model-readings.ts) reads
`subs-limits.json`, but Antigravity's windows were keyed by position (`ag:0..3`), and nothing kept
the numbers fresh at decision time. No second parser (rule 23): the limits check stays the only one.
**Behavior:**
- **Stable Antigravity keys** (`antigravityBucketKey`), from the provider's bucket id and window,
  never the label: `gemini-*` → `ag:gemini:`, `3p-*` → `ag:claude-gpt:`; `5h`/`five_hour` → `5h`,
  `weekly`/`week`/`7d` → `7d`. An unknown family or window, or a repeated key, keeps `ag:<i>` (the
  reader leaves it out, so that allowance reads unknown and never forces). Labels are unchanged.
- **Reading port** `api.fresh(options?)` on the limits channel (`limits-port.ts`, `freshReadings`):
  hands back `{ readings, outcome, ageMs, stale }`. Numbers older than 30 min (`READING_MAX_AGE_MS`)
  are checked again first with the same free check `/subs limit-check` runs, waiting at most 10 s
  (`FRESH_CHECK_TIMEOUT_MS`); a slow check finishes in the background. A failed check keeps the old
  numbers and lists those providers in `stale` (`check-failed`); its `triedAt` stops a repeat within
  30 min, so no decision waits 10 s twice. No chat able to check → `unavailable`, no throw.
- The channel's v1 types moved from `subs-limits.ts` to `limits-port.ts` (re-exported unchanged);
  `fresh` is optional in `LimitsApiV1`, so older copies and pi-web-ui's server still match.
- `/subs` text, rotation, the footer and the file's shape are unchanged (only `ag:` keys differ).
**Hooks in `extensions/multi-sub.ts`:** none.
**Files:** `extensions/mine/limits-port.ts` (new), `extensions/mine/antigravity-limits.ts`,
`extensions/mine/subs-limits.ts`, `tests/limits-reading-check.mjs`,
`tests/support/subs-replies-2026-11-13.json` (recorded replies, ids and emails hidden).
**Test:** `node tests/limits-reading-check.mjs` (fake fetch; failed first: no `limits-port.ts`):
recorded Claude 1 (33% + Fable 0%), Claude 2 (100%, limited), ChatGPT (17%) and Antigravity's four
buckets → stable keys, the unchanged `/subs` text, and pi-queue's own `readingsFromLimits` (sibling
checkout `../pi-queue`, or `PI_QUEUE_DIR`) reading the file into the five allowances; within 30 min
no check; past it a failed check keeps the old numbers, stale, never forcing; a slow check answers
at the deadline; no chat → unavailable.
**Compat/undo:** revert the commit and reinstall (`pi update --extension
git:github.com/shine2lay/pi-multi-pass@mine`, `pi-web-deploy restart`); the reader then sees `ag:0..3`
and treats Antigravity as unknown (no forcing), as before.

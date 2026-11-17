[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### reset-countdown  ·  status: local
**Why:** every quota reset was shown only as an absolute UTC stamp (`reset 09-19 11:13Z`).
Answering the one question actually being asked — *how long until it comes back?* — meant doing
date arithmetic in your head, in another timezone, against a footer that updates while you read it.
**Behavior:** the footer is labeled with the **provider slot** (`anthropic-3`, `codex`), not the
selected model: the quota belongs to the subscription and does not change when you switch models.
The one exception is a model-scoped window (Anthropic's per-model-family cap), which names the model
on that window alone (`codex (account + model): gpt-6-astra 7d 40% left, resets in 2d 1h`).
Every reset time is now rendered as `resets in 4d 15h (09-19 11:13Z)` — relative first,
absolute always kept next to it, so nothing that was readable before got less readable. Two-unit
coarse durations (`4d 15h`, `3h 12m`, `7m`, `<1m`); minutes are dropped next to days. A deadline that
has already passed prints `due` — it is *not* treated as evidence of fresh quota. Missing or
unparsable reset data keeps its existing wording (`resets unknown` / the bare absolute stamp); no
countdown is invented. Applies to the `multi-pass-limits` footer, the reset-first selection
notifications, and `current_model_limits`, whose windows additionally carry machine-readable
`resetsIn` (`in 4d 15h` / `due`) and `resetsInSeconds` (never negative). All of it is a snapshot at
render time, exactly like the quota percentages themselves; `now` is injectable so nothing depends
on the wall clock in tests. No config, no schema, no new quota request.
**Hooks in `extensions/multi-sub.ts`:** the `current_model_limits` tool wraps its report in
`withResetCountdown()` before returning; everything else is inside the fork's own modules
(`formatModelLimits()` and reset-first's `windowSummary()` take an injectable `now`).
**Files:** `extensions/mine/reset-countdown.ts`, `tests/reset-countdown-check.mjs`; touched
`extensions/mine/current-model-limits.ts`, `extensions/mine/reset-first.ts`. The two vm-based
harnesses (`tests/reset-first-check.mjs`, `tests/quota-routing-check.mjs`) spread the new module into
their context, and `tests/current-model-limits-check.mjs` asserts the new footer wording.
**Test:** `node tests/reset-countdown-check.mjs` — duration boundaries (0/−1/NaN/Infinity, minute,
hour, day rollovers), ISO vs Unix-seconds input, `due` for passed/exact-now deadlines, absolute stamp
preserved, unsupported reports gaining no countdown, tool fields incl. clamped `resetsInSeconds`, and
no mutation of the source report. `scripts/test.sh` = 15 checks green.
**Compat:** display-only. Nothing is written to `~/.pi/agent/multi-pass.json`, so unpatched upstream
(and an older fork) behave exactly as before.

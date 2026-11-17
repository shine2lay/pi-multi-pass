[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### loop-back  ·  status: local
**Why:** owner via COO rm-7d437b26 (2026-10-23): "fix it so it it'll loop back to first subscription
in the list". On 10-22/23 chats sat on GPT until its weekly limit while two Claude accounts had room;
at the limit the GPT refusal only walked forward to Argon, an Argon refusal walked off the end and
stopped, and the promax text ("You have hit your ChatGPT usage limit (promax plan). Try again in
...") switched without continuing the turn (no HTTP status, so `piWillRetryTurn` guessed a retry pi
never does).
**Behavior:** on a limit refusal in a pool below a chain's primary, the chain is tried from the top:
the primary's members with room (weekly-first ranking unchanged), then later entries, wrapping past
the end; the current entry's place holds its own pool's other members. A chat on any model of a
chain pool (e.g. `gpt-6-astra`) uses that pool's entry. Each account at most once per turn (the
existing attempted/exhausted marks); a move up uses the turn's one upward step (`ReturnGuard`), so a
manual pick back down mid-turn is not bounced up again; one continuation, no prompt replay. Every
account at its limit: one "Failover exhausted" notice (no extra "All members rate limited").
Default for a non-primary chain pool is now to return on refusal; explicit `returnOnRefusal:false`
still opts a pool out (forward only). Never at a send; recovery off, manual picks and quota
routing unchanged. `/pool status` shows a `loop:` line for every chain pool.
**Hooks in `extensions/multi-sub.ts`:** `buildFailoverPlan` option `loopBack` (top-first order);
`handleError` sets it, treats a move to an earlier chain entry like the fallback-return step up, and
uses `isTerminalUsageLimit` for the forward continuation; `exhaustedReported` skips the second
notice in `agent_end`; `formatPoolStatusLines` adds `loopBackLine`.
`extensions/mine/fallback-return.ts`: `refusalReturns`, `loopBackLine`.
**Test:** `tests/loop-back-check.mjs` (a-i; on 49c2efa a, c-i fail, b passes):
`LOOP_BACK_SOURCE_REF=49c2efa node tests/loop-back-check.mjs` shows the old behaviour.
**Compat/undo:** no new config keys. Revert this commit and reinstall; config then needs
`returnOnRefusal: true` on the GPT and Argon pools for any refusal return (forward walk only, no wrap).

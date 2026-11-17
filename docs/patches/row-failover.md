[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### row-failover  ·  status: local
**Why:** model routing (owner's plan, Show&Tell d_udizqai7oz, slice S5, decision 6; Ops #868): "the
mid-chat fallback also follows each department's own order". A running chat that hits a limit moves to
the next usable cell of its department's tier row, not along the one global chain (claude-then-sol).
pi-queue owns the tables and the one router (rule 23); this patch only asks it and maps the answer.
**Behavior:**
- At a limit, the chat's other accounts of the same model come first (pool rotation, unchanged). Then,
  instead of the chain, pi-queue's route channel (`globalThis[Symbol.for("pi-queue.model-route")]`, v1,
  `api.chatFailover({ session, failed, tried })`) names the next cell: a lead's home chat at its table's
  `lead` tier, a queued task's chat at its task's tier; banned, `none`, limited and excluded cells and the
  cells that failed this turn are skipped there.
- The cell's column (`api.columnOf`) picks the pools; every eligible member is a candidate. A cell with no
  eligible account here is passed over (trace line) and the router asked again (at most 6 asks).
- The switch sets the cell's thinking, logs the decision (`api.logFailover`), shows the route line, and
  tells pi-queue first (`api.routedSwitch`) so S3's lead routing doesn't take it for a hand pick.
- No row left: no move, the router's line, then the one exhausted notice. No fallback-return step-up
  and no chain while a row answers.
- A chat on a provider no pool holds (Ops #995: pi-queue launches GPT-column tasks on `openai-codex`, the live
  GPT pool holds `openai`) uses the enabled pool of its column (`columnPool`) and moves along its row; with no
  row it stays as before (no move, no notice). Before, `handleError` returned early and the queue asked.
- No channel (older pi-queue), no session, a chat of no role, a department with no (valid) table
  (`default`), or a router error: the global chain exactly as before.
**Hooks in `extensions/multi-sub.ts`:** `PoolManager.planRow` (new private method) and `rowTried`;
in `PoolManager.handleError` the pool lookup (`columnPool` when no pool owns the provider; no row then: return
false right after `planRow`), and after the plan is built: row candidates replace the chain ones, the
step-up is skipped under a row, the exhausted branch shows the row line, the switch announces
`routedSwitch`, and after it the thinking is set and the decision logged. `FailoverCandidate.thinking`.
**Files:** `extensions/mine/row-failover.ts` (new; re-exported through `fallback-return.ts` so the vm
checks that load multi-sub.ts see it), `tests/row-failover-check.mjs`, `tests/support/chain-world.mjs`
(`session`, `thinking` options).
**Test:** `node tests/row-failover-check.mjs` (fake router on the channel, real multi-sub.ts, no network,
no model): ops lead chat, both Claude accounts limited → Carbon @ high, not Sol; account 2 with room →
rotates first; Carbon also fails → Astra @ medium with `tried`; a cell without an account → passed over;
no table / no role / no session / no channel / router throws → Sol (global chain); row all limited →
no move, one notice; (h) live GPT pool on `openai`, task on `openai-codex/gpt-6-astra` refused with "Codex error:
The usage limit has been reached" → Claude @ high, one decision logged, turn continued, no replay; (i) same chat
with no role → no move. `ROW_FAILOVER_SOURCE_REF=db3e721` (before): a, c, d, g fail; `=0584115`: h fails.
**Compat/undo:** inert without pi-queue's channel (≥ its S5 commit). Revert this commit, reinstall
(`pi update --extension git:github.com/shine2lay/pi-multi-pass@mine`), `pi-web-deploy restart`.

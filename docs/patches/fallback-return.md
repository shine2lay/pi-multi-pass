[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative. The dated backup is a historical operator artifact, not a repository file. The README's settings now live in [fork fallback](../fork-fallback.md).

### fallback-return  ·  status: local
**Why:** rotation only moves a chat down its chain (claude-real -> codex-fallback); nothing moved
it back up, and codex-fallback has one member. On 2026-10-10/11 five chats (Temper, Design and
Frontend home chats, a Design and a Product queue chat) sat on openai-codex, every turn failing
with "Codex error: The usage limit has been reached", while anthropic-3 had weekly room (26%).
**Behavior:** returns use the chain's first pool/model, ranked by that primary pool's own quota
routing. A member must have room and not be exhausted, cooling down or sign-in failed. At a new
prompt the fallback role alone permits the return: `"fallback": true`, or (when absent) the last
pool of an enabled chain starting elsewhere; `"fallback": false` disables it. On an eligible
mid-turn refusal, optional boolean `returnOnRefusal` overrides that role; when absent the role
still decides, preserving previous behavior. Thus `fallback:false` + `returnOnRefusal:true`
returns on refusal only, never at a send. `fallback:true` + `returnOnRefusal:false` is prompt-only.
`/pool status` reports the refusal-only role explicitly. No change to which errors count.

The Codex usage-limit refusal continues the turn once on the selected primary member (failed reply
cut from context, no prompt replay; pi does not retry that text by itself). One step up per turn;
an account refused this turn is never retried in that turn (ReturnGuard and existing attempted/
exhausted state). Every
primary member exhausted: stay on the current pool. No go-back code: with the live primary's
quotaRouting `recovery:"off"`, subsequent sends stay where a refusal landed. H-PICK-2 restores the
missed GPT refusal return while keeping the owner's send-time moves off.
**Hooks in `extensions/multi-sub.ts`:** import; `PoolConfig.fallback?` and `returnOnRefusal?`;
`PoolManager.returnFromFallback()` (prompt trigger, unchanged), `noteTurnStart()` (guard),
`handleError()` (`returnCandidates(..., "refusal")` before the forward-only candidates),
`returnContinuation`; `multiSub()` handlers: `input` (cancel continuation, then
`returnFromFallback`), `before_agent_start` (reset continuation, `noteTurnStart`), `turn_end`
(observe), `agent_before_settle` (settle); `/pool status` via `fallbackRoleLine()`.
**Files:** `extensions/mine/fallback-return.ts`, `tests/fallback-return-check.mjs`; the other
real-hook harnesses (env-allowed-subs, quota-routing, refusal-fallback, reset-first, signin-failover
checks) put the module in their vm context.
**Test:** `node tests/fallback-return-check.mjs` runs real multiSub hooks with live-shaped pools,
fake quota and no network/model. Cases 1–7 unchanged: turn-start return, mid-turn continuation,
exhausted primary, no ping-pong, unchanged Claude chat, inferred role, source hooks/parse.
(8) refusal-only config stays on GPT at sends and ineligible errors; actual ordinary load/save,
rename, member, strategy and toggle edits preserve both fields. (9) GPT limit returns to the
soonest-week Claude member and continues once, no replay; next send stays there. (10) exhausted
primary stays down; GPT refusal, up, Claude 429 stops when both already refused, never retries GPT;
two usable Claude members are tried in turn, and synthetic same-cascade selection back to GPT
cannot move up or continue again. The original planned down-step was corrected by Ops because
GPT had already refused in that turn. (11) explicit
prompt-only role; actual whole-pool replacement loses both fields and restores legacy returns.
`FALLBACK_RETURN_SOURCE_REF=33ca3a1 node tests/fallback-return-check.mjs` loads both old hooks and
old fallback-return code: cases 1–8 pass (including old saves), case 9 must fail because GPT stays.
**Compat:** absent field keeps legacy behavior. Live codex-fallback has `"fallback": false` and
`"returnOnRefusal": true`; claude-real quotaRouting retains `"recovery": "off"`. Copies already
loaded from 33ca3a1 ignore the new field, remain inert at sends and stop on the GPT limit. Ordinary
old load/save and pool edits preserve the unknown field. Install only with `pi update --extension
git:github.com/shine2lay/pi-multi-pass@mine`; no service restart for this change. New pi processes
load it immediately; open chats receive it at the next normal pi-web-ui restart.

**Whole-pool overwrite exception (Ops #162):** confirming `/pool create` over codex-fallback replaces
the pool, dropping **both** fields. Its chain then infers the fallback role again: GPT returns to
Claude at a new message **and** on refusal when Claude has room; it does not stop at its limit.
That breaks the owner's refusal-only rule. Repair by adding these exact lines to that pool:
```json
"fallback": false,
"returnOnRefusal": true
```
Replacing claude-real also drops its quotaRouting. Restore the existing weekly-first block with
`"recovery": "off"` inside it (see README); do not just remove the routing policy. Overwrite
preservation is deliberately not changed here; it would be another patch.

**Undo H-PICK-2:** remove only `returnOnRefusal`, or restore
`~/kept-from-tmp/2026-10-13/pick-sticks/multi-pass.json.before-H-PICK-2`; retain `fallback:false` and
recovery off. Code: `pi update --extension git:github.com/shine2lay/pi-multi-pass@33ca3a1`.
Loaded chats keep their current code until the next normal restart; no restart is requested.

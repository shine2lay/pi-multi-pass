[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### antigravity-chain-entries  ·  status: local
**Why:** owner 2026-11-02: "can you fix the fall back loop ? if it need fixing since we change subs"
(Ops #758). The live `/pool chain list` read "claude-then-sol | 4 entries | enabled | 2 invalid |
2/4 usable now": both Antigravity entries were "invalid model: no selectable models for antigravity"
and the rotation skipped them. Upstream lists a pool's models from pi-ai's built-in catalog
(`getBuiltinModels(baseProvider)`); pi-ai has no "antigravity" provider, pi-antigravity registers it
through `pi.registerProvider`, which only pi's live model registry holds. So a ChatGPT limit with no
Claude room ended in "Failover exhausted", and an Argon "Quota reached" (9 chats, 2026-11-02 17:13)
moved nobody: every move to Antigravity since 10-25 was a hand switch.
**Behavior:** a pool's selectable models are pi-ai's built-in ones for its base provider, then the
models pi's registry holds for the base provider or a member, each id once (`PoolModelCatalog`).
The registry is the chat's (`ctx.modelRegistry`, set at `session_start`) and is read at every call,
never cached, since an extension may register its provider after multi-pass loads. With no registry,
built-in models only and one plain warning; models are never guessed, and a model in neither list
stays invalid. Chain validity, `/pool chain list|status`, chain create and the pool model picker all
read it, so the Antigravity entries are usable: a ChatGPT limit with no Claude room moves to
Argon and the turn continues once (chatgpt-limit-continue), an Argon quota moves on to Claude on
Antigravity. No change to pools, chains, order, `returnOnRefusal` or recovery.
Second commit, so a broken loop can't read healthy: the `/pool status` `loop:` line (loop-back's
`loopBackLine`, optional `entryIssue`) marks every entry `getChainEntryIssue` rejects, e.g.
`antigravity-fallback (invalid, skipped)` or `(1 of 3 entries invalid)` in the order, then `; skips
invalid entries: <pool> -> <model> (<issue>)`. Before, it listed the pools whatever the rotation
skipped, which is how the live check passed while both Antigravity entries were skipped.
Third commit, each chat reads its own registry (Ops #769, owner m86760 "can you fix the fall back
loop"). The first commit kept one module-level accessor that every `session_start` pointed at its
own `() => ctx.modelRegistry`; the module is loaded once for all chats of a folder, so the last
chat to start won. Once that chat's session was replaced or closed, every other chat's failover
threw "This extension ctx is stale after session replacement or reload" (agent_end -> handleError ->
buildFailoverPlan -> classifyChainEntrySkip -> getChainEntryIssue -> getSelectableModelsForPool ->
PoolModelCatalog.modelIds; journal 11-02 21:06-21:31 and 11-03 02:23-02:26, 30+ lines) and the chat
stopped on the provider error with Claude room free (Ops #766: Argon "Quota reached. Please wait
35h9m26s"). Now `PoolModelCatalog` holds no registry: `modelIds(pool, registry)` takes the handling
chat's registry object (or `undefined`, the documented partial mode) and throws when the argument is
left out. Each entry point reads `ctx.modelRegistry` of its own event or command once
(`chatModelSource(ctx)`) and passes it down: `agent_end`'s `handleError` -> `buildFailoverPlan`,
`/pool status`, `/pool chain list|status|create`. A chat without a registry gets built-in models
and the one warning, never another chat's registry.
Hypothesis H-POOL-REGISTRY-1. Wrong: a module-level last-writer accessor to a chat's ctx getter;
evidence the journal stack above. Change: each planning entry point passes its own event ctx's
registry. Expected: zero "multi-sub.ts · agent_end): This extension ctx is stale" lines after the
install, and failover rotates although another chat of the folder was replaced. Measured by
`tests/pool-registry-per-chat-check.mjs` (fails first on the old code) and a passive 24 h journal
read after `pi-web-deploy restart`. Proves it wrong: the line recurs from multi-sub, or a natural
failover in those 24 h still stops on the provider error with a usable entry left.
Result: (pending).
**Hooks in `extensions/multi-sub.ts`:** the `PoolModelCatalog` import, `poolModels` beside
`getSelectableModelsForPool` (its body), `chatModelSource(ctx)` and the `models` parameter it feeds
through `getSelectableModelsForPool`, `getChainEntryIssue`, `classifyChainEntrySkip`,
`buildFailoverPlan`, the chain validation/format helpers and `formatPoolStatusLines` (which passes
`getChainEntryIssue` to `loopBackLine`).
**Files:** `extensions/mine/pool-models.ts`; `extensions/mine/fallback-return.ts` (`loopBackLine`);
`tests/antigravity-chain-entries-check.mjs`;
`tests/support/live-chain.mjs` (the live chain, its models and live provider texts; shared with
`tests/chatgpt-limit-continue-check.mjs`); `tests/support/chain-world.mjs` takes `builtin`
(provider -> ids, as `getModels`) and `registered` (registry-only models) instead of one model list
for every provider, which is how the old harness hid this, and gives `getAll`, `selects` and
`command`. `tests/loop-back-check.mjs` uses that split. The checks that run the real `multi-sub.ts`
in a VM put `PoolModelCatalog` in its context. Third commit: `tests/pool-registry-per-chat-check.mjs`;
`chain-world.mjs` gains `chainFolder` (one loaded copy, several chats via `open`, each with its own
ctx and registry; `replace()` makes a chat's ctx throw pi's stale text; `warnings`), and
`loadSources(ref)` loads that ref's `pool-models.ts` too (this tree's when the ref predates it).
**Test:** `tests/antigravity-chain-entries-check.mjs` (a-f; no model calls).
`ANTIGRAVITY_ENTRIES_SOURCE_REF=37df0b7 node tests/antigravity-chain-entries-check.mjs`: a-e fail
(d shows the live "2 invalid | 2/4 usable now"); f, the module's own cases, passes. On the first
commit only e (the status marks) fails.
`tests/pool-registry-per-chat-check.mjs` (a-d; no model calls): a chat B started last is replaced,
chat A's ChatGPT limit still moves A to Argon and B's stale ctx is never read (a); each chat's
chain views and failover use its own registry (b); a chat without `getAll` gets built-in models and
the one warning while the other chat keeps its own (c); the catalog keeps no registry and throws
when the argument is left out (d). On the tree before the fix all four failed, a with the live
"This extension ctx is stale after session replacement or reload";
`POOL_REGISTRY_SOURCE_REF=78712dc node tests/pool-registry-per-chat-check.mjs`: a-c fail, d passes
(it tests this tree's module).
**Compat/undo:** no config. Needs a pi whose `ctx.modelRegistry` has `getAll()` (1.0.1 does); without
it the old built-in-only list and one warning. Revert this commit, reinstall with `pi update
--extension git:github.com/shine2lay/pi-multi-pass@mine` and load it with `pi-web-deploy restart`.

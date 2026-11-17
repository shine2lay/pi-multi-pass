[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### model-fallback  ·  status: local
**Why:** run a fallback chain across *models on the same account* and then other providers:
`claude/claude-fable-5-1 → claude/claude-opus-5 → codex/gpt-6-astra`. Upstream exhausts the whole
provider on the first rate limit and treats the provider as "already attempted", so a same-pool chain
entry (Opus on the same Anthropic account) is always skipped and the cascade jumps straight to Codex.
**Behavior:** exhaustion is recorded per (pool, provider, model). The provider is marked exhausted
provider-wide (upstream `markExhausted`) only when no *untried sibling model* remains for it in any
enabled chain. Optimistic: if the limit was account-wide, the sibling fails fast once, then escalates,
and the cascade still reaches the next pool in the same turn. Chain traversal resumes after the exact
(pool, model) entry instead of the first entry for that pool. Configs without same-pool chain entries
behave exactly as upstream. Trace (`/pool trace`) gets one line per decision.
**Hooks in `extensions/multi-sub.ts`:** `PoolManager.handleError()` — `recordModelExhaustion()`
gates `this.markExhausted()`; `PoolManager.buildFailoverPlan()` — `findApplicableChainForModel()`
replaces `findApplicableChain()`, `wasTargetAttempted()` replaces `attemptedProviders.has()` and
`isModelExhausted()` is OR-ed into both `classifyPoolMemberSkip()` calls.
**Files:** `extensions/mine/model-fallback.ts`, `tests/model-fallback-check.mjs`
**Test:** `node tests/model-fallback-check.mjs`
**Compat:** no config schema change. Requires the current provider to be in a pool (single-member
pool is fine) and a chain with several entries for that pool. Unpatched upstream reads the same
config and simply skips the same-pool entries.

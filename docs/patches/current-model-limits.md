[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### current-model-limits  ·  status: local
**Why:** let the AI inspect the active model/account's actual subscription quota, and expose the
same data in the bottom bar. Local conversation token usage is not remaining subscription quota.
**Behavior:** adds the `current_model_limits` tool. It returns the active provider/model, availability,
quota scope, source, usage/remaining percentages, UTC reset timestamps, `checkedAt`, and `cached`.
`refresh` defaults to true; false permits a 60-second cache. Codex reports account-wide quota (including
weekly-only responses), not a model-specific Astra allowance. Google exposes provider/model buckets;
these are explicitly not guaranteed to map exactly to the selected model. Limit bucket output to 50
entries and report omissions. Unsupported providers, including Anthropic with the installed integration,
return `unsupported` and no invented quota values. No undocumented Anthropic endpoint is queried.

`multi-pass-limits` displays a compact footer snapshot, e.g.
`gpt-6-astra (account): 7d 61% left, reset 09-19 11:13Z`.
Unsupported/unavailable quota displays `limits unavailable`. Refresh on session start/reload, model
selection, run completion, and explicit tool calls; automatic refreshes use the 60-second cache.
No background polling or model requests. Snapshot caches are per session/account and also consume
successful reset-first checks, avoiding an immediate duplicate usage request after account selection.
Checks include auth refresh, have a 5-second deadline, and are cancelled on shutdown. Stale results
cannot update the footer for a different active model. Credential objects and raw error bodies are
never included in the tool response or footer.
**Hooks in `extensions/multi-sub.ts`:** quota checkers attach credential-free `limits` data;
`PoolManager.getCurrentModelLimits()` handles host auth and footer updates; `resetFirstHost()` shares
successful snapshots; `session_start`, `model_select`, and `agent_end` update the footer;
`cancelResetSelection()` also cancels limit checks; `multiSub()` registers `current_model_limits`.
**Files:** `extensions/mine/current-model-limits.ts`, `tests/current-model-limits-check.mjs`,
additional production tool/footer assertions in `tests/reset-first-check.mjs`.
**Test:** `node tests/current-model-limits-check.mjs` and `node tests/reset-first-check.mjs`.
Covers scoping, weekly-only data, bounded output, cache isolation/refresh, cancellation/deadlines,
real tool registration and host integration, and unsupported Anthropic behavior. Live Codex tool
verification also succeeded; no paid model request was made for that verification.
**Compat:** no persistent configuration/schema change. Removing this patch removes only the tool
and quota footer; reset-first selection and ordinary pools/chains keep working.

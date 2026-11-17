[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### quota-aware-rotation  ·  status: local
**Why:** observe Anthropic subscription quota before a warning, then use several subscriptions
without constantly abandoning the chosen account. Prefer expiring weekly allowance when selecting
an alternative, while respecting independent five-hour/model caps. A recovered account may be worth
returning to based on weekly expiry, but not merely because it is the first pool member.

**Behavior:** opt-in pool `quotaRouting` with a typed `weekly-first` policy registry. Optional exact
`models` allow-list; omitted means all models. `recovery` defaults to `earlier-weekly-reset` (`off`
disables recovery), `minWeeklyResetAdvantageMinutes` defaults to 0 (strictly earlier, no dwell timer),
`maxObservationAgeMinutes` defaults to 1440. Invalid configs do not activate the policy. Keep the
chosen healthy account; no per-message rotation or proactive reserve threshold. On runtime failure,
rank only accounts within the next existing model/chain group: earliest weekly reset, then five-hour
reset, then comparable headroom. Missing quota preserves eligible fallback order. Configured chain
order remains model preference; cross-model failback is not part of this patch. `quotaRouting`
overrides `resetFirst` on matching models so two selectors cannot compete.

Observe Anthropic unified subscription headers through the installed `before_provider_request` /
`after_provider_response` hooks. Capture account/model identity before the response, reject cancelled
or replaced credentials, parse only allow-listed quota fields. No auth/transport replacement, header
logging, paid probes, synthetic prompts, or undocumented usage endpoint. Account windows and
model-family windows are distinct. Expired or malformed percentages never become zero usage.
`current_model_limits` now reads passive Anthropic observations with original timestamps, scope and
staleness; `refresh:true` rereads shared observations but does not request a model response. Supersedes
the unsupported-Anthropic behavior in `current-model-limits`; the single-footer rule remains intact.
Codex queries reuse the existing checker/cache and also populate normalized routing observations.

Persist credential-free quota windows/failure records under `getAgentDir()/multi-pass-quota/`.
Per-account identity hashes, private per-writer shards, atomic replacement and merge-by-field
observation time preserve concurrent observations. Newer failure identity always wins over an older
failure's late recovery-clear write. Stable account IDs survive token rotation; opaque credentials
conservatively invalidate their state on refresh/re-login instead of reusing another account's quota.
Bounded reads, strict schema/retention checks and memory fallback prevent cache failures from breaking
inference. No raw tokens/headers/errors/prompts/email in persisted bodies or diagnostics.

Known exhausted windows retain actual reset deadlines. Unknown-scope errors use 5-minute exponential
backoff capped at 60 minutes, reset by successful HTTP responses even without quota headers. A past
reset permits an unverified recovery attempt, not an invented fresh quota snapshot. Only previously
failed accounts with an earlier usable weekly deadline can preempt a healthy current account, and
only at idle non-extension user input. Explicit manual selection suppresses earlier failure recovery
intent for that session. Cancellation, live restrictions, auth and model availability are rechecked;
legacy chains and pi's own retry/replay behavior remain unchanged.

**Hooks in `extensions/multi-sub.ts`:** `PoolConfig.quotaRouting`; `PoolManager.captureQuotaRequest`,
`observeQuotaResponse`, `rememberQuotaResult`, `quotaTargetBlocked`, `quotaRoutingHost`,
`recoverQuotaAccount`; hooks in `buildFailoverPlan`, `handleError`, `selectResetFirst`,
`getCurrentModelLimits`, `model_select`, `input`, provider-response events and shutdown.
**Files:** `extensions/mine/{anthropic-quota,quota-state,account-policy,quota-routing}.ts`,
`current-model-limits.ts`, `tests/quota-routing-check.mjs`, updated host integration expectations in
`tests/reset-first-check.mjs`. The module family is intentional: provider facts, storage, pure policy
and orchestration are independently replaceable, not separate competing pi extensions.
**Test:** `scripts/test.sh` (14 checks), including actual production PoolManager/event integration;
strict parsing, model scopes, unknown/expired data, OAuth isolation, cross-writer persistence,
concurrent-failure preservation, headerless recovery, backoff reset, sticky multi-message behavior,
weekly-ranked failover, immediate post-reset recovery, busy/extension-input guards, manual override,
disabled overlapping pools, chain ordering, destination Codex selection, and no duplicate replays.
A separate smoke check used the installed pi-ai Anthropic OAuth transport with a fully mocked fetch:
its real `onResponse` callback forwarded both quota windows before stream consumption. No live model
request or real credential was used. Fresh read-only review findings were reproduced and fixed.
**Limitations:** passive data can be stale or absent; unobserved accounts have unknown quota. The
installed Anthropic transport may not expose headers on failed HTTP responses. Future window schemas
fail closed. No predictive burn-rate forecasting, threshold-warning history, or cross-model automatic
recovery is implemented by this patch.
**Compat:** upstream ignores optional `quotaRouting`; existing strategies/configs continue to work.
`/reload` activates the hook. One normal Anthropic OAuth response can populate that account's meter.

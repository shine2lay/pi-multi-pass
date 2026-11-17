[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative. Private activation receipts are historical operator artifacts, not repository files.

### antigravity-limits  ·  status: local
**Why:** external `pi-antigravity` registers `antigravity`, while the fork knew only the older
`google-antigravity`. The signed-in canonical account was absent from Limits. A three-stage
Claude -> GPT -> Argon chain also needs GPT's non-retryable limit to continue forward before any
return to primary, without replaying the user's prompt.
**Behavior:** enumerate canonical `antigravity` once and label it Antigravity. Read the owning
provider's public usage schema (`retrieveUserQuotaSummary` groups/buckets; when unavailable,
`fetchAvailableModels` models/quotaInfo). Preserve fractions/reset times as shared quota buckets,
not separate private allowances or an account-wide exhaustion verdict. Missing/malformed data
stays unavailable; retain the last reading as stale through existing Limits handling. Ask only
Pi's existing auth resolver to refresh OAuth. Never register a provider, alias/copy credentials,
read the provider's account store, or replace its account selection/catalog/stream. Existing
`google-antigravity` remains supported. Respect the external provider's endpoint/user-agent
environment settings, but fail closed on non-HTTPS/non-Google endpoints or redirects.

For an enabled `claude-real/claude-opus-5-5 -> codex-fallback/gpt-6.1-sol ->
antigravity-fallback/gemini-4-argon` chain, use a single-member `antigravity` pool. Middle pool:
`fallback:false, returnOnRefusal:false`; final pool: `fallback:false, returnOnRefusal:true`.
Primary `quotaRouting.recovery:"off"` stays unchanged. Non-retryable forward chain limits use
existing failed-entry continuation, not prompt replay and not the one upward-return allowance.
Final return still requires a runtime refusal, ranks the primary pool, permits one upward return
per turn and never retries an attempted/exhausted target. Classifier refusal fallback is separate
and unchanged. No send-time rotation/default changes. Config activation is separate from code.

**Hooks in `extensions/multi-sub.ts`:** `limitsHost.bases`; canonical
`PROVIDER_QUOTA_CHECKERS` entry; `PoolManager.handleError()` forward-chain non-retryable continuation.
`extensions/mine/subs-limits.ts`: canonical display label only. No generic cache pruning: a formerly
seen, unconfigured and unauthenticated row remains absent after its one explicit cache-row removal.
**Files:** `extensions/mine/antigravity-limits.ts`, `tests/antigravity-limits-check.mjs`,
`tests/fallback-return-check.mjs` cases 12–14.
**Test:** `scripts/test.sh`. Public-schema fixtures, original-host counterfactual, real current-model
and Limits host/checker, canonical/legacy discovery, signed-out/expired/error/unknown handling,
no secret diagnostics/network, unsafe-endpoint rejection, repeated refresh after single stale-row
removal with other rows retained. Actual production routing hooks: four Claude members before GPT
and Argon, no middle return, final ranked one-return guard, full exhaustion, manual selections,
no send-time/non-limit moves or prompt replay, unchanged classifier and provider registration.
**Compat/undo:** no new config keys. Without this patch canonical account quota is absent but the
owning provider still works. Before code rollback restore the two-stage chain, remove only the new
Antigravity pool, and restore middle `returnOnRefusal:true` (keep `fallback:false` and recovery off).
Install previous fork `git:github.com/shine2lay/pi-multi-pass@2b63f49`; checked normal restart for
loaded chats. One-row stale cache removal does not touch sign-ins or other history; do not restore
an entire old readings file over newer usage. Task-local activation backups/receipts live in
`~/.pi/agent/local-patches/argon-accounts-367/` (private).

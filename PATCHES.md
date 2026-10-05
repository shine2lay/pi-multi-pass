# Fork patches — shine2lay/pi-multi-pass

Fork of [hjanuschka/pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass) (MIT).
Branch **`mine`** = an upstream release tag + the patches listed below, **one commit each**.
`main` mirrors upstream and is never committed to.

| What | Command |
|---|---|
| Upstream base we're on | `git describe --tags --abbrev=0 --match 'v*'` |
| List of our patches | `git log --oneline $(git describe --tags --abbrev=0 --match 'v*')..mine` |
| Full diff vs upstream | `git diff $(git describe --tags --abbrev=0 --match 'v*') mine` |
| One `.patch` file per change | `git format-patch $(git describe --tags --abbrev=0 --match 'v*')..mine -o /tmp/p` |
| Move to a newer upstream release | `scripts/sync-upstream.sh [vX.Y.Z]` |
| Verify everything still works | `scripts/test.sh` |

## Conventions

- **Isolate:** feature code lives in `extensions/mine/<feature>.ts`. `extensions/multi-sub.ts`
  (upstream, 6k lines) gets only imports and minimal call sites. Never reformat it.
- **No `index.ts` in `extensions/mine/`** — pi would load it as a separate extension.
- **One commit per patch.** Commit title = the patch heading below. Body = the *why*.
- **One check per patch** in `tests/<feature>-check.mjs` (plain `node`, same style as upstream's).
  A failing check after a rebase means the patch was lost or broken.
- **Hook points are named by function/method, never by line number.**
- **Status lifecycle:** `local` → `PR #N` → `merged vX.Y.Z`. Once merged upstream, the rebase
  drops our commit automatically; delete the entry here.
- **Config compatibility:** anything written to `~/.pi/agent/multi-pass.json` must be ignored
  harmlessly by unpatched upstream (so switching back never breaks).

## When a sync conflicts (for a human or an AI)

Give the resolver three things and ask it to *re-apply the intent*, not the diff:

1. The patch's entry below (intent, behavior, hook points, test).
2. The original patch file from `/tmp/pi-multi-pass-patches-<old-tag>/` (written by `sync-upstream.sh`).
3. What upstream changed: `git diff <old-tag> <new-tag> -- extensions/multi-sub.ts`.

Then `scripts/test.sh` must pass before `git rebase --continue`.

## Patches

<!-- Copy this template for each patch. Keep entries in commit order.

### <feature-name>  ·  status: local
**Why:** one paragraph of intent — what problem, for whom.
**Behavior:** given X, do Y; never Z. New config keys / slash-commands, if any.
**Hooks in `extensions/multi-sub.ts`:** `PoolManager.<method>()` — what is called and when;
`multiSub()` — registration.
**Files:** `extensions/mine/<feature>.ts`, `tests/<feature>-check.mjs`
**Test:** `node tests/<feature>-check.mjs`
**Compat:** how unpatched upstream behaves with config written by this patch.
-->

### fork-scaffolding  ·  status: local (never for upstream)
**Why:** keep the fork maintainable — document the exact delta, isolate fork code from the
upstream file, script the upstream sync, and carry an explicit MIT notice (upstream declares MIT
in `package.json`/README but ships no LICENSE file).
**Behavior:** no runtime change.
**Hooks in `extensions/multi-sub.ts`:** none.
**Files:** `PATCHES.md`, `LICENSE`, `.gitignore`, `extensions/mine/README.md`,
`scripts/sync-upstream.sh`, `scripts/test.sh`
**Test:** `scripts/test.sh` runs upstream's checks green.
**Compat:** n/a.

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

### reset-first  ·  status: local
**Why:** when entering Astra, consume usable quota from the account whose weekly allowance resets
soonest. Upstream `quota-first` prefers headroom, does not rank destination-pool members when entering
a chain step, and does not select an account on manual model changes.
**Behavior:** opt-in, per-model override on a Codex pool. Query eligible members concurrently using
the existing Codex usage checker, after asking pi to refresh OAuth. Skip accounts the API reports as
limited or with any returned window at 100% used. Rank usable accounts by weekly reset, then 5-hour
reset, then remaining headroom. Weekly-only responses are supported (a missing 5-hour window is not
assumed exhausted). Malformed/unknown data sorts after usable data; if all queries fail, retain the
existing eligible order with a warning. Past/missing reset timestamps do not win over known future
resets. Each check has a 5-second deadline, including auth resolution.

Configure in a `pools[]` entry in `~/.pi/agent/multi-pass.json` (or a project pool override):

```json
"strategy": "quota-first",
"resetFirst": {
  "models": ["gpt-6-astra"],
  "window": "weekly",
  "onSelect": true
}
```

`models` is an exact model-ID allow-list; other models keep the normal strategy. `window` defaults to
`weekly`; `five-hour` or `next` are alternatives. `onSelect: true` also applies on manual model
selection and session startup/reload. False/omitted limits this feature to failover. Remove
`resetFirst` to disable it. Project restrictions, authentication, model availability and existing
cooldowns always apply. No model/account defaults are persisted or changed.

Only rank the next failover group: **never promote Astra ahead of Opus** or move accounts between
chain entries. Check even a single remaining candidate so exhausted accounts are skipped. Suppress
only the router's own model-select events; preserve cascade tracking and pi's existing retry behavior.
Selection state is per session, stale selections are cancelled, and shutdown cancels pending checks.
Selection notifications show the preferred account with usage and UTC reset timestamps; `/pool trace`
records each checked account without credentials. These are selection-time snapshots, not live meters.
The original `multi-pass-quota` footer slot is retired by `single-quota-footer` below.
**Hooks in `extensions/multi-sub.ts`:** `codexQuotaChecker.check()` exposes strict structured quota;
`PoolConfig.resetFirst`; `PoolManager.resetFirstHost()` adapts auth/eligibility/diagnostics;
`reorderCandidatesByStrategy()` defers matching models to the override; `handleError()` ranks before
switching and suppresses self-rerouting; `selectResetFirst()` runs from `session_start` and
`model_select`; `session_shutdown` cancels checks.
**Files:** `extensions/mine/reset-first.ts`, `tests/reset-first-check.mjs`
**Test:** `node tests/reset-first-check.mjs` — ranking, weekly-only/malformed/exhausted data, deadlines,
reentrancy, stale selection, and the actual production PoolManager/event hooks with mocked HTTP and
temporary configuration. No paid model requests or real credentials in tests.
**Compat:** upstream ignores the optional `resetFirst` property and retains `strategy: quota-first`.
No credentials, model IDs, account names or reset schedules are hard-coded into the routing policy.

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

### single-quota-footer  ·  status: local
**Why:** the selector persisted a `multi-pass-quota` snapshot while the limits feature updated
`multi-pass-limits`. pi-web-ui joins these distinct status slots, showing duplicate quota with different
percentages (e.g. a fresh 60% next to the older selector's 61%). They were not appended indefinitely,
but the second persistent snapshot was confusing and stale.
**Behavior:** only `multi-pass-limits` publishes persistent quota text. Selector reasoning remains in
notifications and routing trace. Clear the retired `multi-pass-quota` key on limits refresh, including
after reload, so existing UI state is cleaned up. Repeated refreshes replace the same summary.
Keep the chain/preset `multi-pass` status and other extensions' status entries unchanged.
**Hooks in `extensions/multi-sub.ts`:** `PoolManager.resetFirstHost().report` no longer publishes a
footer entry; `getCurrentModelLimits()` removes the legacy key before updating the canonical one.
**Files:** `extensions/multi-sub.ts`, `tests/reset-first-check.mjs`
**Test:** `node tests/reset-first-check.mjs` reproduces the two-slot bug before this fix and asserts
one quota slot after chain fallback, manual selection, repeated fresh checks, run completion, legacy
state cleanup and switching to unsupported Anthropic. Uses actual production code and pi-web-ui's
keyed replacement/removal semantics; unrelated status entries are preserved.
**Compat:** no configuration change. `/reload` activates the fix and clears the older quota slot.

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

### subs-status  ·  status: superseded by subs-limits
**Was:** `/subs limit-status` (aliases `limit-check`, `status-all`) showing every subscription in its
own `multi-pass-subs` box. Claude accounts only showed numbers seen in recent replies, filtered by the
chat's current model, and `--probe` spent a `max_tokens: 1` message per unobserved account.
**Now:** the subcommands and the box stay; everything behind them is `subs-limits` below.
`extensions/mine/subs-status.ts`, `extensions/mine/anthropic-probe.ts` and their checks are gone.

### subs-limits  ·  status: local
**Why:** `/subs limit-check` missed accounts. Claude accounts were never asked: they showed only
numbers seen in recent replies, filtered by the current chat's model, so an account not used lately
(or a chat on another model) said "no data yet". The ChatGPT account wasn't listed at all unless it
was also configured as a numbered sub. The owner wants every account, reliably, also in pi-web-ui's
left panel (a Limits box under History, with a refresh button).
**Behavior:** one check, `checkAllLimits()`, used by `/subs limit-check` and by pi-web-ui:
- **Every account, every time:** each base provider with a subscription sign-in in pi's store, every
  configured numbered sub (shown "signed out" when it is), and any account seen before (it keeps its
  row instead of vanishing). No model, no project filter: numbers never depend on the chat.
- **Claude:** `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`), the
  free page Claude Code's `/usage` reads: `five_hour` / `seven_day` (utilization in percent,
  `resets_at`), per-model weekly windows from `seven_day_<model>` and `limits[]` (`weekly_scoped` with
  a model scope). Plan (Max/Pro/Free) and email from `/api/oauth/profile`, at most every 12 h.
- **Others:** the existing checkers (ChatGPT `/wham/usage`), handed the same reliable fetch. ChatGPT
  rows take every window in the reply, of any length (`windowsFromCodexUsage`): a Free plan has one
  30-day window, which the checker's own parser (5-hour and weekly only, used by rotation) drops, so
  its verdict is "error"; the windows read from the reply still make a good row (found live 2026-10-02:
  the row said "no usage numbers in the reply").
- **Reliable:** 10 s per attempt including the body; one retry after a timeout, a 5xx or a network
  error; a 429 waits for `Retry-After` (capped at 5 s) once, then reports busy. Accounts run in
  parallel, at most one check per account; a check requested while one runs joins it.
- **Failures keep the last numbers** with the reason in plain words: signed out, sign-in expired
  (refreshes when the account is next used), provider busy (429), timed out, no answer, check failed.
- **Sign-ins:** refreshed only through pi's own store (`ModelRegistry.getProviderAuth`, the refresh
  pi runs before a request, under its lock, written back by pi). Tokens within 2 minutes of expiry
  count as expired, so no checker ever refreshes on its own. Nothing writes auth.json; no token is
  logged or stored.
- **One file:** `~/.pi/agent/multi-pass-quota/subs-limits.json` (version 1), written whole (temp +
  rename). Numbers seen in normal replies (Anthropic quota headers, the footer's Codex checks) update
  their account's row for free, but only once a check has created the rows. Readings from the usage
  page never feed routing: rotation and the footer are unchanged.
- **Shared:** every chat in the process registers its sign-in store; the versioned channel
  `globalThis[Symbol.for("pi-multi-pass.limits")]` = `{ v: 1, listeners, api: { check, readings,
  checking, file } }` lets pi-web-ui's server run the check and hear every change (it falls back to
  reading the file when no chat has loaded pi-multi-pass). Contract types: `LimitsChannelV1`.
**Hooks in `extensions/multi-sub.ts`:** imports; `limitsFile()` and `limitsHost()` replace
`collectAllSubAccounts()`; `QuotaCheckResult` gains optional `plan`/`email`/`usageWindows` (the Codex
checker fills them), `ProviderQuotaChecker.check` an optional `fetchImpl` (the Codex checker uses it); `rememberQuotaResult()` and
`observeQuotaResponse()` call `recordReplyLimits()`; `PoolManager.checkAllSubsLimits()` replaces
`refreshAllSubsStatus()`/`probeMissingSubs()`, and `refreshSubsStatusIfShown()` re-renders from the
file; `session_start` registers the chat's store and installs the API, a second `session_shutdown`
handler withdraws it; the `/subs` case runs the check (`--probe` only gets a note); completions gain
`limit-check`.
**Files:** `extensions/mine/subs-limits.ts`, `tests/subs-limits-check.mjs`; the two vm-based
harnesses (`tests/reset-first-check.mjs`, `tests/quota-routing-check.mjs`) spread the new module into
their context.
**Test:** `node tests/subs-limits-check.mjs` (fake fetch, temp files, no real calls): every account
gets a row (signed out, API key, unknown provider, configured-but-signed-out, gone-but-seen); the
usage page's windows (legacy fields, `limits[]`, per-model, null resets); ChatGPT windows of any
length (a Free plan's 30-day one, from the reply's real shape); profile → plan; an expired
token goes through `refresh` and is re-read, a failed refresh says "sign-in expired"; 401/429/5xx,
timeouts (headers and body), network errors, retries and Retry-After; failures keep the last numbers;
concurrent checks join; reply numbers; the channel; text formatting; and source asserts on the hooks
above. `scripts/test.sh` = 16 checks green.
**Compat:** nothing new in `~/.pi/agent/multi-pass.json`; unpatched upstream ignores the readings
file. Removing the patch removes the check, the file and the channel.

### refusal-fallback  ·  status: local
**Why:** Anthropic's separate cyber classifier can decline an ordinary coding turn;
opt-in routing should try the owner's signed-in alternate once without losing the
conversation or confusing a classifier refusal with exhausted subscription quota.
Anthropic's documented fallback guidance: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.
**Behavior:** top-level `refusalFallback: { enabled: true, provider, model }` (global
or project) handles only the exact Anthropic cyber-classifier error, including its
subscription aliases. Pi 1.0.1 exposes `rawStopReason: "refusal"` and the explanation,
not `stop_details.category`; legacy errors without rawStopReason also match the exact
explanation. Other refusals/errors never match. The non-Anthropic destination must
exist, be signed in and satisfy project restrictions. One ordinary model switch,
one append-only `context_edit` that omits only the incomplete refused response, and
one `agent_before_settle` continuation per user activity. No prompt rewriting/replay,
network probes, account exhaustion, duplicate completed tools or transport changes.
Saved history retains the refused response. The destination stays selected and keeps
its own safety checks; its refusal stops this handler. Stop, new queued input, manual
selection, config changes, failed switching or shutdown cannot schedule a late retry.
`enabled:false` disables it; missing/malformed settings fail closed.
**Hooks in `extensions/multi-sub.ts`:** config normalization/load/effective merge;
`PoolManager.switchRefusalModel()` uses the existing managed `ResetFirst.switchModel()`;
`multiSub()` registers `turn_end`, `agent_before_settle`, user-activity/session reset,
manual-selection and shutdown cancellation.
**Files:** `extensions/mine/refusal-fallback.ts`, `tests/refusal-fallback-check.mjs`;
the existing quota-routing and reset-first VM harnesses import the new pure module.
**Test:** `node tests/refusal-fallback-check.mjs`: strict classifier/config parsing,
continuation after user or completed tool result, opt-in/access/auth/availability,
single retry and no loop, stop/new input/manual selection, races/config changes,
failed/redirected switches, and the actual multiSub event registrations. No network,
model calls or request-body inspection. Optional `PI_REFUSAL_BASELINE_REF=<pre-fix>`
runs the identical hook regression on old source to prove it does not switch/retry.
**Compat:** unpatched upstream harmlessly ignores `refusalFallback`. Other global
config fields and pool routing remain unchanged. Removal/`enabled:false` is the undo.

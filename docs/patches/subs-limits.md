[Patch contract](../../PATCHES.md). Paths and commands are repository-root-relative.

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
  pi runs before a request, under its lock, written back by pi). When a usage check gets HTTP 401
  while the stored `expires` timestamp is still in the future (e.g. a 10-day `openai-codex` token
  invalidated early), `checkAccount` forces one locked refresh through `runtime.getAuth(provider,
  { minOAuthValidityMs: 365d })` and retries once before reporting `sign-in-expired`. Tokens within
  2 minutes of expiry count as expired, so no checker ever refreshes on its own. Nothing writes
  auth.json; no token is logged or stored.
- **Sign in with ChatGPT** (`openai` OAuth, Ops #756): pi SDK 1.0.1 calls the Codex sign-in "OpenAI
  Codex (legacy)"; the owner signs in through `openai`. Its row is named `ChatGPT`; the Codex one
  `ChatGPT (legacy)`, listed only while it holds a sign-in (or is a configured sub), never kept from
  old rows. An `openai` API key alone is not listed. Hypothesis (rule 20): the `openai` token works on
  `/wham/usage` like Codex's. MISS, probed 2026-11-02 with the stored token (no model call, no token
  printed; scope `chatgpt.tokens.use.direct`, aud `api.openai.com/v1`): `chatgpt.com/backend-api/
  wham/usage` 401 `no_matching_rule`, `.../codex/usage` 403, `api.openai.com/v1/me` 401,
  `/v1/organization/usage/completions` 401, `/v1/models` 200 with no usage headers; pi-ai only links
  chatgpt.com/settings/usage on `subscription_sharing_usage_limit_exceeded`, and OpenAI's docs
  publish no usage endpoint or headers for this sign-in. So the row asks nothing and carries a
  `note` (plain words, not a failure: `NO_USAGE_NOTES`); a reply whose error matches
  `subscription_sharing_*usage_limit_exceeded` marks it `limited` with `limitedAt`, the next good
  reply clears it (`recordReplyLimited`, from a `turn_end` hook); a check keeps the file's mark.
  Since 2026-11-04 the live host no longer lists `openai` (owner: "can you remove the chatgpt one too
  since i cant know the limit"; he signed in the Codex login, whose `ChatGPT (legacy)` row has real
  numbers): `limitsHost().bases` drops it, so no `ChatGPT` row is shown, not even from old readings
  (`listAccounts` skips a base the host doesn't list). Routing, the chain's GPT pool and the login are
  unchanged; the note and LIMITED mark code stay for any host that lists it (`recordReplyLimited`
  only updates an existing row, so it does nothing now). Undo: put `"openai"` back in `bases`.
  Undo: drop `"openai"` from `limitsHost().bases` (the row goes; the mark hook then never matches).
- **Stored entry kinds** (`credentialFailure`): `oauth` is checked; only `api_key` says "signed in
  with an API key"; any other entry (no type, unknown type, or malformed like the `{result,next}`
  left in auth.json on 2026-11-02, which made Claude 1-3 look like API keys) says "signed out (saved
  login unreadable); sign in again", reason `signed-out`. Ops #757, Architecture rm-3af8dd22.
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
gets a row (signed out, API key, malformed entry = signed out, unknown provider, configured-but-signed-out, gone-but-seen); the
usage page's windows (legacy fields, `limits[]`, per-model, null resets); ChatGPT windows of any
length (a Free plan's 30-day one, from the reply's real shape); profile → plan; an expired
token goes through `refresh` and is re-read, a failed refresh says "sign-in expired"; 401/429/5xx,
timeouts (headers and body), network errors, retries and Retry-After; failures keep the last numbers;
concurrent checks join; reply numbers; the channel; text formatting; and source asserts on the hooks
above. `scripts/test.sh` = 16 checks green.
**Compat:** nothing new in `~/.pi/agent/multi-pass.json`; unpatched upstream ignores the readings
file. Removing the patch removes the check, the file and the channel.

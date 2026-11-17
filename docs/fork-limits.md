# Fork account limits and Antigravity

[Back to README](../README.md). Source paths in this document are repository-root-relative; home-directory cache files are generated runtime artifacts.

## Fork: every account's limits (`/subs limit-check`)

`/subs limit-check` (aliases `limit-status`, `status-all`) checks **every** signed-in subscription
and shows them in the `multi-pass-subs` box:

- **Claude accounts:** Anthropic's free usage page (`GET /api/oauth/usage`, the page Claude Code's
  `/usage` reads): 5-hour and weekly use, per-model weekly windows when present, and reset times.
  Plan and email come from the profile page. Nothing is sent to a model; no tokens are spent.
- **ChatGPT:** the existing `/wham/usage` checker, showing every window it reports (5-hour and
  weekly on paid plans, one 30-day window on Free). Other providers with a checker use theirs.
- **Every account, every time:** each base provider with a subscription sign-in, every configured
  numbered account (even signed out), and any account seen before. None is dropped, and the
  numbers never depend on the chat's model or project.
- **Reliable:** about 10 s per attempt, one retry after a timeout, a 5xx or a network error; a 429
  waits for `Retry-After` (capped at 5 s) once, then reports "provider busy". Accounts are checked
  in parallel, one check per account at a time; a second request while a check runs joins it.
- **Failures keep the last numbers**, with their age and the reason in plain words: signed out,
  sign-in expired, provider busy (429), timed out, no answer.
- **Sign-ins** are refreshed only by pi (the refresh pi runs before a request, under its lock).
  When that's not possible the row says "sign-in expired; refreshes when the account is next used".
- **One set of numbers:** readings go to `~/.pi/agent/multi-pass-quota/subs-limits.json`, written
  whole. Numbers seen in normal replies update their account's row for free. `--probe` is gone.
- **pi-web-ui's Limits box** uses the same check through a versioned channel on `globalThis`
  (`Symbol.for("pi-multi-pass.limits")`, contract v1 in `extensions/mine/limits-port.ts`).
- **Model routing** reads the same numbers through `api.fresh()`: each account's age, re-checked
  first when older than 30 min (waits at most 10 s); a failed check keeps the old numbers, marked
  stale. Antigravity's windows carry stable keys (`ag:gemini:7d`, `ag:claude-gpt:5h`, ...).

## Fork: externally owned Antigravity account

A signed-in **`antigravity`** account from `pi-antigravity` appears once as Antigravity in Limits,
including `/subs limit-check` and `current_model_limits`. The older `google-antigravity` integration
still works. Multi-pass does not create another login or replace the external provider's account
selection, model catalog or native transport. Refresh belongs to Pi/the owning provider.

Readings use its usage-summary groups/buckets or model-catalog quota fallback. These are **shared
buckets**, not independent allowances for each model variant; model mapping/global exhaustion may
be unknown. Missing numbers stay unavailable. A full unrelated bucket does not mark the entire
account exhausted. Failed refreshes retain old readings explicitly stale. No model request is used.
Previously seen account rows are intentionally retained; if a removed sign-in has a stale row,
remove only that noncredential row after the old writers have stopped, not the other readings.

An optional explicit three-stage chain can run:
`claude-real/claude-opus-5-5 -> codex-fallback/gpt-6.1-sol -> antigravity-fallback/gemini-4-argon`.
Keep Claude's existing weekly-first policy with recovery off. The new pool is:

```json
{
  "name": "antigravity-fallback",
  "baseProvider": "antigravity",
  "members": ["antigravity"],
  "enabled": true,
  "fallback": false,
  "returnOnRefusal": true
}
```

Append `{ "pool": "antigravity-fallback", "model": "gemini-4-argon", "enabled": true }` to the
chosen enabled chain. Set the middle `codex-fallback` to `fallback:false, returnOnRefusal:false`
so its limit reaches Argon before returning to Claude. Only the final pool returns on a limit,
using the ranked primary and the existing one-return/no-retry guards. All targets tried: stop.
Non-retryable forward chain limits continue without replaying the prompt. Sends/manual selections,
defaults and the separate classifier-refusal `openai-codex/gpt-6.1-sol` fallback are unchanged.
Use exact edits or normal edits which preserve optional fields, not whole-pool replacement.

Undo the optional routing activation: remove its third chain entry and new pool, restore the middle
`returnOnRefusal:true`, keep `fallback:false` and Claude recovery off. Code undo before this patch:
`pi update --extension git:github.com/shine2lay/pi-multi-pass@2b63f49`, then the normal checked restart
for already-loaded chats. Never overwrite newer usage with a whole old cache or hand-edit auth stores.

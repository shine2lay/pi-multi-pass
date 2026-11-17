[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative. The dated notes path is a historical operator artifact; the home-directory JSON is generated runtime state.

### signin-failover  ·  status: local
**Why:** 2026-10-10 06:40 anthropic and anthropic-2 hit limits, nine chats rotated onto
anthropic-3 whose stored refresh token Anthropic refused (`invalid_grant`, "Refresh token
not found or invalid"; invalidated outside this machine's pi, see
~/kept-from-tmp/2026-10-10/signin-failover/NOTES.md). Pi's "OAuth refresh failed for
<member>" was kind other here, so every chat stopped (14 stopped turns, queue tasks idle
1-4 h) while anthropic-4 could serve, and nothing remembered the dead login.
**Behavior:** `handleError` treats a sign-in failure of the current member like a limit
refusal: rotation to the next eligible member (pool order, quota routing and GPT fallback
unchanged), then one `agent_before_settle` continuation that omits the failed response by
`context_edit` (pi never retries this error, so no prompt replay). The member is marked in
`~/.pi/agent/multi-pass-quota/signin-failed.json` (provider, time, kind, credential type +
expiry stamp; no token material), shared by all chats: "refused" (HTTP 4xx/invalid_grant)
is skipped until the stored credential's stamp changes (new sign-in or renewal elsewhere)
or a reply from it succeeds; "unreachable" (network/timeout/5xx) is skipped 2 minutes.
`/pool status` shows `sign-in failed HH:MM (skipped until it signs in again)`. Sign-in
texts are classified before the rate-limit regex (their stack line numbers can look like
429/500). At most 3 continues per user prompt; stop, new input, manual model choice or
session switch cancel it. No refresh, probe or network call of its own.
**Hooks in `extensions/multi-sub.ts`:** import; PoolManager `signIn`/`signInContinuation`/
`signInLabel`; `getAvailableMembers` and both eligible callbacks skip blocked members;
`buildFailoverPlan` skip reason `sign-in-failed`; `handleError` trigger/mark/continue;
`formatPoolStatusLines` label; `turn_end`/`agent_before_settle` registrations;
cancel/reset on input, session switch, manual selection.
**Files:** `extensions/mine/signin-failover.ts`, `tests/signin-failover-check.mjs`.
**Test:** `node tests/signin-failover-check.mjs`: parsing of the live text (refused vs
unreachable, not limit errors), stamp without token material, shared store and its expiry
rules, continuation guards, the real multiSub hooks (switch, continue once, no replay,
other chats skip the member, skip reported), `/pool status` label. No network.
`PI_SIGNIN_BASELINE_REF=b8423d2` runs the same hook case on the old source and proves it
stops (no switch, no continue).
**Compat:** no config. Deleting `signin-failed.json` clears all marks. Removal is the undo.

[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### chatgpt-limit-continue  ·  status: local
**Why:** owner 2026-11-02: "can you fix the fall back loop ? if it need fixing since we change subs"
(Ops #758). The chain's GPT pool moved from the Codex sign-in to Sign in with ChatGPT (`openai`).
Its limit error reads `OpenAI API error (429): {..."code":"subscription_sharing_usage_limit_exceeded"}`
+ a usage link. `piWillRetryTurn` guessed from the HTTP status and took the 429 as "pi retries";
pi's own classifier never retries that code. So with no Claude room the chat moved down the chain
to Antigravity, the trace said "waiting for pi to retry the turn", and the turn stopped there.
**Behavior:** `piWillRetryTurn` asks pi's own retry classifier, `isRetryableAssistantError` from
`@earendil-works/pi-ai` (the one pi's `AgentSession._isRetryableError` uses), instead of the status
guess. An empty or non-string message counts as "pi won't retry". A ChatGPT limit moving down the
chain now continues the turn once on the next model, no prompt replay. Errors pi retries (Claude
`429 rate_limit_error`, `overloaded`) still wait for pi's retry, in the pool and down the chain, so
a turn never both retries and continues. The old Codex limit text still continues (it never matched
pi's retry list; `isTerminalUsageLimit` stays as a second guard). A move inside one pool on an
error pi won't retry now takes upstream's follow-up replay branch instead of waiting for a retry
that never comes; live, the only pool with several members is claude-real, whose limit errors (429,
overloaded) pi retries, so nothing changes there. No change to rotation order, pools, chains,
`returnOnRefusal`, recovery off or the one continuation per turn.
**Hooks in `extensions/multi-sub.ts`:** `piWillRetryTurn` (body; its `PI_RETRYABLE_STATUSES` set is
gone) and the `isRetryableAssistantError` import. `parseHttpStatus` stays for its other caller.
**Files:** `extensions/multi-sub.ts`; `tests/chatgpt-limit-continue-check.mjs`;
`tests/support/chain-world.mjs` (the chain harness from `tests/loop-back-check.mjs`, now shared by
both checks) and `tests/support/pi-retry-classifier.mjs` (pi-ai's `dist/utils/retry.js` from the
`pi` on PATH; throws if it can't be found). The checks that run the real `multi-sub.ts` in a VM put
`isRetryableAssistantError` in its context: env-allowed-subs, fallback-return, quota-routing,
reset-first, signin-failover, and the shared harness (loop-back and this check).
`tests/quota-routing-check.mjs` fails with a Claude `429 rate_limit_error` instead of the placeholder
"usage limit reached": pi never retries that placeholder, so its "pi owns retry; no duplicate prompt
queued" step tested the old guess. Upstream's `tests/runtime-failover-check.mjs` keeps its own copy
of the old guess; case d checks the real function gives the copy's answers on both texts it uses.
**Test:** `tests/chatgpt-limit-continue-check.mjs` (a-d, live chain shape; no model calls).
`CHATGPT_LIMIT_SOURCE_REF=4dddddd node tests/chatgpt-limit-continue-check.mjs` shows the old
behaviour: a and d fail (no continuation after the ChatGPT limit; the old guess), b passes. Since
antigravity-chain-entries the check sees models as pi has them (Antigravity only in pi's registry),
so a and c, which land on Antigravity, also fail on any ref before that patch (c fails on 4dddddd too).
**Compat/undo:** no config. Needs a pi whose pi-ai exports `isRetryableAssistantError` (1.0.1 does);
the checks fail loudly on one that doesn't. Revert this commit, reinstall with `pi update
--extension git:github.com/shine2lay/pi-multi-pass@mine` and load it with `pi-web-deploy restart`.

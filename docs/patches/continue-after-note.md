[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### continue-after-note  ·  status: local
**Why:** 2026-10-25 new queued tasks started on `openai-codex/gpt-6-astra` while the ChatGPT
account was at its weekly limit. The first reply was refused and the chat moved to Claude, but the
run ended in error, so pi-queue asked the lead "ran out of usage, carry on?" and the task stalled
(Ops #553, #554, a Security #172 chat). In each, a Board note (`custom_message`, role `custom`) sat
between the prompt and the refused reply; the three continuation guards accepted only `user` or
`toolResult` there. Chats without a note continued (Architecture #313, Security #173).
**Behavior:** a `custom` message right before the failed reply counts as fresh input, like the
user's prompt or a tool result (pi's `convertToLlm` sends it to the model as user input): the failed
reply is cut from the context and the run continues once on the new account, no prompt replay.
An `assistant` (or any other role) right before the failed reply still never continues. No change
to which errors count, rotation order, pools, chains, weekly-first, `returnOnRefusal`, recovery off
(stay where landed) or the one continuation per turn. pi-queue's "ran out of usage" card stays the
fallback when no continuation can happen.
**Hooks in `extensions/multi-sub.ts`:** none. `ReturnContinuation.settle()` (fallback-return),
`RefusalFallback.retry()` (refusal-fallback) and `SignInContinuation.settle()` (signin-failover)
call `isFreshInput()` in place of their inline role check.
**Files:** `extensions/mine/fresh-input.ts`; the three guards above. Tests: a `custom` case each in
`tests/fallback-return-check.mjs` (case 15, the live shape: astra refusal after a Board note),
`tests/refusal-fallback-check.mjs` and `tests/signin-failover-check.mjs`. The old-source loaders in
`tests/fallback-return-check.mjs` and `tests/loop-back-check.mjs` now point every `./<module>.ts`
import of the loaded `fallback-return.ts` at this tree (a `data:` module can't resolve relative
imports), so `*_SOURCE_REF` runs keep working on refs that import `fresh-input.ts`.
**Test:** `scripts/test.sh`. On e48673b the three new `custom` cases fail (no continuation;
fallback-return 1-14 pass, 15 fails) and the `assistant` cases pass; after the change all pass.
**Compat/undo:** no config. Revert this commit, reinstall with `pi update --extension
git:github.com/shine2lay/pi-multi-pass@mine` and load it with a normal pi-web-ui restart.

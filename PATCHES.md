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

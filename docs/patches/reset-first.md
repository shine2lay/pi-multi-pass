[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

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

The footer entry formerly below is in [single-quota-footer](single-quota-footer.md).

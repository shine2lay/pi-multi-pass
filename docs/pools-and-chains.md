# Pools and chains

[Back to README](../README.md).

## How pools work

1. You're using `openai-codex` and hit a rate limit
2. Multi-pass detects the error, marks `openai-codex` as exhausted
3. Switches to `openai-codex-2` (same model ID, different account)
4. Retries your last prompt automatically
5. After a 5-minute cooldown, `openai-codex` becomes available again

**Failed sign-in (fork):** when a member's saved login can't be renewed (pi's
"OAuth refresh failed for <member>"), the chat moves on to the next member the
same way and carries on with the same turn (no prompt replay). Every chat then
skips that member, and `/pool status` shows it as `sign-in failed HH:MM (skipped
until it signs in again)`, until a new sign-in is saved for it or one of its
replies works. A network failure while renewing (`sign-in unreachable`) only
skips it for 2 minutes. Marks live in `~/.pi/agent/multi-pass-quota/signin-failed.json`
(no tokens).

### Pool selection strategy

Each pool has a `strategy` that controls how the next member is chosen on failover:

| Strategy | Behavior |
|---|---|
| `round-robin` | Rotate sequentially through members (default) |
| `quota-first` | Query built-in quota checkers and prefer the member with the most remaining quota |
| `scheduled` | Use per-member time windows and priority roles |
| `custom` | Delegate to a user-provided JS selector script |

Set the strategy during pool creation (`/pool create`) or change it later via `/pool list` -> select pool -> `strategy`.

All strategies fall back to round-robin when their specific data is unavailable.

#### `quota-first`

You have 3 Codex accounts in a pool. Account A has 80% of its 5-hour window left, account B has 20%, account C has 60%. On failover, `quota-first` picks account A first instead of just the next one in rotation order.

Uses the same built-in quota checkers as `/subs limits` (currently Codex and Google providers).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "quota-first"
}
```

#### `scheduled`

Assign each member a role and optional time windows:

- **preferred**: only used during its active windows. When multiple preferred members are active, the one whose window ends soonest goes first (burn that quota before the window closes).
- **default** (no role): always available, used after preferred members.
- **overflow**: last resort, used when preferred and default members are exhausted.

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "scheduled",
  "memberSchedule": {
    "openai-codex": {
      "role": "preferred",
      "windows": [{ "hours": [9, 17], "days": ["mon", "tue", "wed", "thu", "fri"] }]
    },
    "openai-codex-2": {
      "role": "preferred",
      "windows": [{ "hours": [17, 9] }]
    },
    "openai-codex-3": {
      "role": "overflow"
    }
  }
}
```

Window format:
- `hours`: `[start, end)` in 24h local time. Wraps midnight when start > end (e.g. `[22, 6]` = 22:00-05:59).
- `days`: array of `"mon"`, `"tue"`, ..., `"sun"`. Omit for every day.
- `dateRange`: `{ "from": "2025-06-01", "to": "2025-06-30" }` for temporary windows.

During pool creation or via the `strategy` quick action, you can configure schedules interactively with human-friendly input like `9-17 mon-fri`.

#### `custom`

Point to a JS script that decides which member to try first. The script receives full context and returns the preferred provider name (or an ordered array).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "custom",
  "selectorScript": "selectors/my-codex-selector.js"
}
```

Script paths are resolved relative to `~/.pi/agent/`. Absolute paths and `~/` paths also work.

**Selector script interface:**

```js
// ~/.pi/agent/selectors/my-codex-selector.js
module.exports = async function select(ctx) {
  // ctx.members:         string[]  -- available (non-exhausted, authenticated) members
  // ctx.currentProvider: string    -- the provider that just hit a rate limit
  // ctx.modelId:         string    -- the model ID being used
  // ctx.pool:            object    -- { name, baseProvider, members }
  // ctx.timestamp:       number    -- current Unix timestamp (ms)
  // ctx.hour:            number    -- current hour (0-23, local time)
  // ctx.day:             string    -- current day of week ("mon".."sun")
  // ctx.prompt:          string?   -- last user prompt, if available
  //
  // Return: string (provider name), string[] (ordered preference), or undefined (fall back)

  // Example: prefer a specific account during business hours
  if (ctx.hour >= 9 && ctx.hour < 17) {
    return ctx.members.find(m => m === "openai-codex-2");
  }
  return ctx.members[0];
};
```

If the script throws, returns an invalid provider name, or the file is missing, the pool falls back to round-robin.

## How chains work

1. You define an ordered chain of pool/model entries (for example `primary -> backup -> solo`)
2. If the current pool has no eligible members, multi-pass continues forward in the chain
3. It skips disabled or invalid entries and reports why in warnings
4. During retry replays for the same prompt, it preserves cascade state and avoids re-trying already attempted providers
5. Session status shows the active chain start entry: `chain:<name> | starts <pool> -> <model>`

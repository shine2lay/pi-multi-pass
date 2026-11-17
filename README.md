# pi-multi-pass

Multi-subscription extension for [pi](https://github.com/earendil-works/pi-coding-agent) -- use multiple OAuth accounts per provider with automatic rate-limit rotation and project-level affinity.

## Install

```bash
pi install npm:pi-multi-pass
```

Or via git:

```bash
pi install git:github.com/hjanuschka/pi-multi-pass
```

## Features

- **Multiple subscriptions**: Add extra OAuth accounts for any provider
- **Rotation pools**: Group subscriptions and auto-rotate on rate limits
- **Smart pool strategies**: `round-robin`, `quota-first`, `scheduled` (time windows), `custom` (JS script hook)
- **Fallback chains**: Define ordered cross-pool/model failover via `/pool chain`
- **Opt-in routing trace**: Record recent selection, skip, and failover decisions only when requested
- **Model presets**: Named routing shortcuts across providers (`/mp-preset coding-premium`)
- **Built-in limits checks**: Inspect subscription headroom across accounts with `/subs limits`
- **Smarter retries**: Preserve failover progress across internal replay retries
- **Project affinity**: Restrict which subs/pools/chains are used per project
- **TUI management**: `/subs`, `/pool`, and `/mp-preset` commands -- no config files needed
- **Labels**: Tag subscriptions (e.g. "work", "personal")
- **Live model catalogs**: Subscription providers mirror the base provider's
  merged model catalog (static builtin + pi.dev remote overlay from
  `models-store.json`) on every model refresh, so newly catalogued models
  (e.g. `gpt-6-astra` for Codex) reach extra accounts without a
  pi-multi-pass release

## Quick start

```
/subs add              Pick a provider, add a subscription
/login                 Authenticate the new subscription
/subs switch           Manually switch to another subscription/provider
/subs limits           Check built-in quota support (Codex + Google)
/pool create           Group subs into a rotation pool (with strategy selection)
/pool chain create     Build an ordered fallback chain across pools
/pool trace start      Start recording routing decisions for this session
/mp-preset create         Create a named routing preset across providers
/mp-preset coding-premium Activate a preset by name
```

When one account hits a rate limit during an assistant turn, multi-pass automatically switches to the next eligible target and retries.

## Commands

### `/subs` -- Subscription management

```
/subs              Open menu
/subs add          Add a new subscription
/subs remove       Remove a subscription
/subs login        Login to a subscription
/subs logout       Logout from a subscription
/subs switch       Manually switch to a subscription/provider now
/subs list         List subscriptions with auth status; select one for quick actions
/subs status       Detailed status (token expiry, pool membership)
/subs limits       Check built-in quota/usage support (Codex + Google)
/subs limit-check  Check every signed-in account's limits now (fork; see below)
```

### `/pool` -- Rotation pool and chain management

```
/pool              Open menu
/pool create       Create a pool (pick provider, select members)
/pool list         Show pools; select one for quick actions
/pool chain        Open chain manager
/pool toggle       Enable/disable a pool
/pool remove       Delete a pool (keeps subscriptions; prunes linked chain entries)
/pool status       Member health (logged in, rate limited, cooling down)
/pool trace        Manage the opt-in routing decision trace
/pool project      Project-level config (restrict subs, override pools/chains)
```

### `/pool trace` -- Opt-in routing decisions

Tracing is disabled by default and stores nothing until explicitly started. Entries
are kept only in memory for the current pi session, with the newest 100 retained.
Prompt contents are not recorded.

```
/pool trace start   Clear old entries and begin recording
/pool trace show    Inspect selections, skipped candidates, and failovers
/pool trace status  Show whether recording is active
/pool trace stop    Stop recording while retaining captured entries
/pool trace clear   Delete captured entries
```

### `/pool chain` -- Ordered fallback chain management

```
/pool chain             Open chain manager
/pool chain create      Create a chain
/pool chain list        Show all chains
/pool chain toggle      Enable/disable a chain
/pool chain remove      Delete a chain
/pool chain status      Inspect chain entries and validity
```

### `/mp-preset` -- Model presets (named routing)

```
/mp-preset                 Open menu
/mp-preset activate        Switch to a preset's best available entry
/mp-preset <name>          Activate a preset by name directly
/mp-preset create          Create a new preset
/mp-preset list            Show all presets
/mp-preset toggle          Enable/disable a preset
/mp-preset remove          Delete a preset
```

## Guides

- [Project-level configuration](docs/project-configuration.md)
- [Pools, selection strategies, and chains](docs/pools-and-chains.md)
- [Model presets, supported providers, and built-in limits](docs/presets-and-providers.md)
- [Fork fallback returns and refusal fallback](docs/fork-fallback.md)
- [Fork sticky quota-aware account rotation](docs/fork-rotation.md)
- [Fork account limits and externally owned Antigravity](docs/fork-limits.md)
- [Fork patch contract](PATCHES.md)

## Environment variable (optional)

```bash
export MULTI_SUB="openai-codex:2,anthropic:1"
```

Env entries merge with saved config.

Fork: `MULTI_PASS_ALLOWED_SUBS` limits one pi process to the listed providers, like a project's
`allowedSubs` (it replaces that list for the process; unset or blank changes nothing):

```bash
MULTI_PASS_ALLOWED_SUBS="anthropic-4" pi -p "..."   # this run stays on anthropic-4: no rotation or fallback elsewhere
```

## Config files

The project file is optional, generated in your project rather than checked into this repository.

| File | Scope | Contains |
|---|---|---|
| `~/.pi/agent/multi-pass.json` | Global | Subscriptions + pools + chains |
| `<project>/.pi/multi-pass.json` | Project | Pool/chain overrides + sub restrictions |

## License

MIT

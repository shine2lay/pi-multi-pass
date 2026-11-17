# Presets and providers

[Back to README](../README.md). The project configuration path below is optional and generated in your project, not checked into this repository.

## Model presets

Presets are named routing shortcuts that map to an ordered list of provider+model entries across different providers. Think of them as intent-based routing: `coding-premium`, `coding-budget`, `fastest`, etc.

### Commands

```
/mp-preset              Open menu
/mp-preset activate     Switch to a preset's best available entry
/mp-preset <name>       Activate a preset by name directly
/mp-preset create       Create a new preset
/mp-preset list         Show all presets
/mp-preset toggle       Enable/disable a preset
/mp-preset remove       Delete a preset
```

### Example

```
/mp-preset create
  Name: coding-premium
  Entries:
    1. anthropic / claude-sonnet-4-20250514
    2. openai-codex / o3
    3. google-gemini-cli / gemini-2.5-pro

/mp-preset coding-premium
  -> Tries anthropic first. If not logged in, tries openai-codex. Then gemini.
```

### Config

Presets are stored in `~/.pi/agent/multi-pass.json`:

```json
{
  "presets": [
    {
      "name": "coding-premium",
      "enabled": true,
      "entries": [
        { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "enabled": true },
        { "provider": "openai-codex", "model": "o3", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-pro", "enabled": true }
      ]
    },
    {
      "name": "coding-budget",
      "enabled": true,
      "entries": [
        { "provider": "openai-codex", "model": "gpt-4.1-mini", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-flash", "enabled": true }
      ]
    }
  ]
}
```

Presets work with pools: if an entry's provider belongs to a pool, rate-limit failover still rotates within that pool before trying the next preset entry.

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |

## Built-in limits support

`/subs limits` uses a provider-specific checker registry.

Currently implemented:

- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` (or `CHATGPT_BASE_URL`), then summarizes the 5-hour and 7-day subscription windows for the base account and any configured extra Codex subscriptions.
- `google-gemini-cli`: refreshes the saved Google OAuth session when needed, then queries `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` and summarizes the returned Gemini quota buckets by their bottleneck family (for example `Pro` or `Flash`).
- `google-antigravity`: refreshes the saved Antigravity OAuth session when needed, then queries `v1internal:fetchAvailableModels` on the Google Cloud Code Assist endpoints with Antigravity-style headers and summarizes the returned model-level bottleneck.

Google quota is not a single flat subscription bucket, so the details view shows one line per returned Gemini family or Antigravity model with its remaining headroom and reset time.

`/subs limits` is an on-demand snapshot. It helps you see which account looks healthiest right now. By default, automatic switching happens when the active provider returns a rate-limit-style runtime error and that provider belongs to an enabled pool or chain. This fork also offers opt-in recovery selection below.

When a pool uses the `quota-first` strategy, the same quota checkers are used automatically during failover to pick the healthiest member instead of just round-robin.

When a project defines `<project>/.pi/multi-pass.json` with `allowedSubs`, `/subs limits` only shows accounts allowed in that project.

Future providers can add another checker without changing the `/subs` command surface.

For the recovery selection described above, see [fork rotation](fork-rotation.md).

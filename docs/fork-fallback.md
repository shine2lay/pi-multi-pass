# Fork fallback behavior

[Back to README](../README.md). Project configuration is optional and generated in your project. The dated backup below is a historical operator artifact, not a repository file.

## Fork: back up from the fallback pool

A chat on a backup pool can return to the chain's first pool when an account there has room,
picked by that pool's own quota routing. One step up per turn; an account refused this turn is
never retried in that turn. An exhausted primary means stay on the backup. A Codex usage-limit
return continues the same turn once, without replaying
your prompt. `/pool status` shows the role.

- At a new message, only the fallback role permits a return: `"fallback": true`, or (if absent)
  the last pool of an enabled chain starting elsewhere. `"fallback": false` disables it.
- On a mid-turn refusal, optional boolean `returnOnRefusal` decides instead. When absent, the
  fallback role still decides as before. This does not change which errors trigger failover.

For **refusal-only** GPT-to-Claude returns, add these lines inside the `codex-fallback` pool:

```json
"fallback": false,
"returnOnRefusal": true
```

Keep `claude-real`'s existing `quotaRouting` with `"recovery": "off"`. For the live weekly-first
settings, the block inside that pool is:

```json
"quotaRouting": {
  "policy": "weekly-first",
  "recovery": "off",
  "minWeeklyResetAdvantageMinutes": 0,
  "maxObservationAgeMinutes": 1440
}
```

This leaves a chat where its last refusal landed, rather than moving it at the next send.
`fallback:true` with `returnOnRefusal:false` instead allows prompt returns only.
Old copies already loaded from `33ca3a1` ignore `returnOnRefusal`: with `fallback:false` they still
never move at a send, and a GPT limit stops. New pi processes load the installed extension;
open chats get it at the next normal pi-web-ui restart. No restart is needed for the config edit.

**Warning:** confirming `/pool create` over an existing name replaces the **whole** pool.
Ordinary saves, rename, member, strategy and toggle edits keep these fields, but a whole-pool
replacement does not. Replacing `codex-fallback` drops both fields and infers its fallback role
again: GPT moves to Claude at new messages **and** refusals if Claude has room, not just on errors.
It does **not** stop at the GPT limit. Re-add both exact lines above to restore refusal-only
behavior. Replacing `claude-real` drops its quotaRouting too: restore the block above, keeping
`"recovery": "off"`. Overwrite preservation is not part of this patch.

Undo refusal-only return: remove `returnOnRefusal` (keep `fallback:false` and recovery off), or
restore `~/kept-from-tmp/2026-10-13/pick-sticks/multi-pass.json.before-H-PICK-2`. Code undo:
`pi update --extension git:github.com/shine2lay/pi-multi-pass@33ca3a1`. No restart is requested.

## Fork: one refusal fallback

For the exact Anthropic **cyber-classifier refusal**, opt in to one retry on a
signed-in non-Anthropic model. Add this top-level setting to
`~/.pi/agent/multi-pass.json`:

```json
"refusalFallback": {
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-6.1-sol"
}
```

The same setting in `<project>/.pi/multi-pass.json` overrides it for a project;
`{"refusalFallback":{"enabled":false}}` disables it there. Project `allowedSubs`
restrictions still apply. An absent setting means off.

Pi switches normally, keeps that model selected, and continues the existing
conversation once. It does not replay your message, change its text, mark Claude
accounts exhausted, or repeat completed tools. The incomplete refused reply stays
in saved history but is omitted from model context for the retry. Images and the
rest of the conversation stay intact. This handles classifier false positives;
the destination model's own safety checks still apply, and a refusal there stops.

Generic refusals, ordinary assistant text, other policy categories and permission
errors do not match. A missing model/sign-in, a failed switch, Stop, queued new
input or a manual model change keeps the original error without an automatic retry.
Set `enabled` to `false` (or remove the key) to turn it off.

[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### custom-message-turns  ·  status: local
**Why:** pi 1.0.1 -> 1.5.2 upgrade (owner 2026-11-12 "Approve, pi 1.5.2"; Ops #857/#858). pi 1.2.0+
fires `before_agent_start` for a run an add-on starts with `pi.sendMessage(..., { triggerTurn: true })`
(`messageType: "custom"`, no `prompt`); 1.0.1 fired nothing for it. multi-sub's handler stored
`event.prompt` as `lastUserPrompt` for every event, so a queue-report turn wiped the user's prompt and
a limit on that turn replayed nothing after the pool switch.
**Behavior:** the `before_agent_start` handler returns at once for `messageType === "custom"`: the
user's prompt, the cascade and the refusal/sign-in/return continuations stay as they were, exactly as
on 1.0.1. User runs (`messageType: "user"`, or no `messageType` on 1.0.1) are unchanged.
**Hooks in `extensions/multi-sub.ts`:** first line of the `before_agent_start` handler next to
`lastUserPrompt`.
**Test:** `tests/custom-message-turn-check.mjs` (no SDK, no model calls): a custom-message turn after
the user's prompt leaves the stored prompt alone (failed first: replayed `[]` instead of the prompt);
control, a plain user turn replays its own prompt. `tests/support/chain-world.mjs` gains `customTurn()`.
**Compat/undo:** works on 1.0.1 (the event never comes) and 1.5.2. Revert this commit, reinstall with
`pi update --extension git:github.com/shine2lay/pi-multi-pass@mine`, `pi-web-deploy restart`.

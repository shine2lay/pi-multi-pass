[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative. Project configuration is optional and generated in your project, not a checked-in repository file.

### env-allowed-subs  ·  status: local
**Why:** 2026-10-10 the owner had the weekly memory tidy-up (a headless `pi -p` script run by the
scheduler) sign in like the chats, with every account and rotation from the next Sunday on, but
wanted the 10-11 run kept on one account (anthropic-4) so it took nothing from another account a
read was guarded on. Extra accounts exist only through this extension, so `--model
anthropic-4/...` without it is an unknown provider, and with it rotation may leave anthropic-4.
A project `<project>/.pi/multi-pass.json` `allowedSubs` would do it, but it is per folder and would bind
every chat in that folder. The variable is per process.
**Behavior:** `MULTI_PASS_ALLOWED_SUBS="anthropic-4"` (provider names, comma-separated) acts like a
project `allowedSubs` for that process: it replaces the project file's `allowedSubs` (keeping the
file's other keys), so the effective config keeps only listed members in pools, drops chains' empty
pools, moves a session or model on another provider onto a listed one (or refuses it), and the
refusal fallback stays inside the list. pi still registers every subscription. Unset or blank:
no change; chats never set it.
**Hooks in `extensions/multi-sub.ts`:** import; `loadProjectConfig()` returns
`withEnvAllowedSubs(loadProjectConfigFile(cwd))` (the old body, renamed), so every reader of the
project config sees the list.
**Files:** `extensions/mine/env-allowed-subs.ts`, `tests/env-allowed-subs-check.mjs`; the other
real-hook harnesses (quota-routing, refusal-fallback, reset-first, signin-failover checks) put the
module in their vm context.
**Test:** `node tests/env-allowed-subs-check.mjs`: off unless set (unset, blank, commas only),
clean list replacing the file's `allowedSubs`, the hook, and the real multiSub hooks with a
live-shaped config: unset, a limit refusal on anthropic-4 rotates; set to anthropic-4, it stays
(no member, no ChatGPT fallback), and a session started on anthropic-3 moves to anthropic-4.
On the old source (hook check skipped) the "stays" case fails: it rotates to anthropic. No network.
**Compat:** no config file change. Unsetting the variable is the undo for a run; removal for all.

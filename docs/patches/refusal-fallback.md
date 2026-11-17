[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### refusal-fallback  ·  status: local
**Why:** Anthropic's separate cyber classifier can decline an ordinary coding turn;
opt-in routing should try the owner's signed-in alternate once without losing the
conversation or confusing a classifier refusal with exhausted subscription quota.
Anthropic's documented fallback guidance: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.
**Behavior:** top-level `refusalFallback: { enabled: true, provider, model }` (global
or project) handles only the exact Anthropic cyber-classifier error, including its
subscription aliases. Pi 1.0.1 exposes `rawStopReason: "refusal"` and the explanation,
not `stop_details.category`; legacy errors without rawStopReason also match the exact
explanation. Other refusals/errors never match. The non-Anthropic destination must
exist, be signed in and satisfy project restrictions. One ordinary model switch,
one append-only `context_edit` that omits only the incomplete refused response, and
one `agent_before_settle` continuation per user activity. No prompt rewriting/replay,
network probes, account exhaustion, duplicate completed tools or transport changes.
Saved history retains the refused response. The destination stays selected and keeps
its own safety checks; its refusal stops this handler. Stop, new queued input, manual
selection, config changes, failed switching or shutdown cannot schedule a late retry.
`enabled:false` disables it; missing/malformed settings fail closed.
**Hooks in `extensions/multi-sub.ts`:** config normalization/load/effective merge;
`PoolManager.switchRefusalModel()` uses the existing managed `ResetFirst.switchModel()`;
`multiSub()` registers `turn_end`, `agent_before_settle`, user-activity/session reset,
manual-selection and shutdown cancellation.
**Files:** `extensions/mine/refusal-fallback.ts`, `tests/refusal-fallback-check.mjs`;
the existing quota-routing and reset-first VM harnesses import the new pure module.
**Test:** `node tests/refusal-fallback-check.mjs`: strict classifier/config parsing,
continuation after user or completed tool result, opt-in/access/auth/availability,
single retry and no loop, stop/new input/manual selection, races/config changes,
failed/redirected switches, and the actual multiSub event registrations. No network,
model calls or request-body inspection. Optional `PI_REFUSAL_BASELINE_REF=<pre-fix>`
runs the identical hook regression on old source to prove it does not switch/retry.
**Compat:** unpatched upstream harmlessly ignores `refusalFallback`. Other global
config fields and pool routing remain unchanged. Removal/`enabled:false` is the undo.

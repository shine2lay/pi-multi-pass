# Fork quota-aware rotation

[Back to README](../README.md). Account limits are described in [fork limits](fork-limits.md).

## Fork: sticky quota-aware account rotation

Add `quotaRouting` to a pool in `~/.pi/agent/multi-pass.json` (or a project pool override):

```json
"quotaRouting": {
  "policy": "weekly-first",
  "recovery": "earlier-weekly-reset",
  "minWeeklyResetAdvantageMinutes": 0,
  "maxObservationAgeMinutes": 1440
}
```

- **Stay on the chosen subscription until a runtime limit.** No per-message round-robin,
  proactive low-headroom threshold, or periodic rotation timer.
- On failure, choose usable accounts by **earliest weekly reset, then five-hour reset,
  then comparable headroom**. Unknown quota retains eligible fallback order; it is never
  treated as unlimited. A reported cap blocks only its applicable account/model scope.
- A previously failed account becomes eligible after its known reset or conservative retry
  deadline. At the next **idle user-input boundary**, return only if its last observed usable
  weekly allowance resets earlier than the current account's. No minimum hold period applies.
  This is a recovery *attempt*, not proof the new five-hour window is unused. Failures back off.
- Explicit manual model/account selection suppresses prior recovery intent in that session.
  Recovery never interrupts a running turn, tool loop, queued steering input, or automatic retry.
- Model order still comes from the configured chain. This policy reorders accounts within one
  model's pool; it does not jump to another model to burn quota or implement cross-model failback.

Omit `models` to apply to every model in a pool, or add an exact model-ID array. Set `recovery`
to `"off"` for failure-only selection. `minWeeklyResetAdvantageMinutes` can require a larger
reset advantage; zero still requires a strictly earlier reset. `maxObservationAgeMinutes`
controls ranking freshness, not the expiry of explicit exhaustion deadlines. Missing or expired
percentages stay unknown. Remove `quotaRouting` to restore the existing strategy. For matching
models it takes precedence over `resetFirst`; unpatched upstream harmlessly ignores it.

**Anthropic OAuth:** normal response headers populate five-hour, weekly, and reported model-specific
quota snapshots. `current_model_limits` and the single quota footer show the last observation and
staleness. No model probes, undocumented usage endpoint, authentication override, background polling,
or API-key subscription-quota guesses. The first ordinary response must supply usable headers;
missing headers remain unavailable. `/subs limits` still lists only the queryable Codex/Google sources.
(`/subs limit-check`, below, reads Anthropic's usage page when you ask; its readings never feed routing.)
The installed transport exposes successful responses; some error responses have no header event.
Errors without a known exhausted window use bounded retry backoff rather than invented reset times.

**Codex:** uses the existing bounded usage checker when selecting candidates, with a 60-second cache;
normal healthy messages do not scan every account.

Sanitized observations and failure deadlines are stored under `~/.pi/agent/multi-pass-quota/`.
Per-writer shards merge by observation/failure identity across conversations; no raw headers, error
bodies, credentials, prompts, or email addresses are stored. Files are private and old shards expire
after 14 days. Credentials lacking a stable account ID invalidate their cache when rotated/replaced;
one ordinary response repopulates it. Disk failures fall back to session memory.

See [PATCHES.md](../PATCHES.md) for module boundaries, hooks, tests, and fork maintenance notes.

The `/subs limit-check` section formerly below is now in [fork limits](fork-limits.md).

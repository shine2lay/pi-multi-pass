[Patch contract and index](../../PATCHES.md). Source paths and commands are repository-root-relative.

### local-test-workers  ·  status: local
**Why:** the serial shell loop ignored local worker policy even though the checks
already isolate mutable state in separate processes and unique temporary folders.
**Behavior:** `bash scripts/test.sh` uses native Node 22+ `--test` file scheduling,
10 workers locally or a positive integer `WT_CHECK_WORKERS`. `WT_CHECK_WORKERS=1`
keeps the original direct-node serial loop. Nonempty `CI` or `GITHUB_ACTIONS`
always keeps that loop, regardless of the worker override. It still reports every
failure; local native scheduling also finishes every discovered file and fails the
aggregate if any child fails. Invalid local counts fail before any check starts.
Discovery stays `tests/*.mjs`; direct `node tests/<name>.mjs` diagnostics still work.
No unsafe shared-resource class was found; native per-file process isolation is
required (never use shared-process test isolation). SIGINT/SIGTERM process-group
interruption is checked, not crash-proof cleanup after SIGKILL.
**Hooks in `extensions/multi-sub.ts`:** none.
**Files:** `scripts/test.sh`, `tests/local-test-workers-check.mjs`, `PATCHES.md`.
**Test:** `node tests/local-test-workers-check.mjs` uses only synthetic programs
in a temporary Git tree: measured barriers prove default10/override3/serial1,
remote precedence, exact glob inventory (including a spaced filename), failed
children, invalid counts, separate globals and normal/interrupted cleanup. The
same proof accepts `--temper-root PATH` for the plain `test/*-test.mjs` fail-fast
adapter, without adding a dependency to that project.
**Compat/undo:** no runtime/config/package change; revert this patch to restore
the local serial loop. No publication, extension reload or restart required.

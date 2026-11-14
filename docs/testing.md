---
test_check:
  kind: tool
  quarantine: docs/testing-quarantine.md
  below_par: found-below-par.md
  miss_log: docs/testing-misses.jsonl
---

# Testing pi-multi-pass

pi-multi-pass is the `tool` kind. `test-check` reads the block above and scores the repo; the
format is /home/shinelay/projects/agent-tools/docs/test-check-page.md. The facts below come from files by script (make_page.py, QA #155).

## Tools

- Browser test files: 0 (facts table).
- test-check counts 29 test files: tests/antigravity-chain-entries-check.mjs, tests/antigravity-limits-check.mjs, tests/auth-compat-check.mjs, ....
- What they exercise: each of our patches has one check in `tests/<feature>-check.mjs` (PATCHES.md,
  "One check per patch"): moving to the next model when one hits a limit or refuses, reading each
  subscription's limits and reset times, the `/pool` and `/subs` views, quota-aware rotation, and a
  chat that keeps the user's prompt after a custom message. Upstream's own checks run too.
- They are plain `node` scripts; several run the real `extensions/multi-sub.ts` in a small fake world
  (`tests/support/chain-world.mjs`) or against recorded `/subs` replies
  (`tests/support/subs-replies-2026-11-13.json`). A failing check after an upstream sync means a
  patch was lost or broken.

## What runs when

| When | What runs | How long | Source (date) |
| --- | --- | --- | --- |
| Before a change lands (`wt land`, also `wt check`) | `bash scripts/test.sh` (wt entry `pi-multi-pass`); test-check: wt entry pi-multi-pass: check `bash scripts/test.sh` runs node --test (scripts/test.sh:15). A failure refuses the land. | median 0.1 min over the last 10 succeeded lands (each land: check, wait for the land slot, push) | /home/shinelay/projects/agent-tools/wt.yaml:299; land records in /home/shinelay/projects/pi-multi-pass/.git/wt-land-queue/ via test-check on 95eb17c (2026-11-14) |
| After a release | Nothing: no deploy entry in wt.yaml, and no release workflow, scheduled job or timer found | - | /home/shinelay/qa-lab/qa-setup/facts/repo-facts.json, row /home/shinelay/projects/pi-multi-pass (2026-11-14) |

Why: `scripts/test.sh` runs every check, ours and upstream's, so neither a new patch nor an upstream
sync can drop an older patch unnoticed. This is our own copy of an outside project (branch `mine` =
upstream v1.5.0 + one commit per patch, PATCHES.md); `wt land` pushes to our private `shine2lay`
copy (`origin`), never to upstream. A release is a hand step: pi installs this add-on from that git
branch into its own folder (`git:github.com/shine2lay/pi-multi-pass@mine` in pi's settings), so a land
reaches the chats only after pi's copy is updated and pi starts again. Nothing runs after that.

## What is not covered

- Real providers: limits, refusals and sign-ins are faked or recorded, so a change in a provider's
  replies is not caught here.
- The installed copy: nothing checks that pi's copy matches the landed `mine`.
- No smoke test after an update: nothing checks that a new pi session loads the add-on and that
  `/subs` answers. These are level-3 shortfalls.
- Upstream syncs: `scripts/sync-upstream.sh` relies on the checks above; there is no separate test
  of the sync itself.

## How to run

```bash
bash scripts/test.sh   # the landing check
test-check /home/shinelay/projects/pi-multi-pass   # this page's score
```

Rules every test here keeps:

- No automatic re-run. A test that fails and then passes on the same code is repaired, or pulled
  onto [the quarantine list](testing-quarantine.md) with a fix task.
- A skipped test says why and names the task that brings it back.
- Past failures and complaints are checks in [found-below-par.md](../found-below-par.md); bugs that
  got past the tests are in [the miss log](testing-misses.jsonl), each with the test that catches it now.

## Owner

- Ops keeps our copy and writes one check per patch (its commits are Ops tasks, e.g. Ops #866,
  #868). Upstream's checks come from the upstream project.
- Ops owns the landing check in wt.yaml, PATCHES.md, the upstream sync and updating pi's copy.
- QA owns this page, the quarantine list and the miss log, and sets the testing standard.

#!/usr/bin/env bash
# Run every check in tests/ (upstream's and ours). Non-zero exit if any fails.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" || exit 1

# CI and diagnostic serial runs keep the original direct-node loop below.
# Native --test isolates each executable .mjs in its own process.
if [[ -z ${CI:-} && -z ${GITHUB_ACTIONS:-} ]]; then
  workers=${WT_CHECK_WORKERS:-10}
  if [[ ! $workers =~ ^[1-9][0-9]*$ ]]; then
    echo 'WT_CHECK_WORKERS must be a positive integer' >&2
    exit 2
  fi
  if [[ $workers != 1 ]]; then
    exec node --test --test-concurrency="$workers" tests/*.mjs
  fi
fi

pass=0
fail=0
for t in tests/*.mjs; do
  if out=$(node "$t" 2>&1); then
    pass=$((pass + 1))
    echo "ok    $t"
  else
    fail=$((fail + 1))
    echo "FAIL  $t"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
done

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

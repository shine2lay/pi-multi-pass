#!/usr/bin/env bash
# Run every check in tests/ (upstream's and ours). Non-zero exit if any fails.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

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

// Patch: extra-usage-failover. Anthropic's subscription wall ("You're out of
// extra usage") is an HTTP 400 invalid_request_error carrying no ratelimit
// headers. It must be classified as a rate-limit failure so the pool records
// the failure and fails over, instead of retrying the exhausted slot forever.
//
// Evaluates the real RATE_LIMIT_PATTERNS array from multi-sub.ts (not a copy),
// so a regression in the source fails here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
	fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url)),
	"utf8",
);

const block = source.match(/const RATE_LIMIT_PATTERNS\s*=\s*\[([\s\S]*?)\];/);
assert.ok(block, "RATE_LIMIT_PATTERNS array not found in multi-sub.ts");
// Strip comments before eval; the array holds only regex literals.
const body = block[1].replace(/\/\/[^\n]*/g, "");
const patterns = new Function(`return [${body}];`)();
assert.ok(patterns.length >= 8, `expected the upstream patterns to still be present, got ${patterns.length}`);
const isRateLimitError = (msg) => patterns.some((p) => p.test(msg));

// 1. The exact production error body, verbatim (request id from 2026-09-15).
const wall = `400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011Cf5cm4hSLLLhUPVLj8HAm"}`;
assert.equal(isRateLimitError(wall), true, "extra-usage wall must trigger failover");

// 2. Case / whitespace variants Anthropic could plausibly emit.
assert.equal(isRateLimitError("You're Out Of Extra Usage."), true);
assert.equal(isRateLimitError("error: out of extra usage"), true);

// 3. Boundary: 'extra usage' alone (the harmless startup *warning* text) must
//    NOT be treated as a failure — only the "out of" wall is.
assert.equal(
	isRateLimitError("Third-party harness usage draws from extra usage and is billed per token"),
	false,
	"the extra-usage startup notice is not a failure",
);

// 4. Unrelated 400s still don't fail over (no false positives from the new rule).
assert.equal(isRateLimitError(`400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}`), false);
assert.equal(isRateLimitError(`400 Claude Code 2.1.206 does not support this model`), false);

// 5. Upstream behaviour preserved.
assert.equal(isRateLimitError("429 rate_limit_error"), true);
assert.equal(isRateLimitError("overloaded_error"), true);
assert.equal(isRateLimitError("500 internal server error"), false);

console.log("extra-usage-failover: ok");

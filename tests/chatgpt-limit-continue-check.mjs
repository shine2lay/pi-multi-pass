// mine/chatgpt-limit-continue: a Sign in with ChatGPT (openai) usage limit that moves the chat down the
// chain keeps the turn going on the next model: once, with no prompt replay. Retryable errors still wait
// for pi's own retry, so a turn never both retries and continues.
// Owner 2026-11-02: "can you fix the fall back loop ? if it need fixing since we change subs".
// Runs the real multi-sub.ts through the shared chain harness (support/chain-world.mjs) on the live chain
// shape (claude-real -> chatgpt-fallback -> antigravity-fallback, support/live-chain.mjs), with pi's own retry
// classifier from the pi on PATH (support/pi-retry-classifier.mjs). Plain node; no network (fetch throws),
// fake credentials only, no model calls.
// CHATGPT_LIMIT_SOURCE_REF=<ref> loads that ref's multi-sub.ts and fallback-return.ts. 4dddddd: a, c and d fail;
// 37df0b7: a and c fail (they land on Antigravity, which needs mine/antigravity-chain-entries too).
import assert from "node:assert/strict";
import { blockNetwork, chainWorld, continued, loadSources } from "./support/chain-world.mjs";
import { ARGON_MODEL, CHATGPT_LIMIT, CLAUDE, GPT, LIVE_BUILTIN, LIVE_CONFIG, LIVE_REGISTERED, MEMBERS } from "./support/live-chain.mjs";

const ref = process.env.CHATGPT_LIMIT_SOURCE_REF;
const sources = await loadSources(ref);

// The old Codex sign-in's limit text: no status at all.
const CODEX_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min.";
const CLAUDE_429 = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';
const CLAUDE_OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
// The texts tests/runtime-failover-check.mjs (upstream) feeds its own copy of piWillRetryTurn.
const HARNESS_RETRIED = "429 rate limit";
const HARNESS_REPLAYED = '400 {"error":{"message":"usage limit reached"}}';

const world = (opts, run) => chainWorld({ sources, config: LIVE_CONFIG, quotaMembers: MEMBERS, builtin: LIVE_BUILTIN,
	registered: LIVE_REGISTERED, ...opts }, run);

/** One refusal from `start`; the chat lands on `want`. Returns what the first settle gave, the replays and the chat. */
const refuse = (opts, error, want) => world(opts, async (c) => {
	await c.prompt("offline synthetic request");
	const settled = await c.fail(error, "refused");
	assert.deepEqual(c.model, want, `path ${c.path.join(" -> ")}`);
	return { settled, again: await c.settle("refused"), replays: c.replays, piWillRetry: c.piWillRetryTurn(error) };
});

/** pi doesn't retry this one: the turn continues once on the next model, no prompt replay. */
async function continuesOnce(opts, error, want) {
	const r = await refuse(opts, error, want);
	continued(r.settled, "refused");
	assert.deepEqual(r.again, [], "only one continuation for the refusal");
	assert.equal(r.replays, 0, "the prompt is never replayed");
	return r;
}

/** pi retries this one itself: no continuation and no replay, or the turn would run twice. */
async function waitsForPiRetry(opts, error, want) {
	const r = await refuse(opts, error, want);
	assert.deepEqual(r.settled, [], "no continuation: pi retries the turn");
	assert.deepEqual(r.again, [], "no continuation at a later settle either");
	assert.equal(r.replays, 0, "no prompt replay: pi retries the turn");
	assert.equal(r.piWillRetry, true, "piWillRetryTurn: pi retries");
}

const network = blockNetwork("chatgpt-limit-continue checks");
const cases = [
	["a ChatGPT sign-in limit, no Claude room -> Antigravity, the turn continues once, no replay", async () => {
		const r = await continuesOnce({ room: [], start: GPT }, CHATGPT_LIMIT, ARGON_MODEL);
		assert.equal(r.piWillRetry, false, "piWillRetryTurn: pi never retries subscription_sharing_usage_limit_exceeded");
	}],
	["b Claude 429 rate_limit_error and overloaded still wait for pi's retry: in the pool and down the chain", async () => {
		for (const error of [CLAUDE_429, CLAUDE_OVERLOADED]) {
			await waitsForPiRetry({ room: ["anthropic-2"], start: { provider: "anthropic", id: CLAUDE } }, error,
				{ provider: "anthropic-2", id: CLAUDE });
			await waitsForPiRetry({ room: [], start: { provider: "anthropic", id: CLAUDE } }, error, GPT);
		}
	}],
	["c the old Codex usage-limit text still continues the turn", () =>
		continuesOnce({ room: [], start: GPT }, CODEX_LIMIT, ARGON_MODEL)],
	["d piWillRetryTurn is pi's classifier: same answers as runtime-failover-check's copy; no message -> no retry", () =>
		world({ room: [], start: GPT }, async (c) => {
			assert.equal(c.piWillRetryTurn(HARNESS_RETRIED), true, HARNESS_RETRIED);
			assert.equal(c.piWillRetryTurn(HARNESS_REPLAYED), false, HARNESS_REPLAYED);
			for (const missing of ["", undefined, null, 429]) {
				assert.equal(c.piWillRetryTurn(missing), false, `piWillRetryTurn(${JSON.stringify(missing)})`);
			}
		})],
];

let failed = 0;
try {
	for (const [name, run] of cases) {
		try { await run(); console.log(`ok   ${name}`); }
		catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`); }
	}
	assert.deepEqual(network.modelCalls(), [], `no model calls: ${network.urls.join(", ")}`);
} finally { network.restore(); }
console.log(`chatgpt-limit-continue: ${cases.length - failed}/${cases.length} passed${ref ? ` on ${ref}` : ""}; no model calls`);
if (failed) process.exit(1);

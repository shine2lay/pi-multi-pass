// mine/loop-back: a limit refusal anywhere in the chain goes back to the first subscription in the
// list that has room (claude-real, then GPT, then Argon), wrapping past the end to the top.
// Owner via COO rm-7d437b26 (2026-10-23): "fix it so it it'll loop back to first subscription in the list".
// Plain node; no network (fetch throws), fake credentials only, no model calls.
// LOOP_BACK_SOURCE_REF=<ref> loads that ref's multi-sub.ts and fallback-return.ts (49c2efa: a, c, d, e, g fail).
// Fixture config = the shipped shape without the 2026-10-23 stopgap field: GPT and Argon pools carry
// "fallback": false and no "returnOnRefusal". Case g repeats a and c on the live (stopgap) config.
import assert from "node:assert/strict";
import { blockNetwork, chainWorld, continued, loadSources } from "./support/chain-world.mjs";

const ref = process.env.LOOP_BACK_SOURCE_REF;
const sources = await loadSources(ref);
const returnMod = sources.returnMod;

// Live refusal texts (scan-chat-accounts.py, 2026-10-23 07:49-08:59 PDT).
const CODEX_LIMIT = "Codex error: The usage limit has been reached";
const PROMAX_LIMIT = "You have hit your ChatGPT usage limit (promax plan). Try again in ~8780 min.";
const ARGON_LIMIT = "429 quota exhausted";
const CLAUDE_429 = "429 rate_limit_error: This request would exceed your account's rate limit.";
const CLAUDE = "claude-opus-5-5", SOL = "gpt-6.1-sol", ASTRA = "gpt-6-astra", ARGON = "gemini-4-argon";
const MEMBERS = ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"];

const network = blockNetwork("loop-back checks");

const config = (live) => ({
	subscriptions: [], presets: [],
	pools: [
		{ name: "claude-real", baseProvider: "anthropic", members: MEMBERS, enabled: true,
			quotaRouting: { policy: "weekly-first", recovery: "off", minWeeklyResetAdvantageMinutes: 0, maxObservationAgeMinutes: 1440 } },
		{ name: "codex-fallback", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true, fallback: false,
			...(live ? { returnOnRefusal: true } : {}) },
		{ name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"], enabled: true, fallback: false,
			...(live ? { returnOnRefusal: true } : {}) },
	],
	chains: [
		{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: CLAUDE, enabled: true },
			{ pool: "codex-fallback", model: SOL, enabled: true }, { pool: "antigravity-fallback", model: ARGON, enabled: true }] },
		{ name: "fable-then-opus", enabled: false, entries: [{ pool: "claude-real", model: "claude-fable-5-1", enabled: true },
			{ pool: "claude-real", model: "claude-opus-5", enabled: true }] },
	],
	refusalFallback: { enabled: true, provider: "openai-codex", model: SOL },
});

/** The shared chain harness (support/chain-world.mjs) on this fixture: live = the stopgap returnOnRefusal config. */
const world = ({ live = false, ...opts }, run) => chainWorld({ sources, config: config(live), quotaMembers: MEMBERS,
	models: [CLAUDE, SOL, ARGON], ...opts }, run);

/** One GPT-style refusal from `start`; expect the chat on `want` with one continuation. */
const moves = (opts, error, want) => world(opts, async (c) => {
	await c.prompt("offline synthetic request");
	assert.equal(c.path.length, 1, `no move at a send: ${c.path.join(" -> ")}`);
	const settled = await c.fail(error, "refused");
	assert.deepEqual(c.model, want, `path ${c.path.join(" -> ")}`);
	continued(settled, "refused");
	assert.equal((await c.settle("refused")).length, 0, "only one continuation for the refusal");
	assert.equal(c.replays, 0, "the prompt is never replayed");
});

const GPT = { provider: "openai-codex", id: SOL };
const cases = [
	["a GPT limit refusal, a Claude member has room -> that Claude member", () =>
		moves({ room: ["anthropic-4"], start: GPT }, CODEX_LIMIT, { provider: "anthropic-4", id: CLAUDE })],
	["b GPT limit refusal, every Claude member at its limit -> Argon", () =>
		moves({ room: [], start: GPT }, CODEX_LIMIT, { provider: "antigravity", id: ARGON })],
	["c Argon limit refusal wraps to the top: Claude at its limit -> GPT; Claude with room -> Claude", async () => {
		await moves({ room: [], start: { provider: "antigravity", id: ARGON } }, ARGON_LIMIT, GPT);
		await moves({ room: ["anthropic-2", "anthropic-3"], start: { provider: "antigravity", id: ARGON },
			resetDays: { "anthropic-2": 5, "anthropic-3": 1 } }, ARGON_LIMIT, { provider: "anthropic-3", id: CLAUDE });
	}],
	["d GPT on a non-chain model (gpt-6-astra) follows the same order as gpt-6.1-sol", () =>
		moves({ room: ["anthropic-2"], start: { provider: "openai-codex", id: ASTRA } }, CODEX_LIMIT, { provider: "anthropic-2", id: CLAUDE })],
	["e the promax usage-limit text moves the chat and continues the turn", () =>
		moves({ room: ["anthropic-3"], start: GPT }, PROMAX_LIMIT, { provider: "anthropic-3", id: CLAUDE })],
	["f every account at its limit: one plain notice, no move, no loop", () =>
		world({ room: [], start: GPT }, async (c) => {
			await c.prompt("offline synthetic request");
			continued(await c.fail(CODEX_LIMIT, "gpt"), "gpt");
			assert.deepEqual(c.model, { provider: "antigravity", id: ARGON });
			for (const id of ["argon-1", "argon-2"]) {
				const before = c.notes.length;
				assert.equal((await c.fail(ARGON_LIMIT, id)).length, 0, `${id}: nothing continued`);
				const added = c.notes.slice(before).filter((n) => /exhausted|rate limited|at (?:its|their) limit/i.test(n) && !/skipped/.test(n));
				assert.equal(added.length, 1, `${id}: one plain notice, got ${JSON.stringify(c.notes.slice(before))}`);
			}
			assert.deepEqual(c.path, ["openai-codex/gpt-6.1-sol", "antigravity/gemini-4-argon"], "no move once every account refused");
			assert.equal(c.replays, 0);
		})],
	["g live config (stopgap returnOnRefusal: true) does the same as a and c", async () => {
		await moves({ live: true, room: ["anthropic-4"], start: GPT }, CODEX_LIMIT, { provider: "anthropic-4", id: CLAUDE });
		await moves({ live: true, room: [], start: { provider: "antigravity", id: ARGON } }, ARGON_LIMIT, GPT);
	}],
	["h each account once per turn: Claude -> GPT -> Argon -> no ping-pong", () =>
		world({ room: ["anthropic-4"], start: GPT }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CODEX_LIMIT, "gpt");
			assert.equal(c.model.provider, "anthropic-4");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(c.model.provider, "antigravity", `GPT already refused this turn: ${c.path.join(" -> ")}`);
			assert.equal((await c.fail(ARGON_LIMIT, "argon")).length, 0);
			assert.deepEqual(c.path, ["openai-codex/gpt-6.1-sol", "anthropic-4/claude-opus-5-5", "antigravity/gemini-4-argon"]);
			assert.equal(c.replays, 0);
		})],
	["i /pool status shows the loop for every pool", () =>
		world({ room: MEMBERS, start: GPT }, async (c) => {
			for (const name of ["claude-real", "codex-fallback", "antigravity-fallback"]) {
				const line = returnMod.loopBackLine?.(config(false), name);
				assert.match(line ?? "", /limit refusal.*first account with room.*claude-real.*codex-fallback.*antigravity-fallback/, `${name}: ${line}`);
			}
		})],
];

let failed = 0;
try {
	for (const [name, fn] of cases) {
		try { await fn(); console.log(`ok   loop-back: ${name}`); }
		catch (error) { failed++; console.log(`FAIL loop-back: ${name}: ${error.message.split("\n")[0]}`); }
	}
	assert.deepEqual(network.modelCalls(), [], `no model calls: ${network.urls.join(", ")}`);
} finally { network.restore(); }
console.log(`loop-back: ${cases.length - failed}/${cases.length} passed${ref ? ` on ${ref}` : ""}; no model calls`);
if (failed) process.exit(1);

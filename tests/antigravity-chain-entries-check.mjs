// mine/antigravity-chain-entries: the chain's Antigravity entries are usable, so a limit with no Claude room
// moves the chat on to Antigravity and the turn keeps going. pi-ai's built-in catalog has no "antigravity"
// provider; pi-antigravity registers it through pi.registerProvider, so only pi's live model registry holds
// its models. Upstream listed a pool's models from the built-in catalog alone: both Antigravity entries read
// "invalid model: no selectable models for antigravity" and the rotation skipped them.
// Owner 2026-11-02: "can you fix the fall back loop ? if it need fixing since we change subs".
// Runs the real multi-sub.ts through support/chain-world.mjs on the live chain (support/live-chain.mjs), with
// models as pi has them: anthropic and openai built in, antigravity only in the registry. Plain node; no
// network (fetch throws), fake credentials only, no model calls.
// ANTIGRAVITY_ENTRIES_SOURCE_REF=<ref> loads that ref's multi-sub.ts and fallback-return.ts (37df0b7: a-e fail,
// d with the live "2 invalid | 2/4 usable now"; f passes, as it tests this tree's pool-models.ts; on 248a173, the
// models commit, only e fails: its /pool status listed skipped entries as healthy).
import assert from "node:assert/strict";
import { blockNetwork, chainWorld, continued, loadSources } from "./support/chain-world.mjs";
import { ANTIGRAVITY_CLAUDE, ARGON, ARGON_MODEL, ARGON_QUOTA, CHATGPT_LIMIT, CLAUDE, GPT, LIVE_BUILTIN, LIVE_CONFIG,
	LIVE_REGISTERED, MEMBERS } from "./support/live-chain.mjs";
import { NO_REGISTRY_WARNING, PoolModelCatalog } from "../extensions/mine/pool-models.ts";

const ref = process.env.ANTIGRAVITY_ENTRIES_SOURCE_REF;
const sources = await loadSources(ref);

const UNLISTED = "gemini-0-unlisted"; // in neither pi-ai's catalog nor the registry
const world = (opts, run) => chainWorld({ sources, config: LIVE_CONFIG, quotaMembers: MEMBERS, builtin: LIVE_BUILTIN,
	registered: LIVE_REGISTERED, room: [], start: GPT, ...opts }, run);

/** The line /pool chain list shows for claude-then-sol. */
async function chainListLine(c) {
	await c.command("pool", "chain list");
	const shown = c.selects.find((s) => s.title === "Chains");
	assert.ok(shown, `/pool chain list showed a Chains list (notes: ${c.notes.join(" | ")})`);
	return shown.items.find((line) => line.startsWith("claude-then-sol |"));
}

/** The loop: lines /pool status shows, one per pool in the chain. */
async function poolStatusLoopLines(c) {
	await c.command("pool", "status");
	const shown = c.selects.find((s) => s.title === "Pool Status");
	assert.ok(shown, `/pool status showed a Pool Status list (notes: ${c.notes.join(" | ")})`);
	const loops = shown.items.filter((line) => line.startsWith("loop:"));
	assert.equal(loops.length, 3, `one loop: line per chain pool:\n${shown.items.join("\n")}`);
	return loops;
}

/** One refusal in a turn of its own: the chat lands on `want` and the turn continues once, no prompt replay. */
async function refuseAndContinue(c, error, want, id) {
	const replaysBefore = c.replays;
	await c.prompt("offline synthetic request");
	const settled = await c.fail(error, id);
	assert.deepEqual(c.model, want, `path ${c.path.join(" -> ")}`);
	continued(settled, id);
	assert.deepEqual(await c.settle(id), [], "only one continuation for the refusal");
	assert.equal(c.replays, replaysBefore, "the prompt is never replayed");
	assert.equal(c.piWillRetryTurn(error), false, "pi's classifier never retries this text");
}

const network = blockNetwork("antigravity-chain-entries checks");
const cases = [
	["a ChatGPT sign-in limit, no Claude room -> Antigravity Argon (entry 3), the turn continues once, no replay", () =>
		world({}, (c) => refuseAndContinue(c, CHATGPT_LIMIT, ARGON_MODEL, "chatgpt-limit"))],
	["b Argon 'Quota reached' (2026-11-02 17:13) -> Claude on Antigravity (entry 4), the turn continues once", () =>
		world({}, async (c) => {
			await refuseAndContinue(c, CHATGPT_LIMIT, ARGON_MODEL, "chatgpt-limit");
			await refuseAndContinue(c, ARGON_QUOTA, ANTIGRAVITY_CLAUDE, "argon-quota");
		})],
	["c a model in neither pi-ai's catalog nor the registry stays invalid and is skipped", () => {
		const config = structuredClone(LIVE_CONFIG);
		config.chains[0].entries.splice(2, 0, { pool: "antigravity-fallback", model: UNLISTED, enabled: true });
		return world({ config }, async (c) => {
			const line = await chainListLine(c);
			assert.match(line, /\| 5 entries \| enabled \| 1 invalid \|/, line);
			await refuseAndContinue(c, CHATGPT_LIMIT, ARGON_MODEL, "chatgpt-limit"); // past the unlisted entry
		});
	}],
	["d /pool chain list on the live chain: no invalid entry, 4/4 usable", () =>
		world({ room: ["anthropic-2"] }, async (c) => {
			const line = await chainListLine(c);
			assert.equal(line, "claude-then-sol | 4 entries | enabled | 4/4 usable now");
		})],
	["e /pool status loop: lines mark the entries the rotation skips, so a broken loop never reads healthy", async () => {
		await world({}, async (c) => {
			for (const line of await poolStatusLoopLines(c)) {
				assert.match(line, / in claude-real -> chatgpt-fallback -> antigravity-fallback, wrapping to the top;/, line);
				assert.doesNotMatch(line, /invalid/, line);
			}
		});
		// As live before this patch: antigravity in no list pi-multi-pass reads -> both of its entries skipped.
		await world({ registered: [] }, async (c) => {
			for (const line of await poolStatusLoopLines(c)) {
				assert.match(line, / -> antigravity-fallback \(invalid, skipped\), wrapping to the top;/, line);
				assert.match(line, /; skips invalid entries: antigravity-fallback -> gemini-4-argon \(invalid model: no selectable models for antigravity\), antigravity-fallback -> claude-opus-5-5 \(invalid model: no selectable models for antigravity\)$/, line);
			}
		});
		const config = structuredClone(LIVE_CONFIG);
		config.chains[0].entries.splice(2, 0, { pool: "antigravity-fallback", model: UNLISTED, enabled: true });
		await world({ config }, async (c) => {
			for (const line of await poolStatusLoopLines(c)) {
				assert.match(line, / -> antigravity-fallback \(1 of 3 entries invalid\), wrapping to the top;/, line);
				assert.match(line, new RegExp(`; skips invalid entries: antigravity-fallback -> ${UNLISTED} \\(invalid model: ${UNLISTED} unavailable for antigravity-fallback\\)$`), line);
			}
		});
	}],
	["f pool models: built-in first, then registry models of the base provider or a member, each id once", () => {
		const warnings = [];
		const catalog = new PoolModelCatalog((provider) => ({ anthropic: [CLAUDE, "claude-opus-5"] })[provider] ?? [],
			(message) => warnings.push(message));
		const claudePool = { name: "claude-real", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"] };
		const antigravityPool = { name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"] };
		// No registry: built-in only, one plain warning however often it is asked.
		assert.deepEqual(catalog.modelIds(claudePool), [CLAUDE, "claude-opus-5"]);
		assert.deepEqual(catalog.modelIds(antigravityPool), []);
		catalog.useRegistry(() => ({ find() {} })); // a registry without getAll: the same
		assert.deepEqual(catalog.modelIds(antigravityPool), []);
		assert.deepEqual(warnings, [NO_REGISTRY_WARNING], "one warning");
		// The registry is read at every call: a provider registered later shows up.
		let models = [];
		catalog.useRegistry(() => ({ getAll: () => models }));
		assert.deepEqual(catalog.modelIds(antigravityPool), []);
		models = [{ provider: "anthropic", id: CLAUDE }, { provider: "anthropic-2", id: "claude-member-only" },
			{ provider: "antigravity", id: ARGON }, { provider: "antigravity", id: CLAUDE }, { provider: "openai", id: "gpt-x" },
			{ provider: "antigravity", id: 7 }, null];
		assert.deepEqual(catalog.modelIds(claudePool), [CLAUDE, "claude-opus-5", "claude-member-only"]);
		assert.deepEqual(catalog.modelIds(antigravityPool), [ARGON, CLAUDE]);
		assert.equal(warnings.length, 1, "no more warnings once a registry answers");
		// Fail loud on what it can't work from.
		assert.throws(() => catalog.modelIds({ name: "x", members: [] }), /needs a baseProvider/);
		assert.throws(() => catalog.modelIds({ name: "x", baseProvider: "antigravity" }), /needs a members list/);
		catalog.useRegistry(() => ({ getAll: () => "not a list" }));
		assert.throws(() => catalog.modelIds(antigravityPool), /getAll\(\) did not return a list/);
		assert.throws(() => catalog.useRegistry({ getAll: () => [] }), /needs an accessor function/);
		assert.throws(() => new PoolModelCatalog(undefined, () => {}), /needs builtinIds/);
	}],
];

let failed = 0;
try {
	for (const [name, run] of cases) {
		try { await run(); console.log(`ok   ${name}`); }
		catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`); }
	}
	assert.deepEqual(network.modelCalls(), [], `no model calls: ${network.urls.join(", ")}`);
} finally { network.restore(); }
console.log(`antigravity-chain-entries: ${cases.length - failed}/${cases.length} passed${ref ? ` on ${ref}` : ""}; no model calls`);
if (failed) process.exit(1);

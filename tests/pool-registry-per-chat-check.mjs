// mine/antigravity-chain-entries, third commit (Ops #769): every chat's failover and chain views read the
// model registry of the chat whose event or command is handled, never another chat's. pi-web-ui loads
// multi-sub.ts once for all chats of a folder; before, each session_start pointed one module-level accessor
// at its own ctx, so the last chat to start won, and once its session was replaced every other chat's
// failover threw "This extension ctx is stale after session replacement or reload" and stopped on the
// provider error (journal 11-02 21:06-21:31, 11-03 02:23-02:26; Ops #766).
// Owner m86760: "can you fix the fall back loop". Hypothesis H-POOL-REGISTRY-1 in PATCHES.md.
// One loaded copy (support/chain-world.mjs chainFolder), the live chain (support/live-chain.mjs). Plain node;
// no network (fetch throws), fake credentials only, no model calls.
// POOL_REGISTRY_SOURCE_REF=<ref> loads that ref's multi-sub.ts and fallback-return.ts (78712dc: a-c fail;
// d passes, as it tests this tree's pool-models.ts).
import assert from "node:assert/strict";
import { blockNetwork, chainFolder, continued, loadSources, STALE_CTX } from "./support/chain-world.mjs";
import { ARGON, ARGON_MODEL, CHATGPT_LIMIT, CLAUDE, GPT, LIVE_BUILTIN, LIVE_CONFIG, LIVE_REGISTERED, MEMBERS }
	from "./support/live-chain.mjs";
import { NO_REGISTRY_WARNING, PoolModelCatalog } from "../extensions/mine/pool-models.ts";

const ref = process.env.POOL_REGISTRY_SOURCE_REF;
const sources = await loadSources(ref);

const folder = (opts, run) => chainFolder({ sources, config: LIVE_CONFIG, quotaMembers: MEMBERS, builtin: LIVE_BUILTIN,
	registered: LIVE_REGISTERED, room: [], ...opts }, run);

/** The line /pool chain list shows for claude-then-sol in this chat. */
async function chainListLine(chat) {
	const before = chat.selects.length;
	await chat.command("pool", "chain list");
	const shown = chat.selects.slice(before).find((s) => s.title === "Chains");
	assert.ok(shown, `/pool chain list showed a Chains list (notes: ${chat.notes.join(" | ")})`);
	return shown.items.find((line) => line.startsWith("claude-then-sol |"));
}

/** A ChatGPT sign-in limit with no Claude room: the chat lands on Argon and the turn continues once. */
async function limitMovesToArgon(chat, id) {
	await chat.prompt("offline synthetic request");
	const settled = await chat.fail(CHATGPT_LIMIT, id);
	assert.deepEqual(chat.model, ARGON_MODEL, `path ${chat.path.join(" -> ")}`);
	continued(settled, id);
}

const network = blockNetwork("pool-registry-per-chat checks");
const cases = [
	["a chat B (started last) is replaced; chat A's ChatGPT limit still moves A to Argon, and B's stale ctx is never read", () =>
		folder({}, async (f) => {
			const a = await f.open({ start: GPT });
			const b = await f.open({ start: GPT });
			await b.replace();
			assert.throws(() => b.ctx.modelRegistry, new RegExp(STALE_CTX), "B's ctx reads as pi's stale ctx");
			const readsBefore = b.staleReads; // the assert above is one
			await limitMovesToArgon(a, "a-limit");
			assert.equal(b.staleReads, readsBefore, "A's failover never read B's ctx");
			assert.doesNotMatch(await chainListLine(a), /invalid/, "A's chain views read A's registry");
			assert.equal(b.staleReads, readsBefore, "nor did A's /pool chain list");
		})],
	["b each chat's registry is its own: A (Antigravity registered) moves to Argon although B (started last) has none", () =>
		folder({}, async (f) => {
			const a = await f.open({ start: GPT });
			const b = await f.open({ start: GPT, registered: [] });
			assert.match(await chainListLine(b), /\| 2 invalid \|/, "B's own registry has no Antigravity models");
			assert.doesNotMatch(await chainListLine(a), /invalid/, "A's has them");
			await limitMovesToArgon(a, "b-limit");
		})],
	["c a chat with no registry gets built-in models and the one warning, never another chat's registry", () =>
		folder({}, async (f) => {
			const a = await f.open({ start: GPT });
			const c = await f.open({ start: GPT, registry: "no-getAll" });
			assert.match(await chainListLine(c), /\| 2 invalid \|/, "C: built-in models only");
			assert.match(await chainListLine(c), /\| 2 invalid \|/, "C again");
			assert.doesNotMatch(await chainListLine(a), /invalid/, "A keeps its own registry after C started");
			await limitMovesToArgon(a, "c-limit");
			assert.deepEqual(f.warnings.filter((w) => w === NO_REGISTRY_WARNING), [NO_REGISTRY_WARNING], "one warning");
		})],
	["d PoolModelCatalog keeps no registry: each call reads the one it is given, and leaving it out throws", () => {
		const warnings = [];
		const catalog = new PoolModelCatalog((provider) => ({ anthropic: [CLAUDE] })[provider] ?? [], (m) => warnings.push(m));
		const pool = { name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"] };
		const withArgon = { getAll: () => [{ provider: "antigravity", id: ARGON }] };
		const empty = { getAll: () => [] };
		assert.deepEqual(catalog.modelIds(pool, withArgon), [ARGON]);
		assert.deepEqual(catalog.modelIds(pool, empty), [], "the next call reads its own registry, not the last one");
		assert.deepEqual(catalog.modelIds(pool, withArgon), [ARGON]);
		assert.deepEqual(catalog.modelIds(pool, undefined), [], "no registry: built-in only");
		assert.deepEqual(warnings, [NO_REGISTRY_WARNING]);
		assert.throws(() => catalog.modelIds(pool), /needs the chat's model registry/);
		assert.equal(typeof catalog.useRegistry, "undefined", "no shared registry setter");
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
console.log(`pool-registry-per-chat: ${cases.length - failed}/${cases.length} passed${ref ? ` on ${ref}` : ""}; no model calls`);
if (failed) process.exit(1);

// mine/row-failover (model routing S5, Ops #868): a chat whose department has a model table moves along that
// table's tier row when it hits a limit, not along the global chain (claude-then-sol). Owner's plan
// (Show&Tell d_udizqai7oz, decision 6): "the mid-chat fallback also follows each department's own order".
// pi-queue's router is faked here by a small row walker on its route channel (same answer shape as
// pi-queue's api.chatFailover); the chat runs through the real multi-sub.ts (support/chain-world.mjs).
// Plain node; no network (fetch throws), fake credentials only, no model calls.
// ROW_FAILOVER_SOURCE_REF=<ref> loads that ref's multi-sub.ts (db3e721: a, c, d, g fail: global chain).
import assert from "node:assert/strict";
import { blockNetwork, chainWorld, loadSources } from "./support/chain-world.mjs";

const sources = await loadSources(process.env.ROW_FAILOVER_SOURCE_REF);
const KEY = Symbol.for("pi-queue.model-route");

const CLAUDE = "claude-opus-5-5", SOL = "gpt-6.1-sol", ASTRA = "gpt-6-astra", CARBON = "gemini-4-carbon";
const CLAUDE_429 = "429 rate_limit_error: This request would exceed your account's rate limit.";
const AG_429 = "429 quota exhausted";
const MEMBERS = ["anthropic", "anthropic-2"];

const network = blockNetwork("row-failover checks");

/** The live pools and chain (Argon disabled, Ops lead 2026-11-12). */
const config = ({ antigravity = true } = {}) => ({
	subscriptions: [], presets: [],
	pools: [
		{ name: "claude-real", baseProvider: "anthropic", members: MEMBERS, enabled: true,
			quotaRouting: { policy: "weekly-first", recovery: "off", minWeeklyResetAdvantageMinutes: 0, maxObservationAgeMinutes: 1440 } },
		{ name: "chatgpt-fallback", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true, fallback: false, returnOnRefusal: true },
		{ name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"], enabled: antigravity, fallback: false,
			returnOnRefusal: true },
	],
	chains: [
		{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: CLAUDE, enabled: true },
			{ pool: "chatgpt-fallback", model: SOL, enabled: true }, { pool: "antigravity-fallback", model: "gemini-4-argon", enabled: false },
			{ pool: "antigravity-fallback", model: CLAUDE, enabled: true }] },
	],
});

// ── fake pi-queue router: the ops table's high row (order anthropic, antigravity, openai) ──
const ROW = [
	{ column: "anthropic", model: `anthropic/${CLAUDE}`, thinking: "high" },
	{ column: "antigravity", model: `antigravity/${CARBON}`, thinking: "high" },
	{ column: "openai", model: `openai-codex/${ASTRA}`, thinking: "medium" },
];
const columnOf = (provider) => {
	const base = provider.replace(/-\d+$/, "");
	return base === "openai" || base === "openai-codex" ? "openai" : ["anthropic", "antigravity"].includes(base) ? base : undefined;
};
const cellKey = (model) => { const [p, id] = model.split("/"); return `${columnOf(p)}/${id}`; };

/** Installs the fake channel; returns its call log. session.role / noTable / limited (columns) steer it. */
function fakeRouter({ throws = false } = {}) {
	const log = { asks: [], logged: [], routed: [] };
	globalThis[KEY] = { v: 1, api: {
		columnOf,
		chatFailover: ({ session, failed, tried = [] }) => {
			log.asks.push({ failed, tried: tried.map((t) => t.model) });
			if (throws) throw new Error("table unreadable");
			if (!session?.role) return { problems: [] };
			if (session.noTable) return { role: session.role, problems: [], result: { action: "default", why: "no-table", line: "no table" } };
			const passed = new Set([failed, ...tried].map((c) => cellKey(c.model)));
			const cell = ROW.find((c) => !passed.has(cellKey(c.model)) && !(session.limited ?? []).includes(c.column));
			const tier = "high";
			if (!cell) return { role: session.role, problems: [], result: { action: "keep", why: "all-limited", tier, until: 1,
				line: `${session.role} lead failover · tier high · every cell limited` } };
			return { role: session.role, problems: [], result: { action: "pick", why: "fallback", tier,
				pick: { model: cell.model, thinking: cell.thinking, column: cell.column },
				line: `${session.role} lead failover · tier high · ${cell.model} @ ${cell.thinking} · fallback` } };
		},
		logFailover: (result) => { log.logged.push(result.pick?.model); return "decisions.jsonl"; },
		routedSwitch: (sessionId, model) => log.routed.push(`${sessionId} ${model}`),
	} };
	return log;
}

const session = (extra = {}) => ({ getSessionId: () => "chat-1", getSessionFile: () => "/tmp/chat-1.jsonl", getBranch: () => [], ...extra });
const world = ({ antigravity, ...opts }, run) => chainWorld({ sources, config: config({ antigravity }), quotaMembers: MEMBERS,
	builtin: { anthropic: [CLAUDE], "openai-codex": [SOL, ASTRA] }, registered: [{ provider: "antigravity", id: CARBON },
		{ provider: "antigravity", id: CLAUDE }], thinking: "xhigh", ...opts }, run);
const at = (c) => `${c.model.provider}/${c.model.id}@${c.thinking}`;
const CLAUDE_START = { provider: "anthropic", id: CLAUDE };

const cases = [
	["a ops lead chat, both Claude accounts limited -> the row's next cell (Carbon @ high), not GPT Sol", async () => {
		const log = fakeRouter();
		await world({ room: [], start: CLAUDE_START, session: session({ role: "ops" }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(at(c), `antigravity/${CARBON}@high`, `path ${c.path.join(" -> ")}`);
			assert.deepEqual(log.routed, [`chat-1 antigravity/${CARBON}`], "the switch is announced to pi-queue as routing");
			assert.deepEqual(log.logged, [`antigravity/${CARBON}`], "one decision logged");
			assert.ok(c.notes.some((n) => n.includes(`antigravity/${CARBON} @ high`)), `the route line is shown: ${c.notes.join(" | ")}`);
		});
	}],
	["b Claude account 2 has room -> the pool rotates accounts first (same model, thinking kept, nothing logged)", async () => {
		const log = fakeRouter();
		await world({ room: ["anthropic-2"], start: CLAUDE_START, session: session({ role: "ops" }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(at(c), `anthropic-2/${CLAUDE}@xhigh`, `path ${c.path.join(" -> ")}`);
			assert.deepEqual(log.logged, []);
		});
	}],
	["c Carbon then fails in the same turn -> the next cell (Astra @ medium); tried cells passed to the router", async () => {
		const log = fakeRouter();
		await world({ room: [], start: CLAUDE_START, session: session({ role: "ops" }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			await c.fail(AG_429, "carbon");
			assert.equal(at(c), `openai-codex/${ASTRA}@medium`, `path ${c.path.join(" -> ")}`);
			assert.deepEqual(JSON.parse(JSON.stringify(log.asks.at(-1))), { failed: { model: `antigravity/${CARBON}`, thinking: "high" }, tried: [`anthropic/${CLAUDE}`] });
		});
	}],
	["d a picked cell with no eligible account here (Antigravity pool off) is passed over -> Astra", async () => {
		const log = fakeRouter();
		await world({ antigravity: false, room: [], start: CLAUDE_START, session: session({ role: "ops" }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(at(c), `openai-codex/${ASTRA}@medium`, `path ${c.path.join(" -> ")}`);
			assert.equal(log.asks.length, 2, "asked again after passing the cell over");
		});
	}],
	["e department with no table -> the global chain (GPT Sol), thinking kept", async () => {
		const log = fakeRouter();
		await world({ room: [], start: CLAUDE_START, session: session({ role: "ops", noTable: true }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(at(c), `openai-codex/${SOL}@xhigh`, `path ${c.path.join(" -> ")}`);
			assert.deepEqual(log.routed, []);
		});
	}],
	["f chat of no role, no session, no channel, or a channel that throws -> the global chain", async () => {
		const runs = [
			() => { fakeRouter(); return session(); },
			() => { fakeRouter(); return undefined; },
			() => { delete globalThis[KEY]; return session({ role: "ops" }); },
			() => { fakeRouter({ throws: true }); return session({ role: "ops" }); },
		];
		for (const setup of runs) {
			const s = setup();
			await world({ room: [], start: CLAUDE_START, session: s }, async (c) => {
				await c.prompt("offline synthetic request");
				await c.fail(CLAUDE_429, "claude");
				assert.equal(at(c), `openai-codex/${SOL}@xhigh`, `path ${c.path.join(" -> ")}`);
			});
		}
	}],
	["g every other cell of the row limited -> no move, the router's line, one exhausted notice", async () => {
		fakeRouter();
		await world({ room: [], start: CLAUDE_START, session: session({ role: "ops", limited: ["antigravity", "openai"] }) }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CLAUDE_429, "claude");
			assert.equal(at(c), `anthropic/${CLAUDE}@xhigh`, `path ${c.path.join(" -> ")}`);
			assert.ok(c.notes.some((n) => n.includes("every cell limited")), c.notes.join(" | "));
			assert.equal(c.notes.filter((n) => n.includes("Failover exhausted")).length, 1, c.notes.join(" | "));
		});
	}],
];

let failed = 0;
for (const [name, fn] of cases) {
	try { await fn(); console.log(`ok    ${name}`); }
	catch (error) { failed++; console.log(`FAIL  ${name}\n      ${String(error.message).split("\n").join("\n      ")}`); }
}
delete globalThis[KEY];
network.restore();
assert.deepEqual(network.modelCalls(), [], "no model endpoint was called");
if (failed) { console.log(`${failed} of ${cases.length} failed`); process.exit(1); }
console.log(`all ${cases.length} row-failover checks passed`);

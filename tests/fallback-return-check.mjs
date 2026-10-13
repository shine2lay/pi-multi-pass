// mine/fallback-return: a chat on the fallback pool (GPT backup) goes back to the primary Claude pool
// by itself when a Claude account can take the turn; never more than one step up per turn.
// Plain node; no network (fetch throws), no real auth.json, fake credentials only, no model calls.
// FALLBACK_RETURN_SOURCE_REF=<ref> runs the hook cases on that ref's multi-sub.ts instead (old mine:
// they must fail, the chat stays on openai-codex).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import * as signin from "../extensions/mine/signin-failover.ts";
import * as refusal from "../extensions/mine/refusal-fallback.ts";
import * as quotaState from "../extensions/mine/quota-state.ts";
import * as accountPolicy from "../extensions/mine/account-policy.ts";
import * as quotaRouting from "../extensions/mine/quota-routing.ts";
import * as anthropicQuota from "../extensions/mine/anthropic-quota.ts";
import * as limits from "../extensions/mine/current-model-limits.ts";
import * as reset from "../extensions/mine/reset-first.ts";
import * as modelFallback from "../extensions/mine/model-fallback.ts";
import * as countdown from "../extensions/mine/reset-countdown.ts";
import * as subsLimits from "../extensions/mine/subs-limits.ts";
import * as envAllowed from "../extensions/mine/env-allowed-subs.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.env.FALLBACK_RETURN_SOURCE_REF;
const sourceCode = ref
	? execFileSync("git", ["show", `${ref}:extensions/multi-sub.ts`], { cwd: root, encoding: "utf8" })
	: fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
let returnMod = {};
try { returnMod = await import("../extensions/mine/fallback-return.ts"); } catch { /* old mine: module absent */ }

// The live 2026-10-11 text from the stuck chats (openai-codex, gpt-6.1-sol).
const CODEX_LIMIT = "Codex error: The usage limit has been reached";
const CLAUDE_429 = "429 rate_limit_error: This request would exceed your account's rate limit.";
const CLAUDE = "claude-opus-5-5", SOL = "gpt-6.1-sol";
const MEMBERS = ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"];

let checked = 0;
const urls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error("Network forbidden in fallback-return checks"); };
const check = async (name, fn) => {
	try { await fn(); checked++; }
	catch (error) { throw new Error(`fallback-return: ${name}: ${error.message}`); }
};

const poolsConfig = ({ fallbackFlag = true } = {}) => ({
	subscriptions: [], presets: [],
	pools: [
		{ name: "claude-real", baseProvider: "anthropic", members: MEMBERS, enabled: true,
			quotaRouting: { policy: "weekly-first", recovery: "earlier-weekly-reset", minWeeklyResetAdvantageMinutes: 0, maxObservationAgeMinutes: 1440 } },
		{ name: "codex-fallback", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true,
			...(fallbackFlag ? { fallback: true } : {}) },
	],
	chains: [
		{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: CLAUDE, enabled: true }, { pool: "codex-fallback", model: SOL, enabled: true }] },
		{ name: "fable-then-opus", enabled: false, entries: [{ pool: "claude-real", model: "claude-fable-5-1", enabled: true }, { pool: "claude-real", model: "claude-opus-5", enabled: true }] },
	],
	refusalFallback: { enabled: true, provider: "openai-codex", model: SOL },
});

// Fake credentials (no real token material); keys only identify the fake accounts' quota shards.
const creds = Object.fromEntries([...MEMBERS, "openai-codex"].map((p, i) => [p, { type: "oauth", access: `fake-at-${i}`, refresh: `fake-rt-${i}`, expires: 9e12 }]));

/** room: members with weekly room (26%); every other Claude member is at its weekly limit. */
function writeQuota(temp, room) {
	const now = Date.now(), resetAt = Math.floor(now / 1000) + 3 * 86400;
	for (const provider of MEMBERS) {
		const key = quotaState.quotaAccountKey(provider, creds[provider]);
		const full = !room.includes(provider);
		const dir = path.join(temp, "multi-pass-quota", key);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ version: 1, failures: [], windows: [
			{ name: "7d", scope: "account", usedPercent: full ? 100 : 26, resetAt, limited: full, observedAt: now },
			{ name: "account-status", scope: "account", limited: full, ...(full ? { resetAt } : {}), observedAt: now },
		] }));
	}
}

async function world({ room, start, fallbackFlag = true }, run) {
	modelFallback.clearModelExhaustion(); // module-wide state: each fake chat starts clean
	const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-fallback-return-"));
	try {
		fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify(poolsConfig({ fallbackFlag })));
		writeQuota(temp, room);
		const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
			.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
			.replace("export default function multiSub", "function multiSub");
		const production = runInNewContext(`${executable}\n;({multiSub});`, {
			...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
			...limits, ...reset, ...modelFallback, ...countdown, ...subsLimits, ...envAllowed, ...returnMod,
			Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
			readStoredCredential: (provider) => creds[provider],
			builtinProviders: () => [], getModels: () => [{ id: CLAUDE }, { id: SOL }],
			process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
			fetch: globalThis.fetch,
		});
		let current = { provider: start, id: start === "openai-codex" ? SOL : CLAUDE };
		const path_ = [current.provider];
		let replays = 0;
		const events = new Map(), notes = [];
		const ctx = { cwd: temp, get model() { return current; }, isIdle: () => true,
			modelRegistry: {
				authStorage: { hasAuth: (p) => Boolean(creds[p]), get: (p) => creds[p] },
				find: (provider, id) => ({ provider, id }), getProviderAuth: async () => undefined,
			}, ui: { notify: text => notes.push(text), setStatus() {} },
		};
		const emit = async (name, event = {}) => {
			const results = [];
			for (const fn of events.get(name) ?? []) results.push(await fn(event, ctx));
			return results.filter(Boolean);
		};
		production.multiSub({ on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
			registerCommand() {}, registerProvider() {}, registerTool() {},
			sendUserMessage: () => { replays++; },
			setModel: async next => { const previousModel = current; current = { provider: next.provider, id: next.id }; path_.push(current.provider);
				await emit("model_select", { model: current, previousModel, source: "set" }); return true; },
		});
		const boundary = (id) => ({ outcome: "error", continue: false, entries: [], context: {
			contextEntries: [{ sourceEntry: { id: "user" }, messages: [{ role: "user" }] },
				{ sourceEntry: { id }, messages: [{ role: "assistant" }] }], pendingMessages: [] } });
		const c = {
			notes, get model() { return current; }, get path() { return path_; }, get replays() { return replays; },
			/** A new prompt: input (turn start) then before_agent_start. */
			prompt: async (text, { input = true } = {}) => {
				if (input) await emit("input", { text, source: "rpc" });
				await emit("before_agent_start", { prompt: text });
			},
			/** The current member refuses; returns what settle decided. */
			fail: async (error, id = `failed-${path_.length}`) => {
				const message = { role: "assistant", provider: current.provider, model: current.id, stopReason: "error", errorMessage: error };
				await emit("turn_end", { message, messageEntryId: id });
				await emit("agent_end", { messages: [message] });
				return emit("agent_before_settle", boundary(id));
			},
		};
		await emit("session_start", {});
		return await run(c);
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

try {
	await check("1 turn start: a codex chat goes back up when Claude 3 has room", () =>
		world({ room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.deepEqual(c.model, { provider: "anthropic-3", id: CLAUDE }, `path ${c.path.join(" -> ")}`);
			assert.ok(c.notes.some((n) => /fallback-return: openai-codex -> anthropic-3/.test(n)), "the step up is reported");
		}));

	await check("2 mid-turn: the Codex usage-limit refusal continues on Claude", () =>
		world({ room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request", { input: false }); // a run already going on codex
			const settled = await c.fail(CODEX_LIMIT, "codex-failed");
			assert.deepEqual(c.model, { provider: "anthropic-3", id: CLAUDE }, `path ${c.path.join(" -> ")}`);
			assert.equal(c.replays, 0, "the user's prompt is never replayed");
			assert.deepEqual(settled[0], { entries: [{ type: "context_edit", targetId: "codex-failed", replacement: null }], continue: true },
				"the run continues once on the new member");
		}));

	await check("3 all Claude exhausted: the chat stays on codex, as today", () =>
		world({ room: [], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal(c.model.provider, "openai-codex");
			const settled = await c.fail(CODEX_LIMIT);
			assert.equal(c.model.provider, "openai-codex", `path ${c.path.join(" -> ")}`);
			assert.equal(c.path.length, 1, "no switch at all");
			assert.equal(settled.length, 0, "nothing continued");
		}));

	await check("4 no ping-pong: up, Claude refuses, down to codex, codex refuses: stays down", () =>
		world({ room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal(c.model.provider, "anthropic-3");
			await c.fail(CLAUDE_429);
			assert.equal(c.model.provider, "openai-codex", `down the chain: ${c.path.join(" -> ")}`);
			await c.fail(CODEX_LIMIT);
			assert.deepEqual(c.path, ["openai-codex", "anthropic-3", "openai-codex"], "one step up per turn");
			if (returnMod.ReturnGuard) {
				const guard = new returnMod.ReturnGuard(), turn = {};
				assert.ok(guard.allow(turn)); guard.mark(turn);
				assert.equal(guard.allow(turn), false, "second step in the same turn refused");
				assert.ok(guard.allow({}), "a new turn starts clean");
			}
		}));

	await check("5 a chat already on Claude: nothing changes", () =>
		world({ room: ["anthropic-3"], start: "anthropic-3" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.deepEqual(c.path, ["anthropic-3"]);
			assert.ok(!c.notes.some((n) => /fallback-return/.test(n)));
		}));

	await check("6 no \"fallback\" field: the last pool in the chain counts as the fallback", async () => {
		await world({ room: ["anthropic-3"], start: "openai-codex", fallbackFlag: false }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal(c.model.provider, "anthropic-3", `path ${c.path.join(" -> ")}`);
		});
		assert.ok(returnMod.isFallbackPool, "fallback-return module present");
		const cfg = poolsConfig({ fallbackFlag: false });
		assert.equal(returnMod.isFallbackPool(cfg, "codex-fallback"), true, "last pool of the chain");
		assert.equal(returnMod.isFallbackPool(cfg, "claude-real"), false, "first pool is the primary");
		cfg.pools[1].fallback = false;
		assert.equal(returnMod.isFallbackPool(cfg, "codex-fallback"), false, "\"fallback\": false opts out");
		const flagged = { pools: [...poolsConfig().pools, { name: "loose", members: ["x"], enabled: true, fallback: true }], chains: [] };
		assert.equal(returnMod.isFallbackPool(flagged, "loose"), true, "\"fallback\": true marks it");
		assert.equal(returnMod.primaryTarget(flagged, "loose"), undefined, "without a chain there is no primary to go back to");
		assert.deepEqual(returnMod.primaryTarget(poolsConfig(), "codex-fallback"),
			{ poolName: "claude-real", modelId: CLAUDE, chainName: "claude-then-sol", chainIndex: 0 });
	});

	await check("7 source: hooks named in PATCHES.md are wired; multi-sub.ts parses", () => {
		for (const [what, re] of [
			["import", /from "\.\/mine\/fallback-return\.ts"/],
			["turn-start return in input", /pi\.on\("input"[\s\S]{0,600}poolManager\.returnFromFallback\(ctx\)/],
			["guard marked at turn start", /noteTurnStart\(\): void \{[\s\S]{0,200}returnGuard\.mark/],
			["step up in handleError", /async handleError\([\s\S]*?returnGuard\.allow\(cascade\)[\s\S]*?returnCandidates\(/],
			["continuation settle", /agent_before_settle[\s\S]{0,200}returnContinuation\.settle/],
			["status line", /fallbackRoleLine\(loadGlobalConfig\(\), pool\.name\)/],
			["config field", /fallback\?: boolean;/],
		]) assert.match(sourceCode, re, what);
		execFileSync(process.execPath, ["--check", path.join(root, "extensions/multi-sub.ts")], { stdio: "pipe" });
	});

	assert.ok(urls.every((u) => !/\/v1\/messages|\/responses|\/completions/.test(u)), `no model calls: ${urls.join(", ")}`);
	console.log(`fallback-return: ${checked}/7 checks passed; no model calls${urls.length ? ` (${urls.length} refused quota fetches)` : ", no network"}`);
} finally { globalThis.fetch = realFetch; }

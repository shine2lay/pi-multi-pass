// mine/fallback-return: a chat on the fallback pool (GPT backup) goes back to the primary Claude pool
// by itself when a Claude account can take the turn; never more than one step up per turn.
// Plain node; no network (fetch throws), no real auth.json, fake credentials only, no model calls.
// FALLBACK_RETURN_SOURCE_REF=<ref> loads BOTH that ref's hooks and fallback-return module.
// On 33ca3a1, cases 1-8 pass; case 9 fails because the refusal-only chat stays on openai-codex.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import * as antigravityLimits from "../extensions/mine/antigravity-limits.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.env.FALLBACK_RETURN_SOURCE_REF;
const sourceCode = ref
	? execFileSync("git", ["show", `${ref}:extensions/multi-sub.ts`], { cwd: root, encoding: "utf8" })
	: fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
const returnSource = ref
	? execFileSync("git", ["show", `${ref}:extensions/mine/fallback-return.ts`], { cwd: root, encoding: "utf8" })
	: undefined;
const returnMod = returnSource
	? await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(returnSource,
		{ mode: "strip", disableExperimentalWarning: true }).replace('"./signin-failover.ts"',
		JSON.stringify(pathToFileURL(path.join(root, "extensions/mine/signin-failover.ts")).href))).toString("base64")}`)
	: await import("../extensions/mine/fallback-return.ts");

// The live 2026-10-11 text from the stuck chats (openai-codex, gpt-6.1-sol).
const CODEX_LIMIT = "Codex error: The usage limit has been reached";
const CLAUDE_429 = "429 rate_limit_error: This request would exceed your account's rate limit.";
const CLAUDE = "claude-opus-5-5", SOL = "gpt-6.1-sol", ARGON = "gemini-4-argon";
const ARGON_LIMIT = "429 quota exhausted";
const MEMBERS = ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"];

let checked = 0;
const urls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error("Network forbidden in fallback-return checks"); };
const onlyCase = process.env.FALLBACK_RETURN_CASE;
if (onlyCase && !/^(?:[1-9]|1[0-4])$/.test(onlyCase)) throw new Error("FALLBACK_RETURN_CASE must be 1-14");
const check = async (name, fn) => {
	if (onlyCase && name.split(" ")[0] !== onlyCase) return;
	try { await fn(); checked++; console.log(`ok fallback-return: ${name}`); }
	catch (error) { throw new Error(`fallback-return: ${name}: ${error.message}`); }
};

const poolsConfig = ({ fallbackFlag = true, poolFields = {}, recovery = "earlier-weekly-reset", third = false } = {}) => ({
	subscriptions: [], presets: [],
	pools: [
		{ name: "claude-real", baseProvider: "anthropic", members: MEMBERS, enabled: true,
			quotaRouting: { policy: "weekly-first", recovery, minWeeklyResetAdvantageMinutes: 0, maxObservationAgeMinutes: 1440 } },
		{ name: "codex-fallback", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true,
			...(fallbackFlag ? { fallback: true } : {}), ...poolFields },
		...(third ? [{ name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"], enabled: true,
			fallback: false, returnOnRefusal: true }] : []),
	],
	chains: [
		{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: CLAUDE, enabled: true }, { pool: "codex-fallback", model: SOL, enabled: true },
			...(third ? [{ pool: "antigravity-fallback", model: ARGON, enabled: true }] : [])] },
		{ name: "fable-then-opus", enabled: false, entries: [{ pool: "claude-real", model: "claude-fable-5-1", enabled: true }, { pool: "claude-real", model: "claude-opus-5", enabled: true }] },
	],
	refusalFallback: { enabled: true, provider: "openai-codex", model: SOL },
});

// Fake credentials (no real token material); keys only identify the fake accounts' quota shards.
const creds = Object.fromEntries([...MEMBERS, "openai-codex", "antigravity"].map((p, i) => [p, { type: "oauth", access: `fake-at-${i}`, refresh: `fake-rt-${i}`, expires: 9e12, projectId: "fake-project" }]));

/** room: members with weekly room (26%); every other Claude member is at its weekly limit. */
function writeQuota(temp, room, weeklyResetDays = {}) {
	const now = Date.now();
	for (const provider of MEMBERS) {
		const resetAt = Math.floor(now / 1000) + (weeklyResetDays[provider] ?? 3) * 86400;
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

// The owner's live routing shape: no prompt recovery, and the GPT pool returns on refusal only.
const liveRefusal = { poolFields: { fallback: false, returnOnRefusal: true }, recovery: "off" };

async function world({ room, start, fallbackFlag = true, poolFields, recovery, weeklyResetDays, third }, run) {
	modelFallback.clearModelExhaustion(); // module-wide state: each fake chat starts clean
	const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-fallback-return-"));
	try {
		fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify(poolsConfig({ fallbackFlag, poolFields, recovery, third })));
		writeQuota(temp, room, weeklyResetDays);
		const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
			.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
			.replace("export default function multiSub", "function multiSub");
		const production = runInNewContext(`${executable}\n;({multiSub, loadGlobalConfig, saveGlobalConfig,
			renamePoolConfig, editPoolMembers, changePoolStrategy, togglePoolConfig, buildPoolConfig, persistPoolConfig});`, {
			...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
			...limits, ...reset, ...modelFallback, ...countdown, ...subsLimits, ...envAllowed, ...returnMod, ...antigravityLimits,
			Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
			readStoredCredential: (provider) => creds[provider],
			builtinProviders: () => [], getModels: () => [{ id: CLAUDE }, { id: SOL }, { id: ARGON }],
			process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
			fetch: globalThis.fetch,
		});
		let current = { provider: start, id: start === "openai-codex" ? SOL : start === "antigravity" ? ARGON : CLAUDE };
		const path_ = [current.provider];
		let replays = 0;
		const events = new Map(), notes = [], registered = [];
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
		const pi = { on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
			registerCommand() {}, registerProvider: (name) => registered.push(name), registerTool() {},
			sendUserMessage: () => { replays++; },
			setModel: async next => { const previousModel = current; current = { provider: next.provider, id: next.id }; path_.push(current.provider);
				await emit("model_select", { model: current, previousModel, source: "set" }); return true; },
		};
		production.multiSub(pi);
		const boundary = (id) => ({ outcome: "error", continue: false, entries: [], context: {
			contextEntries: [{ sourceEntry: { id: "user" }, messages: [{ role: "user" }] },
				{ sourceEntry: { id }, messages: [{ role: "assistant" }] }], pendingMessages: [] } });
		const c = {
			notes, registered, get model() { return current; }, get path() { return path_; }, get replays() { return replays; },
			/** A new prompt: input (turn start) then before_agent_start. */
			prompt: async (text, { input = true } = {}) => {
				if (input) await emit("input", { text, source: "rpc" });
				await emit("before_agent_start", { prompt: text });
			},
			settle: (id) => emit("agent_before_settle", boundary(id)),
			// Test-only external selection through the existing API; no new input or state reset.
			select: (model) => pi.setModel(model),
			/** Real ordinary saves/edits on an isolated config; also runs unchanged on old source. */
			checkSaves: async () => {
				const manager = { loadPools() {} };
				const roles = (stage, name = "codex-fallback") => {
					const saved = production.loadGlobalConfig();
					const pool = saved.pools.find((p) => p.name === name);
					assert.ok(pool, `${stage}: pool still present`);
					assert.equal(pool.fallback, false, `${stage}: fallback:false survives`);
					assert.equal(pool.returnOnRefusal, true, `${stage}: unknown returnOnRefusal survives`);
					assert.equal(saved.pools[0].quotaRouting.recovery, "off", `${stage}: recovery stays off`);
					return { saved, pool };
				};
				let { saved, pool } = roles("load");
				production.saveGlobalConfig(saved);
				({ saved, pool } = roles("ordinary save"));
				ctx.ui.input = async () => "codex-renamed";
				await production.renamePoolConfig(ctx, manager, saved, pool);
				({ saved, pool } = roles("rename", "codex-renamed"));
				assert.equal(saved.chains[0].entries[1].pool, "codex-renamed", "rename updates chain references");
				ctx.ui.input = async () => "codex-fallback";
				await production.renamePoolConfig(ctx, manager, saved, pool);
				({ saved, pool } = roles("rename back"));
				// Seed one removable fake member so the real member edit takes its saving branch.
				pool.members.push("openai-codex-2");
				production.saveGlobalConfig(saved);
				const picks = ["remove openai-codex-2", "save", "quota-first", "round-robin"];
				ctx.ui.select = async (_title, items) => {
					const wanted = picks.shift();
					const selected = items.find((item) => item === wanted || item.startsWith(`${wanted} —`));
					assert.ok(selected, `synthetic UI pick exists: ${wanted}`);
					return selected;
				};
				await production.editPoolMembers(ctx, manager, saved, pool);
				({ saved, pool } = roles("member edit"));
				assert.deepEqual([...pool.members], ["openai-codex"], "member edit actually saves");
				await production.changePoolStrategy(ctx, manager, saved, pool);
				({ saved, pool } = roles("strategy change"));
				assert.equal(pool.strategy, "quota-first");
				await production.changePoolStrategy(ctx, manager, saved, pool);
				({ saved, pool } = roles("strategy reset"));
				assert.equal(pool.strategy, undefined);
				await production.togglePoolConfig(ctx, manager, saved, pool);
				({ saved, pool } = roles("toggle off"));
				assert.equal(pool.enabled, false);
				await production.togglePoolConfig(ctx, manager, saved, pool);
				({ pool } = roles("toggle on"));
				assert.equal(pool.enabled, true);
				assert.equal(picks.length, 0, "all real UI edit branches used");
				console.log(`save compatibility ${ref ?? "working tree"}: load/save, rename, member, strategy, toggle preserve both fields`);
			},
			/** Deliberate whole-pool replacement remains out of scope; prove its documented exception. */
			overwritePool: () => {
				const config = production.loadGlobalConfig();
				const built = production.buildPoolConfig({ name: "codex-fallback", baseProvider: "openai-codex",
					members: ["openai-codex"], enabled: true });
				assert.equal(built.ok, true);
				const result = production.persistPoolConfig(config, built.pool);
				assert.equal(result.action, "updated");
				production.saveGlobalConfig(result.config);
				const pool = production.loadGlobalConfig().pools[1];
				assert.equal(pool.fallback, undefined, "explicit replacement drops fallback");
				assert.equal(pool.returnOnRefusal, undefined, "explicit replacement drops returnOnRefusal");
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

	await check("8 refusal-only: new sends stay on GPT; old normal saves keep both fields", () =>
		world({ ...liveRefusal, room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.prompt("another offline synthetic request");
			assert.deepEqual(c.path, ["openai-codex"], "Claude room does not cause a move at a send");
			await c.checkSaves();
			await c.prompt("offline synthetic request after normal edits");
			assert.deepEqual(c.path, ["openai-codex"], "normal saves do not re-enable prompt returns");
			for (const error of ["500 internal_server_error", "400 bad_request", "context too long", "Request aborted"]) {
				assert.equal((await c.fail(error)).length, 0, `no continuation for ${error}`);
				assert.equal(c.model.provider, "openai-codex", `no account move for ${error}`);
			}
			assert.equal(c.replays, 0);
		}));

	await check("9 refusal-only: Codex limit returns to ranked Claude once without replay", () =>
		world({ ...liveRefusal, room: ["anthropic-2", "anthropic-4"], start: "openai-codex",
			weeklyResetDays: { "anthropic-2": 4, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal(c.model.provider, "openai-codex");
			const settled = await c.fail(CODEX_LIMIT, "refusal-only-failed");
			assert.deepEqual(c.model, { provider: "anthropic-4", id: CLAUDE }, `path ${c.path.join(" -> ")}`);
			assert.equal(c.replays, 0, "no prompt replay");
			assert.deepEqual(settled, [{ entries: [{ type: "context_edit", targetId: "refusal-only-failed", replacement: null }], continue: true }]);
			assert.equal((await c.settle("refusal-only-failed")).length, 0, "the same failure continues only once");
			await c.prompt("offline synthetic next turn");
			assert.deepEqual(c.path, ["openai-codex", "anthropic-4"], "the next send stays where the refusal landed");
			const cfg = poolsConfig(liveRefusal);
			assert.match(returnMod.fallbackRoleLine(cfg, "codex-fallback"), /refusal return.*claude-real.*never at a send/);
		}));

	await check("10 refusal-only: no Claude room stays down; one upward move per turn", async () => {
		await world({ ...liveRefusal, room: [], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal((await c.fail(CODEX_LIMIT)).length, 0);
			assert.deepEqual(c.path, ["openai-codex"], "no eligible Claude, no move or continuation");
		});
		await world({ ...liveRefusal, room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal((await c.fail(CODEX_LIMIT, "first-codex-refusal"))[0]?.continue, true);
			assert.equal(c.model.provider, "anthropic-3");
			assert.equal((await c.fail(CLAUDE_429, "claude-refusal")).length, 0);
			// Ops corrected the plan: the only GPT member already refused, so retrying it
			// would defeat existing exhaustion/attempted guards. The cascade stops here.
			assert.deepEqual(c.path, ["openai-codex", "anthropic-3"]);
			assert.ok(c.notes.some((n) => /Rate limited on openai-codex/.test(n)), "GPT refusal reported");
			assert.ok(c.notes.some((n) => /openai-codex skipped \(already attempted this turn\)/.test(n)), "refused GPT is never retried");
			assert.ok(c.notes.some((n) => /Failover exhausted after anthropic-3/.test(n)), "Claude refusal and exhausted stop reported");
			assert.equal(c.replays, 0);
		});
		await world({ ...liveRefusal, room: ["anthropic-2", "anthropic-4"], start: "openai-codex",
			weeklyResetDays: { "anthropic-2": 4, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CODEX_LIMIT, "codex-two-primary");
			assert.equal(c.model.provider, "anthropic-4");
			await c.fail(CLAUDE_429, "claude-a-refusal");
			assert.equal(c.model.provider, "anthropic-2", "another usable Claude gets the retry");
			await c.fail(CLAUDE_429, "claude-b-refusal");
			assert.deepEqual(c.path, ["openai-codex", "anthropic-4", "anthropic-2"], "stops only after both Claude members refuse");
			assert.ok(c.notes.some((n) => /Failover exhausted after anthropic-2/.test(n)));
			assert.equal(c.replays, 0);
		});
		await world({ ...liveRefusal, room: ["anthropic-2", "anthropic-4"], start: "openai-codex",
			weeklyResetDays: { "anthropic-2": 4, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("offline synthetic request");
			await c.fail(CODEX_LIMIT, "codex-first-up");
			assert.equal(c.model.provider, "anthropic-4");
			// Keep an untried healthy Claude member available, making the guard decisive.
			await c.select({ provider: "openai-codex", id: SOL });
			assert.equal((await c.fail(CODEX_LIMIT, "codex-external-return")).length, 0);
			assert.deepEqual(c.path, ["openai-codex", "anthropic-4", "openai-codex"], "no second upward move despite healthy Claude");
			assert.equal((await c.settle("codex-external-return")).length, 0, "no second continuation");
			assert.equal(c.replays, 0);
		});
	});

	await check("11 fallback:true + returnOnRefusal:false is prompt-only; overwrite restores legacy role", async () => {
		const promptOnly = { poolFields: { fallback: true, returnOnRefusal: false }, recovery: "off" };
		await world({ ...promptOnly, room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request");
			assert.equal(c.model.provider, "anthropic-3", "prompt return follows fallback role");
		});
		await world({ ...promptOnly, room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			await c.prompt("offline synthetic request", { input: false });
			assert.equal((await c.fail(CODEX_LIMIT)).length, 0, "explicit false disables refusal return");
			assert.deepEqual(c.path, ["openai-codex"]);
		});
		assert.match(returnMod.fallbackRoleLine(poolsConfig(promptOnly), "codex-fallback"), /at a send only; never on refusal/);
		// Ops's corrected caveat: replacing the whole pool drops BOTH fields. The chain then
		// infers fallback:true again, so both prompt and refusal returns come back, not a stop.
		for (const input of [true, false]) await world({ ...liveRefusal, room: ["anthropic-3"], start: "openai-codex" }, async (c) => {
			c.overwritePool();
			await c.prompt("offline synthetic request", { input });
			if (!input) assert.equal((await c.fail(CODEX_LIMIT))[0]?.continue, true);
			assert.equal(c.model.provider, "anthropic-3", `after explicit overwrite: ${input ? "send" : "refusal"} returns`);
		});
	});

	const threeStage = { third: true, poolFields: { fallback: false, returnOnRefusal: false }, recovery: "off" };
	await check("12 three stages: all four Claude slots precede GPT and Argon, then exhausted stop", () =>
		world({ ...threeStage, room: MEMBERS, start: "anthropic",
			weeklyResetDays: { anthropic: 4, "anthropic-2": 3, "anthropic-3": 2, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("fixed three-stage fixture");
			assert.deepEqual(c.path, ["anthropic"], "healthy manual choice stays at send");
			for (let i = 0; i < 4; i++) await c.fail(CLAUDE_429, `claude-${i}`);
			assert.deepEqual(c.path, ["anthropic", "anthropic-4", "anthropic-3", "anthropic-2", "openai-codex"]);
			assert.equal((await c.fail(CODEX_LIMIT, "gpt-forward"))[0]?.continue, true, "non-retryable GPT error continues forward without replay");
			assert.deepEqual(c.model, { provider: "antigravity", id: ARGON });
			assert.equal((await c.settle("gpt-forward")).length, 0, "one continuation per error");
			assert.equal((await c.fail(ARGON_LIMIT, "argon-final")).length, 0);
			assert.equal((await c.fail(ARGON_LIMIT, "argon-repeated")).length, 0);
			assert.deepEqual(c.path, ["anthropic", "anthropic-4", "anthropic-3", "anthropic-2", "openai-codex", "antigravity"], "no exhausted retry or jump back");
			assert.equal(c.replays, 0);
			assert.deepEqual(c.registered, [], "external canonical provider registration is never replaced");
		}));

	await check("13 middle GPT refuses: Argon before any primary return, final return ranked and bounded", () =>
		world({ ...threeStage, room: ["anthropic-2", "anthropic-4"], start: "openai-codex",
			weeklyResetDays: { "anthropic-2": 4, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("fixed middle-stage fixture");
			await c.prompt("manual GPT remains selected");
			assert.deepEqual(c.path, ["openai-codex"], "no prompt moves despite primary room");
			assert.equal((await c.fail(CODEX_LIMIT, "gpt-middle"))[0]?.continue, true);
			assert.equal(c.model.provider, "antigravity", "Argon is ahead of primary even with room");
			assert.equal((await c.fail(ARGON_LIMIT, "argon-return"))[0]?.continue, true);
			assert.equal(c.model.provider, "anthropic-4", "final refusal returns to ranked primary");
			await c.fail(CLAUDE_429, "claude-four");
			assert.equal(c.model.provider, "anthropic-2");
			assert.equal((await c.fail(CLAUDE_429, "claude-two")).length, 0);
			assert.deepEqual(c.path, ["openai-codex", "antigravity", "anthropic-4", "anthropic-2"]);
			assert.equal(c.replays, 0);
		}));

	await check("14 final Argon manual choice never moves at sends/non-limit errors; one upward return", async () => {
		await world({ ...threeStage, room: ["anthropic-2", "anthropic-4"], start: "antigravity",
			weeklyResetDays: { "anthropic-2": 4, "anthropic-4": 1 } }, async (c) => {
			await c.prompt("manual final-stage fixture");
			await c.prompt("another send stays on Argon");
			for (const error of ["500 internal_server_error", "context too long", "Request aborted"])
				assert.equal((await c.fail(error)).length, 0);
			assert.deepEqual(c.path, ["antigravity"]);
			assert.equal((await c.fail(ARGON_LIMIT, "final-return"))[0]?.continue, true);
			assert.equal(c.model.provider, "anthropic-4");
			await c.select({ provider: "antigravity", id: ARGON });
			assert.equal((await c.fail(ARGON_LIMIT, "final-return-again")).length, 0, "unused primary room cannot bypass one-return guard");
			assert.deepEqual(c.path, ["antigravity", "anthropic-4", "antigravity"]);
			assert.equal(c.replays, 0);
		});
		const cfg = poolsConfig(threeStage);
		assert.deepEqual(cfg.refusalFallback, { enabled: true, provider: "openai-codex", model: SOL }, "classifier remains GPT");
		assert.equal(returnMod.returnCandidates(cfg, "openai-codex", () => true, new Set(), "refusal").length, 0);
		assert.equal(returnMod.returnCandidates(cfg, "antigravity", () => true).length, 0, "no send-time return");
		assert.equal(returnMod.returnCandidates(cfg, "antigravity", () => true, new Set(), "refusal").length, 4);
	});

	assert.ok(urls.every((u) => !/\/v1\/messages|\/responses|\/completions/.test(u)), `no model calls: ${urls.join(", ")}`);
	console.log(`fallback-return: ${checked}/${onlyCase ? 1 : 14} checks passed${onlyCase ? ` (case ${onlyCase})` : ""}; no model calls${urls.length ? ` (${urls.length} refused quota fetches)` : ", no network"}`);
} finally { globalThis.fetch = realFetch; }

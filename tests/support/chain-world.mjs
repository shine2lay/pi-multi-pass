// One chat driven through the real multi-sub.ts (and fallback-return.ts) by a fake pi: its hooks, model,
// notices, prompt replays and agent_before_settle continuations, with weekly quota files for the Claude pool.
// Models as pi has them: pi-ai's built-in catalog per provider (getModels) and pi's live registry
// (ctx.modelRegistry.getAll), which alone holds providers an extension registers, such as antigravity.
// Shared by tests/loop-back-check.mjs, tests/chatgpt-limit-continue-check.mjs and
// tests/antigravity-chain-entries-check.mjs; chainFolder (several chats, one loaded copy) by
// tests/pool-registry-per-chat-check.mjs.
// Plain node: fetch is a recorder that throws (blockNetwork), credentials are fake, no model calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import * as signin from "../../extensions/mine/signin-failover.ts";
import * as refusal from "../../extensions/mine/refusal-fallback.ts";
import * as quotaState from "../../extensions/mine/quota-state.ts";
import * as accountPolicy from "../../extensions/mine/account-policy.ts";
import * as quotaRouting from "../../extensions/mine/quota-routing.ts";
import * as anthropicQuota from "../../extensions/mine/anthropic-quota.ts";
import * as limits from "../../extensions/mine/current-model-limits.ts";
import * as reset from "../../extensions/mine/reset-first.ts";
import * as modelFallback from "../../extensions/mine/model-fallback.ts";
import * as countdown from "../../extensions/mine/reset-countdown.ts";
import * as subsLimits from "../../extensions/mine/subs-limits.ts";
import * as envAllowed from "../../extensions/mine/env-allowed-subs.ts";
import * as antigravityLimits from "../../extensions/mine/antigravity-limits.ts";
import * as poolModels from "../../extensions/mine/pool-models.ts";
import { isRetryableAssistantError } from "./pi-retry-classifier.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const strip = (source) => stripTypeScriptTypes(source, { mode: "strip", disableExperimentalWarning: true });

/**
 * multi-sub.ts source, the fallback-return module and the pool-models module: this tree's, or those at git
 * `ref` for a run on older code (pool-models: this tree's when `ref` predates it).
 */
export async function loadSources(ref) {
	if (!ref) {
		return { sourceCode: fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8"),
			returnMod: await import("../../extensions/mine/fallback-return.ts"), poolModelsMod: poolModels };
	}
	const show = (file) => execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" });
	// A data: module can't resolve relative imports: point each ./<module>.ts at this tree's copy.
	const returnSource = strip(show("extensions/mine/fallback-return.ts")).replace(/"\.\/([\w-]+\.ts)"/g, (_, file) =>
		JSON.stringify(pathToFileURL(path.join(root, "extensions/mine", file)).href));
	const asModule = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
	let poolModelsMod = poolModels;
	try { poolModelsMod = await asModule(strip(show("extensions/mine/pool-models.ts"))); }
	catch (error) { if (!/exists on disk, but not in|does not exist in/.test(String(error.stderr ?? error.message))) throw error; }
	return { sourceCode: show("extensions/multi-sub.ts"), returnMod: await asModule(returnSource), poolModelsMod };
}

/** Swaps fetch for a recorder that throws. modelCalls() lists any model endpoint asked for; restore() puts fetch back. */
export function blockNetwork(label) {
	const urls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => { urls.push(String(url)); throw new Error(`Network forbidden in ${label}`); };
	return {
		urls,
		modelCalls: () => urls.filter((u) => /\/v1\/messages|\/responses|\/completions/.test(u)),
		restore: () => { globalThis.fetch = realFetch; },
	};
}

/** Fake OAuth credentials for every member of every pool in `config`. */
export function fakeCredentials(config) {
	return Object.fromEntries(config.pools.flatMap((pool) => pool.members).map((p, i) =>
		[p, { type: "oauth", access: `fake-at-${i}`, refresh: `fake-rt-${i}`, expires: 9e12, projectId: "fake-project" }]));
}

/** room: quota members with weekly room (26% used, reset in resetDays[member] or 3 days); the others are at 100%. */
function writeQuota(temp, creds, quotaMembers, room, resetDays = {}) {
	const now = Date.now();
	for (const provider of quotaMembers) {
		const resetAt = Math.floor(now / 1000) + (resetDays[provider] ?? 3) * 86400;
		const full = !room.includes(provider);
		const dir = path.join(temp, "multi-pass-quota", quotaState.quotaAccountKey(provider, creds[provider]));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ version: 1, failures: [], windows: [
			{ name: "7d", scope: "account", usedPercent: full ? 100 : 26, resetAt, limited: full, observedAt: now },
			{ name: "account-status", scope: "account", limited: full, ...(full ? { resetAt } : {}), observedAt: now },
		] }));
	}
}

/** pi's text when an extension reads a ctx whose session was replaced or closed. */
export const STALE_CTX = "This extension ctx is stale after session replacement or reload";

/**
 * One chat on `start` ({ provider, id }) with `config` as multi-pass.json in a fresh agent dir.
 * sources: from loadSources(). quotaMembers: the members that get quota files (see writeQuota).
 * builtin: { provider: model ids } pi-ai's built-in catalog offers (getModels; other providers get none).
 * registered: [{ provider, id }] only pi's registry holds (an extension's provider); the registry lists
 * these after every built-in model. run(chat) gets notes, model, path, replays, selects (each
 * ctx.ui.select: { title, items }), command(name, args) and prompt(text), fail(error, id)
 * (turn_end + agent_end + agent_before_settle) and settle(id).
 */
export async function chainWorld(options, run) {
	assert.ok(options?.start?.provider && options.start.id, "chainWorld needs start");
	return chainFolder(options, async (folder) => run(await folder.open({ start: options.start })));
}

/**
 * Several chats of one chat folder, as pi-web-ui runs them: multi-sub.ts is loaded once, and each chat
 * calls its factory with its own pi and ctx. Options as chainWorld, without start. run(folder) gets
 * open({ start, registered?, registry? }) -> a chat as chainWorld's plus replace() (session_shutdown,
 * then its ctx is stale: every read throws STALE_CTX, as pi's does) and staleReads (reads after that);
 * registered overrides the folder's registry-only models for that chat; registry "no-getAll" gives the
 * chat a registry without getAll (an older pi). folder.warnings: console.warn lines of the loaded copy.
 */
export async function chainFolder({ sources, config, quotaMembers, builtin, registered = [], room, resetDays }, run) {
	assert.ok(sources?.sourceCode && sources?.returnMod, "chainWorld needs sources from loadSources()");
	assert.ok(config?.pools?.length && quotaMembers?.length && builtin && Object.keys(builtin).length && Array.isArray(registered)
		&& room, "chainWorld needs config, quotaMembers, builtin, registered and room");
	modelFallback.clearModelExhaustion();
	const creds = fakeCredentials(config);
	const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-chain-world-"));
	try {
		fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify(config));
		writeQuota(temp, creds, quotaMembers, room, resetDays);
		const executable = strip(sources.sourceCode)
			.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
			.replace("export default function multiSub", "function multiSub");
		const warnings = [];
		const production = runInNewContext(`${executable}\n;({multiSub, loadGlobalConfig, piWillRetryTurn});`, {
			...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
			...limits, ...reset, ...modelFallback, ...countdown, ...subsLimits, ...envAllowed, ...sources.returnMod, ...antigravityLimits,
			...(sources.poolModelsMod ?? poolModels), isRetryableAssistantError,
			Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
			readStoredCredential: (provider) => creds[provider],
			builtinProviders: () => [], getModels: (provider) => (builtin[provider] ?? []).map((id) => ({ provider, id })),
			process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date,
			console: { ...console, warn: (...args) => warnings.push(args.join(" ")) },
			fetch: globalThis.fetch,
		});
		const open = (chat) => openChat({ production, temp, creds, builtin, registered, ...chat });
		return await run({ open, warnings });
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function openChat({ production, temp, creds, builtin, registered, start, registry = "full" }) {
	assert.ok(start?.provider && start?.id && Array.isArray(registered), "open needs start and a registered list");
	assert.ok(registry === "full" || registry === "no-getAll", `registry must be "full" or "no-getAll", got ${registry}`);
	const registryModels = [...Object.entries(builtin).flatMap(([provider, ids]) => ids.map((id) => ({ provider, id }))),
		...registered.map(({ provider, id }) => ({ provider, id }))];
	let current = { ...start };
	const path_ = [`${current.provider}/${current.id}`];
	let replays = 0, stale = false, staleReads = 0;
	const events = new Map(), notes = [], commands = new Map(), selects = [];
	const modelRegistry = {
		authStorage: { hasAuth: (p) => Boolean(creds[p]), get: (p) => creds[p] },
		find: (provider, id) => ({ provider, id }), getProviderAuth: async () => undefined,
		...(registry === "full" ? { getAll: () => registryModels.map((model) => ({ ...model })) } : {}),
	};
	// pi's ctx after its session is replaced: every property read throws.
	const ctx = new Proxy({ cwd: temp, get model() { return current; }, isIdle: () => true, hasUI: true, modelRegistry,
		ui: { notify: text => notes.push(text), setStatus() {},
			select: async (title, items) => { selects.push({ title, items: [...items] }); return undefined; } },
	}, { get(target, key, receiver) {
		if (stale) { staleReads++; throw new Error(STALE_CTX); }
		return Reflect.get(target, key, receiver);
	} });
	const emit = async (name, event = {}) => {
		const results = [];
		for (const fn of events.get(name) ?? []) results.push(await fn(event, ctx));
		return results.filter(Boolean);
	};
	const pi = { on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
		registerCommand: (name, spec) => commands.set(name, spec), registerProvider() {}, registerTool() {},
		sendUserMessage: () => { replays++; },
		setModel: async next => { const previousModel = current; current = { provider: next.provider, id: next.id };
			path_.push(`${current.provider}/${current.id}`);
			await emit("model_select", { model: current, previousModel, source: "set" }); return true; },
	};
	production.multiSub(pi);
	const boundary = (id) => ({ outcome: "error", continue: false, entries: [], context: {
		contextEntries: [{ sourceEntry: { id: "user" }, messages: [{ role: "user" }] },
			{ sourceEntry: { id }, messages: [{ role: "assistant" }] }], pendingMessages: [] } });
	await emit("session_start", {});
	return {
		notes, commands, ctx, selects, piWillRetryTurn: production.piWillRetryTurn,
		get staleReads() { return staleReads; },
		replace: async () => { await emit("session_shutdown", {}); stale = true; },
		command: (name, args) => commands.get(name).handler(args, ctx),
		get model() { return current; }, get path() { return path_; }, get replays() { return replays; },
		prompt: async (text) => { await emit("input", { text, source: "rpc" }); await emit("before_agent_start", { prompt: text }); },
		settle: (id) => emit("agent_before_settle", boundary(id)),
		fail: async (error, id = `failed-${path_.length}-${notes.length}`) => {
			const message = { role: "assistant", provider: current.provider, model: current.id, stopReason: "error", errorMessage: error };
			await emit("turn_end", { message, messageEntryId: id });
			await emit("agent_end", { messages: [message] });
			return emit("agent_before_settle", boundary(id));
		},
	};
}

/** The failed reply is dropped and the run continues once: no prompt replay. */
export const continued = (settled, id) => assert.deepEqual(settled,
	[{ entries: [{ type: "context_edit", targetId: id, replacement: null }], continue: true }], "the turn continues once, no replay");

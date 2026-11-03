// One chat driven through the real multi-sub.ts (and fallback-return.ts) by a fake pi: its hooks, model,
// notices, prompt replays and agent_before_settle continuations, with weekly quota files for the Claude pool.
// Shared by tests/loop-back-check.mjs and tests/chatgpt-limit-continue-check.mjs.
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
import { isRetryableAssistantError } from "./pi-retry-classifier.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const strip = (source) => stripTypeScriptTypes(source, { mode: "strip", disableExperimentalWarning: true });

/** multi-sub.ts source and the fallback-return module: this tree's, or those at git `ref` for a run on older code. */
export async function loadSources(ref) {
	if (!ref) {
		return { sourceCode: fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8"),
			returnMod: await import("../../extensions/mine/fallback-return.ts") };
	}
	const show = (file) => execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" });
	// A data: module can't resolve relative imports: point each ./<module>.ts at this tree's copy.
	const returnSource = strip(show("extensions/mine/fallback-return.ts")).replace(/"\.\/([\w-]+\.ts)"/g, (_, file) =>
		JSON.stringify(pathToFileURL(path.join(root, "extensions/mine", file)).href));
	return { sourceCode: show("extensions/multi-sub.ts"),
		returnMod: await import(`data:text/javascript;base64,${Buffer.from(returnSource).toString("base64")}`) };
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

/**
 * One chat on `start` ({ provider, id }) with `config` as multi-pass.json in a fresh agent dir.
 * sources: from loadSources(). quotaMembers: the members that get quota files (see writeQuota).
 * models: the model ids getModels() offers. run(chat) gets notes, model, path, replays and
 * prompt(text), fail(error, id) (turn_end + agent_end + agent_before_settle) and settle(id).
 */
export async function chainWorld({ sources, config, quotaMembers, models, room, start, resetDays }, run) {
	assert.ok(sources?.sourceCode && sources?.returnMod, "chainWorld needs sources from loadSources()");
	assert.ok(config?.pools?.length && quotaMembers?.length && models?.length && room && start?.provider && start?.id,
		"chainWorld needs config, quotaMembers, models, room and start");
	modelFallback.clearModelExhaustion();
	const creds = fakeCredentials(config);
	const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-chain-world-"));
	try {
		fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify(config));
		writeQuota(temp, creds, quotaMembers, room, resetDays);
		const executable = strip(sources.sourceCode)
			.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
			.replace("export default function multiSub", "function multiSub");
		const production = runInNewContext(`${executable}\n;({multiSub, loadGlobalConfig, piWillRetryTurn});`, {
			...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
			...limits, ...reset, ...modelFallback, ...countdown, ...subsLimits, ...envAllowed, ...sources.returnMod, ...antigravityLimits,
			isRetryableAssistantError,
			Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
			readStoredCredential: (provider) => creds[provider],
			builtinProviders: () => [], getModels: () => models.map((id) => ({ id })),
			process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
			fetch: globalThis.fetch,
		});
		let current = { ...start };
		const path_ = [`${current.provider}/${current.id}`];
		let replays = 0;
		const events = new Map(), notes = [], commands = new Map();
		const ctx = { cwd: temp, get model() { return current; }, isIdle: () => true, hasUI: true,
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
		return await run({
			notes, commands, ctx, piWillRetryTurn: production.piWillRetryTurn,
			get model() { return current; }, get path() { return path_; }, get replays() { return replays; },
			prompt: async (text) => { await emit("input", { text, source: "rpc" }); await emit("before_agent_start", { prompt: text }); },
			settle: (id) => emit("agent_before_settle", boundary(id)),
			fail: async (error, id = `failed-${path_.length}-${notes.length}`) => {
				const message = { role: "assistant", provider: current.provider, model: current.id, stopReason: "error", errorMessage: error };
				await emit("turn_end", { message, messageEntryId: id });
				await emit("agent_end", { messages: [message] });
				return emit("agent_before_settle", boundary(id));
			},
		});
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

/** The failed reply is dropped and the run continues once: no prompt replay. */
export const continued = (settled, id) => assert.deepEqual(settled,
	[{ entries: [{ type: "context_edit", targetId: id, replacement: null }], continue: true }], "the turn continues once, no replay");

// mine/signin-failover: a pool member whose sign-in can't be renewed is skipped like a limit refusal,
// and the chat continues on the next member instead of stopping.
// Plain node; no network (fetch throws), no real auth.json, fake credentials only.
// PI_SIGNIN_BASELINE_REF=<ref> also runs the end-to-end case on that ref's multi-sub.ts and expects the
// old stop (b8423d2: no switch, no continue).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
import * as fallback from "../extensions/mine/model-fallback.ts";
import * as countdown from "../extensions/mine/reset-countdown.ts";
import * as subsLimits from "../extensions/mine/subs-limits.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// The live 2026-10-10 06:40 text (pi 1.0.1), stack shortened; the stack carries line numbers that
// must not be read as HTTP statuses.
const liveError = (provider = "anthropic-3") => `OAuth refresh failed for ${provider}: Anthropic token refresh request failed. url=${TOKEN_URL}; details=Error: HTTP request failed. status=400; url=${TOKEN_URL}; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=Error: HTTP request failed.\n    at postJson (file:///x/pi-ai/dist/auth/oauth/anthropic.js:79:15)\n    at async AuthStorage.modify (file:///x/pi-coding-agent/dist/core/auth-storage.js:381:24)`;
const networkError = `OAuth refresh failed for anthropic-3: Anthropic token refresh request failed. url=${TOKEN_URL}; details=TypeError: fetch failed; cause=Error: getaddrinfo EAI_AGAIN platform.claude.com; stack=TypeError: fetch failed\n    at node:internal/deps/undici/undici:13429:13`;
const model = { id: "claude-opus-5-5" };
let checked = 0, fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error("Network forbidden in signin-failover checks"); };
const check = async (name, fn) => {
	try { await fn(); checked++; }
	catch (error) { throw new Error(`signin-failover: ${name}: ${error.message}`); }
};

try {
	await check("parse: live text is a refused sign-in of anthropic-3", () => {
		assert.deepEqual(signin.parseSignInFailure(liveError()), { provider: "anthropic-3", kind: "refused" });
	});
	await check("parse: network trouble is unreachable, not refused", () => {
		assert.deepEqual(signin.parseSignInFailure(networkError), { provider: "anthropic-3", kind: "unreachable" });
		const stackOnly = `OAuth refresh failed for anthropic-2: Anthropic token refresh request failed. details=AbortError: timed out; stack=x\n    at y (file:///a.js:429:400)`;
		assert.equal(signin.parseSignInFailure(stackOnly).kind, "unreachable");
	});
	await check("parse: limit refusals and other errors are not sign-in failures", () => {
		for (const text of ["429 rate_limit_error", "overloaded_error", "Credential store read failed for anthropic", undefined, ""]) {
			assert.equal(signin.parseSignInFailure(text), undefined, String(text));
		}
	});
	await check("stamp: type and expiry only, never token material", () => {
		const stamp = signin.credentialStamp({ type: "oauth", access: "fake-at", refresh: "fake-rt", expires: 1234 });
		assert.equal(stamp, "oauth:1234");
		assert.equal(signin.credentialStamp(undefined), null);
	});

	await check("store: refused stays until the stored login changes; unreachable pauses 2 min", () => {
		const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-signin-store-"));
		try {
			let now = new Date(2026, 9, 10, 6, 40, 14).getTime();
			const stamps = { "anthropic-3": "oauth:1", "anthropic-2": "oauth:2" };
			const file = path.join(temp, "signin-failed.json");
			const store = new signin.SignInFailures(file, (p) => stamps[p] ?? null, () => now);
			const other = new signin.SignInFailures(file, (p) => stamps[p] ?? null, () => now); // another chat
			store.mark(signin.parseSignInFailure(liveError()));
			assert.equal(other.blocked("anthropic-3"), true, "every chat sees the mark");
			assert.equal(other.label("anthropic-3"), "sign-in failed 06:40");
			now += 6 * 3600_000;
			assert.equal(store.blocked("anthropic-3"), true, "a refused login doesn't heal by waiting");
			stamps["anthropic-3"] = "oauth:3"; // a new sign-in (or a renewal elsewhere) was stored
			assert.equal(store.blocked("anthropic-3"), false);
			assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).accounts["anthropic-3"], undefined, "mark removed");
			store.mark(signin.parseSignInFailure(networkError.replace("anthropic-3", "anthropic-2")));
			assert.equal(store.label("anthropic-2").startsWith("sign-in unreachable"), true);
			now += signin.UNREACHABLE_PAUSE_MS;
			assert.equal(store.blocked("anthropic-2"), false, "tried again after the pause");
			store.mark(signin.parseSignInFailure(liveError()));
			store.clear("anthropic-3");
			assert.equal(store.blocked("anthropic-3"), false, "a reply clears it");
			assert.doesNotMatch(fs.readFileSync(file, "utf8"), /fake|access|refresh/, "no token material in the file");
		} finally { fs.rmSync(temp, { recursive: true, force: true }); }
	});

	await check("continuation: one context-edit continue on the armed member, never otherwise", () => {
		const c = new signin.SignInContinuation();
		const failed = { role: "assistant", provider: "anthropic-3", model: model.id, stopReason: "error", errorMessage: liveError() };
		const boundary = (extra = {}) => ({ outcome: "error", continue: false, entries: [], context: {
			contextEntries: [{ sourceEntry: { id: "tool" }, messages: [{ role: "toolResult" }] },
				{ sourceEntry: { id: "failed" }, messages: [{ role: "assistant" }] }], pendingMessages: [] }, ...extra });
		const from = { provider: "anthropic-3", id: model.id }, to = { provider: "anthropic-4", id: model.id };
		c.observe(failed, "failed", from);
		assert.equal(c.arm(from, to), true);
		assert.deepEqual(c.settle(boundary(), to, false),
			{ entries: [{ type: "context_edit", targetId: "failed", replacement: null }], continue: true });
		assert.equal(c.settle(boundary(), to, false), undefined, "once");
		c.observe(failed, "failed", from); c.arm(from, to);
		assert.equal(c.settle(boundary(), from, false), undefined, "not when the model is not the armed one");
		c.observe(failed, "failed", from); c.arm(from, to);
		assert.equal(c.settle({ ...boundary(), context: { ...boundary().context, pendingMessages: [{}] } }, to, false), undefined, "new input wins");
		c.observe(failed, "failed", from); c.arm(from, to);
		assert.equal(c.settle(boundary(), to, true), undefined, "not after an abort");
		c.observe({ ...failed, errorMessage: "429 rate_limit_error" }, "failed", from);
		assert.equal(c.arm(from, to), false, "only sign-in failures");
		c.reset();
		for (let i = 0; i < signin.MAX_CONTINUES_PER_PROMPT; i++) { c.observe(failed, "failed", from); c.arm(from, to); assert.ok(c.settle(boundary(), to, false)); }
		c.observe(failed, "failed", from);
		assert.equal(c.arm(from, to), false, "bounded per prompt");
	});

	// Run the real multiSub registrations with fake host state: a chat that failed over onto
	// anthropic-3 meets the live sign-in error. Boundary previews carry only entry IDs and roles.
	async function integration(sourceCode) {
		const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-signin-failover-"));
		try {
			fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify({ subscriptions: [], presets: [], chains: [],
				pools: [{ name: "claude-real", baseProvider: "anthropic", members: ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"], enabled: true }] }));
			const creds = Object.fromEntries(["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"]
				.map((p, i) => [p, { type: "oauth", expires: 1000 + i }]));
			const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
				.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
				.replace("export default function multiSub", "function multiSub");
			const production = runInNewContext(`${executable}\n;({multiSub, formatPoolStatusLines});`, {
				...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
				...limits, ...reset, ...fallback, ...countdown, ...subsLimits,
				Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
				readStoredCredential: (provider) => creds[provider],
				builtinProviders: () => [], getModels: () => [model],
				process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
				fetch: globalThis.fetch,
			});
			const chat = (start) => {
				let current = { provider: start, id: model.id }, switches = 0, replays = 0;
				const events = new Map(), notes = [];
				const ctx = { cwd: temp, get model() { return current; },
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
				let poolManager;
				production.multiSub({ on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
					registerCommand: (name, command) => { if (name === "pool") poolManager = command; },
					registerProvider() {}, registerTool() {},
					sendUserMessage: () => { replays++; },
					setModel: async next => { const previousModel = current; current = { provider: next.provider, id: next.id }; switches++;
						await emit("model_select", { model: current, previousModel, source: "set" }); return true; },
				});
				return { ctx, emit, notes, get model() { return current; }, get switches() { return switches; }, get replays() { return replays; } };
			};
			const boundary = (id) => ({ outcome: "error", continue: false, entries: [], context: {
				contextEntries: [{ sourceEntry: { id: "user" }, messages: [{ role: "user" }] },
					{ sourceEntry: { id }, messages: [{ role: "assistant" }] }], pendingMessages: [] } });
			const fail = async (c, error) => {
				const message = { role: "assistant", provider: c.model.provider, model: model.id, stopReason: "error", errorMessage: error };
				await c.emit("turn_end", { message, messageEntryId: "failed" });
				await c.emit("agent_end", { messages: [message] });
				return c.emit("agent_before_settle", boundary("failed"));
			};

			// Chat 1: on anthropic-3 when its sign-in fails.
			const one = chat("anthropic-3");
			await one.emit("session_start", {});
			await one.emit("before_agent_start", { prompt: "offline synthetic request" });
			const continued = await fail(one, liveError());
			const markFile = path.join(temp, "multi-pass-quota", "signin-failed.json");
			const marked = fs.existsSync(markFile) ? JSON.parse(fs.readFileSync(markFile, "utf8")).accounts : {};

			// Chat 2: anthropic-2 refuses with a limit; the rotation must not pick anthropic-3.
			const two = chat("anthropic-2");
			await two.emit("session_start", {});
			await two.emit("before_agent_start", { prompt: "offline synthetic request" });
			await fail(two, "429 rate_limit_error: This request would exceed your account's rate limit.");

			return { continued: continued.length ? continued[0] : undefined, one, two, marked, notes: one.notes.concat(two.notes) };
		} finally { fs.rmSync(temp, { recursive: true, force: true }); }
	}
	const sourceCode = fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
	await check("real hooks: sign-in failure moves on, continues once, no prompt replay", async () => {
		const r = await integration(sourceCode);
		assert.equal(r.one.switches, 1, "switched to the next member");
		assert.notEqual(r.one.model.provider, "anthropic-3");
		assert.equal(r.one.model.id, model.id, "same model");
		assert.equal(r.one.replays, 0, "the user's prompt is never replayed");
		assert.deepEqual(r.continued, { entries: [{ type: "context_edit", targetId: "failed", replacement: null }], continue: true });
		assert.equal(r.marked["anthropic-3"]?.kind, "refused");
		assert.equal(r.two.switches, 1, "the limit refusal still rotates");
		assert.notEqual(r.two.model.provider, "anthropic-3", "a failed sign-in is skipped by other chats");
		assert.ok(r.notes.some((n) => /anthropic-3 skipped \(sign-in failed \d\d:\d\d\)/.test(n)), "skip is reported");
	});
	await check("pool status shows the mark", async () => {
		const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-signin-status-"));
		try {
			const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
				.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
				.replace("export default function multiSub", "function multiSub");
			const { formatPoolStatusLines } = runInNewContext(`${executable}\n;({formatPoolStatusLines});`, {
				...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
				...limits, ...reset, ...fallback, ...countdown, ...subsLimits, Type: {}, getAgentDir: () => temp,
				readStoredCredential: () => undefined, builtinProviders: () => [], getModels: () => [model],
				process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
			});
			const pool = { name: "claude-real", baseProvider: "anthropic", members: ["anthropic", "anthropic-3"], enabled: true };
			const manager = { getAvailableMembers: () => ["anthropic"], isMemberExhausted: () => false,
				signInLabel: (p) => (p === "anthropic-3" ? "sign-in failed 06:40" : undefined) };
			const lines = formatPoolStatusLines(pool, { hasAuth: () => true }, manager);
			assert.ok(lines.includes("  anthropic -- logged in (available)"), lines.join("\n"));
			assert.ok(lines.includes("  anthropic-3 -- sign-in failed 06:40 (skipped until it signs in again)"), lines.join("\n"));
		} finally { fs.rmSync(temp, { recursive: true, force: true }); }
	});
	if (process.env.PI_SIGNIN_BASELINE_REF) {
		await check("same case on the pre-fix source stops the chat", async () => {
			const baseline = execFileSync("git", ["show", `${process.env.PI_SIGNIN_BASELINE_REF}:extensions/multi-sub.ts`], { cwd: root, encoding: "utf8" });
			const before = await integration(baseline);
			assert.equal(before.one.switches, 0, "baseline does not move on");
			assert.equal(before.continued, undefined, "baseline does not continue");
		});
	}
	assert.equal(fetches, 0, "no network or model calls during checks");
	console.log(`signin-failover: ${checked} checks passed; no network or model calls`);
} finally { globalThis.fetch = realFetch; }

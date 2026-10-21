// External-provider compatibility: fixed public schema, actual host/checker, no real auth/network.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import * as external from "../extensions/mine/antigravity-limits.ts";
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
import * as subs from "../extensions/mine/subs-limits.ts";
import * as envAllowed from "../extensions/mine/env-allowed-subs.ts";
import * as fallback from "../extensions/mine/fallback-return.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const realFetch = globalThis.fetch;
const unexpectedUrls = [];
globalThis.fetch = async url => { unexpectedUrls.push(String(url)); throw new Error("network forbidden"); };
const dir = fs.mkdtempSync(path.join(tmpdir(), "antigravity-limits-"));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const credential = { type: "oauth", access: "fake-access-private", refresh: "fake-refresh-private", expires: 9e12, projectId: "fake-project" };
const groupReply = { groups: [
	{ displayName: "Gemini", buckets: [
		{ bucketId: "gemini-5h", displayName: "5-hour", window: "FIVE_HOUR", remainingFraction: 0.75, resetTime: "2026-11-01T01:00:00Z" },
		{ bucketId: "gemini-week", displayName: "Weekly", remainingFraction: 0, resetTime: "2026-11-05T01:00:00Z" },
		{ bucketId: "unknown", remainingFraction: null },
	] },
	{ displayName: "Claude+GPT", buckets: [{ bucketId: "other", remainingFraction: 0.4 }] },
] };
const catalogReply = { models: {
	"gemini-4-argon": { displayName: "Gemini 4 Argon", quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-01T01:00:00Z" } },
	"gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-01T01:00:00Z" } },
	"no-number": { quotaInfo: { resetTime: "invalid" } },
	chat_internal: { quotaInfo: { remainingFraction: 1 } },
	internal: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
} };
const isolatedEnv = {};
const summarize = (data, catalog) => external.antigravityModelLimits(data, catalog);
try {
	const groups = summarize(groupReply);
	assert.equal(groups.status, "available");
	assert.equal(groups.scope, "provider-model-buckets");
	assert.deepEqual(groups.windows.map(w => w.remainingPercent), [75, 0, 40]);
	assert.equal(groups.limited, undefined, "empty unrelated bucket is not account-wide exhaustion");
	assert.match(groups.windows[0].name, /Shared Gemini \/ 5-hour/);
	assert.match(groups.note, /1 bucket\(s\) have unknown usage/);
	assert.equal(summarize({ groups: [{ buckets: [{ bucketId: "unknown" }] }] }).status, "unavailable");
	for (const value of [null, "0.5", NaN, Infinity, -0.1, 1.1])
		assert.equal(summarize({ groups: [{ buckets: [{ remainingFraction: value }] }] }).windows.length, 0);
	const models = summarize(catalogReply, true);
	assert.equal(models.windows.length, 2, "only known external model buckets; variants not private budgets");
	assert.match(models.windows[0].name, /Shared model bucket: gemini-4-argon/);
	assert.match(models.note, /not a private allowance/);
	assert.equal(summarize({ models: { x: { quotaInfo: { remainingFraction: 0.5, resetTime: "invalid" } } } }, true).windows[0].resetAt, undefined);
	assert.equal(summarize({ groups: [{ buckets: Array.from({ length: 25 }, () => ({ remainingFraction: 0.5 })) }] }).omittedWindows, 5);

	let calls = 0;
	const goodFetch = async (url, init) => {
		calls++;
		assert.match(String(url), /^https:\/\/[^/]+\.googleapis.com\/v1internal:retrieveUserQuotaSummary$/);
		assert.equal(init.redirect, "error", "no credential-bearing redirect follow");
		return json(groupReply);
	};
	let result = await external.checkAntigravityLimits(credential, undefined, goodFetch, isolatedEnv);
	assert.equal(result.kind, "available");
	assert.equal(calls, 1);
	assert.equal(result.limits.limited, undefined);
	assert.ok(!JSON.stringify(result).includes("fake-access-private"));
	assert.ok(!JSON.stringify(result).includes("fake-project"));
	assert.equal((await external.checkAntigravityLimits(undefined, undefined, goodFetch, isolatedEnv)).kind, "missing-auth");
	assert.equal((await external.checkAntigravityLimits({ ...credential, expires: 1 }, undefined, goodFetch, isolatedEnv)).kind, "missing-auth");
	assert.equal(calls, 1, "signed-out/expired makes no request and never refreshes itself");
	result = await external.checkAntigravityLimits(credential, undefined, async url =>
		String(url).endsWith("retrieveUserQuotaSummary") ? json({ error: { message: "SUBSCRIPTION_REQUIRED" } }, 403) : json(catalogReply), isolatedEnv);
	assert.equal(result.limits.status, "available", "free-tier aggregate failure can still read shared model buckets");
	assert.match(result.limits.source, /fetchAvailableModels/);
	for (const status of [401, 429, 503]) {
		result = await external.checkAntigravityLimits(credential, undefined,
			async () => json({ token: "fake-secret-not-output", error: "secret@example.test" }, status), isolatedEnv);
		assert.equal(result.kind, "error");
		assert.match(result.summary, new RegExp(`HTTP ${status}`));
		assert.ok(!JSON.stringify(result).includes("fake-secret"));
		assert.ok(!JSON.stringify(result).includes("@"));
	}
	result = await external.checkAntigravityLimits(credential, undefined, async () => { throw new Error("Bearer fake-secret"); }, isolatedEnv);
	assert.ok(!JSON.stringify(result).includes("fake-secret"));
	result = await external.checkAntigravityLimits(credential, undefined, async () => json({ groups: [] }), isolatedEnv);
	assert.equal(result.limits.status, "unavailable");
	const controller = new AbortController(); controller.abort();
	assert.match((await external.checkAntigravityLimits(credential, controller.signal, goodFetch, isolatedEnv)).summary, /cancelled/);
	calls = 0;
	for (const endpoint of ["http://cloudcode-pa.googleapis.com", "https://evil.test", "https://user:pw@cloudcode-pa.googleapis.com"])
		assert.match((await external.checkAntigravityLimits(credential, undefined, goodFetch, { ANTIGRAVITY_BASE_URL: endpoint })).summary, /invalid/);
	assert.equal(calls, 0, "unsafe custom endpoint cannot receive credentials");

	const creds = Object.fromEntries(["anthropic", "anthropic-2", "anthropic-3", "anthropic-4", "antigravity", "google-antigravity"].map(p => [p, credential]));
	fs.writeFileSync(path.join(dir, "multi-pass.json"), JSON.stringify({
		subscriptions: [2, 3, 4].map(index => ({ provider: "anthropic", index })), pools: [], chains: [], presets: [],
	}));
	let refreshed = [];
	const runSource = (source, fetchImpl = globalThis.fetch) => {
		const executable = stripTypeScriptTypes(source, { mode: "strip", disableExperimentalWarning: true })
			.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
			.replace("export default function multiSub", "function multiSub");
		return runInNewContext(`${executable}\n;({ limitsHost, PROVIDER_TEMPLATES, PROVIDER_QUOTA_CHECKERS, multiSub });`, {
			...fs, ...path, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
			...limits, ...reset, ...modelFallback, ...countdown, ...subs, ...envAllowed, ...fallback, ...external,
			Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => dir,
			readStoredCredential: p => creds[p], builtinProviders: () => [], getModels: () => [],
			process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
			fetch: fetchImpl,
		});
	};
	const registry = { getProviderAuth: async p => { refreshed.push(p); } };
	const baseline = runSource(execFileSync("git", ["show", "2b63f49:extensions/multi-sub.ts"], { cwd: root, encoding: "utf8" }));
	assert.ok(!subs.listAccounts(baseline.limitsHost(() => registry)).some(r => r.provider === "antigravity"),
		"counterfactual: original production host misses the same canonical credential");
	const source = fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
	const production = runSource(source), host = production.limitsHost(() => registry);
	let slots = subs.listAccounts(host);
	assert.equal(slots.filter(r => r.provider === "antigravity").length, 1);
	assert.equal(slots.find(r => r.provider === "antigravity").name, "Antigravity 1");
	assert.ok(slots.some(r => r.provider === "google-antigravity"), "legacy id remains separately supported");
	assert.equal(production.PROVIDER_TEMPLATES.antigravity, undefined, "no external OAuth/provider cloning template");
	assert.ok(production.PROVIDER_TEMPLATES["google-antigravity"]);
	assert.ok(production.PROVIDER_QUOTA_CHECKERS.some(c => c.baseProvider === "google-antigravity"));
	delete creds["google-antigravity"]; // discovery proven; do not exercise its separate unchanged SDK fetch
	const canonical = slots.find(r => r.provider === "antigravity");
	let row = await subs.checkAccount(host, canonical, undefined, { file: path.join(dir, "single.json"), fetch: goodFetch });
	assert.equal(row.failure, undefined);
	assert.equal(row.windows.length, 3);
	assert.equal(row.limited, undefined, "empty shared bucket cannot become an account-wide verdict in the Limits box");
	assert.ok(refreshed.includes("antigravity"), "refresh delegated to owning Pi registry");
	delete creds.antigravity;
	row = await subs.checkAccount(host, canonical, row, { file: path.join(dir, "single.json"), fetch: goodFetch });
	assert.equal(row.failure.reason, "signed-out");
	assert.equal(row.windows.length, 3, "signed out keeps old data explicitly stale");
	creds.antigravity = credential;
	row = await subs.checkAccount(host, canonical, undefined, { file: path.join(dir, "single.json"), fetch: async () => json({}) });
	assert.equal(row.failure.reason, "error");
	assert.equal(row.checkedAt, undefined);
	assert.deepEqual(row.windows, [], "unknown is never fabricated zero usage");

	// One narrow cache-row removal, then repeated real checks. Other rows persist.
	const file = path.join(dir, "subs-limits.json"), now = Date.now();
	const stale = { provider: "anthropic-5", base: "anthropic", number: 5, name: "Claude 5", windows: [], triedAt: now };
	const retained = { ...stale, provider: "openai-codex", base: "openai-codex", name: "ChatGPT 1", number: 1 };
	let previous = { version: 1, updatedAt: now, accounts: [stale, retained] };
	assert.ok(subs.listAccounts(host, previous).some(r => r.provider === "anthropic-5"), "original prior-cache retention is sole cause");
	previous.accounts = previous.accounts.filter(r => r.provider !== "anthropic-5");
	subs.writeLimitsReadings(file, previous);
	for (let i = 0; i < 2; i++) {
		const readings = await subs.checkAllLimits(host, { file, retryDelayMs: 0, fetch: async url => {
			if (String(url) === subs.ANTHROPIC_USAGE_URL) return json({ five_hour: { utilization: 25 } });
			if (String(url) === subs.ANTHROPIC_PROFILE_URL) return json({});
			if (String(url).endsWith("retrieveUserQuotaSummary")) return json(groupReply);
			throw new Error("network forbidden; legacy fake intentionally fails closed");
		} });
		assert.ok(!readings.accounts.some(r => r.provider === "anthropic-5"), "fresh normal refresh cannot resurrect removed stale row");
		assert.ok(readings.accounts.some(r => r.provider === "openai-codex"), "other previous rows retained");
		assert.equal(readings.accounts.filter(r => r.provider === "antigravity").length, 1);
		assert.ok(readings.accounts.find(r => r.provider === "antigravity").checkedAt);
	}
	// Actual registered current-model tool + hooks: canonical checker, no model/registration takeover.
	const tools = new Map(), events = new Map(), registrations = [];
	const canonicalProduction = runSource(source, goodFetch);
	canonicalProduction.multiSub({
		on: (event, fn) => events.set(event, [...events.get(event) ?? [], fn]),
		registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
		registerProvider: provider => registrations.push(provider),
		setModel: () => { throw new Error("must not select any model"); },
	});
	const ctx = { cwd: dir, model: { provider: "antigravity", id: "gemini-4-argon" }, isIdle: () => true,
		ui: { setStatus() {}, notify() {} }, modelRegistry: { ...registry,
			authStorage: { hasAuth: provider => Boolean(creds[provider]), get: provider => creds[provider] },
			find: (provider, id) => ({ provider, id }),
		} };
	globalThis.fetch = goodFetch; // imported adapter's own default fetch is outside the VM too
	const report = (await tools.get("current_model_limits").execute("fixture-limits", { refresh: true }, undefined, undefined, ctx)).details;
	globalThis.fetch = async url => { unexpectedUrls.push(String(url)); throw new Error("network forbidden"); };
	assert.equal(report.status, "available");
	assert.equal(report.scope, "provider-model-buckets");
	assert.equal(report.windows.length, 3);
	assert.match(report.note, /shared quota groups/);
	assert.deepEqual(registrations, ["anthropic-2", "anthropic-3", "anthropic-4"],
		"existing numbered direct accounts still register, but canonical/legacy external providers are never replaced");
	for (const shutdown of events.get("session_shutdown") ?? []) await shutdown({}, ctx);
	assert.deepEqual(unexpectedUrls, [], "all fetches are isolated fakes; no default fetch path");
	console.log("antigravity-limits: counterfactual discovery, canonical+legacy, shared schema, honest failures, Pi refresh, repeated cache persistence and no secrets/network passed");
} finally {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
}

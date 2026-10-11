// mine/env-allowed-subs: MULTI_PASS_ALLOWED_SUBS limits one pi process to the listed subscriptions, like a
// project's allowedSubs; unset, nothing changes. Plain node; no network (fetch throws), fake credentials only.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as envAllowed from "../extensions/mine/env-allowed-subs.ts";
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

const { ALLOWED_SUBS_ENV, envAllowedSubs, withEnvAllowedSubs } = envAllowed;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = { id: "claude-opus-5-5" };
const members = ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"];
let checked = 0, fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error("Network forbidden in env-allowed-subs checks"); };
const savedEnv = process.env[ALLOWED_SUBS_ENV];
const check = async (name, fn) => {
	try { await fn(); checked++; }
	catch (error) { throw new Error(`env-allowed-subs: ${name}: ${error.message}`); }
};

try {
	await check("off unless set", () => {
		assert.equal(ALLOWED_SUBS_ENV, "MULTI_PASS_ALLOWED_SUBS");
		for (const env of [{}, { MULTI_PASS_ALLOWED_SUBS: "" }, { MULTI_PASS_ALLOWED_SUBS: " , ," }]) {
			assert.equal(envAllowedSubs(env), undefined, JSON.stringify(env));
		}
		const project = { pools: [{ name: "claude", members }], allowedSubs: ["anthropic-3"] };
		assert.equal(withEnvAllowedSubs(undefined, {}), undefined, "no file, no variable: no project config");
		assert.equal(withEnvAllowedSubs(project, {}), project, "no variable: the file's config as it is");
	});

	await check("set: a clean list that replaces the file's allowedSubs and keeps its other keys", () => {
		assert.deepEqual(envAllowedSubs({ MULTI_PASS_ALLOWED_SUBS: " anthropic-4 ,anthropic-4, openai-codex " }), ["anthropic-4", "openai-codex"]);
		assert.deepEqual(withEnvAllowedSubs(undefined, { MULTI_PASS_ALLOWED_SUBS: "anthropic-4" }), { allowedSubs: ["anthropic-4"] });
		const project = { pools: [{ name: "claude", members }], allowedSubs: ["anthropic-3"] };
		assert.deepEqual(withEnvAllowedSubs(project, { MULTI_PASS_ALLOWED_SUBS: "anthropic-4" }), { ...project, allowedSubs: ["anthropic-4"] });
		assert.deepEqual(project.allowedSubs, ["anthropic-3"], "the loaded file object is not changed");
		process.env[ALLOWED_SUBS_ENV] = "anthropic-4";
		assert.deepEqual(envAllowedSubs(), ["anthropic-4"], "reads the process environment by default");
		delete process.env[ALLOWED_SUBS_ENV];
		assert.equal(envAllowedSubs(), undefined);
	});

	const sourceCode = fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
	await check("hook: every project-config reader goes through the variable", () => {
		assert.ok(/^import \{ withEnvAllowedSubs \} from "\.\/mine\/env-allowed-subs\.ts";$/m.test(sourceCode), "multi-sub.ts imports withEnvAllowedSubs");
		assert.ok(/function loadProjectConfig\(cwd: string\): ProjectConfig \| undefined \{\n\treturn withEnvAllowedSubs\(loadProjectConfigFile\(cwd\)\);/.test(sourceCode),
			"loadProjectConfig applies the variable to the file's config");
		assert.equal((sourceCode.match(/loadProjectConfigFile\(/g) ?? []).length, 2, "the file reader is defined once and called only by loadProjectConfig");
	});

	// The real multiSub registrations with fake host state (as in signin-failover-check), shaped like the
	// live config (labels left out): three registered Claude subscriptions, a four-member Claude pool and a
	// chain to a ChatGPT pool. A chat on one member meets a limit refusal, with and without the variable.
	async function integration(allowed, start, startModel = model.id) {
		const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-env-allowed-subs-"));
		if (allowed === undefined) delete process.env[ALLOWED_SUBS_ENV];
		else process.env[ALLOWED_SUBS_ENV] = allowed;
		try {
			fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify({ presets: [],
				subscriptions: [2, 3, 4].map((index) => ({ provider: "anthropic", index })),
				pools: [{ name: "claude-real", baseProvider: "anthropic", members, enabled: true },
					{ name: "codex-fallback", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true }],
				chains: [{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: model.id, enabled: true },
					{ pool: "codex-fallback", model: "gpt-6.1-sol", enabled: true }] }] }));
			const creds = Object.fromEntries([...members, "openai-codex"].map((p, i) => [p, { type: "oauth", expires: 1000 + i }]));
			const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
				.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
				.replace("export default function multiSub", "function multiSub");
			const production = runInNewContext(`${executable}\n;({multiSub});`, {
				...fs, ...path, ...envAllowed, ...signin, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting,
				...anthropicQuota, ...limits, ...reset, ...fallback, ...countdown, ...subsLimits,
				Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
				readStoredCredential: (provider) => creds[provider],
				builtinProviders: () => [], getModels: (provider) => provider === "openai-codex" ? [{ id: "gpt-6.1-sol" }] : [model],
				process: { env: {}, pid: process.pid }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
				fetch: globalThis.fetch,
			});
			let current = { provider: start, id: startModel }, switches = 0;
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
			const registered = [];
			production.multiSub({ on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
				registerCommand() {}, registerProvider: (name) => { registered.push(name); }, registerTool() {},
				sendUserMessage() {},
				setModel: async next => { const previousModel = current; current = { provider: next.provider, id: next.id }; switches++;
					await emit("model_select", { model: current, previousModel, source: "set" }); return true; },
			});
			await emit("session_start", {});
			const atStart = current.provider;
			await emit("before_agent_start", { prompt: "offline synthetic request" });
			const message = { role: "assistant", provider: current.provider, model: model.id, stopReason: "error",
				errorMessage: "429 rate_limit_error: This request would exceed your account's rate limit." };
			await emit("turn_end", { message, messageEntryId: "failed" });
			await emit("agent_end", { messages: [message] });
			return { atStart, after: current.provider, model: current.id, switches, notes, registered };
		} finally {
			delete process.env[ALLOWED_SUBS_ENV];
			fs.rmSync(temp, { recursive: true, force: true });
		}
	}

	await check("real hooks: unset, a limit refusal on anthropic-4 still rotates (chats unchanged)", async () => {
		const r = await integration(undefined, "anthropic-4");
		assert.equal(r.atStart, "anthropic-4");
		assert.equal(r.switches, 1, `rotated: ${r.notes.join(" | ")}`);
		assert.notEqual(r.after, "anthropic-4");
	});
	await check("real hooks: MULTI_PASS_ALLOWED_SUBS=anthropic-4 keeps the run on anthropic-4", async () => {
		const r = await integration("anthropic-4", "anthropic-4");
		assert.equal(r.atStart, "anthropic-4");
		assert.equal(r.switches, 0, `no other member and no ChatGPT fallback to move to: ${r.notes.join(" | ")}`);
		assert.equal(r.after, "anthropic-4");
		assert.ok(r.registered.includes("anthropic-3"), `pi still registers every subscription; the list only limits use: ${r.registered.join(", ")}`);
	});
	await check("real hooks: a session started elsewhere is moved onto the listed account", async () => {
		const r = await integration("anthropic-4", "anthropic-3");
		assert.equal(r.atStart, "anthropic-4", `moved at session start: ${r.notes.join(" | ")}`);
		assert.equal(r.after, "anthropic-4");
	});
	await check("real hooks: today's GPT-only pin keeps Sol and cannot fall onto Claude after refusal", async () => {
		const r = await integration("openai-codex", "openai-codex", "gpt-6.1-sol");
		assert.equal(r.atStart, "openai-codex");
		assert.equal(r.after, "openai-codex");
		assert.equal(r.model, "gpt-6.1-sol");
		assert.equal(r.switches, 0, "a refusal has no authorised alternative");
	});
	assert.equal(fetches, 0, "no network or model calls during checks");
	console.log(`env-allowed-subs: ${checked} checks passed; no network or model calls`);
} finally {
	globalThis.fetch = realFetch;
	if (savedEnv === undefined) delete process.env[ALLOWED_SUBS_ENV];
	else process.env[ALLOWED_SUBS_ENV] = savedEnv;
}

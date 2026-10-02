import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ANTHROPIC_PROFILE_URL, ANTHROPIC_USAGE_URL, LIMITS_CHANNEL_KEY, REASON_TEXT,
	baseOf, checkAccount, checkAllLimits, formatAccountLine, formatAgo, formatLimitWindow, formatLimitsText,
	installLimitsApi, limitsChannel, limitsCheckSummary, limitsChecking, listAccounts,
	parseAnthropicProfile, parseAnthropicUsage, planName, readLimitsReadings, recordReplyLimits,
	registerLimitsHost, reliableFetch, retryAfterMs, sanitizeReadings, windowsFromChecker,
	windowsFromQuotaHeaders, writeLimitsReadings,
} from "../extensions/mine/subs-limits.ts";

/* subs-limits: every account on every check, through the providers' free usage pages,
 * one shared readings file. Fake fetch only: a real network call fails the test. */

globalThis.fetch = async (url) => { throw new Error(`real network call in a test: ${url}`); };

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-02T06:00:00Z");
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const STATE_KEY = Symbol.for("pi-multi-pass.limits.state.v1");
const BASES = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity", "minimax", "minimax-cn"];
const WHAM = "https://chatgpt.test/backend-api/wham/usage";

const root = mkdtempSync(join(tmpdir(), "subs-limits-check-"));
let fileNo = 0;
const newFile = () => join(root, `run-${++fileNo}`, "subs-limits.json");
const resetShared = () => { delete globalThis[STATE_KEY]; delete globalThis[LIMITS_CHANNEL_KEY]; };

let clock = NOW;
const now = () => clock;
const slept = [];
const sleep = async (ms) => { slept.push(ms); };
const opts = (file, fetchImpl, extra = {}) =>
	({ file, fetch: fetchImpl, now, sleep, timeoutMs: 40, retryDelayMs: 0, retryAfterCapMs: 5000, ...extra });

const json = (body, status = 200, headers = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hang = () => new Promise(() => {});
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

function makeFetch(handler) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const h = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
		const call = { url: String(url), auth: h.Authorization ?? h.authorization, beta: h["anthropic-beta"], method: init.method };
		calls.push(call);
		return handler(call, init);
	};
	fetchImpl.calls = calls;
	fetchImpl.count = (url, token) => calls.filter((c) => c.url === url && (!token || c.auth === `Bearer ${token}`)).length;
	return fetchImpl;
}

const oauth = (access, expires = NOW + HOUR) => ({ type: "oauth", access, refresh: `refresh-${access}`, expires });
function makeHost({ creds = {}, configured = [], refresh, checkOther } = {}) {
	const host = {
		configured: () => configured,
		bases: () => BASES,
		stored: (p) => (creds[p] ? { ...creds[p] } : undefined),
		checkOther,
	};
	if (refresh !== null) host.refresh = refresh ?? (async () => undefined);
	return host;
}

/** Mirrors the ChatGPT checker: it catches fetch errors (AbortError aside) and reports kind "error". */
async function codexLike(provider, base, credential, fetchImpl, signal) {
	if (base !== "openai-codex") return undefined;
	try {
		const r = await fetchImpl(WHAM, { method: "GET", headers: { Authorization: `Bearer ${credential.access}` }, signal });
		if (!r.ok) return { kind: "error", summary: `HTTP ${r.status}` };
		const body = await r.json();
		return {
			kind: "available",
			windows: [
				{ name: "5h", usedPercent: body.five, resetAt: "2026-10-02T08:00:00Z" },
				{ name: "7d", remainingPercent: 100 - body.week, resetAt: "2026-10-08T00:00:00Z" },
			],
			plan: "plus", email: "chat@example.com",
		};
	} catch (error) {
		if (error?.name === "AbortError") throw error;
		return { kind: "error", summary: String(error?.message ?? error) };
	}
}

const usage = (five, week, extra = {}) => ({
	five_hour: { utilization: five, resets_at: "2026-10-02T09:00:00.000+00:00" },
	seven_day: { utilization: week, resets_at: "2026-10-06T19:00:00.363018+00:00" },
	seven_day_opus: null,
	...extra,
});
const PROFILE_MAX = { account: { email: "one@example.com", has_claude_max: true, has_claude_pro: false }, organization: { organization_type: "claude_max" } };
const PROFILE_PRO = { account: { email: "two@example.com", has_claude_max: false, has_claude_pro: true } };
const PROFILE_FREE = { account: { email: "three@example.com", has_claude_max: false, has_claude_pro: false }, organization: { organization_type: "" } };

/* --- small helpers --- */
assert.equal(planName("plus"), "Plus");
assert.equal(planName("claude_max"), "Max");
assert.equal(planName("team"), "Team");
assert.equal(planName("unknown"), undefined);
assert.equal(baseOf("anthropic-3", BASES), "anthropic");
assert.equal(baseOf("openai-codex", BASES), "openai-codex");
assert.equal(baseOf("minimax-cn", BASES), "minimax-cn", "an exact base wins over a numbered reading");
assert.equal(baseOf("minimax-cn-2", BASES), "minimax-cn");
assert.equal(baseOf("mystery-2", BASES), undefined);
assert.equal(retryAfterMs("3"), 3000);
assert.equal(retryAfterMs(new Date(NOW + 7000).toUTCString(), NOW), 7000);
assert.equal(retryAfterMs("soon"), undefined);
assert.equal(retryAfterMs(null), undefined);

/* --- Anthropic's usage page → windows --- */
{
	const parsed = parseAnthropicUsage(usage(12, 40, {
		seven_day_sonnet: { utilization: 5, resets_at: "2026-10-06T19:00:00+00:00" },
		limits: [
			{ kind: "session", group: "session", percent: 99, resets_at: null, scope: null },
			{ kind: "weekly_all", group: "weekly", percent: 99, resets_at: null },
			{ kind: "weekly_scoped", group: "weekly", percent: 6, resets_at: "2026-10-06T19:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
			{ kind: "weekly_scoped", group: "weekly", percent: 50, resets_at: null, scope: { model: null, surface: { id: "cowork" } } },
		],
	}));
	assert.deepEqual(parsed.windows.map((w) => [w.key, w.label, w.usedPercent]), [
		["5h", "5-hour", 12], ["7d", "Weekly", 40], ["7d:sonnet", "Weekly · Sonnet", 5], ["7d:fable", "Weekly · Fable", 6],
	], "five_hour/seven_day first, per-model weekly windows after; app (surface) scopes are not model limits");
	assert.equal(parsed.windows[0].resetAt, sec("2026-10-02T09:00:00Z"));
	assert.equal(parsed.windows[1].resetAt, sec("2026-10-06T19:00:00Z"));
	assert.equal(parsed.limited, false);

	const newer = parseAnthropicUsage({ limits: [
		{ kind: "session", percent: 0, resets_at: null },
		{ kind: "weekly_all", percent: 100, resets_at: "2026-10-03T19:00:00.363018+00:00" },
	] });
	assert.deepEqual(newer.windows.map((w) => [w.key, w.usedPercent, w.resetAt, w.limited]), [
		["5h", 0, undefined, undefined], ["7d", 100, sec("2026-10-03T19:00:00Z"), true],
	], "limits[] alone is enough; a window not started yet has no reset; 100% is limited");
	assert.equal(newer.limited, true);
	assert.equal(parseAnthropicUsage({ five_hour: { utilization: 130, resets_at: null } }).windows[0].usedPercent, 100);
	assert.equal(parseAnthropicUsage({ five_hour: null, seven_day: null }), undefined, "no numbers is not 0%");
	assert.equal(parseAnthropicUsage("nope"), undefined);

	assert.deepEqual(parseAnthropicProfile(PROFILE_MAX), { email: "one@example.com", plan: "Max" });
	assert.deepEqual(parseAnthropicProfile(PROFILE_PRO), { email: "two@example.com", plan: "Pro" });
	assert.deepEqual(parseAnthropicProfile(PROFILE_FREE), { email: "three@example.com", plan: "Free" });
	assert.equal(parseAnthropicProfile({ organization: { organization_type: "claude_max" } }).plan, "Max");
	assert.deepEqual(parseAnthropicProfile(undefined), { email: undefined, plan: undefined });
}

/* --- other checkers' windows and reply headers → windows --- */
{
	const codex = windowsFromChecker([
		{ name: "5h", usedPercent: 30, resetAt: "2026-10-02T08:00:00Z" },
		{ name: "7d", remainingPercent: 75, resetAt: 1791000000 },
		{ name: "gemini-2.5-pro", remainingPercent: 60 },
		{ name: "no-number" },
	]);
	assert.deepEqual(codex.map((w) => [w.key, w.label, w.usedPercent, w.resetAt]), [
		["5h", "5-hour", 30, sec("2026-10-02T08:00:00Z")], ["7d", "Weekly", 25, 1791000000],
		["m:gemini-2.5-pro", "gemini-2.5-pro", 40, undefined],
	]);
	const headers = windowsFromQuotaHeaders([
		{ name: "5h", usedPercent: 20, resetAt: 1790930000 },
		{ name: "7d_opus", usedPercent: 50, limited: false },
		{ name: "7d", limited: true },
		{ name: "overage", usedPercent: 3 },
	]);
	assert.deepEqual(headers.map((w) => [w.key, w.label, w.usedPercent]), [
		["5h", "5-hour", 20], ["7d:opus", "Weekly · Opus", 50],
	], "header windows without a number, and non-window headers, are skipped");
}

/* --- reliable fetch: deadline per attempt, one retry, Retry-After --- */
{
	const run = async (handler, extra = {}) => {
		slept.length = 0;
		const fake = makeFetch(handler);
		const log = { attempts: 0 };
		const f = reliableFetch(fake, log, { timeoutMs: 40, retryDelayMs: 7, retryAfterCapMs: 5000, sleep, now, ...extra });
		let response, error;
		try { response = await f("https://x.test/u", extra.init ?? {}); } catch (e) { error = e; }
		return { response, error, log, calls: fake.calls.length, slept: [...slept] };
	};
	let r0 = 0;
	let r = await run(() => (r0++ === 0 ? json({}, 503) : json({ ok: 1 })));
	assert.equal(r.response.status, 200);
	assert.deepEqual([r.calls, r.log.attempts, r.slept], [2, 2, [7]], "a 5xx is retried once");

	r0 = 0;
	r = await run(() => (r0++ === 0 ? json({}, 429, { "retry-after": "2" }) : json({ ok: 1 })));
	assert.deepEqual([r.response.status, r.slept], [200, [2000]], "a 429 waits for Retry-After");

	r = await run(() => json({}, 429, { "retry-after": "60" }));
	assert.deepEqual([r.response.status, r.calls, r.slept, r.log.status], [429, 2, [5000], 429], "the wait is capped; a second 429 is the answer");

	r = await run(() => json({}, 404));
	assert.deepEqual([r.response.status, r.calls], [404, 1], "a 4xx is not retried");

	r = await run(() => { throw new TypeError("fetch failed"); });
	assert.equal(r.error?.name, "LimitsFetchError");
	assert.equal(r.error.message, "no answer");
	assert.deepEqual([r.calls, r.log.network, r.log.timedOut], [2, true, false]);

	let t0 = Date.now();
	r = await run(() => hang());
	assert.equal(r.error?.name, "LimitsFetchError", "a timeout is not an AbortError: checkers must not rethrow it");
	assert.equal(r.error.message, "timed out");
	assert.deepEqual([r.calls, r.log.timedOut], [2, true]);
	assert.ok(Date.now() - t0 < 2000, "the deadline holds");

	r = await run(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
	assert.deepEqual([r.error?.message, r.calls, r.log.timedOut], ["timed out", 2, true], "a stalled body is a timeout too");

	const caller = new AbortController();
	caller.abort(new Error("chat closed"));
	r = await run(() => json({ ok: 1 }), { init: { signal: caller.signal } });
	assert.equal(r.error?.message, "chat closed", "the caller's own cancel is passed through, not retried");
	assert.equal(r.calls <= 1, true);

	r = await run(() => new Response(null, { status: 204 }));
	assert.equal(r.response.status, 204);
}

/* --- every account gets a row --- */
{
	const host = makeHost({
		creds: { anthropic: oauth("a"), "anthropic-2": oauth("b"), "openai-codex": oauth("c"), minimax: { type: "api_key", key: "k" } },
		configured: [{ provider: "anthropic-2", label: "two@example.com" }, { provider: "anthropic-3", label: "three@example.com" }],
	});
	const previous = { version: 1, updatedAt: NOW, accounts: [
		{ provider: "openai-codex-2", base: "openai-codex", number: 2, name: "ChatGPT 2", windows: [], checkedAt: NOW - 2 * DAY },
		{ provider: "anthropic-9", base: "anthropic", number: 9, name: "Claude 9", windows: [], checkedAt: NOW - 60 * DAY },
		{ provider: "mystery", base: "mystery", number: 1, name: "Mystery 1", windows: [], checkedAt: NOW },
	] };
	assert.deepEqual(listAccounts(host, previous, NOW).map((s) => [s.provider, s.name, s.label]), [
		["anthropic", "Claude 1", undefined],
		["anthropic-2", "Claude 2", "two@example.com"],
		["anthropic-3", "Claude 3", "three@example.com"],
		["openai-codex", "ChatGPT 1", undefined],
		["openai-codex-2", "ChatGPT 2", undefined],
	], "signed-in bases (ChatGPT too, though not a numbered sub), configured slots even signed out, recent rows kept; an API key alone is no subscription");
}

/* --- a full check, then a check where things fail --- */
{
	resetShared();
	clock = NOW;
	slept.length = 0;
	const file = newFile();
	const creds = {
		anthropic: oauth("tok-1"), "anthropic-2": oauth("tok-2"), "anthropic-3": oauth("tok-3"),
		"openai-codex": oauth("tok-c"), "github-copilot": oauth("tok-g"), "minimax-2": { type: "api_key", key: "k" },
	};
	const host = makeHost({
		creds,
		configured: [
			{ provider: "anthropic-2", label: "two@example.com" }, { provider: "anthropic-3", label: "three@example.com" },
			{ provider: "anthropic-4", label: "four@example.com" }, { provider: "minimax-2", label: "mm" },
		],
		checkOther: codexLike,
	});
	assert.equal(readLimitsReadings(file), undefined, "nothing before the first check");
	assert.equal(formatLimitsText(readLimitsReadings(file)), "Limits: not checked yet. Run /subs limit-check.");

	const seen = {};
	const once = (key) => (seen[key] = (seen[key] ?? 0) + 1);
	const fake1 = makeFetch((c) => {
		if (c.url === ANTHROPIC_USAGE_URL) {
			if (c.auth === "Bearer tok-1") return json(usage(12, 40));
			if (c.auth === "Bearer tok-2") return once("u2") === 1 ? json({ error: "overloaded" }, 503) : json(usage(30, 55));
			if (c.auth === "Bearer tok-3") return json({ error: "rate_limited" }, 429, { "retry-after": "2" });
		}
		if (c.url === ANTHROPIC_PROFILE_URL) {
			if (c.auth === "Bearer tok-1") return json(PROFILE_MAX);
			if (c.auth === "Bearer tok-2") return json(PROFILE_PRO);
			return json({}, 500);
		}
		if (c.url === WHAM) return json({ five: 10, week: 25 });
		throw new Error(`unexpected call ${c.url}`);
	});
	const r1 = await checkAllLimits(host, opts(file, fake1));
	const row = (r, p) => r.accounts.find((a) => a.provider === p);

	assert.deepEqual(r1.accounts.map((a) => [a.provider, a.name, a.failure?.reason]), [
		["anthropic", "Claude 1", undefined],
		["anthropic-2", "Claude 2", undefined],
		["anthropic-3", "Claude 3", "busy"],
		["anthropic-4", "Claude 4", "signed-out"],
		["openai-codex", "ChatGPT 1", undefined],
		["github-copilot", "Copilot 1", "unsupported"],
		["minimax-2", "MiniMax 2", "not-subscription"],
	], "every account has a row, none dropped");
	assert.equal(r1.checkedAt, NOW);
	const c1 = row(r1, "anthropic");
	assert.deepEqual(c1.windows.map((w) => [w.key, w.usedPercent, w.resetAt]), [
		["5h", 12, sec("2026-10-02T09:00:00Z")], ["7d", 40, sec("2026-10-06T19:00:00Z")],
	]);
	assert.deepEqual([c1.plan, c1.email, c1.source, c1.checkedAt, c1.limited], ["Max", "one@example.com", "check", NOW, undefined]);
	assert.deepEqual(row(r1, "anthropic-2").windows.map((w) => w.usedPercent), [30, 55], "a 503 is retried once");
	assert.deepEqual([row(r1, "anthropic-2").plan, row(r1, "anthropic-2").label], ["Pro", "two@example.com"]);
	assert.equal(row(r1, "anthropic-3").failure.text, "provider busy (429)");
	assert.ok(slept.includes(2000), "the 429 waited for Retry-After");
	assert.equal(row(r1, "anthropic-4").failure.text, "signed out");
	const chat = row(r1, "openai-codex");
	assert.deepEqual([chat.plan, chat.email, chat.windows.map((w) => [w.key, w.usedPercent])],
		["Plus", "chat@example.com", [["5h", 10], ["7d", 25]]], "ChatGPT through its own checker, with the reliable fetch");
	assert.equal(row(r1, "github-copilot").failure.text, REASON_TEXT.unsupported);
	assert.equal(row(r1, "minimax-2").failure.text, REASON_TEXT["not-subscription"]);

	assert.deepEqual([fake1.count(ANTHROPIC_USAGE_URL, "tok-1"), fake1.count(ANTHROPIC_USAGE_URL, "tok-2"), fake1.count(ANTHROPIC_USAGE_URL, "tok-3")], [1, 2, 2]);
	assert.ok(fake1.calls.every((c) => [ANTHROPIC_USAGE_URL, ANTHROPIC_PROFILE_URL, WHAM].includes(c.url)), "usage pages only: never a model request");
	assert.ok(fake1.calls.filter((c) => c.url.startsWith("https://api.anthropic.com")).every((c) => c.beta === "oauth-2025-04-20" && c.method === "GET"));

	const raw = readFileSync(file, "utf8");
	assert.deepEqual(JSON.parse(raw), JSON.parse(JSON.stringify(r1)), "the file holds exactly what the check returned");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dirname(file)), ["subs-limits.json"], "written whole: no temp files left");
	assert.doesNotMatch(raw, /tok-|refresh-/, "no token is ever stored");

	const summary1 = limitsCheckSummary(r1);
	assert.equal(summary1.failed, 4);
	assert.match(summary1.text, /^Limits: checked 3 of 7 accounts \(Claude 3: provider busy \(429\); Claude 4: signed out; /);

	// Ten minutes later: Claude 1 times out, Claude 2's sign-in is rejected, Claude 3 answers, ChatGPT is down.
	clock = NOW + 10 * MIN;
	const fake2 = makeFetch((c) => {
		if (c.url === ANTHROPIC_USAGE_URL) {
			if (c.auth === "Bearer tok-1") return hang();
			if (c.auth === "Bearer tok-2") return json({ error: "invalid token" }, 401);
			if (c.auth === "Bearer tok-3") return json(usage(5, 90));
		}
		if (c.url === ANTHROPIC_PROFILE_URL && c.auth === "Bearer tok-3") return json(PROFILE_FREE);
		if (c.url === WHAM) return json({}, 502);
		throw new Error(`unexpected call ${c.url} ${c.auth}`);
	});
	const r2 = await checkAllLimits(host, opts(file, fake2));
	const t1 = row(r2, "anthropic");
	assert.deepEqual([t1.failure.reason, t1.failure.text, t1.windows.map((w) => w.usedPercent), t1.checkedAt, t1.triedAt, t1.plan],
		["timeout", "timed out", [12, 40], NOW, NOW + 10 * MIN, "Max"], "a failed check keeps the last numbers and their age");
	assert.equal(fake2.count(ANTHROPIC_PROFILE_URL, "tok-1"), 0, "plan and email are read again only after 12 h");
	assert.match(formatAccountLine(t1, clock), /^Claude 1 · Max · one@example\.com — timed out · last numbers 10 min ago: 5-hour 12% used, resets in .+ · Weekly 40% used, resets in .+$/);
	const t2 = row(r2, "anthropic-2");
	assert.deepEqual([t2.failure.reason, t2.failure.text, t2.windows.map((w) => w.usedPercent)],
		["sign-in-expired", "sign-in expired; refreshes when the account is next used", [30, 55]]);
	const t3 = row(r2, "anthropic-3");
	assert.deepEqual([t3.failure, t3.plan, t3.windows.map((w) => w.usedPercent), t3.checkedAt], [undefined, "Free", [5, 90], NOW + 10 * MIN]);
	const tc = row(r2, "openai-codex");
	assert.deepEqual([tc.failure.reason, tc.failure.text, tc.plan, tc.windows.map((w) => w.usedPercent)], ["no-answer", "no answer", "Plus", [10, 25]]);
	assert.equal(r2.accounts.length, 7);
	assert.equal(limitsCheckSummary(r2).failed, 6);

	// The text never depends on the chat: only the "(this chat)" mark moves.
	const asTwo = formatLimitsText(r2, { now: clock, current: "anthropic-2" });
	const asChat = formatLimitsText(r2, { now: clock, current: "openai-codex" });
	assert.match(asTwo, /^Limits · 7 account\(s\) · checked just now\n/);
	assert.match(asTwo, /\n {2}Claude 2 · Pro · two@example\.com \(this chat\) — sign-in expired/);
	assert.match(asChat, /\n {2}ChatGPT 1 · Plus · chat@example\.com \(this chat\) — no answer/);
	assert.equal(asTwo.replace(" (this chat)", ""), asChat.replace(" (this chat)", ""));
	assert.equal(checkAllLimits.length, 2, "the check takes a host and options: no model");
}

/* --- sign-ins: refreshed only through pi's own store --- */
{
	resetShared();
	clock = NOW;
	const creds = { anthropic: oauth("old", NOW - 1000) };
	const refreshed = [];
	const host = makeHost({
		creds,
		refresh: async (p) => { refreshed.push(p); creds[p] = oauth("new", NOW + HOUR); },
	});
	const fake = makeFetch((c) => (c.url === ANTHROPIC_USAGE_URL ? json(usage(1, 2)) : json(PROFILE_MAX)));
	const slot = listAccounts(host, undefined, NOW)[0];
	const ok = await checkAccount(host, slot, undefined, opts(newFile(), fake));
	assert.equal(ok.failure, undefined);
	assert.deepEqual(refreshed, ["anthropic"], "pi's store refreshed the expired sign-in");
	assert.ok(fake.calls.length > 0 && fake.calls.every((c) => c.auth === "Bearer new"), "the re-read token is used; the old one never");

	const kept = { provider: "anthropic", base: "anthropic", number: 1, name: "Claude 1", windows: [{ key: "5h", label: "5-hour", usedPercent: 33 }], checkedAt: NOW - HOUR, source: "check" };
	creds.anthropic = oauth("old", NOW - 1000);
	const failing = makeHost({ creds, refresh: async () => { throw new Error("refresh rejected"); } });
	const none = makeFetch(() => { throw new Error("must not be called"); });
	const expired = await checkAccount(failing, slot, kept, opts(newFile(), none));
	assert.deepEqual([expired.failure.reason, expired.windows[0].usedPercent, expired.checkedAt, none.calls.length],
		["sign-in-expired", 33, NOW - HOUR, 0], "a refresh that fails: no call, last numbers kept");
	assert.doesNotMatch(JSON.stringify(expired), /refresh rejected|old/, "the reason is plain words, never the error or a token");

	// Within two minutes of expiry, and pi chose not to refresh: expired, and no other checker
	// is reached (some would refresh on their own, outside pi's store).
	let otherCalled = false;
	const nearly = makeHost({
		creds: { "openai-codex": oauth("c", NOW + MIN) },
		checkOther: async () => { otherCalled = true; return { kind: "available" }; },
	});
	const near = await checkAccount(nearly, listAccounts(nearly, undefined, NOW)[0], undefined, opts(newFile(), none));
	assert.deepEqual([near.failure.reason, otherCalled], ["sign-in-expired", false]);

	const noRefresh = makeHost({ creds: { anthropic: oauth("fine") }, refresh: null });
	const plain = await checkAccount(noRefresh, slot, undefined, opts(newFile(), fake));
	assert.equal(plain.failure, undefined, "a host without pi's refresh still checks a valid sign-in");

	const gone = makeHost({ creds: {}, configured: [{ provider: "anthropic-2" }] });
	const out = await checkAccount(gone, listAccounts(gone, undefined, NOW)[0], undefined, opts(newFile(), none));
	assert.equal(out.failure.reason, "signed-out");
}

/* --- a checker that lets the fetch error escape still gets the plain reason --- */
{
	resetShared();
	const throwing = makeHost({
		creds: { "openai-codex": oauth("c") },
		checkOther: async (_p, _b, _c, fetchImpl) => { await fetchImpl(WHAM, {}); return { kind: "available" }; },
	});
	const slot = listAccounts(throwing, undefined, NOW)[0];
	const timedOut = await checkAccount(throwing, slot, undefined, opts(newFile(), makeFetch(() => hang())));
	assert.equal(timedOut.failure.reason, "timeout");
	const down = await checkAccount(throwing, slot, undefined, opts(newFile(), makeFetch(() => { throw new TypeError("fetch failed"); })));
	assert.equal(down.failure.reason, "no-answer");
	const empty = await checkAccount(throwing, slot, undefined, opts(newFile(), makeFetch(() => json({}))));
	assert.deepEqual([empty.failure.reason, empty.failure.text], ["error", "check failed (no usage numbers in the reply)"]);
	const odd = makeFetch((c) => (c.url === ANTHROPIC_USAGE_URL ? json({ nothing: true }) : json({}, 404)));
	const claude = makeHost({ creds: { anthropic: oauth("a") } });
	const noNumbers = await checkAccount(claude, listAccounts(claude, undefined, NOW)[0], undefined, opts(newFile(), odd));
	assert.equal(noNumbers.failure.text, "check failed (no usage numbers in the reply)");
	const forbidden = makeFetch(() => json({}, 403));
	const denied = await checkAccount(claude, listAccounts(claude, undefined, NOW)[0], undefined, opts(newFile(), forbidden));
	assert.equal(denied.failure.text, "check failed (HTTP 403)");
}

/* --- concurrent checks join; the shared channel --- */
{
	resetShared();
	clock = NOW;
	const file = newFile();
	const gate = deferred();
	const fake = makeFetch(async (c) => {
		if (c.url === ANTHROPIC_PROFILE_URL) return json(PROFILE_MAX);
		await gate.promise;
		return json(usage(1, 2));
	});
	const host = makeHost({ creds: { anthropic: oauth("a"), "anthropic-2": oauth("b") }, configured: [{ provider: "anthropic-2" }] });
	const events = [];
	limitsChannel().listeners.add((e) => events.push(e.checking));
	limitsChannel().listeners.add(() => { throw new Error("a broken listener is its own problem"); });
	const off = registerLimitsHost(host);
	const api = installLimitsApi(opts(file, fake));
	assert.equal(globalThis[LIMITS_CHANNEL_KEY].api, api);
	assert.equal(globalThis[LIMITS_CHANNEL_KEY].v, 1);
	assert.equal(api.file, file);
	assert.equal(api.readings(), undefined);
	assert.equal(api.checking(), false);

	const p1 = api.check();
	const p2 = checkAllLimits(host, opts(file, fake));
	const p3 = api.check();
	assert.ok(p1 === p2 && p2 === p3, "a press while a check runs joins it");
	assert.equal(limitsChecking(), true);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(events, [true]);
	gate.resolve();
	const done = await p1;
	assert.deepEqual([fake.count(ANTHROPIC_USAGE_URL, "a"), fake.count(ANTHROPIC_USAGE_URL, "b")], [1, 1], "one check per account");
	assert.deepEqual(events, [true, false]);
	assert.equal(limitsChecking(), false);
	assert.deepEqual(api.readings().accounts.map((a) => a.provider), ["anthropic", "anthropic-2"]);
	assert.equal(done.accounts.length, 2);
	const next = api.check();
	assert.notEqual(next, p1, "after it ends, a new press runs a new check");
	await next;

	// The latest chat closed: its store still serves (pi's files), as the fallback.
	off();
	const afterClose = await api.check();
	assert.equal(afterClose.accounts.length, 2);

	// pi-web-ui's server may create the channel first: pi-multi-pass joins it.
	resetShared();
	const fromServer = { v: 1, listeners: new Set() };
	globalThis[LIMITS_CHANNEL_KEY] = fromServer;
	assert.equal(limitsChannel(), fromServer);
	const lonely = installLimitsApi(opts(newFile(), fake));
	assert.equal(fromServer.api, lonely);
	await assert.rejects(lonely.check(), /No chat has loaded pi-multi-pass yet/);
}

/* --- numbers seen in replies update their row, for free --- */
{
	resetShared();
	const file = newFile();
	const events = [];
	limitsChannel().listeners.add((e) => events.push(e));
	const five = (used, extra = {}) => [{ key: "5h", label: "5-hour", usedPercent: used, ...extra }];
	assert.equal(recordReplyLimits(file, "anthropic", five(50), NOW), false);
	assert.equal(existsSync(file), false, "before the first check, replies write nothing");

	clock = NOW;
	// Signed in for the whole block (its last part runs two hours on).
	const host = makeHost({ creds: { anthropic: oauth("a", NOW + 24 * HOUR) } });
	await checkAllLimits(host, opts(file, makeFetch((c) => (c.url === ANTHROPIC_USAGE_URL ? json(usage(10, 20)) : json(PROFILE_MAX)))));
	events.length = 0;
	assert.equal(recordReplyLimits(file, "anthropic", five(55, { resetAt: 1790930000 }), NOW + 5 * MIN), true);
	let a = readLimitsReadings(file).accounts[0];
	assert.deepEqual([a.windows.map((w) => [w.key, w.usedPercent]), a.source, a.checkedAt], [[["5h", 55], ["7d", 20]], "reply", NOW + 5 * MIN]);
	assert.equal(events.length, 1, "a reply's numbers are announced");
	assert.equal(recordReplyLimits(file, "anthropic", five(55, { resetAt: 1790930000 }), NOW + 5 * MIN + 30_000), false, "unchanged numbers don't rewrite the file");
	assert.equal(recordReplyLimits(file, "anthropic", [{ key: "7d:opus", label: "Weekly · Opus", usedPercent: 9 }], NOW + 6 * MIN), false, "a reply never adds a window the usage page doesn't show");
	assert.equal(recordReplyLimits(file, "anthropic-9", five(1), NOW + 6 * MIN), false, "no row, no write");
	assert.equal(recordReplyLimits(file, "anthropic", [{ key: "5h", label: "5-hour" }], NOW + 6 * MIN), false);
	assert.equal(recordReplyLimits(file, "anthropic", windowsFromQuotaHeaders([{ name: "7d", usedPercent: 100, limited: true }]), NOW + 7 * MIN), true);
	a = readLimitsReadings(file).accounts[0];
	assert.deepEqual([a.limited, a.windows.find((w) => w.key === "7d").label], [true, "Weekly"], "the page's label stays; limited follows");

	// A failed check followed by a reply: the reply's numbers clear the failure.
	const failed = readLimitsReadings(file);
	failed.accounts[0].failure = { reason: "busy", text: "provider busy (429)", at: NOW };
	writeLimitsReadings(file, failed);
	assert.equal(recordReplyLimits(file, "anthropic", windowsFromQuotaHeaders([{ name: "7d", usedPercent: 100, limited: true }]), NOW + 7 * MIN + 10_000), true);
	assert.equal(readLimitsReadings(file).accounts[0].failure, undefined);

	// Numbers from a reply that arrive while a check runs (and fails) are kept.
	resetShared();
	clock = NOW + 2 * HOUR;
	const racing = makeFetch((c) => {
		if (c.url === ANTHROPIC_USAGE_URL) {
			recordReplyLimits(file, "anthropic", five(70), NOW + 2 * HOUR + 1);
			return hang();
		}
		return json(PROFILE_MAX);
	});
	const raced = await checkAllLimits(host, opts(file, racing));
	const r = raced.accounts[0];
	assert.deepEqual([r.failure.reason, r.windows.find((w) => w.key === "5h").usedPercent, r.source, r.checkedAt],
		["timeout", 70, "reply", NOW + 2 * HOUR + 1]);
}

/* --- the file: versioned, sanitized --- */
{
	const file = newFile();
	assert.equal(sanitizeReadings({ version: 2, accounts: [] }), undefined);
	assert.equal(sanitizeReadings(null), undefined);
	const clean = sanitizeReadings({ version: 1, updatedAt: NOW, checkedAt: NOW, accounts: [
		{ provider: "anthropic", base: "anthropic", name: "Claude 1", number: 1, windows: [{ key: "5h", label: "5-hour", usedPercent: 140 }, { label: "no key" }],
			failure: { reason: "busy", text: "provider busy (429)", at: NOW }, token: "secret" },
		{ base: "anthropic", name: "no provider" },
		{ provider: "anthropic-2", base: "anthropic", name: "Claude 2", windows: [], failure: { reason: "made-up" } },
	] });
	assert.deepEqual(clean.accounts.map((a) => a.provider), ["anthropic", "anthropic-2"]);
	assert.deepEqual(clean.accounts[0].windows.map((w) => w.usedPercent), [100]);
	assert.equal(clean.accounts[0].failure.reason, "busy");
	assert.equal(clean.accounts[1].failure, undefined);
	assert.equal("token" in clean.accounts[0], false);
	writeLimitsReadings(file, clean);
	assert.deepEqual(JSON.parse(JSON.stringify(readLimitsReadings(file))), JSON.parse(JSON.stringify(clean)));
	writeLimitsReadings(file, { ...clean, version: 2 });
	assert.equal(readLimitsReadings(file), undefined, "an unknown version reads as nothing");
}

/* --- text --- */
{
	assert.equal(formatAgo(undefined), undefined);
	assert.equal(formatAgo(NOW, NOW), "just now");
	assert.equal(formatAgo(NOW - 5 * MIN, NOW), "5 min ago");
	assert.equal(formatAgo(NOW - 3 * HOUR, NOW), "3 h ago");
	assert.equal(formatAgo(NOW - 2 * DAY, NOW), "2 d ago");
	const s = NOW / 1000;
	assert.equal(formatLimitWindow({ key: "7d", label: "Weekly", usedPercent: 40, resetAt: s + 4 * 86400 + 2 * 3600 }, NOW), "Weekly 40% used, resets in 4d 2h");
	assert.equal(formatLimitWindow({ key: "5h", label: "5-hour", usedPercent: 100, resetAt: s - 60, limited: true }, NOW), "5-hour 100% used, has reset since");
	assert.equal(formatLimitWindow({ key: "7d", label: "Weekly" }, NOW), "Weekly ?");
	assert.equal(formatLimitsText({ version: 1, updatedAt: NOW, accounts: [] }), "Limits: not checked yet. Run /subs limit-check.");
	assert.equal(formatAccountLine({ provider: "anthropic", base: "anthropic", number: 1, name: "Claude 1", windows: [] }, NOW), "Claude 1 — no numbers yet");
	assert.equal(formatAccountLine({ provider: "anthropic", base: "anthropic", number: 1, name: "Claude 1", plan: "Max", label: "me@x",
		windows: [{ key: "7d", label: "Weekly", usedPercent: 100, resetAt: s + 3600, limited: true }], limited: true, checkedAt: NOW - 2 * MIN }, NOW),
	"Claude 1 · Max · me@x — Weekly 100% used, resets in 1h · LIMITED · checked 2 min ago");
}

/* --- the hooks in multi-sub.ts (upstream file: only call sites) --- */
{
	const src = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
	const mod = readFileSync(new URL("../extensions/mine/subs-limits.ts", import.meta.url), "utf8");
	assert.doesNotMatch(src, /subs-status\.ts|anthropic-probe\.ts|probeAnthropicQuota|refreshAllSubsStatus|probeMissingSubs|collectAllSubAccounts/);
	assert.match(src, /from "\.\/mine\/subs-limits\.ts"/);
	assert.match(src, /refresh: async \(provider\) => registry\(\)\?\.getProviderAuth\(provider\)/, "sign-ins refresh only through pi's own store");
	assert.match(src, /async check\(account: QuotaAccount, signal\?: AbortSignal, fetchImpl: typeof fetch = fetch\)/);
	assert.match(src, /await fetchImpl\(`\$\{baseUrl\}\/wham\/usage`/);
	const checkers = src.match(/const PROVIDER_QUOTA_CHECKERS[^;]*;/)?.[0] ?? "";
	assert.ok(checkers && !/anthropic/i.test(checkers), "rotation unchanged: no Anthropic checker in PROVIDER_QUOTA_CHECKERS");
	const sessionStart = src.slice(src.indexOf('pi.on("session_start"'), src.indexOf('pi.on("model_select"'));
	assert.match(sessionStart, /registerLimitsHost\(limitsHost\(\(\) => registry\)\)/);
	assert.match(sessionStart, /installLimitsApi\(\{ file: limitsFile\(\) \}\)/);
	assert.match(src, /pi\.on\("session_shutdown", \(\) => \{\s*unregisterLimitsHost\?\.\(\);/);
	assert.match(src, /case "limit-check":[\s\S]{0,80}case "status-all": \{\s*const readings = await poolManager\.checkAllSubsLimits\(ctx\);/);
	assert.match(src, /rememberQuotaResult[\s\S]{0,800}recordReplyLimits\(limitsFile\(\), provider, windowsFromChecker/);
	assert.match(src, /recordReplyLimits\(limitsFile\(\), request\.provider, windowsFromQuotaHeaders\(windows\)\)/);
	const ifShown = src.slice(src.indexOf("async refreshSubsStatusIfShown"), src.indexOf("async checkAllSubsLimits"));
	assert.ok(ifShown.length > 0);
	assert.doesNotMatch(ifShown, /checkAllLimits|fetch/, "re-showing the box reads the file only");
	const hostFn = src.slice(src.indexOf("function limitsHost("), src.indexOf("const codexQuotaChecker"));
	assert.ok(hostFn.length > 0);
	assert.doesNotMatch(hostFn, /ctx\.model|modelId|\.model\b/, "the check never depends on a chat's model");
	assert.match(src, /"multi-pass-limits"/, "the footer's current-account box stays");
	assert.equal((mod.match(/writeFileSync\(/g) ?? []).length, 1, "the readings file is the only thing written");
	assert.doesNotMatch(mod, /console\.|auth\.json"/, "no logging (no token can leak), no auth.json path");
}

rmSync(root, { recursive: true, force: true });
console.log("subs-limits: ok");

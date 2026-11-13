// limits-reading (model routing S2): recorded /subs replies → stable readings the router decides by.
// Recorded 2026-11-13 04:19Z from the four free usage pages /subs limit-check reads (ids and emails hidden):
// Claude 1 (33% weekly, Fable sub-cap 0%), Claude 2 (100%, limited), ChatGPT legacy (17%), Antigravity's two
// groups × weekly/5-hour. Fake fetch only: the real one throws. The seam test reads the result with pi-queue's
// own reader (`readingsFromLimits`, model-readings.ts; PI_QUEUE_DIR, default ~/projects/pi-queue), so there is
// one parser on each side of the file and this proves they agree.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as subs from "../extensions/mine/subs-limits.ts";
import * as ag from "../extensions/mine/antigravity-limits.ts";
import * as port from "../extensions/mine/limits-port.ts";

globalThis.fetch = async () => { throw new Error("network forbidden in tests"); };
const recorded = JSON.parse(readFileSync(new URL("./support/subs-replies-2026-11-13.json", import.meta.url), "utf8")).replies;
const queueDir = process.env.PI_QUEUE_DIR ?? join(homedir(), "projects/pi-queue");
const routing = await import(pathToFileURL(join(queueDir, "model-readings.ts")).href);

const MIN = 60_000;
const T0 = Date.parse("2026-11-13T04:19:54Z");
let clock = T0;
const now = () => clock;
const dir = mkdtempSync(join(tmpdir(), "limits-reading-"));
const file = join(dir, "subs-limits.json");

// One fake server for the four pages. `mode`: "ok" = the recorded replies, "down" = every page 500s,
// "slow" = the recorded replies after 300 ms.
let mode = "ok", calls = 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function fakeFetch(url, init = {}) {
	calls++;
	const u = String(url), auth = new Headers(init.headers).get("authorization") ?? "";
	if (mode === "slow") await new Promise((done) => setTimeout(done, 300));
	if (mode === "down") return json({ error: "down" }, 500);
	if (u === subs.ANTHROPIC_PROFILE_URL) return json({}, 404);
	if (u === subs.ANTHROPIC_USAGE_URL) return json(recorded[auth.endsWith("anthropic-2") ? "anthropic-2" : "anthropic"].body);
	if (u.endsWith("/wham/usage")) return json(recorded["openai-codex"].body);
	if (u.endsWith("v1internal:retrieveUserQuotaSummary")) return json(recorded.antigravity.body);
	throw new Error(`unexpected url ${u}`);
}

// The host as multi-sub.ts builds it: the Codex checker reads every window (`windowsFromCodexUsage`), the
// Antigravity checker is the real one.
const host = {
	configured: () => [{ provider: "anthropic-2" }],
	bases: () => ["anthropic", "openai-codex", "antigravity"],
	stored: (p) => ({ type: "oauth", access: `fake-${p}`, expires: 9e12, ...(p === "antigravity" ? { projectId: "fake" } : {}) }),
	checkOther: async (provider, base, credential, fetchImpl, signal) => {
		if (base === "openai-codex") {
			const r = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", { headers: { Authorization: `Bearer ${credential.access}` }, signal });
			if (!r.ok) return { kind: "error", summary: `HTTP ${r.status}` };
			const body = await r.json();
			return { kind: "available", plan: body.plan_type, usageWindows: subs.windowsFromCodexUsage(body, clock) };
		}
		if (base === "antigravity") {
			const r = await ag.checkAntigravityLimits(credential, signal, fetchImpl, {});
			return { kind: r.kind, windows: r.limits?.windows, usageWindows: r.usageWindows, summary: r.summary };
		}
		return undefined;
	},
};
subs.registerLimitsHost(host);
const api = subs.installLimitsApi({ file, fetch: fakeFetch, now, retryDelayMs: 1, timeoutMs: 2_000 });
const row = (r, p) => r.accounts.find((a) => a.provider === p);
const win = (a, key) => a.windows.find((w) => w.key === key);

try {
	// 1. Antigravity's buckets get stable keys from the provider's own bucket id and window; labels unchanged.
	assert.equal(ag.antigravityBucketKey({ bucketId: "gemini-weekly", window: "weekly" }), "ag:gemini:7d");
	assert.equal(ag.antigravityBucketKey({ bucketId: "3p-5h", window: "5h" }), "ag:claude-gpt:5h");
	assert.equal(ag.antigravityBucketKey({ bucketId: "gemini-week" }), "ag:gemini:7d", "window from the id's suffix");
	assert.equal(ag.antigravityBucketKey({ bucketId: "gemini-5h", window: "FIVE_HOUR" }), "ag:gemini:5h");
	assert.equal(ag.antigravityBucketKey({ bucketId: "new-family-weekly", window: "weekly" }), undefined, "unknown family: no guess");
	assert.equal(ag.antigravityBucketKey({ bucketId: "gemini-monthly", window: "monthly" }), undefined, "unknown window: no guess");
	const agReply = await ag.checkAntigravityLimits({ type: "oauth", access: "fake", expires: 9e12 }, undefined, fakeFetch, {});
	assert.deepEqual(agReply.usageWindows.map((w) => [w.key, w.label, Math.round(w.usedPercent)]), [
		["ag:gemini:7d", "Shared Gemini Models / Weekly Limit Remaining", 100],
		["ag:gemini:5h", "Shared Gemini Models / Five Hour Limit Remaining", 0],
		["ag:claude-gpt:7d", "Shared Claude and GPT models / Weekly Limit Remaining", 100],
		["ag:claude-gpt:5h", "Shared Claude and GPT models / Five Hour Limit Remaining", 0],
	]);
	const odd = { groups: [{ displayName: "New", buckets: [{ bucketId: "x", remainingFraction: 0.5 }, { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1 }, { bucketId: "gemini-week", remainingFraction: 1 }] }] };
	const oddReply = await ag.checkAntigravityLimits({ type: "oauth", access: "fake", expires: 9e12 }, undefined, async () => json(odd), {});
	assert.deepEqual(oddReply.usageWindows.map((w) => w.key), ["ag:0", "ag:gemini:7d", "ag:2"], "unknown or repeated bucket: position, as before");

	// 2. No readings yet: the port runs the free check and hands back every account fresh.
	let got = await api.fresh();
	assert.equal(got.outcome, "checked");
	assert.deepEqual(got.stale, []);
	const r = got.readings;
	assert.deepEqual(r.accounts.map((a) => a.provider), ["anthropic", "anthropic-2", "openai-codex", "antigravity"]);
	assert.deepEqual([win(row(r, "anthropic"), "7d").usedPercent, win(row(r, "anthropic"), "7d:fable").usedPercent], [33, 0]);
	assert.equal(win(row(r, "anthropic"), "7d:fable").label, "Weekly · Fable");
	assert.deepEqual([win(row(r, "anthropic-2"), "7d").usedPercent, row(r, "anthropic-2").limited], [100, true]);
	assert.deepEqual([win(row(r, "openai-codex"), "7d").usedPercent, row(r, "openai-codex").plan], [17, "Prolite"]);
	assert.deepEqual(row(r, "antigravity").windows.map((w) => w.key), ["ag:gemini:7d", "ag:gemini:5h", "ag:claude-gpt:7d", "ag:claude-gpt:5h"]);
	assert.deepEqual(Object.values(got.ageMs), [0, 0, 0, 0]);
	const firstCalls = calls;

	// What people read is unchanged: same labels, no keys.
	const text = subs.formatLimitsText(r, { now: clock });
	assert.match(text, /Antigravity 1 — Shared Gemini Models \/ Weekly Limit Remaining 100% used, resets in 19h 3\dm · Shared Gemini Models \/ Five Hour Limit Remaining 0% used, resets in 3h \d+m · Shared Claude and GPT models \/ Weekly Limit Remaining 100% used, resets in 5d 11h · Shared Claude and GPT models \/ Five Hour Limit Remaining 0% used, resets in 4\dm · checked just now/);
	assert.match(text, /Claude 1 — Weekly 33% used, resets in 3d · Weekly · Fable 0% used, resets in 3d · checked just now/);
	assert.doesNotMatch(text, /ag:/);

	// 3. The seam: pi-queue's reader turns the file into the router's allowances.
	const seam = routing.readingsFromLimits(JSON.parse(readFileSync(file, "utf8")));
	const by = Object.fromEntries(seam.allowances.map((a) => [a.id, a]));
	assert.deepEqual(seam.allowances.map((a) => a.id), ["claude-1", "claude-2", "chatgpt", "ag-gemini", "ag-claude-gpt"]);
	assert.deepEqual([by["claude-1"].weekly.usedPercent, by["claude-1"].weekly.resetAt, by["claude-1"].caps.fable.usedPercent],
		[33, Date.parse("2026-11-16T05:00:00Z"), 0]);
	assert.equal(by["claude-2"].weekly.limited, true);
	assert.deepEqual([by.chatgpt.weekly.usedPercent, by.chatgpt.weekly.resetAt], [17, 1794950544_000]);
	assert.deepEqual([by["ag-gemini"].weekly.usedPercent, by["ag-gemini"].short.usedPercent, by["ag-gemini"].weekly.resetAt], [100, 0, Date.parse("2026-11-13T23:50:26Z")]);
	assert.deepEqual([by["ag-claude-gpt"].weekly.usedPercent, by["ag-claude-gpt"].short.usedPercent], [100, 0]);
	assert.ok(seam.allowances.every((a) => routing.isFresh(a, clock)));
	assert.equal(routing.allowanceLimit(by["ag-gemini"], "gemini-4-carbon", clock).limited, true);
	assert.equal(routing.allowanceLimit(by["claude-1"], "claude-opus-5-5", clock).limited, false);

	// 4. Within 30 min: no check, no call.
	clock = T0 + 29 * MIN;
	got = await api.fresh();
	assert.deepEqual([got.outcome, got.stale, calls], ["not-needed", [], firstCalls]);
	assert.equal(got.ageMs.antigravity, 29 * MIN);

	// 5. Older than 30 min and the check fails: the old numbers stay, marked stale, so the router can't force on them.
	clock = T0 + 31 * MIN;
	mode = "down";
	got = await api.fresh();
	assert.equal(got.outcome, "check-failed");
	assert.deepEqual(got.stale, ["anthropic", "anthropic-2", "openai-codex", "antigravity"]);
	assert.ok(calls > firstCalls, "the check ran");
	assert.deepEqual(row(got.readings, "antigravity").windows, row(r, "antigravity").windows, "old numbers kept");
	assert.equal(row(got.readings, "antigravity").checkedAt, T0);
	assert.ok(got.readings.accounts.every((a) => a.failure));
	assert.equal(got.ageMs.anthropic, 31 * MIN);
	assert.match(subs.formatLimitsText(got.readings, { now: clock }), /Claude 1 — no answer · last numbers 31 min ago: Weekly 33% used/);
	const stale = routing.readingsFromLimits(got.readings);
	assert.ok(stale.allowances.every((a) => !routing.isFresh(a, clock) && routing.forceRule(a, clock) === undefined));

	// 6. A failed attempt isn't repeated within 30 min (no 10 s wait at every decision); still stale.
	const failedCalls = calls;
	clock = T0 + 40 * MIN;
	got = await api.fresh();
	assert.deepEqual([got.outcome, got.stale.length, calls], ["not-needed", 4, failedCalls]);

	// 7. A check slower than the deadline: the port answers at the deadline with what it has; the check
	//    finishes in the background and the next decision reads its numbers.
	clock = T0 + 72 * MIN;
	mode = "slow";
	const started = Date.now();
	got = await api.fresh({ timeoutMs: 50 });
	assert.equal(got.outcome, "timed-out");
	assert.ok(Date.now() - started < 250, "answered at the deadline");
	assert.equal(got.stale.length, 4);
	await api.check(); // joins the running check
	got = await api.fresh();
	assert.deepEqual([got.outcome, got.stale], ["not-needed", []]);
	assert.equal(row(got.readings, "anthropic").checkedAt, T0 + 72 * MIN);

	// 8. No chat can check (no sign-in store): no fresh reading, no throw.
	const none = await port.freshReadings({ readings: () => undefined, check: () => Promise.reject(new Error("No chat")) });
	assert.deepEqual([none.outcome, none.stale, none.readings], ["unavailable", [], undefined]);
	assert.equal(port.READING_MAX_AGE_MS, 30 * MIN);
	assert.equal(port.FRESH_CHECK_TIMEOUT_MS, 10_000);
	console.log("limits-reading-check: all assertions passed");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

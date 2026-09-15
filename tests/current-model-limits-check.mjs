import assert from "node:assert/strict";
import {
  CurrentModelLimits, codexModelLimits, googleModelLimits, unavailableLimits, formatModelLimits,
} from "../extensions/mine/current-model-limits.ts";

const data = codexModelLimits({ limited: false, weekly: { usedPercent: 37, resetAt: 1789816415 } });
assert.equal(data.scope, "account");
assert.equal(data.windows[0].name, "7d");
assert.equal(data.windows[0].remainingPercent, 63);
assert.equal(data.windows[0].resetAt, "2026-09-19T11:13:35.000Z");
assert.match(data.note, /No 5-hour window/);
assert.equal(codexModelLimits({ limited: false }).status, "unavailable");
assert.equal(codexModelLimits({ limited: true, weekly: { usedPercent: 110 } }).windows[0].remainingPercent, 0);
assert.equal(codexModelLimits({ limited: false, weekly: { usedPercent: 20, resetAt: Infinity } }).windows[0].resetAt, undefined);
const google = googleModelLimits({ models: [{ model: "Pro", remainingPercent: 45, resetAt: 1789816415 }] });
assert.equal(google.scope, "provider-model-buckets");
assert.equal(google.windows[0].usedPercent, 55);
assert.match(google.note, /may not exactly match/);
const many = googleModelLimits({ models: Array.from({ length: 80 }, (_, i) => ({ model: `model-${i}`, remainingPercent: 50 })) });
assert.equal(many.windows.length, 50);
assert.equal(many.omittedWindows, 30);

const current = { provider: "openai-codex", id: "gpt-6-astra" };
const cache = new CurrentModelLimits(60000, 20);
let checks = 0;
const check = async (provider) => { assert.ok(provider); checks++; return data; };
let report = await cache.get(current, check);
assert.equal(report.status, "available");
assert.equal(report.cached, false);
assert.equal(report.provider, current.provider);
assert.equal(report.model, current.id);
assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
// reset-countdown: countdown first, absolute UTC stamp kept right next to it.
assert.match(
  formatModelLimits(report, Date.parse("2026-09-14T20:00:00.000Z")),
  /7d 63% left, resets in 4d 15h \(09-19 11:13Z\)/,
);
report = await cache.get(current, check);
assert.equal(report.cached, true);
assert.equal(checks, 1);
report = await cache.get({ ...current, id: "gpt-5.5" }, check);
assert.equal(report.model, "gpt-5.5", "cached account quota is labeled with current model");
assert.equal(checks, 1);
await cache.get(current, check, { refresh: true });
assert.equal(checks, 2);
await cache.get({ ...current, provider: "openai-codex-2" }, check);
assert.equal(checks, 3, "never reuse another account's quota");
const separate = new CurrentModelLimits();
await separate.get(current, check);
assert.equal(checks, 4, "web-ui sessions have independent state");
const expired = new CurrentModelLimits(0);
expired.remember(current.provider, data);
await expired.get(current, check);
assert.equal(checks, 5);
const shared = new CurrentModelLimits();
shared.remember(current.provider, data);
await shared.get(current, check);
assert.equal(checks, 5, "reuse selector's quota snapshot rather than fetching twice");
const unsupported = await cache.get({ provider: "anthropic", id: "claude-fable-5-1" },
  async () => unavailableLimits("No configured quota source.", true));
assert.equal(unsupported.status, "unsupported");
assert.equal(unsupported.windows.length, 0);
assert.match(formatModelLimits(unsupported), /limits unavailable/);
const timeout = await cache.get(current, () => new Promise(() => {}), { refresh: true });
assert.equal(timeout.status, "unavailable");
assert.match(timeout.note, /timed out/);
const failed = await cache.get(current, async () => { throw new Error("SECRET must never appear in output"); }, { refresh: true });
assert.equal(failed.status, "unavailable");
assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
const controller = new AbortController(); controller.abort();
const before = checks;
const aborted = await cache.get(current, check, { signal: controller.signal });
assert.match(aborted.note, /cancelled/);
assert.equal(checks, before);
let done;
const cancelling = new CurrentModelLimits(60000, 100);
const pending = cancelling.get(current, () => new Promise((resolve) => { done = resolve; }));
cancelling.cancel();
assert.match((await pending).note, /cancelled/);
done(data);
await cancelling.get(current, check);
assert.equal(checks, before + 1, "late result cannot repopulate cancelled cache");
assert.equal((await cache.get(undefined, check)).model, null);
assert.match(formatModelLimits({ ...unsupported, ...google }), /quota buckets/);
console.log("current-model-limits: scoping, safe output, cache, footer, deadlines and cancellation passed");

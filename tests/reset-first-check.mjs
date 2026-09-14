import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as reset from "../extensions/mine/reset-first.ts";
import * as modelFallback from "../extensions/mine/model-fallback.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.now(), day = 86400, seconds = Math.floor(now / 1000);
const modelId = "gpt-6-astra";
const a = "openai-codex", b = "openai-codex-2";
const pool = { name: "codex", baseProvider: a, enabled: true, members: [a, b], strategy: "quota-first",
  resetFirst: { models: [modelId], window: "weekly", onSelect: true } };
function raw(weeklyDays, fiveHourHours, weeklyUsed = 20, fiveHourUsed = 30) {
  return { rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: fiveHourUsed, limit_window_seconds: 18000, reset_at: seconds + fiveHourHours * 3600 },
    secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_at: seconds + weeklyDays * day } } };
}
const later = reset.parseResetUsage(raw(4, 1, 10, 10));
const sooner = reset.parseResetUsage(raw(1, 4, 80, 70));
const rank = (av = later, bv = sooner, config = pool.resetFirst) =>
  reset.rankResetAccounts([a, b], new Map([[a, av], [b, bv]]), config, now);
assert.deepEqual(rank(), [b, a], "weekly reset wins over headroom and 5-hour reset");
assert.deepEqual(rank(later, sooner, { ...pool.resetFirst, window: "five-hour" }), [a, b]);
assert.deepEqual(rank(later, sooner, { ...pool.resetFirst, window: "next" }), [a, b]);
assert.deepEqual(rank(reset.parseResetUsage(raw(1, 2)), sooner), [a, b], "5-hour reset breaks weekly tie");
assert.deepEqual(rank(reset.parseResetUsage(raw(1, 4, 10)), sooner), [a, b], "headroom breaks identical resets");
assert.deepEqual(rank(later, reset.parseResetUsage(raw(1, 4, 100))), [a], "weekly exhausted");
assert.deepEqual(rank(later, reset.parseResetUsage(raw(1, 4, 80, 100))), [a], "5-hour exhausted");
assert.deepEqual(rank(later, { ...sooner, limited: true }), [a], "API allowed/limit flags win");
assert.deepEqual(rank(later, reset.parseResetUsage(raw(1, 4, 99, 99))), [b, a], "remaining 1% is not zero quota");
assert.deepEqual(rank(undefined, sooner), [b, a]);
assert.deepEqual(reset.rankResetAccounts([a, b], new Map(), pool.resetFirst), [a, b], "no data: original order");
assert.equal(reset.parseResetUsage({ rate_limit: { allowed: false } }).limited, true);
assert.equal(reset.parseResetUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }).fiveHour, undefined);
assert.equal(reset.parseResetUsage({ rate_limit: { secondary_window: { used_percent: NaN, limit_window_seconds: 604800 } } }).weekly, undefined);
assert.deepEqual(rank({ ...later, weekly: { ...later.weekly, resetAt: seconds - 1 } }, sooner), [b, a], "past reset is unknown");
const weeklyOnly = days => ({ rate_limit: { allowed: true,
  primary_window: raw(days, 1).rate_limit.secondary_window, secondary_window: null } });
assert.deepEqual(rank(reset.parseResetUsage(weeklyOnly(4)), reset.parseResetUsage(weeklyOnly(1))), [b, a],
  "live API shape: weekly-only accounts are usable, not missing quota data");
const malformed = weeklyOnly(1); malformed.rate_limit.secondary_window = {};
assert.equal(reset.parseResetUsage(malformed).incomplete, true);
assert.deepEqual(rank(later, reset.parseResetUsage(malformed)), [a, b], "malformed is not the same as absent");
assert.equal(reset.usesResetFirst({ ...pool, enabled: false }, modelId), false);
assert.equal(reset.usesResetFirst(pool, "gpt-5.5"), false);
assert.equal(reset.usesResetFirst({ ...pool, resetFirst: { models: "bad" } }, modelId), false);

// Exercise the actual router, including one-candidate quota checks and bounded failures.
const messages = [], queried = [];
const host = { pools: () => [pool], eligible: () => true, report: (...args) => messages.push(args),
  check: async (provider) => { queried.push(provider); return provider === a ? later : sooner; } };
const candidates = [a, b].map((provider) => ({ poolName: "codex", provider, modelId, source: "chain", chainName: "fable-chain", chainIndex: 2 }));
const router = new reset.ResetFirstRouter(20);
assert.equal((await router.reorder(candidates, host))[0].provider, b);
assert.deepEqual(queried, [a, b]);
assert.ok(messages.some(([text]) => text.includes("7d 20% left") && text.includes("5h 30% left")));
queried.length = 0;
const opus = { poolName: "claude", provider: "anthropic", modelId: "claude-opus-5", source: "chain", chainIndex: 1 };
assert.equal((await router.reorder([opus, ...candidates], host))[0], opus);
assert.equal(queried.length, 0, "do not query or promote Astra before Opus");
assert.deepEqual(await router.reorder([candidates[0]], { ...host, check: async () => ({ ...later, limited: true }) }), []);
assert.deepEqual(await router.reorder(candidates, { ...host, check: async () => { throw new Error("offline"); } }), candidates);
assert.deepEqual(await router.reorder(candidates, { ...host, check: () => new Promise(() => {}) }), candidates, "timeout cannot hang selection");
const controller = new AbortController(); controller.abort();
assert.deepEqual(await router.reorder(candidates, { ...host, signal: controller.signal }), []);
let current = { provider: a, id: modelId }, switches = 0;
const doSwitch = async (provider, id) => {
  switches++; current = { provider, id };
  await router.select(current, host, () => current, doSwitch);
  return true;
};
queried.length = 0;
await router.select(current, host, () => current, doSwitch);
assert.equal(current.provider, b);
assert.equal(switches, 1, "own model_select must not recurse");
assert.equal(queried.length, 2, "no duplicate quota checks after own switch");
let release;
current = { provider: a, id: modelId };
const pending = router.select(current, { ...host, check: () => new Promise((resolve) => { release = resolve; }) }, () => current, doSwitch);
current = { provider: "anthropic", id: "claude-fable-5-1" };
await router.select(current, host, () => current, doSwitch);
release(sooner);
await pending;
assert.equal(current.provider, "anthropic", "late quota results must not override a newer selection");

// Integration: execute REAL production code with mocked host APIs, quota HTTP and temp config.
// No copied PoolManager algorithm, no real credentials, no paid model requests.
const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-reset-first-"));
const configPath = path.join(temp, "multi-pass.json");
const claude = { name: "claude", baseProvider: "anthropic", members: ["anthropic"], enabled: true };
const config = { subscriptions: [], presets: [], pools: [claude, pool], chains: [{ name: "fable-chain", enabled: true, entries: [
  { pool: "claude", model: "claude-fable-5-1", enabled: true },
  { pool: "claude", model: "claude-opus-5", enabled: true },
  { pool: "codex", model: modelId, enabled: true },
] }] };
try {
  fs.writeFileSync(configPath, JSON.stringify(config));
  const source = fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
  const executable = stripTypeScriptTypes(source, { mode: "strip", disableExperimentalWarning: true })
    .replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
    .replace("export default function multiSub", "function multiSub");
  let requests = [], refreshed = [], httpData = { [a]: raw(4, 1, 10, 10), [b]: raw(1, 4, 80, 70) };
  const exports = runInNewContext(`${executable}\n;({ multiSub, PoolManager });`, {
    ...fs, ...path, ...modelFallback, ...reset,
    getAgentDir: () => temp, builtinProviders: () => [],
    getModels: () => ["claude-fable-5-1", "claude-opus-5", modelId, "gpt-5.5"].map((id) => ({ id })),
    process: { env: {} }, Buffer, URL, Headers, AbortController, AbortSignal, console,
    fetch: async (_url, options) => {
      const provider = options.headers.get("chatgpt-account-id");
      assert.ok(refreshed.includes(provider), "refresh auth before fetching usage");
      requests.push(provider);
      return { ok: true, json: async () => httpData[provider] };
    },
  });
  const known = new Set([a, b, "anthropic"]), missingModels = new Set();
  let model = { provider: "anthropic", id: "claude-fable-5-1" };
  const ctx = {
    cwd: temp, get model() { return model; },
    modelRegistry: {
      authStorage: { hasAuth: (p) => known.has(p), get: (p) => ({ type: "oauth", access: "fake-test-access", accountId: p }) },
      getProviderAuth: async (p) => { refreshed.push(p); },
      find: (provider, id) => known.has(provider) && !missingModels.has(provider) ? { provider, id } : undefined,
    },
    ui: { notify: (s) => notifications.push(s), setStatus: (key, value) => status.set(key, value) },
  };
  const events = new Map(), notifications = [], status = new Map(), chosen = [], replays = [];
  const emit = async (name, event = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const pi = {
    on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
    registerCommand() {}, registerProvider() {},
    setModel: async (next) => { const previousModel = model; model = next; chosen.push(next.provider); await emit("model_select", { model, previousModel, source: "set" }); return true; },
    sendUserMessage: (message) => replays.push(message),
  };
  modelFallback.clearModelExhaustion();
  exports.multiSub(pi);
  await emit("session_start");
  await emit("before_agent_start", { prompt: "test prompt" });
  const fail = () => emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] });
  await fail();
  assert.equal(model.id, "claude-opus-5");
  assert.equal(requests.length, 0);
  await fail();
  assert.equal(model.id, modelId);
  assert.equal(model.provider, b, "chain entry must apply destination pool reset-first policy");
  assert.deepEqual(requests, [a, b]);
  assert.ok(status.get("multi-pass").includes(`active ${b}`));
  assert.ok(status.get("multi-pass-quota").includes(`prefers ${b}`));
  assert.equal(replays.length, 0, "leave automatic retries to pi; never queue duplicate prompts");
  // Current Astra account fails: query remaining account, do not reroute back via model_select.
  requests = [];
  await fail();
  assert.equal(model.provider, a);
  assert.deepEqual(requests, [a]);

  // New extension instance: manual model selection + real model_select hooks, no cooldown state.
  events.clear(); modelFallback.clearModelExhaustion(); requests = []; refreshed = [];
  model = { provider: "anthropic", id: "claude-fable-5-1" };
  exports.multiSub(pi);
  await emit("session_start");
  await pi.setModel({ provider: a, id: modelId });
  assert.equal(model.provider, b, "manual Astra selection must also select earliest weekly reset");
  assert.deepEqual(requests, [a, b]);
  httpData = { [a]: weeklyOnly(4), [b]: weeklyOnly(1) }; requests = [];
  await pi.setModel({ provider: a, id: modelId });
  assert.equal(model.provider, b, "manual selection with real weekly-only API shape");
  assert.ok(status.get("multi-pass-quota").includes("5h not reported"));
  // Missing model / logged-out account cannot enter selection.
  missingModels.add(b); requests = [];
  await pi.setModel({ provider: a, id: modelId });
  assert.equal(model.provider, a);
  assert.deepEqual(requests, [a]);
  missingModels.clear(); known.delete(b); requests = [];
  await pi.setModel({ provider: a, id: modelId });
  assert.deepEqual(requests, [a]); known.add(b);
  // Respect project allowedSubs, not global membership.
  fs.mkdirSync(path.join(temp, ".pi"));
  fs.writeFileSync(path.join(temp, ".pi/multi-pass.json"), JSON.stringify({ allowedSubs: [a] }));
  requests = [];
  await pi.setModel({ provider: a, id: modelId });
  assert.equal(model.provider, a);
  assert.deepEqual(requests, [a]);
  fs.unlinkSync(path.join(temp, ".pi/multi-pass.json"));
  // Non-Astra selection does not call the quota endpoint, and clears stale quota status.
  requests = [];
  await pi.setModel({ provider: a, id: "gpt-5.5" });
  assert.equal(requests.length, 0);
  assert.equal(status.get("multi-pass-quota"), undefined);
  await emit("session_shutdown");
  console.log("reset-first: ranking, deadlines, manual selection and production failover integration passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  modelFallback.clearModelExhaustion();
}

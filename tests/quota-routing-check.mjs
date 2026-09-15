import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import * as qs from "../extensions/mine/quota-state.ts";
import * as policy from "../extensions/mine/account-policy.ts";
import * as routing from "../extensions/mine/quota-routing.ts";
import * as anthropic from "../extensions/mine/anthropic-quota.ts";
import * as limits from "../extensions/mine/current-model-limits.ts";
import * as reset from "../extensions/mine/reset-first.ts";
import * as fallback from "../extensions/mine/model-fallback.ts";
import * as countdown from "../extensions/mine/reset-countdown.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-quota-routing-"));
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const second = () => Math.floor(now / 1000), day = 86400;
const credential = (accountId) => ({ type: "oauth", access: "PRIVATE-ACCESS", refresh: "PRIVATE-REFRESH", accountId });
const window = (name, usedPercent, resetAt, extra = {}) => ({ name, scope: "account", usedPercent, resetAt, observedAt: now, ...extra });
const state = (...windows) => ({ version: 1, windows, failures: [] });
const config = { policy: "weekly-first", recovery: "earlier-weekly-reset" };
const hdr = (hourUsed, weekUsed, hourReset = second() + 18000, weekReset = second() + 4 * day) => ({
  "anthropic-ratelimit-unified-5h-utilization": String(hourUsed / 100),
  "anthropic-ratelimit-unified-5h-reset": String(hourReset),
  "anthropic-ratelimit-unified-7d-utilization": String(weekUsed / 100),
  "anthropic-ratelimit-unified-7d-reset": String(weekReset),
  "anthropic-ratelimit-unified-status": "allowed",
});
try {
  // Strict parsing, account/model scopes, no warning threshold / raw-token assumptions.
  const windows = anthropic.parseAnthropicQuotaHeaders({ ...hdr(23, 61),
    "Anthropic-Ratelimit-Unified-7d-opus-utilization": "0.99", // not a supported bucket key
    "anthropic-ratelimit-unified-7d_alpha-utilization": "1.0",
    "anthropic-ratelimit-unified-7d_alpha-reset": String(second() + day),
    "authorization": "Bearer PRIVATE-ACCESS", "set-cookie": "PRIVATE-COOKIE",
  }, "model-alpha", now);
  assert.equal(windows.length, 3);
  assert.equal(windows.find(w => w.name === "5h").usedPercent, 23);
  assert.equal(windows.find(w => w.name === "7d").usedPercent, 61);
  assert.equal(qs.quotaBlocked(state(...windows), "model-alpha", now), true);
  assert.equal(qs.quotaBlocked(state(...windows), "model-beta", now), false, "model-only cap cannot exhaust the account");
  assert.doesNotMatch(JSON.stringify(windows), /PRIVATE|authorization|cookie/i);
  for (const bad of ["", "NaN", "Infinity", "-1", "oops"]) {
    assert.deepEqual(anthropic.parseAnthropicQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": bad }, "m", now), []);
  }
  const warning = anthropic.parseAnthropicQuotaHeaders({ ...hdr(75, 50), "anthropic-ratelimit-unified-status": "allowed_warning" }, "m", now);
  assert.equal(qs.quotaBlocked(state(...warning), "m", now), false, "warning is not exhaustion");
  const rejected = anthropic.parseAnthropicQuotaHeaders({ "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day_alpha", "anthropic-ratelimit-unified-reset": String(second() + day) }, "model-alpha", now);
  assert.equal(rejected[0].modelFamily, "alpha");
  assert.equal(qs.quotaBlocked(state(...rejected), "model-beta", now), false);
  const unknownClaim = anthropic.parseAnthropicQuotaHeaders({ "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "unknown_future_bucket" }, "model-alpha", now);
  assert.equal(unknownClaim[0].scope, "model");
  assert.equal(unknownClaim[0].modelId, "model-alpha");
  assert.equal(anthropic.anthropicModelLimits(state(...windows), "anthropic", "model-beta", now).windows.length, 2);
  const expired = state(window("5h", 100, second() - 1), window("7d", 70, second() + day));
  assert.equal(qs.quotaBlocked(expired, "m", now), false);
  const expiredReport = anthropic.anthropicModelLimits(expired, "anthropic", "m", now);
  assert.equal(expiredReport.windows.find(w => w.name === "5h").usedPercent, undefined, "reset does not invent 0% usage");
  assert.equal(expiredReport.stale, true);
  assert.match(limits.formatModelLimits(expiredReport), /observed.*stale/);

  // Persistence: account isolation, identity replacement, concurrent writer merge, malformed input.
  assert.equal(qs.quotaAccountKey("anthropic", { type: "api_key", key: "PRIVATE" }), undefined);
  assert.ok(qs.quotaAccountKey("openai-codex", { ...credential("x"), access: "long-jwt".repeat(500) }));
  const keyA = qs.quotaAccountKey("anthropic", credential("a")), keyB = qs.quotaAccountKey("anthropic", credential("b"));
  assert.notEqual(keyA, keyB);
  assert.equal(qs.quotaAccountKey("anthropic", { ...credential("a"), access: "rotated", refresh: "rotated" }), keyA);
  assert.notEqual(qs.quotaAccountKey("anthropic", { type: "oauth", access: "a" }), qs.quotaAccountKey("anthropic", { type: "oauth", access: "b" }));
  const directory = path.join(temp, "state"), storeA = new qs.QuotaStateStore(directory), storeB = new qs.QuotaStateStore(directory);
  storeA.update(keyA, { windows: [window("5h", 10, second() + 18000)] });
  now += 1;
  storeB.update(keyA, { windows: [window("7d", 40, second() + day)] });
  assert.equal(storeA.get(keyA).windows.length, 2);
  now += 1;
  storeA.update(keyA, { windows: [window("5h", 20, second() + 18000)] });
  assert.equal(storeB.get(keyA).windows.find(w => w.name === "5h").usedPercent, 20);
  assert.equal(new qs.QuotaStateStore(directory).get(keyA).windows.length, 2, "survives reload");
  assert.equal(storeA.get(keyB).windows.length, 0);
  assert.deepEqual(storeA.get("../../escape"), qs.emptyQuotaState());
  const sanitized = qs.sanitizeQuotaState({ ...state(window("5h", 20, second() + 18000, { secret: "PRIVATE" })), access: "PRIVATE" }, now);
  assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE|secret|access/);
  for (const file of fs.readdirSync(path.join(directory, keyA))) {
    assert.equal(fs.statSync(path.join(directory, keyA, file)).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, keyA, file), "utf8"), /PRIVATE/);
  }
  const failures = qs.emptyQuotaState();
  const f1 = qs.failureObservation(failures, "m", now);
  const f2 = qs.failureObservation({ ...failures, failures: [f1] }, "m", now + 6 * 60000);
  assert.equal(f1.retryAt - now, 5 * 60000);
  assert.equal(f2.retryAt - (now + 6 * 60000), 10 * 60000, "failed recovery backs off");
  assert.equal(qs.failureObservation(state(window("5h", 100, second() + 7200)), "m", now).retryAt, (second() + 7200) * 1000 + 1000);

  // Review regressions: a late F1 clearance cannot delete concurrent F2; success
  // without headers or per-window statuses resets speculative backoff independently.
  const raceKey = qs.quotaAccountKey("anthropic", credential("race"));
  const failure1 = qs.failureObservation(state(), "m", now);
  storeA.update(raceKey, { failures: [failure1] });
  now += 1000;
  const failure2 = qs.failureObservation(storeA.get(raceKey), "m", now);
  storeB.update(raceKey, { failures: [failure2] });
  now += 1000;
  storeA.update(raceKey, { failures: [{ ...failure1, observedAt: now, succeededAt: now, retryAt: failure1.failedAt }] });
  assert.equal(storeB.get(raceKey).failures[0].failedAt, failure2.failedAt);
  assert.equal(qs.quotaBlocked(storeB.get(raceKey), "m", now), true);
  const coordinator = new routing.QuotaRouter(storeA);
  coordinator.observe(raceKey, [], "m");
  assert.equal(qs.quotaBlocked(storeA.get(raceKey), "m", now), false, "headerless HTTP success clears only backoff");
  now += 1000;
  coordinator.failed(raceKey, "m");
  assert.equal(storeA.get(raceKey).failures[0].attempts, 1);
  now += 1000;
  coordinator.observe(raceKey, anthropic.parseAnthropicQuotaHeaders(hdr(5, 10), "m", now), "m");
  now += 1000;
  coordinator.failed(raceKey, "m");
  assert.equal(storeA.get(raceKey).failures[0].attempts, 1, "success doesn't require per-window allowed status");

  // Re-check manual intent/restrictions after asynchronous metadata work.
  const recoverDir = path.join(temp, "recover"), recoverStore = new qs.QuotaStateStore(recoverDir);
  const recoverRouter = new routing.QuotaRouter(recoverStore);
  const rA = qs.quotaAccountKey("a", credential("a")), rB = qs.quotaAccountKey("b", credential("b"));
  const prior = now - 10 * 60000;
  recoverStore.update(rA, { windows: [window("7d", 30, second() + day)], failures: [{ modelId: "m", failedAt: prior, retryAt: prior + 5 * 60000, attempts: 1, observedAt: prior }] });
  recoverStore.update(rB, { windows: [window("7d", 30, second() + 4 * day)] });
  let selection = { provider: "b", id: "m" }, release, restricted = false, switchCount = 0;
  const recoverPool = { name: "p", enabled: true, baseProvider: "test", members: ["a", "b"], quotaRouting: config };
  const recoverHost = { pools: () => [{ ...recoverPool, members: restricted ? ["b"] : ["a", "b"] }],
    eligible: () => true, accountKey: p => p === "a" ? rA : rB, current: () => selection, report() {},
    check: p => p === "a" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(),
    setModel: async provider => { switchCount++; selection = { provider, id: "m" }; return true; } };
  const pendingSelection = recoverRouter.recover(recoverHost);
  recoverRouter.manualSelection(); release(); await pendingSelection;
  assert.equal(switchCount, 0, "late metadata cannot override a manual choice");
  const otherRouter = new routing.QuotaRouter(recoverStore);
  const pendingRestriction = otherRouter.recover(recoverHost);
  restricted = true; release(); await pendingRestriction;
  assert.equal(switchCount, 0, "latest project membership wins after metadata returns");

  const accounts = [
    { provider: "a", state: state(window("7d", 10, second() + 5 * day), window("5h", 10, second() + 3600)) },
    { provider: "b", state: state(window("7d", 90, second() + day), window("5h", 99, second() + 12000)) },
    { provider: "c", state: state(window("7d", 50, second() + 2 * day), window("5h", 50, second() + 7200)) },
  ];
  const p = policy.accountPolicies[config.policy];
  assert.deepEqual(p.rank(accounts, "m", config, now).map(a => a.provider), ["b", "c", "a"]);
  const blockedB = { ...accounts[1], state: state(window("5h", 100, second() + 3600)) };
  assert.deepEqual(p.rank([accounts[0], blockedB, accounts[2]], "m", config, now).map(a => a.provider), ["c", "a"]);
  assert.equal(p.preferRecovery(accounts[1], accounts[0], "m", config, now), true);
  assert.equal(p.preferRecovery(accounts[0], accounts[1], "m", config, now), false);
  assert.equal(p.preferRecovery(accounts[1], { provider: "unknown", state: state() }, "m", config, now), false);
  assert.equal(policy.usesQuotaRouting({ enabled: true, quotaRouting: { policy: "constructor" } }, "m"), false);
  assert.equal(policy.usesQuotaRouting({ enabled: true, quotaRouting: { ...config, models: "bad" } }, "m"), false);
  assert.equal(policy.usesQuotaRouting({ enabled: true, quotaRouting: { ...config, models: ["other"] } }, "m"), false);

  // Production integration: execute actual extension code, not a copied routing algorithm.
  const a = "anthropic", b = "anthropic-2", c = "anthropic-3", x = "openai-codex", y = "openai-codex-2";
  const pool = { name: "claude", baseProvider: a, members: [a, b, c], enabled: true, quotaRouting: config };
  const codexPool = { name: "codex", baseProvider: x, members: [x, y], enabled: true,
    quotaRouting: { ...config, models: ["model-gamma"] }, resetFirst: { models: ["model-gamma"], onSelect: true, window: "weekly" } };
  const fullConfig = { subscriptions: [], presets: [], pools: [pool, codexPool], chains: [{ name: "user-defined", enabled: true, entries: [
    { pool: "claude", model: "model-alpha", enabled: true }, { pool: "claude", model: "model-beta", enabled: true },
    { pool: "codex", model: "model-gamma", enabled: true },
  ] }] };
  fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify(fullConfig));
  const executable = stripTypeScriptTypes(fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8"), { mode: "strip", disableExperimentalWarning: true })
    .replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "").replace("export default function multiSub", "function multiSub");
  let model = { provider: a, id: "model-alpha" }, idle = true, requests = 0;
  const known = new Set([a, b, c, x, y]), events = new Map(), tools = new Map(), status = new Map(), notices = [], chosen = [], replay = [];
  const emit = async (name, event = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const ctx = { cwd: temp, isIdle: () => idle, get model() { return model; },
    modelRegistry: { authStorage: { hasAuth: p => known.has(p), get: p => known.has(p) ? credential(p) : undefined },
      getProviderAuth: async () => {}, find: (provider, id) => known.has(provider) ? { provider, id } : undefined },
    ui: { notify: message => notices.push(message), setStatus: (key, value) => value ? status.set(key, value) : status.delete(key) },
  };
  const pi = { on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]), registerCommand() {}, registerProvider() {},
    registerTool: tool => tools.set(tool.name, tool), sendUserMessage: text => replay.push(text),
    setModel: async next => { const previousModel = model; model = next; chosen.push(next.provider); await emit("model_select", { model, previousModel, source: "set" }); return true; } };
  const production = runInNewContext(`${executable}\n;({multiSub});`, {
    ...fs, ...path, ...qs, ...policy, ...routing, ...anthropic, ...limits, ...reset, ...fallback, ...countdown,
    Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
    builtinProviders: () => [], getModels: () => ["model-alpha", "model-beta", "model-gamma"].map(id => ({ id })),
    process: { env: {} }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
    fetch: async (url, options) => {
      requests++; assert.match(url, /\/wham\/usage$/); // no Anthropic endpoint, probes or credentials sent anywhere else
      const provider = options.headers.get("chatgpt-account-id");
      return { ok: true, json: async () => ({ rate_limit: { allowed: true, primary_window: {
        used_percent: provider === y ? 80 : 10, limit_window_seconds: 604800, reset_at: second() + (provider === y ? 1 : 4) * day,
      } } }) };
    },
  });
  const response = async headers => { await emit("before_provider_request", { payload: {} }); await emit("after_provider_response", { status: 200, headers }); };
  const fail = async () => emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "usage limit reached" }] });
  fallback.clearModelExhaustion();
  production.multiSub(pi);
  await emit("session_start");
  assert.equal(requests, 0);
  const tool = tools.get("current_model_limits");
  assert.equal((await tool.execute("t", {}, undefined, undefined, ctx)).details.status, "unavailable");
  const aReset = second() + 120, aWeekly = second() + 20000;
  await response(hdr(90, 50, aReset, aWeekly));
  assert.equal((await tool.execute("t", {}, undefined, undefined, ctx)).details.windows.find(w => w.name === "5h").usedPercent, 90);
  assert.match(status.get("multi-pass-limits"), /observed/);
  await pi.setModel({ provider: b, id: "model-alpha" }); await response(hdr(20, 80, second() + 18000, second() + 2 * day));
  await pi.setModel({ provider: c, id: "model-alpha" }); await response(hdr(20, 60, second() + 18000, second() + day));
  await pi.setModel({ provider: a, id: "model-alpha" });
  const initialSwitches = chosen.length;
  for (let i = 0; i < 5; i++) { await emit("input", { text: "real work", source: "interactive" }); await response(hdr(90 + i, 50, aReset, aWeekly)); }
  assert.equal(chosen.length, initialSwitches, "healthy messages never rotate just because another account exists");
  assert.equal(requests, 0, "capture uses ordinary response headers, no quota probes");
  now += 1000;
  await response(hdr(100, 50, aReset, aWeekly));
  await emit("before_agent_start", { prompt: "continue" });
  await fail();
  assert.equal(model.provider, c, "weekly reset beats round-robin account B");
  assert.equal(model.id, "model-alpha", "exhaust other subscriptions for selected model before descending chain");
  assert.equal(replay.length, 0, "pi owns retry; no duplicate prompt queued");
  await emit("input", { text: "continue", source: "interactive" });
  assert.equal(model.provider, c);
  now = aReset * 1000 + 1001;
  idle = false;
  await emit("input", { text: "queued while busy", source: "interactive" }); assert.equal(model.provider, c);
  idle = true;
  await emit("input", { text: "automatic continuation", source: "extension" }); assert.equal(model.provider, c);
  await emit("input", { text: "new work", source: "interactive" });
  assert.equal(model.provider, a, "no dwell delay: recovered A has earlier weekly expiry");
  const recovered = (await tool.execute("t", {}, undefined, undefined, ctx)).details;
  assert.equal(recovered.windows.find(w => w.name === "5h").usedPercent, undefined);
  await response(hdr(3, 52, second() + 18000, aWeekly));
  const afterRecovery = chosen.length;
  for (let i = 0; i < 3; i++) await emit("input", { text: "more work", source: "interactive" });
  assert.equal(chosen.length, afterRecovery);
  now += 1000;
  await pi.setModel({ provider: c, id: "model-alpha" });
  await emit("input", { text: "my intentional choice", source: "interactive" });
  assert.equal(model.provider, c, "manual account choice suppresses earlier recovery intent");

  // Model-only cap preserves the sibling model, and destination pool uses its own policy.
  known.delete(b); known.delete(c);
  await pi.setModel({ provider: a, id: "model-alpha" });
  await response({ ...hdr(5, 55, second() + 18000, aWeekly),
    "anthropic-ratelimit-unified-7d_alpha-utilization": "1",
    "anthropic-ratelimit-unified-7d_alpha-reset": String(second() + day) });
  now += 1000;
  await emit("before_agent_start", { prompt: "model fallback" });
  await fail();
  assert.equal(model.id, "model-beta", JSON.stringify(notices.slice(-12))); assert.equal(model.provider, a);
  await fail();
  assert.equal(model.id, "model-gamma"); assert.equal(model.provider, y, "quota routing also applies when entering Codex from a chain");
  assert.equal(requests, 2, "one metadata check per eligible Codex account; no competing reset-first selector");
  assert.equal(replay.length, 0);
  // A disabled overlapping pool must not revive the competing legacy onSelect router.
  fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify({ ...fullConfig, pools: [...fullConfig.pools,
    { name: "disabled-shadow", enabled: false, baseProvider: x, members: [x, y] }] }));
  await pi.setModel({ provider: x, id: "model-gamma" });
  assert.equal(model.provider, x, "keep intentional account selection despite disabled overlapping pool");
  assert.doesNotMatch(JSON.stringify([...status, notices]), /PRIVATE/);
  assert.deepEqual([...status.keys()].filter(k => k.startsWith("multi-pass-") && k !== "multi-pass"), ["multi-pass-limits"]);
  await emit("session_shutdown");
  console.log("quota-routing: passive OAuth capture, strict scopes, persistence, sticky failover, recovery, manual override and production hooks passed");
} finally {
  Date.now = realNow;
  fallback.clearModelExhaustion();
  fs.rmSync(temp, { recursive: true, force: true });
}

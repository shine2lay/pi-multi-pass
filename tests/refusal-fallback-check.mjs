import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
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
const refusalError = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";
const source = { provider: "anthropic", id: "claude-fable-5-1" };
const target = { provider: "openai-codex", id: "gpt-6.1-sol" };
const config = { enabled: true, provider: target.provider, model: target.id };
const message = (extra = {}) => ({ role: "assistant", provider: source.provider, model: source.id,
  stopReason: "error", rawStopReason: "refusal", errorMessage: refusalError, ...extra });
const boundary = (priorRole = "user") => ({ outcome: "error", continue: false, context: {
  contextEntries: [{ sourceEntry: { id: "original-context" }, messages: [{ role: priorRole }] },
    { sourceEntry: { id: "refused" }, messages: [{ role: "assistant" }] }], pendingMessages: [],
} });
let checked = 0, fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetches++; throw new Error("Network forbidden in refusal-fallback checks"); };
const check = async (name, fn) => {
  try { await fn(); checked++; }
  catch (error) { throw new Error(`refusal-fallback: ${name}: ${error.message}`); }
};
function fixture() {
  const controller = new refusal.RefusalFallback();
  let current = { ...source }, cfg = { refusalFallback: { ...config } }, switches = 0;
  const notes = [];
  const host = {
    config: () => cfg, current: () => current, authenticated: () => true, available: () => true,
    setModel: async (next) => { switches++; current = next; return true; }, notify: text => notes.push(text),
  };
  controller.observe(message(), "refused", current);
  return { controller, host, notes, switches: () => switches, current: () => current,
    setCurrent: next => { current = next; }, setConfig: next => { cfg = next; } };
}

try {
  await check("only the exact Anthropic cyber-classifier error", () => {
    for (const provider of ["anthropic", "anthropic-2", "anthropic-3"]) {
      assert.equal(refusal.isAnthropicCyberRefusal(message({ provider })), true);
    }
    assert.equal(refusal.isAnthropicCyberRefusal(message({ rawStopReason: undefined })), true);
    assert.equal(refusal.isAnthropicCyberRefusal(message({ errorMessage: `Error: ${refusalError}` })), true);
    for (const extra of [
      { provider: "openai-codex" }, { provider: "some-anthropic-proxy" },
      { stopReason: "aborted" }, { stopReason: "stop" }, { rawStopReason: "max_tokens" },
      { role: "user" }, { errorMessage: "The model refused to complete the request" },
      { errorMessage: "403 Forbidden" }, { errorMessage: "HTTP 429 rate limit" },
      { errorMessage: refusalError.replace("violative cyber", "disallowed biological") },
      { errorMessage: `unrelated error: ${refusalError}` },
      { errorMessage: `${refusalError} unrelated trailing content` },
    ]) assert.equal(refusal.isAnthropicCyberRefusal(message(extra)), false);
  });
  await check("configuration is opt-in, validated and non-Anthropic", () => {
    assert.equal(refusal.normalizeRefusalFallback(undefined), undefined);
    for (const raw of [null, [], {}, true, { ...config, enabled: false }, { ...config, model: "" },
      { ...config, provider: "anthropic-2" }, { ...config, provider: " anthropic " }, { ...config, model: 4 }]) {
      assert.equal(refusal.normalizeRefusalFallback(raw).enabled, false);
    }
    const normalized = refusal.normalizeRefusalFallback({ ...config, provider: ` ${target.provider} ` });
    assert.equal(normalized.enabled, true);
    assert.equal(normalized.provider, target.provider);
  });
  await check("one switch; only the refused response is omitted", async () => {
    const f = fixture(), event = boundary();
    const result = await f.controller.retry(event, f.host);
    assert.equal(result.continue, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].type, "context_edit");
    assert.equal(result.entries[0].targetId, "refused");
    assert.equal(result.entries[0].replacement, null);
    assert.equal(f.switches(), 1);
    assert.equal(f.current().id, target.id);
    assert.equal(event.context.contextEntries.length, 2, "input projection was not rewritten");
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0], /retrying once/);
    assert.equal(await f.controller.retry(event, f.host), undefined);
  });
  await check("tool-result tail can continue without replaying completed tools", async () => {
    const f = fixture();
    assert.equal((await f.controller.retry(boundary("toolResult"), f.host)).continue, true);
    assert.equal(f.switches(), 1);
  });
  await check("fallback refusal or later Claude refusal cannot loop", async () => {
    const f = fixture();
    await f.controller.retry(boundary(), f.host);
    f.controller.observe(message({ provider: target.provider, model: target.id }), "refused", f.current());
    assert.equal(await f.controller.retry(boundary(), f.host), undefined);
    f.setCurrent(source);
    f.controller.observe(message(), "refused", source);
    assert.equal(await f.controller.retry(boundary(), f.host), undefined);
    assert.equal(f.switches(), 1);
    f.controller.reset();
    f.controller.observe(message(), "refused", source);
    assert.equal((await f.controller.retry(boundary(), f.host)).continue, true, "next user activity gets its own budget");
  });
  await check("disabled, unavailable, signed-out or restricted targets do not retry", async () => {
    for (const mode of ["absent", "disabled", "missing", "signed-out", "restricted"]) {
      const f = fixture();
      if (mode === "absent") f.setConfig({});
      if (mode === "disabled") f.setConfig({ refusalFallback: { enabled: false } });
      if (mode === "missing") f.host.available = () => false;
      if (mode === "signed-out") f.host.authenticated = () => false;
      if (mode === "restricted") f.setConfig({ refusalFallback: config, allowedProviderNames: ["anthropic"] });
      assert.equal(await f.controller.retry(boundary(), f.host), undefined, mode);
      assert.equal(f.switches(), 0, mode);
    }
  });
  await check("manual selection, queued input, abort and shutdown win", async () => {
    for (const mode of ["manual", "queued", "aborted", "shutdown", "already-continuing", "new-tail", "invalid-tail", "non-error"]) {
      const f = fixture(), event = boundary();
      if (mode === "manual") f.setCurrent(target);
      if (mode === "queued") event.context.pendingMessages.push({ role: "user" });
      if (mode === "aborted") { const abort = new AbortController(); abort.abort(); f.host.signal = abort.signal; }
      if (mode === "shutdown") f.controller.cancel();
      if (mode === "already-continuing") event.continue = true;
      if (mode === "new-tail") event.context.contextEntries.push({ sourceEntry: { id: "later" }, messages: [{ role: "user" }] });
      if (mode === "invalid-tail") event.context.contextEntries[0].messages[0].role = "assistant";
      if (mode === "non-error") event.outcome = "stop";
      assert.equal(await f.controller.retry(event, f.host), undefined, mode);
      assert.equal(f.switches(), 0, mode);
    }
  });
  await check("stale failures from another model cannot redirect", async () => {
    const f = fixture();
    f.controller.observe(message({ model: "other-model" }), "refused", source);
    assert.equal(await f.controller.retry(boundary(), f.host), undefined);
    assert.equal(f.switches(), 0);
  });
  await check("failed or redirected switch keeps the original error", async () => {
    for (const mode of ["false", "throws", "different-target"]) {
      const f = fixture();
      f.host.setModel = async () => {
        if (mode === "throws") throw new Error("test error");
        if (mode === "different-target") f.setCurrent({ ...target, id: "other-model" });
        return mode !== "false";
      };
      assert.equal(await f.controller.retry(boundary(), f.host), undefined, mode);
      assert.equal(f.notes.length, 1, mode);
    }
  });
  await check("configuration and cancellation rechecked after model switch", async () => {
    for (const mode of ["cancel", "abort", "restrict", "disable"]) {
      const f = fixture(), original = f.host.setModel, abort = new AbortController();
      f.host.signal = abort.signal;
      f.host.setModel = async next => {
        const changed = await original(next);
        if (mode === "cancel") f.controller.cancel();
        if (mode === "abort") abort.abort();
        if (mode === "restrict") f.setConfig({ refusalFallback: config, allowedProviderNames: ["anthropic"] });
        if (mode === "disable") f.setConfig({ refusalFallback: { enabled: false } });
        return changed;
      };
      assert.equal(await f.controller.retry(boundary(), f.host), undefined, mode);
    }
  });

  // Run the real multiSub registrations, with fake host state and no provider calls.
  // Boundary previews contain only entry IDs and roles, never model request bodies.
  async function integration(sourceCode) {
    const temp = fs.mkdtempSync(path.join(tmpdir(), "pi-refusal-fallback-"));
    try {
      fs.writeFileSync(path.join(temp, "multi-pass.json"), JSON.stringify({ subscriptions: [], presets: [],
        pools: [{ name: "claude", baseProvider: "anthropic", members: ["anthropic"], enabled: true }],
        chains: [], refusalFallback: config }));
      const executable = stripTypeScriptTypes(sourceCode, { mode: "strip", disableExperimentalWarning: true })
        .replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];/gm, "")
        .replace("export default function multiSub", "function multiSub");
      const production = runInNewContext(`${executable}\n;({multiSub, loadEffectiveConfig, normalizeMultiPassConfig});`, {
        ...fs, ...path, ...refusal, ...quotaState, ...accountPolicy, ...quotaRouting, ...anthropicQuota,
        ...limits, ...reset, ...fallback, ...countdown, ...subsLimits,
        Type: { Object: p => p, Optional: p => p, Boolean: () => ({}) }, getAgentDir: () => temp,
        builtinProviders: () => [], getModels: () => [{ id: source.id }, { id: target.id }],
        process: { env: {} }, Buffer, URL, Headers, AbortController, AbortSignal, Date, console,
        fetch: globalThis.fetch,
      });
      let model = { ...source }, switches = 0, replays = 0;
      const events = new Map(), notes = [], tools = new Map();
      const ctx = { cwd: temp, get model() { return model; },
        modelRegistry: {
          authStorage: { hasAuth: () => true, get: () => ({ type: "api_key", key: "offline-test" }) },
          find: (provider, id) => ({ provider, id }), getProviderAuth: async () => undefined,
        }, ui: { notify: text => notes.push(text), setStatus() {} },
      };
      const emit = async (name, event = {}) => {
        const results = [];
        for (const fn of events.get(name) ?? []) results.push(await fn(event, ctx));
        return results.filter(Boolean);
      };
      production.multiSub({ on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
        registerCommand() {}, registerProvider() {}, registerTool: t => tools.set(t.name, t),
        sendUserMessage: () => { replays++; },
        setModel: async next => { const previousModel = model; model = next; switches++;
          await emit("model_select", { model, previousModel, source: "set" }); return true; },
      });
      await emit("before_agent_start", { prompt: "offline synthetic request" });
      await emit("turn_end", { ...boundary(), message: message(), messageEntryId: "refused" });
      await emit("agent_end", { messages: [message()] });
      const result = await emit("agent_before_settle", boundary());
      if (result.length) {
        assert.equal(result[0].continue, true);
        assert.equal(result[0].entries[0].targetId, "refused");
        assert.equal(result[0].entries[0].replacement, null);
        assert.equal(model.provider, target.provider);
        assert.equal(model.id, target.id);
        // Both config load and normalized save paths must retain the option.
        assert.equal(production.loadEffectiveConfig(temp).refusalFallback.enabled, true);
        assert.equal(production.normalizeMultiPassConfig({ refusalFallback: config }).refusalFallback.model, target.id);
        fs.mkdirSync(path.join(temp, ".pi"));
        fs.writeFileSync(path.join(temp, ".pi/multi-pass.json"), JSON.stringify({ refusalFallback: { enabled: false } }));
        assert.equal(production.loadEffectiveConfig(temp).refusalFallback.enabled, false);
        await emit("turn_end", { ...boundary(), message: message({ provider: target.provider, model: target.id }), messageEntryId: "refused" });
        assert.equal((await emit("agent_before_settle", boundary())).length, 0, "destination refusal must stop");
      }
      assert.equal(replays, 0, "never replay user input");
      return { continuations: result.length, switches };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const sourceCode = fs.readFileSync(path.join(root, "extensions/multi-sub.ts"), "utf8");
  await check("real registered hooks switch and continue exactly once", async () => {
    const result = await integration(sourceCode);
    assert.equal(result.continuations, 1);
    assert.equal(result.switches, 1);
  });
  if (process.env.PI_REFUSAL_BASELINE_REF) {
    await check("same regression fails on the pre-fix source", async () => {
      const baseline = execFileSync("git", ["show", `${process.env.PI_REFUSAL_BASELINE_REF}:extensions/multi-sub.ts`], { cwd: root, encoding: "utf8" });
      const before = await integration(baseline);
      assert.equal(before.continuations, 0, "baseline has no automatic retry");
      assert.equal(before.switches, 0, "baseline does not switch to Sol");
    });
  }
  assert.equal(fetches, 0, "no network or model calls during checks");
  console.log(`refusal-fallback: ${checked} checks passed; no network or model calls`);
} finally { globalThis.fetch = realFetch; }

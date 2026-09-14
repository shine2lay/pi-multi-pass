import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.removeAllListeners("warning");
process.on("warning", () => {});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mf = await import(join(root, "extensions", "mine", "model-fallback.ts"));

// --- hooks survive rebases -------------------------------------------------
const source = readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8");
assert.match(source, /from "\.\/mine\/model-fallback\.ts"/);
assert.match(source, /const exhaustion = recordModelExhaustion\(\{/);
assert.match(source, /if \(exhaustion\.escalate\) \{\s*this\.markExhausted\(currentModel\.provider\);/);
assert.doesNotMatch(source, /cascade\.\n\s*this\.markExhausted\(currentModel\.provider\);/, "unconditional markExhausted is back");
assert.match(source, /findApplicableChainForModel\(this\.getEnabledChains\(config\), pool\.name, currentModel\.id\)/);
assert.match(source, /wasTargetAttempted\(attemptedProviders, pool\.name, candidate, currentModel\.id\)/);
assert.match(source, /wasTargetAttempted\(attemptedProviders, targetPool\.name, member, entry\.model\)/);
assert.match(source, /this\.isMemberExhausted\(pool, candidate\) \|\| isModelExhausted\(pool\.name, candidate, currentModel\.id\)/);
assert.match(source, /this\.isMemberExhausted\(targetPool, member\) \|\| isModelExhausted\(targetPool\.name, member, entry\.model\)/);

// --- behavior: fable -> opus (same account) -> astra ---------------------------
const chains = [{
  name: "fable-chain", enabled: true, entries: [
    { pool: "claude", model: "claude-fable-5-1", enabled: true },
    { pool: "claude", model: "claude-opus-5", enabled: true },
    { pool: "codex", model: "gpt-6-astra", enabled: true },
  ],
}];
const t0 = 1_000_000;
mf.clearModelExhaustion();

assert.deepEqual(mf.getSiblingModels("claude", "claude-fable-5-1", chains), ["claude-opus-5"]);
assert.deepEqual(mf.getSiblingModels("codex", "gpt-6-astra", chains), []);

// turn starts on fable; attemptedProviders already has the provider (upstream startTurn)
const attempted = new Set(["anthropic"]);

// 1) fable hits its limit -> model-scoped only; opus on the same account stays eligible
const first = mf.recordModelExhaustion({ poolName: "claude", provider: "anthropic", modelId: "claude-fable-5-1", chains, now: t0 });
assert.equal(first.escalate, false);
assert.deepEqual(first.untried, ["claude-opus-5"]);
assert.match(first.detail, /model-scoped/);
assert.equal(mf.isModelExhausted("claude", "anthropic", "claude-fable-5-1", t0 + 1), true);
assert.equal(mf.wasTargetAttempted(attempted, "claude", "anthropic", "claude-fable-5-1", t0 + 1), true, "fable itself is attempted");
assert.equal(mf.wasTargetAttempted(attempted, "claude", "anthropic", "claude-opus-5", t0 + 1), false, "opus on same account is NOT attempted");
assert.equal(mf.isModelExhausted("claude", "anthropic", "claude-opus-5", t0 + 1), false);
assert.deepEqual(mf.findApplicableChainForModel(chains, "claude", "claude-fable-5-1"), { chain: chains[0], index: 0 });

// 2) opus hits a limit too -> no untried sibling -> escalate to provider-wide (upstream markExhausted)
const second = mf.recordModelExhaustion({ poolName: "claude", provider: "anthropic", modelId: "claude-opus-5", chains, now: t0 + 1000 });
assert.equal(second.escalate, true);
assert.match(second.detail, /all sibling models already exhausted/);
// cascade resumes after the opus entry, not after the first claude entry
assert.deepEqual(mf.findApplicableChainForModel(chains, "claude", "claude-opus-5"), { chain: chains[0], index: 1 });

// 3) pool without sibling models behaves exactly like upstream: escalate immediately
const codex = mf.recordModelExhaustion({ poolName: "codex", provider: "openai-codex", modelId: "gpt-6-astra", chains, now: t0 });
assert.equal(codex.escalate, true);
assert.match(codex.detail, /no sibling model configured/);

// 4) cooldown expiry frees the model target
assert.equal(mf.isModelExhausted("claude", "anthropic", "claude-fable-5-1", t0 + mf.MODEL_EXHAUSTION_COOLDOWN_MS), false);

// 5) unknown model falls back to first pool match (upstream behavior)
assert.deepEqual(mf.findApplicableChainForModel(chains, "claude", "claude-sonnet-5"), { chain: chains[0], index: 0 });
assert.equal(mf.findApplicableChainForModel(chains, "nope", "x"), undefined);

console.log("model-fallback-check: ok");

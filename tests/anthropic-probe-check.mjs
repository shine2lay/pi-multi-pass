import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeBody, probeHeaders, probeAnthropicQuota } from "../extensions/mine/anthropic-probe.ts";
import { parseAnthropicQuotaHeaders } from "../extensions/mine/anthropic-quota.ts";

/* anthropic-probe：用一次最小请求把订阅额度头问出来（只在 --probe 时）。 */

/* --- 请求真的「最小」 --- */
const body = JSON.parse(probeBody("claude-haiku-4-5"));
assert.equal(body.max_tokens, 1, "探针必须只要 1 个 token");
assert.equal(body.messages.length, 1);
assert.ok(JSON.stringify(body).length < 160, "探针请求体应当极小");
assert.ok(!("stream" in body), "不要流式：拿的是响应头");

const headers = probeHeaders("tok-abc");
assert.equal(headers.authorization, "Bearer tok-abc");
assert.equal(headers["anthropic-beta"], "oauth-2025-04-20", "订阅调用需要 OAuth beta 头");
assert.equal(headers["anthropic-version"], "2023-06-01");

/* --- 只收额度头，凭据不外泄 --- */
const fakeHeaders = new Map([
  ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
  ["anthropic-ratelimit-unified-5h-reset", String(Math.floor(Date.now() / 1000) + 3600)],
  ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
  ["set-cookie", "session=secret"],
  ["x-account-email", "someone@example.com"],
]);
const fakeResponse = {
  status: 200,
  headers: { forEach: (fn) => fakeHeaders.forEach((v, k) => fn(v, k)) },
  text: async () => "{}",
};
let seenInit;
const ok = await probeAnthropicQuota("tok-abc", "claude-haiku-4-5", {
  fetchImpl: async (_url, init) => { seenInit = init; return fakeResponse; },
});
assert.equal(ok.status, 200);
assert.deepEqual(Object.keys(ok.headers).sort(), [
  "anthropic-ratelimit-unified-5h-reset",
  "anthropic-ratelimit-unified-5h-utilization",
  "anthropic-ratelimit-unified-7d-utilization",
], "只保留额度头：cookie / 账号邮箱等一律不进内存");
assert.ok(seenInit.headers.authorization.startsWith("Bearer "), "凭据只用于这一次请求");

/* --- 解析结果接得上既有的额度解析器 --- */
const windows = parseAnthropicQuotaHeaders(ok.headers, "claude-haiku-4-5");
assert.ok(windows.some((w) => w.name === "5h" && Math.round(w.usedPercent) === 21));
assert.ok(windows.some((w) => w.name === "7d" && Math.round(w.usedPercent) === 8));

/* --- 4xx 也有收获（限流时额度头照样回来） --- */
const limitedHeaders = new Map([
  ["anthropic-ratelimit-unified-status", "rejected"],
  ["anthropic-ratelimit-unified-representative-claim", "seven_day"],
]);
const rateLimited = await probeAnthropicQuota("t", "m", {
  fetchImpl: async () => ({ status: 429, headers: { forEach: (fn) => limitedHeaders.forEach((v, k) => fn(v, k)) }, text: async () => "" }),
});
assert.equal(rateLimited.status, 429);
assert.ok(parseAnthropicQuotaHeaders(rateLimited.headers, "m").some((w) => w.limited), "429 也应解析出 limited");

/* --- 失败只报错，不抛 --- */
const boom = await probeAnthropicQuota("t", "m", { fetchImpl: async () => { throw new Error("network down"); } });
assert.equal(boom.status, 0);
assert.equal(boom.error, "probe failed");
const slow = await probeAnthropicQuota("t", "m", {
  timeoutMs: 20,
  fetchImpl: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
});
assert.equal(slow.error, "probe timed out");

/* --- 默认绝不探针（只有 --probe 才花钱） --- */
const src = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
assert.ok(src.includes("--probe") && src.includes(".test(rest)"), "只有命令里出现 --probe 才开启");
assert.match(src, /if \(options\.probe\) await this\.probeMissingSubs/, "没要求就不探");
const fn = src.slice(src.indexOf("private async probeMissingSubs"), src.indexOf("async getCurrentModelLimits"));
assert.match(fn, /if \(sub\.source !== "unknown"\) continue;/, "已有观测的账号不重复花额度");
assert.match(fn, /quotaRouter\.observe/, "探到的额度要写回共享 quota-state，另一个框与路由同样受益");

console.log("anthropic-probe-check: ok");

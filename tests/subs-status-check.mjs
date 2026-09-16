import assert from "node:assert/strict";
import {
  formatWindow, formatAge, formatSubLine, formatSubsStatus,
} from "../extensions/mine/subs-status.ts";

/* subs-status：所有订阅的余量一览（与「当前账号」的 multi-pass-limits 并存）。 */

const now = Date.parse("2026-09-15T20:00:00.000Z");
const iso = (s) => Date.parse(s);

/* --- 单个窗口 --- */
assert.equal(formatWindow({ name: "7d", remainingPercent: 61, resetAt: "2026-09-19T11:13:00.000Z" }, now), "7d 61% (in 3d 15h)");
assert.equal(formatWindow({ name: "5h", remainingPercent: 90 }, now), "5h 90%", "没有重置时间就只报余量");
assert.equal(formatWindow({ name: "7d" }, now), "7d ?", "没有数字时写 ? 而不是 0%");
assert.equal(formatWindow({ name: "7d", remainingPercent: 61, resetAt: Math.floor(iso("2026-09-15T21:00:00.000Z") / 1000) }, now), "7d 61% (in 1h)", "Unix 秒也认");

/* --- 观测新鲜度 --- */
assert.equal(formatAge(now - 30_000, now), "just now");
assert.equal(formatAge(now - 5 * 60_000, now), "5m ago");
assert.equal(formatAge(now - 3 * 3_600_000, now), "3h ago");
assert.equal(formatAge(now - 2 * 86_400_000, now), "2d ago");
assert.equal(formatAge(undefined, now), undefined);

/* --- 一行一个订阅 --- */
assert.equal(
  formatSubLine({ provider: "codex", source: "live", windows: [{ name: "7d", remainingPercent: 61, resetAt: "2026-09-19T11:13:00.000Z" }] }, now),
  "codex: 7d 61% (in 3d 15h)",
);
assert.equal(
  formatSubLine({ provider: "anthropic-2", label: "shinelay@gmail.com", source: "observed", observedAt: now - 120_000, windows: [{ name: "7d", remainingPercent: 92 }] }, now),
  "anthropic-2 (shinelay@gmail.com): 7d 92% — observed 2m ago",
  "被动观测必须标出观测时间（数据可能已经旧了）",
);
assert.match(
  formatSubLine({ provider: "anthropic-3", source: "unknown", windows: [] }, now),
  /no data yet/,
  "没观测到 ≠ 没额度：必须说“还没有数据”",
);
assert.match(
  formatSubLine({ provider: "anthropic", source: "live", limited: true, windows: [{ name: "5h", remainingPercent: 0 }] }, now),
  /limited/,
);

/* --- 整块：排序与表头 --- */
const block = formatSubsStatus([
  { provider: "a-late", source: "live", windows: [{ name: "7d", remainingPercent: 80, resetAt: "2026-09-20T00:00:00.000Z" }] },
  { provider: "b-soon", source: "live", windows: [{ name: "7d", remainingPercent: 20, resetAt: "2026-09-16T00:00:00.000Z" }] },
  { provider: "c-limited", source: "live", limited: true, windows: [{ name: "7d", remainingPercent: 0, resetAt: "2026-09-15T21:00:00.000Z" }] },
], now);
const order = block.split("\n").slice(1).map((l) => l.trim().split(":")[0]);
assert.deepEqual(order, ["b-soon", "a-late", "c-limited"], "先用快过期的额度；受限的排最后");
assert.match(block.split("\n")[0], /^subs \(3\) · checked 20:00Z$/);
assert.equal(formatSubsStatus([], now), "subs: none configured");

console.log("subs-status-check: ok");

/* --- 回归：纯 Anthropic 的池子也必须列出账号 ---------------------------- *
 * 之前 /subs limit-status 报「Checked 0 subscription(s)」：账号枚举走的是
 * collectQuotaAccounts()，它只列「有 quota checker 的 provider」（Codex / Google）。
 * Anthropic 订阅没有可查接口（额度只在正常响应的响应头里），于是纯 Anthropic 的
 * 配置得到零个账号。全景视图必须把它们也列出来 —— 查不到就用观测值/老实说没数据。 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
assert.match(src, /function collectAllSubAccounts\(/, "需要一个不按 checker 过滤的账号枚举器");
assert.match(
  src.slice(src.indexOf("async refreshAllSubsStatus")),
  /collectAllSubAccounts\(ctx\)/,
  "全景刷新必须用它，而不是只列可查 provider 的 collectQuotaAccounts",
);
const enumerator = src.slice(src.indexOf("function collectAllSubAccounts("), src.indexOf("const codexQuotaChecker"));
assert.ok(!/PROVIDER_QUOTA_CHECKERS/.test(enumerator), "枚举器不得再按 checker 过滤");
assert.match(enumerator, /normalizeQuotaAllowedProviderNames/, "项目级 provider 限制仍要生效");
console.log("subs-status-check: anthropic-only 枚举回归 ok");

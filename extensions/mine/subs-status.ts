/**
 * subs-status —— 一眼看完**所有订阅**的余量，而不只是当前这个账号。
 *
 * 与 `multi-pass-limits` 的区别（两者刻意并存）：
 *   · `multi-pass-limits` = **当前在用**的那个账号/模型，跑完一轮就刷新，回答
 *     「我现在还能用多久」；
 *   · `multi-pass-subs`（本模块）= **池子里每个订阅**各自的余量，回答「整体还剩
 *     多少、接下来该切谁」。它不自动刷新（查一次是要花代价的），只在你明确
 *     `/subs limit-status` 时更新。
 *
 * 数据来源分两类，且**必须在文案里区分**，否则会把「没观测到」误读成「没额度」：
 *   · 可直接查的（Codex 的 usage 接口）→ 现查现报，标 `live`；
 *   · 只能被动观测的（Anthropic 订阅：额度写在正常响应的响应头里）→ 用最近一次
 *     观测，标上观测时间；从没观测过就是 `unknown`，绝不编造数字。
 *
 * 纯函数 + 可注入的 now，全部分支都能单测，不碰网络、不碰凭据。
 */

import { formatResetIn } from "./reset-countdown.ts";

/** 一个订阅在某个窗口上的余量（已归一化，凭据无关）。 */
export interface SubWindow {
	/** 窗口名：`5h` / `7d` / 模型族名。 */
	name: string;
	remainingPercent?: number;
	/** UTC ISO 或 Unix 秒，交给 reset-countdown 统一解析。 */
	resetAt?: string | number;
}

/** 一个订阅的整体状态。 */
export interface SubStatus {
	/** 池成员名（provider slot，如 `anthropic-2`）——额度属于订阅，不属于模型。 */
	provider: string;
	/** 用户自己起的标签（multi-pass.json 的 subscriptions[].label，通常是邮箱）。 */
	label?: string;
	/** live = 刚查的；observed = 最近一次被动观测；unknown = 没有数据。 */
	source: "live" | "observed" | "unknown";
	/** observed 时的观测时刻（ms）；用于标注新鲜度。 */
	observedAt?: number;
	windows: SubWindow[];
	/** 该账号当前被判定为受限（限流/额度耗尽）。 */
	limited?: boolean;
	/** 查询失败的原因（credential-free，短句）。 */
	note?: string;
}

/** `61%` / `?`（没有数字时绝不写 0%）。 */
function leftOf(w: SubWindow): string {
	return w.remainingPercent === undefined || !Number.isFinite(w.remainingPercent)
		? "?"
		: `${Math.round(w.remainingPercent)}%`;
}

/** `7d 61% (in 4d 15h)`；没有重置时间就只报余量。 */
export function formatWindow(w: SubWindow, now = Date.now()): string {
	const relative = formatResetIn(w.resetAt, now);
	return relative ? `${w.name} ${leftOf(w)} (${relative})` : `${w.name} ${leftOf(w)}`;
}

/** 观测时间 → `2m ago` / `3h ago`；刚观测到的不啰嗦。 */
export function formatAge(observedAt: number | undefined, now = Date.now()): string | undefined {
	if (observedAt === undefined || !Number.isFinite(observedAt)) return undefined;
	const ms = now - observedAt;
	if (ms < 0) return undefined;
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** 一行 = 一个订阅。 */
export function formatSubLine(sub: SubStatus, now = Date.now()): string {
	const who = sub.label ? `${sub.provider} (${sub.label})` : sub.provider;
	if (sub.source === "unknown" || sub.windows.length === 0) {
		// 「还没观测到」与「没额度了」是两件完全不同的事，必须说清楚。
		return `${who}: ${sub.note ?? "no data yet"}`;
	}
	const windows = sub.windows.map((w) => formatWindow(w, now)).join(" · ");
	const age = sub.source === "observed" ? formatAge(sub.observedAt, now) : undefined;
	const tail = [sub.limited ? "limited" : "", age ? `observed ${age}` : ""].filter(Boolean).join(" · ");
	return `${who}: ${windows}${tail ? ` — ${tail}` : ""}`;
}

/**
 * 整块状态文案（状态框里多行显示）。排序：受限的排最后（它们最没用），
 * 其余按「最早重置」在前 —— 先用快过期的额度，与 quota-routing 的 weekly-first 同一取向。
 */
export function formatSubsStatus(subs: SubStatus[], now = Date.now()): string {
	if (subs.length === 0) return "subs: none configured";
	const rank = (s: SubStatus): number => {
		if (s.limited) return Number.POSITIVE_INFINITY;
		const times = s.windows
			.map((w) => (typeof w.resetAt === "number" ? w.resetAt * 1000 : w.resetAt ? Date.parse(w.resetAt) : Number.NaN))
			.filter((t) => Number.isFinite(t) && t > now);
		return times.length > 0 ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
	};
	const ordered = [...subs].sort((a, b) => rank(a) - rank(b));
	return [`subs (${subs.length}) · checked ${new Date(now).toISOString().slice(11, 16)}Z`]
		.concat(ordered.map((s) => `  ${formatSubLine(s, now)}`))
		.join("\n");
}

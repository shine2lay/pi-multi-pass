/** Passive subscription quota adapter. No auth changes, HTTP requests, prompts, or UI effects. */
import type { ModelLimitsReport } from "./current-model-limits.ts";
import { quotaBlocked, windowApplies, windowIsCurrent, type QuotaState, type QuotaWindow } from "./quota-state.ts";

const PREFIX = "anthropic-ratelimit-unified-";
const limited = (value?: string) => ["rejected", "rate_limited", "exceeded", "limited"].includes(value ?? "");
function number(value: string | undefined): number | undefined {
	if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
function claimName(value?: string): string | undefined {
	if (value === "five_hour") return "5h";
	if (value === "seven_day") return "7d";
	if (value?.startsWith("seven_day_") && /^[a-z0-9_]+$/.test(value)) return `7d_${value.slice(10)}`;
	return undefined;
}

export function parseAnthropicQuotaHeaders(
	headers: Record<string, string>, modelId: string, now = Date.now(),
): QuotaWindow[] {
	const values = new Map(Object.entries(headers).filter(([key, value]) => key.toLowerCase().startsWith(PREFIX)
		&& typeof value === "string" && value.length <= 256).map(([key, value]) => [key.toLowerCase().slice(PREFIX.length), value]));
	const names = new Set<string>();
	for (const key of values.keys()) {
		const match = key.match(/^(5h|7d(?:_[a-z0-9_]{1,64})?)-(utilization|reset|status)$/);
		if (match) names.add(match[1]);
	}
	const claim = claimName(values.get("representative-claim"));
	if (claim && limited(values.get("status"))) names.add(claim);
	const windows: QuotaWindow[] = [];
	for (const name of [...names].slice(0, 32)) {
		const utilization = number(values.get(`${name}-utilization`));
		const reset = number(values.get(`${name}-reset`) ?? (name === claim ? values.get("reset") : undefined));
		const status = values.get(`${name}-status`);
		const rejected = limited(status) || (name === claim && limited(values.get("status")));
		const knownStatus = rejected || status === "allowed" || status === "allowed_warning";
		const window: QuotaWindow = {
			name, scope: name === "5h" || name === "7d" ? "account" : "model",
			modelFamily: name.startsWith("7d_") ? name.slice(3) : undefined,
			usedPercent: utilization !== undefined && utilization <= 100 ? utilization * 100 : undefined,
			resetAt: reset !== undefined && reset > 0 && reset * 1000 <= now + 14 * 86400000 ? reset : undefined,
			limited: knownStatus ? rejected : undefined, observedAt: now,
		};
		if (window.usedPercent !== undefined || window.resetAt !== undefined || window.limited !== undefined) windows.push(window);
	}
	// An unrecognized claim must never block unrelated models or imply a made-up weekly quota.
	if (limited(values.get("status")) && !claim) {
		const reset = number(values.get("reset"));
		windows.push({ name: "request-limit", scope: "model", modelId, limited: true,
			resetAt: reset && reset * 1000 <= now + 14 * 86400000 ? reset : undefined, observedAt: now });
	}
	return windows;
}

export function anthropicModelLimits(
	state: QuotaState, provider: string, modelId: string, now = Date.now(),
): ModelLimitsReport {
	const applicable = state.windows.filter((w) => windowApplies(w, modelId));
	const observedAt = applicable.length ? Math.max(...applicable.map((w) => w.observedAt)) : now;
	const windows = applicable.map((w) => {
		const current = windowIsCurrent(w, now);
		return { name: w.name, scope: w.scope,
			usedPercent: current ? w.usedPercent : undefined,
			remainingPercent: current && w.usedPercent !== undefined ? Math.max(0, 100 - w.usedPercent) : undefined,
			resetAt: w.resetAt ? new Date(w.resetAt * 1000).toISOString() : undefined,
			observedAt: new Date(w.observedAt).toISOString() };
	});
	return {
		provider, model: modelId, status: windows.length ? "available" : "unavailable",
		scope: applicable.some((w) => w.scope === "model") ? "account-and-model" : "account",
		source: "Anthropic OAuth response headers", checkedAt: new Date(observedAt).toISOString(), cached: true,
		stale: applicable.some((w) => !windowIsCurrent(w, now) || now - w.observedAt > 5 * 60000),
		limited: quotaBlocked(state, modelId, now), windows,
		note: windows.length
			? "Last observed subscription quota, not a live query. Shared account windows and applicable model windows only. Past-reset percentages are unknown until another response; no probe request is sent."
			: "No Anthropic OAuth quota headers observed for this account yet. Send a normal message; this check never sends a probe or queries an undocumented endpoint.",
	};
}

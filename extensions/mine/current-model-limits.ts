import type { ResetUsage } from "./reset-first.ts";
import { formatResetPhrase } from "./reset-countdown.ts";

export interface LimitWindow {
	name: string;
	remainingPercent?: number;
	usedPercent?: number;
	resetAt?: string; // UTC ISO timestamp
	scope?: "account" | "model";
	observedAt?: string;
}

export interface ModelLimitsData {
	status: "available" | "unsupported" | "unavailable";
	scope: "account" | "account-and-model" | "provider-model-buckets" | "unknown";
	source?: string;
	limited?: boolean;
	windows: LimitWindow[];
	note?: string;
	omittedWindows?: number;
	stale?: boolean;
}

export interface ModelLimitsReport extends ModelLimitsData {
	provider: string | null;
	model: string | null;
	checkedAt: string;
	cached: boolean;
}

function resetISO(seconds?: number): string | undefined {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
	const date = new Date(seconds * 1000);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function codexModelLimits(usage: ResetUsage): ModelLimitsData {
	const windows: LimitWindow[] = [];
	for (const [name, value] of [["5h", usage.fiveHour], ["7d", usage.weekly]] as const) {
		if (!value) continue;
		windows.push({ name, usedPercent: value.usedPercent,
			remainingPercent: Math.max(0, 100 - value.usedPercent), resetAt: resetISO(value.resetAt) });
	}
	return {
		status: windows.length ? "available" : "unavailable", scope: "account", source: "Codex /wham/usage",
		limited: usage.limited, windows,
		note: "Account-wide subscription quota, not a separate allowance for this model."
			+ (usage.incomplete ? " Some returned quota windows could not be read." : "")
			+ (!usage.fiveHour ? " No 5-hour window was reported." : ""),
	};
}

export function googleModelLimits(snapshot: {
	models: { model: string; remainingPercent?: number; resetAt?: number }[];
}): ModelLimitsData {
	const windows = snapshot.models.filter((m) => m.remainingPercent !== undefined && Number.isFinite(m.remainingPercent))
		.map((m) => ({ name: m.model, remainingPercent: m.remainingPercent,
			usedPercent: 100 - m.remainingPercent!, resetAt: resetISO(m.resetAt) }));
	return {
		status: windows.length ? "available" : "unavailable", scope: "provider-model-buckets", source: "Google quota API",
		windows: windows.slice(0, 50), omittedWindows: Math.max(0, windows.length - 50),
		note: "Provider-reported quota buckets; bucket names may not exactly match the selected model.",
	};
}

export function unavailableLimits(note: string, unsupported = false): ModelLimitsData {
	return { status: unsupported ? "unsupported" : "unavailable", scope: "unknown", windows: [], note };
}

/** Compact, explicitly scoped footer. Full UTC times and observation time are available through the tool.
 *  `now` is injectable so the reset countdown is testable without touching the clock. */
export function formatModelLimits(report: ModelLimitsReport, now = Date.now()): string {
	// The quota belongs to the SUBSCRIPTION, not to whatever model is selected right now, so the
	// footer is labeled with the provider slot ("anthropic-3", "codex"). The only model-specific
	// thing here is a per-model-family window, which names the model on that window alone (below).
	const label = report.provider ?? report.model ?? "no provider";
	if (report.status !== "available") return `${label}: limits unavailable`;
	if (report.scope === "provider-model-buckets") {
		return `${label}: ${report.windows.length + (report.omittedWindows ?? 0)} quota buckets (use current_model_limits)`;
	}
	const windows = report.windows.map((w) => {
		const left = w.remainingPercent === undefined ? "?" : `${Math.round(w.remainingPercent)}%`;
		// Relative first ("resets in 4d 15h"), absolute UTC kept right next to it.
		const when = w.resetAt ? `${w.resetAt.slice(5, 10)} ${w.resetAt.slice(11, 16)}Z` : undefined;
		// A model-scoped window (e.g. an Opus-only cap) is the one place a model id is meaningful.
		const name = w.scope === "model" && report.model ? `${report.model} ${w.name}` : w.name;
		return `${name} ${left} left, ${formatResetPhrase(w.resetAt, when, now)}`;
	});
	const scope = report.scope === "account-and-model" ? "account + model" : "account";
	const observation = report.source === "Anthropic OAuth response headers" ? " | observed" : "";
	return `${label} (${scope}): ${windows.join(" | ")}${report.limited ? " | limited" : ""}${observation}${report.stale ? " (stale)" : ""}`;
}

/** Per-session, credential-free snapshots. No polling timers or automatic model requests. */
export class CurrentModelLimits {
	private cache = new Map<string, { data: ModelLimitsData; checkedAt: number }>();
	private pending = new Set<AbortController>();
	private ttlMs: number;
	private timeoutMs: number;

	constructor(ttlMs = 60000, timeoutMs = 5000) { this.ttlMs = ttlMs; this.timeoutMs = timeoutMs; }

	remember(provider: string, data: ModelLimitsData): void {
		this.cache.set(provider, { data, checkedAt: Date.now() });
	}

	cancel(): void {
		for (const controller of this.pending) controller.abort();
		this.pending.clear();
	}

	async get(
		model: { provider: string; id: string } | undefined,
		check: (provider: string, signal: AbortSignal) => Promise<ModelLimitsData>,
		options: { refresh?: boolean; signal?: AbortSignal } = {},
	): Promise<ModelLimitsReport> {
		const report = (data: ModelLimitsData, checkedAt: number, cached: boolean): ModelLimitsReport => ({
			...data, provider: model?.provider ?? null, model: model?.id ?? null,
			checkedAt: new Date(checkedAt).toISOString(), cached,
		});
		if (!model) return report(unavailableLimits("No model is selected."), Date.now(), false);
		if (options.signal?.aborted) return report(unavailableLimits("Quota check cancelled."), Date.now(), false);
		const cached = this.cache.get(model.provider);
		if (!options.refresh && cached && Date.now() - cached.checkedAt < this.ttlMs) {
			return report(cached.data, cached.checkedAt, true);
		}

		const controller = new AbortController();
		this.pending.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop = () => {};
		let timedOut = false;
		const stopped = new Promise<ModelLimitsData>((resolve) => {
			stop = () => resolve(unavailableLimits(timedOut ? "Quota check timed out." : "Quota check cancelled."));
			controller.signal.addEventListener("abort", stop, { once: true });
			timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
		});
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const data = await Promise.race([
				check(model.provider, controller.signal).catch(() => unavailableLimits("Unable to fetch subscription quota; check authentication or retry later.")),
				stopped,
			]);
			// The checker may ignore cancellation; late results must never repopulate the cache.
			if (!controller.signal.aborted) this.remember(model.provider, data);
			return report(data, Date.now(), false);
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", stop);
			options.signal?.removeEventListener("abort", abort);
			this.pending.delete(controller);
			controller.abort();
		}
	}
}

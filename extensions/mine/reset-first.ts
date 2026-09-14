/** Reset-aware account selection. Pure quota data only; credentials stay in the host checker. */
export interface ResetFirstConfig {
	models: string[];
	window?: "weekly" | "five-hour" | "next";
	onSelect?: boolean;
}

interface UsageWindow {
	usedPercent: number;
	resetAt?: number; // Unix seconds, not milliseconds
}

export interface ResetUsage {
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	limited: boolean;
	/** A returned window was malformed/unrecognized; an absent window is not an error. */
	incomplete?: boolean;
}

interface Pool {
	name: string;
	baseProvider: string;
	members: string[];
	enabled: boolean;
	resetFirst?: ResetFirstConfig;
}

interface Target { provider: string; id: string }
interface Candidate {
	poolName: string;
	provider: string;
	modelId: string;
	source: string;
	chainName?: string;
	chainIndex?: number;
}

export interface ResetFirstHost {
	pools(): Pool[]; // effective/project-filtered pools, never the unfiltered global config
	eligible(pool: Pool, provider: string, modelId: string): boolean;
	check(provider: string, signal: AbortSignal): Promise<ResetUsage | undefined>;
	report(message: string, warning?: boolean, traceOnly?: boolean): void;
	signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

/** Strict parsing: missing/malformed percentages must not become "0% used". */
export function parseResetUsage(data: unknown): ResetUsage {
	const rate = record(record(data)?.rate_limit);
	const result: ResetUsage = { limited: rate?.allowed === false || rate?.limit_reached === true };
	for (const value of [rate?.primary_window, rate?.secondary_window]) {
		if (value === undefined || value === null) continue; // e.g. weekly-only subscriptions
		const raw = record(value);
		if (!raw || typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent)
			|| raw.used_percent < 0 || typeof raw.limit_window_seconds !== "number") {
			result.incomplete = true;
			continue;
		}
		if (raw.used_percent >= 100) result.limited = true;
		if (!Number.isFinite(raw.limit_window_seconds)
			|| (Math.abs(raw.limit_window_seconds - 18000) > 120 && Math.abs(raw.limit_window_seconds - 604800) > 120)) {
			result.incomplete = true;
			continue;
		}
		const window: UsageWindow = {
			usedPercent: raw.used_percent,
			resetAt: typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) && raw.reset_at > 0
				? raw.reset_at : undefined,
		};
		if (Math.abs(raw.limit_window_seconds - 18000) <= 120) result.fiveHour = window;
		if (Math.abs(raw.limit_window_seconds - 604800) <= 120) result.weekly = window;
	}
	return result;
}

export function usesResetFirst(pool: Pool | undefined, modelId: string): pool is Pool {
	const config = pool?.resetFirst;
	return Boolean(pool?.enabled && pool.baseProvider === "openai-codex"
		&& config && Array.isArray(config.models) && config.models.includes(modelId)
		&& (config.window === undefined || ["weekly", "five-hour", "next"].includes(config.window)));
}

function exhausted(usage?: ResetUsage): boolean {
	return Boolean(usage?.limited || (usage?.fiveHour?.usedPercent ?? 0) >= 100
		|| (usage?.weekly?.usedPercent ?? 0) >= 100);
}

function complete(usage?: ResetUsage): boolean {
	return Boolean(usage && !usage.incomplete && (usage.fiveHour || usage.weekly));
}

function reset(window: UsageWindow | undefined, now: number): number {
	// Past resets in a stale API response are unknown, not a reason to prefer an account.
	return window?.resetAt !== undefined && window.resetAt > now / 1000 ? window.resetAt : Infinity;
}

/** Known usable accounts first, then earliest reset, then headroom. Unknowns retain input order. */
export function rankResetAccounts(
	providers: string[],
	usage: Map<string, ResetUsage | undefined>,
	config: ResetFirstConfig,
	now = Date.now(),
): string[] {
	return providers.filter((provider) => !exhausted(usage.get(provider))).sort((a, b) => {
		const left = usage.get(a);
		const right = usage.get(b);
		if (complete(left) !== complete(right)) return complete(left) ? -1 : 1;
		if (!complete(left) || !complete(right)) return 0;
		const times = (value: ResetUsage): number[] => {
			const weekly = reset(value.weekly, now), fiveHour = reset(value.fiveHour, now);
			return config.window === "five-hour" ? [fiveHour, weekly]
				: config.window === "next" ? [Math.min(weekly, fiveHour), weekly, fiveHour]
					: [weekly, fiveHour];
		};
		const lt = times(left!), rt = times(right!);
		for (let i = 0; i < lt.length; i++) {
			if (lt[i] !== rt[i]) return lt[i] < rt[i] ? -1 : 1;
		}
		const used = (value: ResetUsage) => Math.max(value.weekly?.usedPercent ?? 0, value.fiveHour?.usedPercent ?? 0);
		return used(left!) - used(right!);
	});
}

function windowSummary(label: string, window?: UsageWindow): string {
	if (!window) return `${label} not reported`;
	const remaining = Math.max(0, 100 - window.usedPercent);
	const date = window.resetAt === undefined ? undefined : new Date(window.resetAt * 1000);
	const when = date && Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
	return `${label} ${Math.round(remaining)}% left, resets ${when}`;
}

/** Each checker has a deadline, including credential refresh. Abort-safe even if a checker ignores its signal. */
async function boundedCheck(
	check: ResetFirstHost["check"], provider: string, timeoutMs: number, signal?: AbortSignal,
): Promise<ResetUsage | undefined> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finish: () => void = () => {};
	const stopped = new Promise<undefined>((resolve) => {
		finish = () => { controller.abort(); resolve(undefined); };
		timer = setTimeout(finish, timeoutMs);
	});
	signal?.addEventListener("abort", finish, { once: true });
	try {
		if (signal?.aborted) return undefined;
		return await Promise.race([check(provider, controller.signal).catch(() => undefined), stopped]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", finish);
		controller.abort();
	}
}

/** One instance per PoolManager/session; never share selection state between web-ui conversations. */
export class ResetFirstRouter {
	private managedTarget?: { key: string };
	private selection?: AbortController;
	private generation = 0;
	private timeoutMs: number;

	constructor(timeoutMs = 5000) { this.timeoutMs = timeoutMs; }

	cancel(): void {
		this.generation++;
		this.selection?.abort();
		this.selection = undefined;
	}

	isManagedSelection(model: Target | undefined): boolean {
		return Boolean(model && this.managedTarget?.key === JSON.stringify([model.provider, model.id]));
	}

	/** Suppress only our own nested model_select event, not another manual selection. */
	async switchModel<T>(model: Target, action: () => Promise<T>): Promise<T> {
		this.cancel();
		const token = { key: JSON.stringify([model.provider, model.id]) };
		this.managedTarget = token;
		try { return await action(); }
		finally { if (this.managedTarget === token) this.managedTarget = undefined; }
	}

	private async rank(pool: Pool, modelId: string, providers: string[], host: ResetFirstHost): Promise<string[]> {
		const eligible = [...new Set(providers)].filter((provider) => pool.members.includes(provider)
			&& host.eligible(pool, provider, modelId));
		if (eligible.length === 0) return [];
		const results = await Promise.all(eligible.map(async (provider) => [
			provider, await boundedCheck(host.check, provider, this.timeoutMs, host.signal),
		] as const));
		if (host.signal?.aborted) return [];
		const usage = new Map(results);
		const ranked = rankResetAccounts(eligible, usage, pool.resetFirst!);
		for (const [provider, value] of results) {
			host.report(`[pool:${pool.name}] reset-first checked ${provider}: ${windowSummary("7d", value?.weekly)}; ${windowSummary("5h", value?.fiveHour)}${exhausted(value) ? "; exhausted, skipped" : ""}`, false, true);
		}
		if (ranked[0]) {
			const value = usage.get(ranked[0]);
			host.report(`[pool:${pool.name}] reset-first prefers ${ranked[0]} (${modelId}); ${pool.resetFirst?.window ?? "weekly"} reset first; ${windowSummary("7d", value?.weekly)}; ${windowSummary("5h", value?.fiveHour)}${complete(value) ? "" : "; quota unavailable, using eligible fallback order"}`, !complete(value));
		} else {
			host.report(`[pool:${pool.name}] reset-first: no account with reported quota remaining`, true);
		}
		return ranked;
	}

	/** Rank only the next route group. Never move Astra ahead of Opus or mix chain steps. */
	async reorder<C extends Candidate>(candidates: C[], host: ResetFirstHost): Promise<C[]> {
		let pending = candidates.slice();
		while (pending.length) {
			const first = pending[0];
			const pool = host.pools().find((p) => p.name === first.poolName);
			if (!usesResetFirst(pool, first.modelId)) return pending;
			const groupKey = (c: Candidate) => JSON.stringify([c.poolName, c.modelId, c.source, c.chainName, c.chainIndex]);
			let end = 1;
			while (end < pending.length && groupKey(pending[end]) === groupKey(first)) end++;
			const group = pending.slice(0, end);
			const ranked = await this.rank(pool, first.modelId, group.map((c) => c.provider), host);
			if (host.signal?.aborted) return [];
			const rest = pending.slice(end);
			if (ranked.length) return [...ranked.map((provider) => group.find((c) => c.provider === provider)!), ...rest];
			pending = rest;
		}
		return pending;
	}

	/** Manual selection / startup: choose within the selected model's effective pool. */
	async select(
		model: Target | undefined,
		host: ResetFirstHost,
		current: () => Target | undefined,
		setModel: (provider: string, modelId: string) => Promise<boolean>,
	): Promise<void> {
		if (this.isManagedSelection(model)) return;
		this.cancel();
		const generation = this.generation;
		const pool = host.pools().findLast((p) => p.enabled && model && p.members.includes(model.provider));
		if (!model || !usesResetFirst(pool, model.id) || pool.resetFirst?.onSelect !== true) return;
		const controller = new AbortController();
		this.selection = controller;
		const signal = host.signal ? AbortSignal.any([host.signal, controller.signal]) : controller.signal;
		const ranked = await this.rank(pool, model.id, pool.members, { ...host, signal });
		if (signal.aborted || generation !== this.generation
			|| current()?.provider !== model.provider || current()?.id !== model.id) return;
		// Re-read restrictions after network I/O; a preference never overrides access restrictions.
		const freshPool = host.pools().find((p) => p.name === pool.name);
		if (!usesResetFirst(freshPool, model.id) || freshPool.resetFirst?.onSelect !== true) return;
		for (const provider of ranked) {
			if (current()?.provider !== model.provider || current()?.id !== model.id) return;
			if (!freshPool.members.includes(provider) || !host.eligible(freshPool, provider, model.id)) continue;
			if (provider === model.provider) return;
			const success = await this.switchModel({ provider, id: model.id }, () => setModel(provider, model.id));
			if (success) return;
		}
	}
}

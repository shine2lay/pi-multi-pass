/** Routing coordinator: one owner of decisions, with host-owned auth, checks and model changes. */
import { accountPolicies, usesQuotaRouting, type QuotaPool } from "./account-policy.ts";
import { failureObservation, quotaBlocked, type QuotaStateStore, type QuotaState, type QuotaWindow } from "./quota-state.ts";

export interface QuotaTarget { provider: string; id: string }
export interface QuotaCandidate {
	poolName: string; provider: string; modelId: string; source: string;
	chainName?: string; chainIndex?: number;
}
export interface QuotaRoutingHost {
	pools(): QuotaPool[];
	accountKey(provider: string): string | undefined;
	eligible(pool: QuotaPool, provider: string, modelId: string): boolean;
	/** Metadata checks only, bounded by host. Passive providers do nothing here. */
	check(provider: string, signal?: AbortSignal): Promise<void>;
	current(): QuotaTarget | undefined;
	setModel(provider: string, modelId: string): Promise<boolean>;
	report(message: string): void;
	signal?: AbortSignal;
}

export class QuotaRouter {
	private store: QuotaStateStore;
	private clock: () => number;
	private generation = 0;
	private manualAfter = 0;
	private consumed = new Set<string>();
	constructor(store: QuotaStateStore, clock = () => Date.now()) { this.store = store; this.clock = clock; }

	cancel(): void { this.generation++; }
	manualSelection(): void { this.cancel(); this.manualAfter = this.clock(); this.consumed.clear(); }
	state(key: string | undefined): QuotaState { return this.store.get(key); }
	observe(key: string | undefined, windows: QuotaWindow[], successfulModel?: string): void {
		const succeededAt = this.clock();
		const state = windows.length ? this.store.update(key, { windows }) : this.store.get(key);
		const failure = successfulModel && state.failures.find((f) => f.modelId === successfulModel);
		// Success is independent of quota-header availability. Only clear failures predating
		// that response; merge is ordered by failure identity, so a concurrent F2 survives.
		if (failure && failure.failedAt < succeededAt) this.store.update(key, {
			failures: [{ ...failure, retryAt: failure.failedAt, succeededAt, observedAt: succeededAt }],
		});
	}
	failed(key: string | undefined, modelId: string): void {
		this.store.update(key, { failures: [failureObservation(this.store.get(key), modelId, this.clock())] });
	}
	blocked(key: string | undefined, modelId: string): boolean { return quotaBlocked(this.store.get(key), modelId, this.clock()); }

	/** One route group at a time: account policies must never reorder model/chain preference. */
	async reorder<C extends QuotaCandidate>(
		candidates: C[], host: QuotaRoutingHost, legacy: (group: C[]) => Promise<C[]>,
	): Promise<C[]> {
		let pending = candidates.slice();
		while (pending.length && !host.signal?.aborted) {
			const first = pending[0], pool = host.pools().find((p) => p.name === first.poolName);
			const key = (c: C) => JSON.stringify([c.poolName, c.modelId, c.source, c.chainName, c.chainIndex]);
			let end = 1;
			while (end < pending.length && key(pending[end]) === key(first)) end++;
			const group = pending.slice(0, end), rest = pending.slice(end);
			if (!usesQuotaRouting(pool, first.modelId)) {
				const ranked = await legacy(group);
				if (ranked.length) return [...ranked, ...rest];
			} else {
				const eligible = group.filter((c) => pool.members.includes(c.provider) && host.eligible(pool, c.provider, c.modelId));
				await Promise.all([...new Set(eligible.map((c) => c.provider))].map((p) => host.check(p, host.signal).catch(() => {})));
				if (host.signal?.aborted) return [];
				const freshPool = host.pools().find((p) => p.name === pool.name);
				if (!usesQuotaRouting(freshPool, first.modelId)) return [];
				const available = eligible.filter((c) => freshPool.members.includes(c.provider) && host.eligible(freshPool, c.provider, c.modelId));
				const ranked = accountPolicies[freshPool.quotaRouting.policy].rank(available.map((c) => ({ provider: c.provider,
					state: this.state(host.accountKey(c.provider)) })), first.modelId, freshPool.quotaRouting, this.clock());
				if (ranked.length) {
					host.report(`[pool:${pool.name}] ${freshPool.quotaRouting.policy} selected ${ranked[0].provider}; usable weekly reset first, then five-hour reset/headroom; unknown quota retains eligible order`);
					return [...ranked.map((a) => available.find((c) => c.provider === a.provider)!), ...rest];
				}
			}
			pending = rest;
		}
		return [];
	}

	/** Only called at an idle, new-user-input boundary. Never on every response or a timer. */
	async recover(host: QuotaRoutingHost): Promise<void> {
		const current = host.current(), generation = this.generation;
		const pool = host.pools().findLast((p) => p.enabled && current && p.members.includes(current.provider));
		if (!current || !usesQuotaRouting(pool, current.id) || pool.quotaRouting.recovery === "off") return;
		const now = this.clock();
		const due = pool.members.filter((p) => p !== current.provider && host.eligible(pool, p, current.id)).flatMap((provider) => {
			const accountKey = host.accountKey(provider), state = this.state(accountKey);
			const failure = state.failures.find((f) => f.modelId === current.id && f.failedAt > this.manualAfter && f.retryAt <= now);
			const token = failure ? JSON.stringify([accountKey, current.id, failure.failedAt]) : "";
			return failure && !this.consumed.has(token) ? [{ provider, token }] : [];
		});
		if (!due.length) return; // Healthy messages do not trigger account quota scans.
		await Promise.all([...due.map((d) => d.provider), current.provider].map((p) => host.check(p, host.signal).catch(() => {})));
		const unchanged = () => !host.signal?.aborted && generation === this.generation
			&& host.current()?.provider === current.provider && host.current()?.id === current.id;
		if (!unchanged()) return;
		const freshPool = host.pools().find((p) => p.name === pool.name);
		if (!usesQuotaRouting(freshPool, current.id) || freshPool.quotaRouting.recovery === "off") return;
		const policy = accountPolicies[freshPool.quotaRouting.policy];
		const active = { provider: current.provider, state: this.state(host.accountKey(current.provider)) };
		const ranked = policy.rank(due.filter((d) => freshPool.members.includes(d.provider) && host.eligible(freshPool, d.provider, current.id))
			.map((d) => ({ provider: d.provider, state: this.state(host.accountKey(d.provider)) })), current.id, freshPool.quotaRouting, this.clock());
		for (const candidate of ranked) {
			if (!policy.preferRecovery(candidate, active, current.id, freshPool.quotaRouting, this.clock())) continue;
			if (!unchanged()) return;
			const token = due.find((d) => d.provider === candidate.provider)!.token;
			this.consumed.add(token);
			let switched = false;
			try { switched = await host.setModel(candidate.provider, current.id); } catch { /* auth may disappear */ }
			if (switched) {
				host.report(`[pool:${pool.name}] recovery check chose ${candidate.provider}: its usable weekly allowance resets earlier; reset eligibility is confirmed by the next real response`);
				return;
			}
		}
	}
}

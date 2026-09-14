/** Pure account policies. Model/chain preference is deliberately outside this module. */
import { quotaBlocked, windowIsCurrent, type QuotaState } from "./quota-state.ts";

export interface QuotaRoutingConfig {
	policy: "weekly-first";
	/** Omit to apply to every model in this pool. */
	models?: string[];
	recovery?: "earlier-weekly-reset" | "off";
	/** Strictly earlier even when zero (default). No periodic rotation timer. */
	minWeeklyResetAdvantageMinutes?: number;
	/** Ranking freshness, not exhaustion expiry; explicit blocks retain their reset deadline. */
	maxObservationAgeMinutes?: number;
}
export interface QuotaPool {
	name: string;
	baseProvider: string;
	members: string[];
	enabled: boolean;
	quotaRouting?: QuotaRoutingConfig;
}
export interface AccountCandidate { provider: string; state: QuotaState }
export interface AccountPolicy {
	rank(accounts: AccountCandidate[], modelId: string, config: QuotaRoutingConfig, now: number): AccountCandidate[];
	preferRecovery(candidate: AccountCandidate, current: AccountCandidate, modelId: string, config: QuotaRoutingConfig, now: number): boolean;
}

function window(account: AccountCandidate, name: string, config: QuotaRoutingConfig, now: number) {
	return account.state.windows.find((w) => w.name === name && w.scope === "account"
		&& windowIsCurrent(w, now, (config.maxObservationAgeMinutes ?? 1440) * 60000)
		&& w.usedPercent !== undefined);
}
const reset = (w: ReturnType<typeof window>, now: number) => w?.resetAt && w.resetAt * 1000 > now ? w.resetAt : Infinity;

const weeklyFirst: AccountPolicy = {
	rank(accounts, modelId, config, now) {
		return accounts.filter((a) => !quotaBlocked(a.state, modelId, now)).slice().sort((a, b) => {
			const aw = window(a, "7d", config, now), bw = window(b, "7d", config, now);
			const ah = window(a, "5h", config, now), bh = window(b, "5h", config, now);
			if (Boolean(aw || ah) !== Boolean(bw || bh)) return aw || ah ? -1 : 1;
			for (const [left, right] of [[reset(aw, now), reset(bw, now)], [reset(ah, now), reset(bh, now)]]) {
				if (left !== right) return left < right ? -1 : 1;
			}
			// Comparable windows only. Unknown percentages aren't zero usage / unlimited quota.
			if (ah && bh && ah.usedPercent !== bh.usedPercent) return ah.usedPercent! - bh.usedPercent!;
			if (aw && bw && aw.usedPercent !== bw.usedPercent) return aw.usedPercent! - bw.usedPercent!;
			return 0;
		});
	},
	preferRecovery(candidate, current, modelId, config, now) {
		if (config.recovery === "off" || quotaBlocked(candidate.state, modelId, now)) return false;
		const candidateWeekly = window(candidate, "7d", config, now);
		const currentWeekly = window(current, "7d", config, now);
		if (!candidateWeekly || !currentWeekly || candidateWeekly.usedPercent! >= 100) return false;
		const next = reset(candidateWeekly, now), active = reset(currentWeekly, now);
		return Number.isFinite(next) && Number.isFinite(active) && next < active
			&& (active - next) * 1000 >= (config.minWeeklyResetAdvantageMinutes ?? 0) * 60000;
	},
};

/** Small typed registry: adding a policy doesn't add another model-switching event handler. */
export const accountPolicies: Readonly<Record<string, AccountPolicy>> = Object.freeze({ "weekly-first": weeklyFirst });

export function usesQuotaRouting(pool: QuotaPool | undefined, modelId: string): pool is QuotaPool & { quotaRouting: QuotaRoutingConfig } {
	const c = pool?.quotaRouting;
	return Boolean(pool?.enabled && c && Object.hasOwn(accountPolicies, c.policy)
		&& (c.models === undefined || Array.isArray(c.models) && c.models.every((m) => typeof m === "string") && c.models.includes(modelId))
		&& (c.recovery === undefined || ["earlier-weekly-reset", "off"].includes(c.recovery))
		&& [c.minWeeklyResetAdvantageMinutes, c.maxObservationAgeMinutes].every((v) => v === undefined
			|| typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 14 * 24 * 60));
}

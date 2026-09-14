/**
 * model-fallback — model-scoped exhaustion for chain failover.
 *
 * Upstream tracks rate-limit exhaustion per *provider* (account). That is right
 * when a limit is account-wide, but some limits are per *model* — e.g. Anthropic
 * subscriptions meter Claude Fable separately from Opus. With provider-scoped
 * exhaustion a chain like
 *
 *     claude/claude-fable-5-1 -> claude/claude-opus-5 -> codex/gpt-6-astra
 *
 * skips the Opus step: the first failure marks `anthropic` exhausted and the
 * cascade's `attemptedProviders` already contains it, so the plan jumps
 * straight to Codex.
 *
 * This module records exhaustion per (pool, provider, model) and only escalates
 * to upstream's provider-wide exhaustion when the account has no untried
 * sibling model left in any enabled chain. It is deliberately optimistic: when a
 * limit really is account-wide, the sibling model fails fast once and the
 * provider is then escalated, so the cascade still reaches the next pool within
 * the same turn.
 *
 * Configs without same-pool chain entries behave exactly as upstream (there are
 * no siblings, so every failure escalates immediately).
 *
 * Hooks in ../multi-sub.ts (see PATCHES.md → model-fallback):
 *   PoolManager.handleError()        recordModelExhaustion() gates markExhausted()
 *   PoolManager.buildFailoverPlan()  findApplicableChainForModel(), wasTargetAttempted(),
 *                                    isModelExhausted() in both candidate loops
 */

export interface ChainEntryLike {
	pool: string;
	model: string;
	enabled: boolean;
}

export interface ChainLike {
	name: string;
	enabled: boolean;
	entries: ChainEntryLike[];
}

/** Mirrors upstream PoolState.cooldownMs (5 minutes). */
export const MODEL_EXHAUSTION_COOLDOWN_MS = 5 * 60 * 1000;

/** (pool, provider, model) -> exhaustedAt (ms). Module-level: one PoolManager per process. */
const exhaustedTargets = new Map<string, number>();

function targetKey(poolName: string, provider: string, modelId: string): string {
	return `${poolName}\u0000${provider}\u0000${modelId}`;
}

/** True while (provider, model) in this pool is inside its exhaustion cooldown. Expired entries are dropped. */
export function isModelExhausted(
	poolName: string,
	provider: string,
	modelId: string,
	now: number = Date.now(),
	cooldownMs: number = MODEL_EXHAUSTION_COOLDOWN_MS,
): boolean {
	const key = targetKey(poolName, provider, modelId);
	const exhaustedAt = exhaustedTargets.get(key);
	if (exhaustedAt === undefined) return false;
	if (now - exhaustedAt >= cooldownMs) {
		exhaustedTargets.delete(key);
		return false;
	}
	return true;
}

/**
 * Other models configured for the same pool across enabled chains/entries —
 * the alternatives an account can still try when one of its models is limited.
 */
export function getSiblingModels(poolName: string, modelId: string, chains: ChainLike[]): string[] {
	const siblings: string[] = [];
	for (const chain of chains) {
		if (!chain.enabled) continue;
		for (const entry of chain.entries) {
			if (!entry.enabled || entry.pool !== poolName || entry.model === modelId) continue;
			if (!siblings.includes(entry.model)) siblings.push(entry.model);
		}
	}
	return siblings;
}

export interface ModelExhaustionResult {
	/** Caller should mark the whole provider exhausted (upstream behavior). */
	escalate: boolean;
	siblings: string[];
	untried: string[];
	/** One-line explanation suitable for the routing trace. */
	detail: string;
}

/**
 * Record a rate-limit failure for (pool, provider, model) and decide whether
 * the provider as a whole should be marked exhausted.
 */
export function recordModelExhaustion(input: {
	poolName: string;
	provider: string;
	modelId: string;
	chains: ChainLike[];
	now?: number;
	cooldownMs?: number;
}): ModelExhaustionResult {
	const now = input.now ?? Date.now();
	const cooldownMs = input.cooldownMs ?? MODEL_EXHAUSTION_COOLDOWN_MS;
	exhaustedTargets.set(targetKey(input.poolName, input.provider, input.modelId), now);

	const siblings = getSiblingModels(input.poolName, input.modelId, input.chains);
	const untried = siblings.filter(
		(model) => !isModelExhausted(input.poolName, input.provider, model, now, cooldownMs),
	);
	const escalate = untried.length === 0;

	const target = `${input.provider} (${input.modelId})`;
	let detail: string;
	if (siblings.length === 0) {
		detail = `${target} exhausted; no sibling model configured for pool ${input.poolName}; marking provider exhausted`;
	} else if (escalate) {
		detail = `${target} exhausted; all sibling models already exhausted (${siblings.join(", ")}); marking provider exhausted`;
	} else {
		detail = `${target} exhausted (model-scoped); untried sibling model(s) on ${input.provider}: ${untried.join(", ")}`;
	}
	return { escalate, siblings, untried, detail };
}

/**
 * Model-aware replacement for `attemptedProviders.has(member)`.
 *
 * A provider that was attempted this turn may still serve a *different* model.
 * Every attempted (provider, model) target is model-exhausted by the time a plan
 * is built (failures are recorded before planning), so "attempted" for a given
 * model is: provider attempted AND that model exhausted on it.
 */
export function wasTargetAttempted(
	attemptedProviders: Set<string>,
	poolName: string,
	provider: string,
	modelId: string,
	now: number = Date.now(),
): boolean {
	return attemptedProviders.has(provider) && isModelExhausted(poolName, provider, modelId, now);
}

/**
 * Locate the chain entry the current (pool, model) is running from.
 *
 * Upstream matches on pool only, so with several entries for one pool the
 * cascade always resumes after the *first* one. Prefer the exact (pool, model)
 * entry; fall back to upstream's first-pool-match within the same chain.
 */
export function findApplicableChainForModel<C extends ChainLike>(
	enabledChains: C[],
	poolName: string,
	modelId: string,
): { chain: C; index: number } | undefined {
	for (const chain of enabledChains) {
		const exact = chain.entries.findIndex((entry) => entry.pool === poolName && entry.model === modelId);
		if (exact >= 0) return { chain, index: exact };
		const byPool = chain.entries.findIndex((entry) => entry.pool === poolName);
		if (byPool >= 0) return { chain, index: byPool };
	}
	return undefined;
}

/** Test/diagnostics helper: forget all model-scoped exhaustion. */
export function clearModelExhaustion(): void {
	exhaustedTargets.clear();
}

/** Test/diagnostics helper: currently exhausted targets as "pool/provider/model". */
export function listExhaustedTargets(now: number = Date.now(), cooldownMs: number = MODEL_EXHAUSTION_COOLDOWN_MS): string[] {
	const out: string[] = [];
	for (const [key, exhaustedAt] of exhaustedTargets) {
		if (now - exhaustedAt >= cooldownMs) {
			exhaustedTargets.delete(key);
			continue;
		}
		out.push(key.split("\u0000").join("/"));
	}
	return out;
}

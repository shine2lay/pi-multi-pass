/** mine/fallback-return: a chat may go back up to the primary pool at a send or on refusal.
 *
 * The rotation only ever moves down a chain (claude-real -> codex-fallback). Nothing moved a chat
 * back up, and the fallback pool has one member, so on 2026-10-10/11 five chats sat on openai-codex
 * failing with "Codex error: The usage limit has been reached" while a Claude account had room.
 *
 * Pool roles come from config, not provider names: a pool is a fallback when it carries
 * "fallback": true, or when it is the last pool of an enabled chain that starts on another pool.
 * The primary is that chain's first entry (its pool and its model). returnOnRefusal, when set,
 * overrides that role only on a refusal; fallback:false + returnOnRefusal:true never moves at a send.
 *
 * This module only decides; multi-sub.ts ranks (the primary pool's own quota routing) and switches.
 * At most one step up per turn (ReturnGuard); a primary member that refused in this turn is already
 * marked exhausted by the normal rotation, so it is not offered again (no ping-pong).
 * No pi imports, so plain node can test it.
 */
import { MAX_CONTINUES_PER_PROMPT, type ContinueBoundary, type ContinueMessage, type ContinueModel,
	type ContinueResult } from "./signin-failover.ts";

export interface ReturnPool { name: string; members: string[]; enabled: boolean; fallback?: boolean; returnOnRefusal?: boolean }
export interface ReturnChainEntry { pool: string; model: string; enabled?: boolean }
export interface ReturnChain { name: string; enabled: boolean; entries: ReturnChainEntry[] }
export interface ReturnConfig { pools: ReturnPool[]; chains: ReturnChain[] }
export interface ReturnTarget { poolName: string; modelId: string; chainName: string; chainIndex: number }
export interface ReturnCandidate {
	poolName: string; provider: string; modelId: string; source: "chain"; chainName: string; chainIndex: number;
}

const entriesOf = (chain: ReturnChain) => chain.entries.filter((entry) => entry.enabled !== false);
const enabledPool = (config: ReturnConfig, name: string) => config.pools.find((p) => p.enabled && p.name === name);

/** A pool is a fallback when marked so, or when it ends an enabled chain that starts elsewhere. */
export function isFallbackPool(config: ReturnConfig, name: string): boolean {
	const pool = enabledPool(config, name);
	if (!pool) return false;
	if (pool.fallback === true) return true;
	if (pool.fallback === false) return false;
	return config.chains.some((chain) => {
		if (!chain.enabled) return false;
		const entries = entriesOf(chain);
		return entries.length > 1 && entries.at(-1)!.pool === name && entries[0].pool !== name;
	});
}

/** The first entry of a chain that reaches this pool; the caller checks the trigger's role. */
export function primaryTarget(config: ReturnConfig, fromPool: string): ReturnTarget | undefined {
	if (!enabledPool(config, fromPool)) return undefined;
	for (const chain of config.chains) {
		if (!chain.enabled || !entriesOf(chain).some((entry) => entry.pool === fromPool)) continue;
		const index = chain.entries.findIndex((entry) => entry.enabled !== false);
		const first = chain.entries[index];
		if (!first || first.pool === fromPool || !enabledPool(config, first.pool)) continue;
		if (isFallbackPool(config, first.pool)) continue;
		return { poolName: first.pool, modelId: first.model, chainName: chain.name, chainIndex: index };
	}
	return undefined; // "fallback": true without a chain: no known primary model, so no return
}

/** The pool a provider is in (last match, as the rest of multi-sub resolves it). */
export function poolOf(config: ReturnConfig, provider: string): ReturnPool | undefined {
	return config.pools.findLast((p) => p.enabled && p.members.includes(provider));
}

/** Primary members a chat on the fallback may go back to, in pool order; the caller ranks them. */
export function returnCandidates(
	config: ReturnConfig,
	currentProvider: string,
	eligible: (pool: ReturnPool, provider: string, modelId: string) => boolean,
	attempted: ReadonlySet<string> = new Set(),
	trigger: "prompt" | "refusal" = "prompt",
): ReturnCandidate[] {
	const from = poolOf(config, currentProvider);
	if (!from) return [];
	const isFallback = isFallbackPool(config, from.name);
	if (!(trigger === "refusal" ? from.returnOnRefusal ?? isFallback : isFallback)) return [];
	const target = primaryTarget(config, from.name);
	if (!target) return [];
	const primary = enabledPool(config, target.poolName)!;
	return primary.members
		.filter((provider) => provider !== currentProvider && !attempted.has(provider)
			&& eligible(primary, provider, target.modelId))
		.map((provider) => ({ poolName: primary.name, provider, modelId: target.modelId, source: "chain" as const,
			chainName: target.chainName, chainIndex: target.chainIndex }));
}

/** At most one step up per turn. Keyed by the turn's own object, so a new turn starts clean. */
export class ReturnGuard<T extends object> {
	private used = new WeakSet<T>();
	allow(turn: T | undefined): boolean { return !turn || !this.used.has(turn); }
	mark(turn: T | undefined): void { if (turn) this.used.add(turn); }
}

/** Pi does not retry "Codex error: The usage limit has been reached", so after the step up the
 * run is continued once on the new member, without replaying the prompt (same as signin-failover). */
export class ReturnContinuation {
	private failed: { entryId: string; source: ContinueModel } | undefined;
	private armed: ContinueModel | undefined;
	private used = 0;

	reset(): void { this.failed = undefined; this.armed = undefined; this.used = 0; }
	cancel(): void { this.failed = undefined; this.armed = undefined; }

	observe(message: ContinueMessage, entryId: string, current: ContinueModel | undefined,
		isLimit: (text: string) => boolean): void {
		this.failed = undefined;
		this.armed = undefined;
		if (!entryId || !current || message.role !== "assistant" || message.stopReason !== "error") return;
		if (!message.errorMessage || !isLimit(message.errorMessage) || message.provider !== current.provider) return;
		this.failed = { entryId, source: { ...current } };
	}

	arm(source: ContinueModel, target: ContinueModel): boolean {
		if (!this.failed || this.failed.source.provider !== source.provider || this.used >= MAX_CONTINUES_PER_PROMPT) return false;
		this.armed = { ...target };
		return true;
	}

	settle(boundary: ContinueBoundary, current: ContinueModel | undefined, aborted: boolean): ContinueResult | undefined {
		const failed = this.failed, armed = this.armed;
		this.failed = undefined;
		this.armed = undefined;
		if (!failed || !armed || aborted || boundary.outcome !== "error" || boundary.continue) return undefined;
		if (current?.provider !== armed.provider || current.id !== armed.id) return undefined;
		if (boundary.context.pendingMessages.length) return undefined; // new input continues the run itself
		const visible = boundary.context.contextEntries.filter((entry) => entry.messages.length);
		if (visible.at(-1)?.sourceEntry.id !== failed.entryId) return undefined;
		const priorRole = visible.slice(0, -1).at(-1)?.messages.at(-1)?.role;
		if (priorRole !== "user" && priorRole !== "toolResult") return undefined;
		this.used += 1;
		const edit = { type: "context_edit" as const, targetId: failed.entryId, replacement: null };
		return { entries: [...(boundary.entries ?? []), edit], continue: true };
	}
}

/** One line for /pool status. */
export function fallbackRoleLine(config: ReturnConfig, poolName: string): string | undefined {
	const pool = enabledPool(config, poolName);
	if (!pool) return undefined;
	const isFallback = isFallbackPool(config, poolName);
	const onRefusal = pool.returnOnRefusal ?? isFallback;
	if (!isFallback && !onRefusal) return undefined;
	const target = primaryTarget(config, poolName);
	if (!isFallback) return target
		? `role: refusal return (chats go back to ${target.poolName} / ${target.modelId} when it refuses and a member has room; never at a send)`
		: "role: refusal return (no primary chain entry, so chats stay here; never at a send)";
	return target
		? `role: fallback (chats go back to ${target.poolName} / ${target.modelId} ${onRefusal ? "when a member has room" : "at a send only; never on refusal"})`
		: "role: fallback (no primary chain entry, so chats stay here)";
}

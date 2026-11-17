/** mine/row-failover: a running chat that hits a limit moves along its department's tier row (model routing S5).
 *
 * Owner's plan (Show&Tell d_udizqai7oz, decision 6; Ops #868): the mid-chat fallback follows each department's own
 * order, not the one global chain (claude-then-sol). pi-queue owns the tables and the one router; it answers on its
 * route channel (`globalThis[Symbol.for("pi-queue.model-route")]`, v1, `api.chatFailover`) with the next usable
 * cell of the chat's row: a lead's home chat at its table's `lead` tier, a queued task's chat at its task's tier.
 * Banned, `none` and excluded cells are skipped there, as are the cells that failed this turn (`tried`).
 *
 * This module maps that answer onto pi-multi-pass's pools: the cell's column picks the pools (`api.columnOf`),
 * every eligible member is a candidate (the pool picks the account, as for a chain entry). A cell with no eligible
 * member is passed over and the router asked again. No answer, a chat of no role, or a department with no table
 * (`default`): undefined, and the caller keeps its global chain.
 * No pi imports, so plain node can test it.
 */
export const ROUTE_CHANNEL_KEY = Symbol.for("pi-queue.model-route");

export interface RowChoice { model: string; thinking?: string }
export interface RowRoute {
	action: string;
	why?: string;
	tier?: string;
	until?: number;
	line: string;
	pick?: { model: string; thinking: string; column: string };
}
export interface RowAnswer { role?: string; result?: RowRoute; problems?: string[] }
export interface RowChannel {
	chatFailover(req: { session: unknown; failed: RowChoice; tried?: RowChoice[] }): RowAnswer;
	columnOf(provider: string): string | undefined;
	logFailover?(result: RowRoute): unknown;
	routedSwitch?(sessionId: string, model: string): void;
}
export interface RowPool { name: string; baseProvider?: string; members: string[]; enabled: boolean }
export interface RowCandidate {
	poolName: string; provider: string; modelId: string; source: "chain"; chainName: string; chainIndex: number;
	/** The cell's thinking level: set on the chat after the switch. Marks a row candidate. */
	thinking: string;
}
export interface RowPlan {
	role: string;
	/** The router's answer the candidates come from (or its last one: no cell left). */
	result: RowRoute;
	/** One cell's members; empty when no cell of the row is left (the caller reports `result.line`). */
	candidates: RowCandidate[];
	/** Cells the router picked that had no eligible account here (no sign-in, missing model, exhausted). */
	passed: string[];
	problems: string[];
}

/** Bound on re-asks when picked cells have no eligible account (a row has at most three cells). */
const MAX_ASKS = 6;

/** pi-queue's route channel, when its copy offers row failover. */
export function rowChannel(): RowChannel | undefined {
	const channel = (globalThis as Record<symbol, unknown>)[ROUTE_CHANNEL_KEY] as { v?: number; api?: Partial<RowChannel> } | undefined;
	const api = channel?.v === 1 ? channel.api : undefined;
	return typeof api?.chatFailover === "function" && typeof api.columnOf === "function" ? (api as RowChannel) : undefined;
}

/**
 * The enabled pool of a provider's row column, for a chat on a provider no pool holds: pi-queue launches GPT-column
 * tasks on "openai-codex" while the live GPT pool holds "openai" (Ops #995). Used only when the chat's row answers.
 * No channel (an older pi-queue): undefined.
 */
export function columnPool<P extends RowPool>(channel: RowChannel | undefined, provider: string, pools: readonly P[]): P | undefined {
	const column = channel?.columnOf(provider);
	return channel && column ? pools.find((p) => p.enabled && channel.columnOf(p.baseProvider ?? p.members[0] ?? "") === column) : undefined;
}

/** "anthropic-2" → pinned to that account; "anthropic" → any account of the column. */
const pinned = (provider: string) => /-\d+$/.test(provider);

export function planRowFailover(input: {
	channel: RowChannel;
	session: unknown;
	failed: RowChoice;
	tried: readonly RowChoice[];
	pools: readonly RowPool[];
	eligible: (pool: RowPool, provider: string, modelId: string) => boolean;
}): RowPlan | undefined {
	const { channel } = input;
	const tried = [...input.tried];
	const passed: string[] = [];
	let last: RowPlan | undefined;
	for (let ask = 0; ask < MAX_ASKS; ask++) {
		const answer = channel.chatFailover({ session: input.session, failed: input.failed, tried });
		const result = answer.result;
		if (!answer.role || !result || result.action === "default") return undefined;
		last = { role: answer.role, result, candidates: [], passed, problems: answer.problems ?? [] };
		if (result.action !== "pick" || !result.pick) return last;
		const { model, thinking } = result.pick;
		const slash = model.indexOf("/");
		const provider = model.slice(0, slash), modelId = model.slice(slash + 1);
		const column = channel.columnOf(provider);
		const chainName = `${answer.role} ${result.tier ?? ""} row`.replace(/\s+/g, " ");
		for (const pool of input.pools) {
			if (!pool.enabled) continue;
			const members = pinned(provider)
				? pool.members.filter((m) => m === provider)
				: channel.columnOf(pool.baseProvider ?? pool.members[0] ?? "") === column ? pool.members : [];
			for (const member of members) {
				if (!input.eligible(pool, member, modelId)) continue;
				last.candidates.push({ poolName: pool.name, provider: member, modelId, source: "chain", chainName,
					chainIndex: tried.length, thinking });
			}
		}
		if (last.candidates.length) return last;
		passed.push(`${model}@${thinking}`);
		tried.push({ model, thinking });
	}
	return last;
}

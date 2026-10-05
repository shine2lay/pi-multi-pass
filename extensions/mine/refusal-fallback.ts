/** Single, opt-in fallback for the Anthropic cyber-classifier refusal.
 * No prompt rewriting, transport replacement, account exhaustion or user replay.
 * Pi's append-only context edit omits only the incomplete refused response.
 */
export type RefusalFallbackConfig =
	| { enabled: false }
	| { enabled: true; provider: string; model: string };

export function normalizeRefusalFallback(raw: unknown): RefusalFallbackConfig | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object") return { enabled: false };
	const value = raw as Record<string, unknown>;
	if (value.enabled !== true || typeof value.provider !== "string" || typeof value.model !== "string"
		|| !value.provider.trim() || !value.model.trim() || /^anthropic(?:-\d+)?$/.test(value.provider.trim())) {
		return { enabled: false };
	}
	return { enabled: true, provider: value.provider.trim(), model: value.model.trim() };
}

export interface RefusalModel { provider: string; id: string }
export interface RefusalMessage {
	role: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: string;
}

// Pi 1.0.1 preserves rawStopReason and explanation, but not stop_details.category.
// Do not match generic refusals, assistant text, other policy categories or 403s.
const CYBER_REFUSAL = /^\s*(?:Error:\s*)?This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy\.(?:\s+To learn more, see https:\/\/platform\.claude\.com\/docs\/en\/build-with-claude\/refusals-and-fallback\.?)?\s*$/;
export function isAnthropicCyberRefusal(message: RefusalMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error"
		&& /^anthropic(?:-\d+)?$/.test(message.provider ?? "")
		&& (message.rawStopReason === undefined || message.rawStopReason === "refusal")
		&& typeof message.errorMessage === "string" && CYBER_REFUSAL.test(message.errorMessage);
}

export interface RefusalBoundary {
	outcome: string;
	continue?: boolean;
	context: {
		contextEntries: { sourceEntry: { id: string }; messages: { role: string }[] }[];
		pendingMessages: unknown[];
	};
}
export interface RefusalHost {
	config(): { refusalFallback?: RefusalFallbackConfig; allowedProviderNames?: string[] };
	current(): RefusalModel | undefined;
	authenticated(provider: string): boolean;
	available(model: RefusalModel): boolean;
	setModel(model: RefusalModel): Promise<boolean>;
	notify(message: string): void;
	signal?: AbortSignal;
}
export interface RefusalRetry {
	entries: { type: "context_edit"; targetId: string; replacement: null }[];
	continue: true;
}
function sameModel(a: RefusalModel | undefined, b: RefusalModel): boolean {
	return a?.provider === b.provider && a.id === b.id;
}

export class RefusalFallback {
	private pending: { entryId: string; source: RefusalModel } | undefined;
	private spent = false;
	private generation = 0;
	private selecting = false;
	get isSelecting(): boolean { return this.selecting; }

	/** Only a new user activity/session resets the one-fallback budget. */
	reset(): void { this.cancel(); this.spent = false; }
	/** Manual selection, abort or shutdown must not trigger a late retry. */
	cancel(): void { this.pending = undefined; this.generation++; }

	observe(message: RefusalMessage, entryId: string, current: RefusalModel | undefined): void {
		this.cancel();
		if (this.spent || !entryId || !current || !isAnthropicCyberRefusal(message)
			|| message.provider !== current.provider || message.model !== current.id) return;
		this.pending = { entryId, source: { ...current } };
	}

	async retry(boundary: RefusalBoundary, host: RefusalHost): Promise<RefusalRetry | undefined> {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || this.spent || boundary.outcome !== "error" || boundary.continue
			|| host.signal?.aborted || !sameModel(host.current(), pending.source)) return;
		// Let new queued input win; never resend an older user request alongside it.
		if (boundary.context.pendingMessages.length) return;
		const visible = boundary.context.contextEntries.filter(entry => entry.messages.length);
		if (visible.at(-1)?.sourceEntry.id !== pending.entryId) return;
		// Once the refused response is omitted, Pi needs a user/tool-result tail.
		const priorRole = visible.slice(0, -1).at(-1)?.messages.at(-1)?.role;
		if (priorRole !== "user" && priorRole !== "toolResult") return;
		this.spent = true;
		const config = host.config().refusalFallback;
		if (!config?.enabled) return;
		const target = { provider: config.provider, id: config.model };
		const eligible = (): boolean => {
			const fresh = host.config();
			return fresh.refusalFallback?.enabled === true
				&& fresh.refusalFallback.provider === target.provider && fresh.refusalFallback.model === target.id
				&& (!fresh.allowedProviderNames || fresh.allowedProviderNames.includes(target.provider))
				&& host.authenticated(target.provider) && host.available(target);
		};
		if (!eligible()) {
			host.notify("multi-pass: refusal fallback unavailable; check the target sign-in, model and project access.");
			return;
		}
		const generation = this.generation;
		let switched = false;
		this.selecting = true;
		try { switched = await host.setModel(target); }
		catch { /* Keep the original error; do not log provider errors or credentials. */ }
		finally { this.selecting = false; }
		if (this.generation !== generation || host.signal?.aborted || !eligible()) return;
		if (!switched || !sameModel(host.current(), target)) {
			host.notify("multi-pass: refusal fallback could not switch models; the original error is kept.");
			return;
		}
		host.notify(`multi-pass: Anthropic declined; switched to ${target.id} and retrying once.`);
		// The raw saved response remains for audit. Only this incomplete response is
		// omitted from context; all user content, images and completed tools remain.
		return { entries: [{ type: "context_edit", targetId: pending.entryId, replacement: null }], continue: true };
	}
}

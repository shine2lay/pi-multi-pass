/** mine/signin-failover: a pool member whose sign-in can't be renewed is skipped like a limit refusal.
 *
 * Pi 1.0.1 renews an expiring OAuth login under a lock and turns any renewal error into
 * "OAuth refresh failed for <provider>" (pi-ai dist/auth/resolve.js). Pi never retries that text,
 * and the upstream rotation only moves on limit errors, so a chat that failed over onto a dead
 * login stopped (2026-10-10 06:40, anthropic-3: 14 stopped turns in 9 chats).
 *
 * This module only decides; multi-sub.ts switches the model. It never refreshes, reads or stores a
 * token: the only credential fact it keeps is the stored expiry time, to notice a later sign-in.
 * No pi imports, so plain node can test it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SignInFailureKind = "refused" | "unreachable";
export interface SignInFailure {
	provider: string;
	/** refused: the provider answered no (4xx, invalid_grant): only a new sign-in helps.
	 * unreachable: network, timeout or 5xx: worth another try after a short pause. */
	kind: SignInFailureKind;
}

// Pi 1.0.1 wording (resolveStoredOAuth). "expires too soon" is a renewal that did not help either.
const SIGN_IN_FAILURE = /\bOAuth refresh (?:failed|returned a token that expires too soon) for ([A-Za-z0-9._:-]+?)(?=[\s:;,]|$)/;
const REFUSED = /invalid_grant|invalid_client|unauthorized_client|\bstatus=4\d\d\b|"status"\s*:\s*4\d\d\b|expires too soon/i;

export function parseSignInFailure(errorMessage: string | undefined): SignInFailure | undefined {
	if (typeof errorMessage !== "string") return undefined;
	const match = errorMessage.match(SIGN_IN_FAILURE);
	if (!match) return undefined;
	// Classify on the reason only, never on the stack (line numbers look like statuses).
	const reason = errorMessage.split(/;\s*stack=|\n\s+at\s/)[0];
	return { provider: match[1], kind: REFUSED.test(reason) ? "refused" : "unreachable" };
}

/** How long an unreachable sign-in is skipped before it is tried again. */
export const UNREACHABLE_PAUSE_MS = 2 * 60_000;

export interface SignInMark {
	at: number;
	kind: SignInFailureKind;
	/** Stored credential expiry when it failed; a different value means someone signed in again. */
	stamp: string | null;
}
interface SignInFile {
	version: 1;
	accounts: Record<string, SignInMark>;
}

/** Credential stamp without token material: the stored type and expiry time. */
export function credentialStamp(credential: unknown): string | null {
	if (!credential || typeof credential !== "object") return null;
	const value = credential as { type?: unknown; expires?: unknown };
	return `${typeof value.type === "string" ? value.type : "?"}:${typeof value.expires === "number" ? value.expires : "?"}`;
}

/** Sign-in failures shared by every chat (and `/pool status` in another process) through one small
 * file. Reads are cheap and fresh; a write replaces the whole file. */
export class SignInFailures {
	private readonly file: string;
	private readonly stampOf: (provider: string) => string | null;
	private readonly now: () => number;

	constructor(file: string, stampOf: (provider: string) => string | null, now: () => number = Date.now) {
		this.file = file;
		this.stampOf = stampOf;
		this.now = now;
	}

	private read(): SignInFile {
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SignInFile>;
			if (parsed?.version === 1 && parsed.accounts && typeof parsed.accounts === "object") {
				return { version: 1, accounts: { ...parsed.accounts } };
			}
		} catch { /* missing or unreadable: nothing marked */ }
		return { version: 1, accounts: {} };
	}

	private write(data: SignInFile): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temp, this.file);
		} catch { /* best effort: the in-turn failover still happens */ }
	}

	mark(failure: SignInFailure): SignInMark {
		const data = this.read();
		const mark = { at: this.now(), kind: failure.kind, stamp: this.stampOf(failure.provider) };
		data.accounts[failure.provider] = mark;
		this.write(data);
		return mark;
	}

	clear(provider: string): void {
		const data = this.read();
		if (!data.accounts[provider]) return;
		delete data.accounts[provider];
		this.write(data);
	}

	/** The mark that still holds, or undefined. A changed stored credential (new sign-in, or a renewal
	 * elsewhere) or an expired pause lifts it. */
	current(provider: string): SignInMark | undefined {
		const mark = this.read().accounts[provider];
		if (!mark || typeof mark.at !== "number") return undefined;
		const stamp = this.stampOf(provider);
		if (stamp !== mark.stamp) {
			this.clear(provider);
			return undefined;
		}
		if (mark.kind !== "refused" && this.now() - mark.at >= UNREACHABLE_PAUSE_MS) return undefined;
		return mark;
	}

	blocked(provider: string): boolean {
		return this.current(provider) !== undefined;
	}

	/** "sign-in failed 06:40" for /pool status and skip notices. */
	label(provider: string): string | undefined {
		const mark = this.current(provider);
		if (!mark) return undefined;
		const time = new Date(mark.at);
		const hh = String(time.getHours()).padStart(2, "0");
		const mm = String(time.getMinutes()).padStart(2, "0");
		return mark.kind === "refused" ? `sign-in failed ${hh}:${mm}` : `sign-in unreachable ${hh}:${mm}`;
	}
}

// ---- continue the same turn on the next member (no user input replayed) ----

export interface ContinueModel { provider: string; id: string }
export interface ContinueMessage { role: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string }
export interface ContinueBoundary {
	outcome: string;
	continue?: boolean;
	/** Entries earlier handlers added at this boundary; a result replaces the list, so keep them. */
	entries?: unknown[];
	context: {
		contextEntries: { sourceEntry: { id: string }; messages: { role: string }[] }[];
		pendingMessages: unknown[];
	};
}
export interface ContinueResult {
	entries: unknown[];
	continue: true;
}

/** At most this many sign-in failovers per user prompt (a pool rarely has more members). */
export const MAX_CONTINUES_PER_PROMPT = 8;

/** Pi will not retry a sign-in failure, and replaying the user's prompt would duplicate it. Instead
 * the failed (empty) response is left out of the context and the run continues on the new member,
 * the way mine/refusal-fallback does. */
export class SignInContinuation {
	private failed: { entryId: string; source: ContinueModel } | undefined;
	private armed: ContinueModel | undefined;
	private used = 0;

	/** New user prompt or session: fresh budget. */
	reset(): void { this.failed = undefined; this.armed = undefined; this.used = 0; }
	/** Manual model choice or abort: never continue late. */
	cancel(): void { this.failed = undefined; this.armed = undefined; }

	/** turn_end: remember the failed response's entry. */
	observe(message: ContinueMessage, entryId: string, current: ContinueModel | undefined): void {
		this.failed = undefined;
		this.armed = undefined;
		if (!entryId || !current || message.role !== "assistant" || message.stopReason !== "error") return;
		const failure = parseSignInFailure(message.errorMessage);
		if (!failure || failure.provider !== current.provider || message.provider !== current.provider) return;
		this.failed = { entryId, source: { ...current } };
	}

	/** agent_end: the rotation moved this chat to target. */
	arm(source: ContinueModel, target: ContinueModel): boolean {
		if (!this.failed || this.failed.source.provider !== source.provider || this.used >= MAX_CONTINUES_PER_PROMPT) return false;
		this.armed = { ...target };
		return true;
	}

	/** agent_before_settle: continue once on the armed target. */
	settle(boundary: ContinueBoundary, current: ContinueModel | undefined, aborted: boolean): ContinueResult | undefined {
		const failed = this.failed;
		const armed = this.armed;
		this.failed = undefined;
		this.armed = undefined;
		if (!failed || !armed || aborted || boundary.outcome !== "error" || boundary.continue) return undefined;
		if (current?.provider !== armed.provider || current.id !== armed.id) return undefined;
		// New queued input wins; it continues the run by itself.
		if (boundary.context.pendingMessages.length) return undefined;
		const visible = boundary.context.contextEntries.filter((entry) => entry.messages.length);
		if (visible.at(-1)?.sourceEntry.id !== failed.entryId) return undefined;
		const priorRole = visible.slice(0, -1).at(-1)?.messages.at(-1)?.role;
		if (priorRole !== "user" && priorRole !== "toolResult") return undefined;
		this.used += 1;
		const edit = { type: "context_edit" as const, targetId: failed.entryId, replacement: null };
		return { entries: [...(boundary.entries ?? []), edit], continue: true };
	}
}

/**
 * limits-port — the limits channel's v1 contract (shared with pi-web-ui's server/subs-limits.ts) and the
 * reading port model routing decides by (owner's plan d_udizqai7oz, slice S2).
 *
 *   · `fresh()` hands back the shared readings with each account's age. Numbers older than 30 min are
 *     checked again first (the same free check as `/subs limit-check`), waiting at most 10 s.
 *   · A failed or slow check keeps the old numbers and lists those accounts as stale: the router
 *     (pi-queue's `readingsFromLimits` / `isFresh`) never forces on them.
 *   · A failed attempt isn't repeated for 30 min, so a decision never waits 10 s twice in a row.
 *
 * Imports only types from subs-limits.ts (no cycle at run time); no pi imports.
 */
import type { LimitsAccount, LimitsReadings } from "./subs-limits.ts";

export interface LimitsEvent {
	checking: boolean;
	readings?: LimitsReadings;
}

/** Contract v1, shared with pi-web-ui (server/subs-limits.ts). Either side may create it. */
export interface LimitsApiV1 {
	/** Check every account (joins a check already running); resolves with the readings after it. */
	check(): Promise<LimitsReadings>;
	/** The shared file's readings; undefined before the first check. */
	readings(): LimitsReadings | undefined;
	checking(): boolean;
	file: string;
	/** The reading port (since S2; older copies lack it): readings no older than 30 min where a check can get them. */
	fresh?(options?: FreshOptions): Promise<FreshReading>;
}

export interface LimitsChannelV1 {
	v: 1;
	/** Called on every change: a check starting or ending, and every write. */
	listeners: Set<(event: LimitsEvent) => void>;
	/** Set by pi-multi-pass (the latest loaded copy). */
	api?: LimitsApiV1;
}

/** Older numbers are checked again before a decision (plan §3). */
export const READING_MAX_AGE_MS = 30 * 60_000;
/** The longest a decision waits for that check. */
export const FRESH_CHECK_TIMEOUT_MS = 10_000;

export interface FreshOptions {
	maxAgeMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

/** `not-needed`: numbers new enough, or a check already tried within maxAge; `check-failed`: the check ran
 *  and some numbers are still old; `timed-out`: the check is still running; `unavailable`: no chat can check. */
export type FreshOutcome = "not-needed" | "checked" | "check-failed" | "timed-out" | "unavailable";

export interface FreshReading {
	/** The shared file's readings (subs-limits.json v1) after any check; a failed check keeps the old numbers. */
	readings?: LimitsReadings;
	outcome: FreshOutcome;
	/** ms since each account's numbers were read, by provider; accounts without numbers are left out. */
	ageMs: Record<string, number>;
	/** Providers whose numbers are older than maxAge: never force on them. */
	stale: string[];
}

const hasNumbers = (a: LimitsAccount): boolean => !a.note && a.windows.some((w) => w.usedPercent !== undefined);
const isStale = (a: LimitsAccount, now: number, maxAge: number): boolean =>
	hasNumbers(a) && (a.checkedAt === undefined || now - a.checkedAt > maxAge);

/** Never checked, or an account's numbers are old and no check was tried for it within maxAge. */
export function needsCheck(readings: LimitsReadings | undefined, now: number, maxAge = READING_MAX_AGE_MS): boolean {
	if (!readings?.checkedAt) return true;
	return readings.accounts.some((a) => isStale(a, now, maxAge) && now - (a.triedAt ?? a.checkedAt ?? 0) > maxAge);
}

function describe(readings: LimitsReadings | undefined, outcome: FreshOutcome, now: number, maxAge: number): FreshReading {
	const accounts = readings?.accounts ?? [];
	return {
		readings, outcome,
		ageMs: Object.fromEntries(accounts.filter((a) => hasNumbers(a) && a.checkedAt !== undefined)
			.map((a) => [a.provider, Math.max(0, now - a.checkedAt!)])),
		stale: accounts.filter((a) => isStale(a, now, maxAge)).map((a) => a.provider),
	};
}

/** The reading port. Never throws: a check that fails, rejects or runs late is an outcome. */
export async function freshReadings(
	api: Pick<LimitsApiV1, "readings" | "check">, options: FreshOptions = {},
): Promise<FreshReading> {
	const now = options.now ?? Date.now;
	const maxAge = options.maxAgeMs ?? READING_MAX_AGE_MS;
	const before = api.readings();
	if (!needsCheck(before, now(), maxAge)) return describe(before, "not-needed", now(), maxAge);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ran = await Promise.race([
		Promise.resolve().then(() => api.check()).then(() => "checked" as const, () => "unavailable" as const),
		new Promise<"timed-out">((done) => { timer = setTimeout(() => done("timed-out"), options.timeoutMs ?? FRESH_CHECK_TIMEOUT_MS); }),
	]);
	clearTimeout(timer);
	const after = describe(api.readings(), ran, now(), maxAge);
	if (ran === "checked" && after.stale.length) after.outcome = "check-failed";
	return after;
}

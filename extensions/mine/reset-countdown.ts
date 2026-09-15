/**
 * reset-countdown — "resets in 4d 15h" next to every quota reset timestamp.
 *
 * An absolute UTC stamp ("reset 09-19 11:13Z") is precise but needs mental
 * arithmetic against the current time, in a different timezone, to answer the
 * only question actually being asked: how long until this quota comes back?
 * These helpers add the relative form; the absolute stamp always stays visible
 * next to it, so nothing that was readable before becomes less readable.
 *
 * Pure functions with an injectable `now`: no clocks, no I/O, no state.
 */

import type { LimitWindow, ModelLimitsReport } from "./current-model-limits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse, two-unit duration: `4d 15h`, `3h 12m`, `7m`, `<1m`.
 *
 * Two units is the useful resolution for a quota window — minutes next to days
 * are noise. A non-finite or negative input has no duration (the caller decides
 * what to print instead).
 */
export function formatDuration(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	if (ms < MINUTE) return "<1m";
	if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const minutes = Math.floor((ms % HOUR) / MINUTE);
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** Accepts a UTC ISO string or Unix **seconds** (the two shapes the quota sources use). */
function resetMs(resetAt: string | number | undefined): number | undefined {
	if (resetAt === undefined) return undefined;
	if (typeof resetAt === "number") {
		if (!Number.isFinite(resetAt) || resetAt <= 0) return undefined;
		return resetAt * 1000;
	}
	const parsed = Date.parse(resetAt);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Relative form of a reset time: `in 4d 15h`, `in 12m`, or `due` once the
 * deadline has passed (a past deadline means the window should already have
 * rolled over — it is NOT evidence of fresh quota, so it never claims one).
 * Unparsable/missing input returns undefined so callers keep their own wording.
 */
export function formatResetIn(resetAt: string | number | undefined, now = Date.now()): string | undefined {
	const target = resetMs(resetAt);
	if (target === undefined) return undefined;
	if (target <= now) return "due";
	const duration = formatDuration(target - now);
	return duration === undefined ? undefined : `in ${duration}`;
}

/** `resets in 4d 15h (09-19 11:13Z)` — relative first, absolute kept in parentheses. */
export function formatResetPhrase(
	resetAt: string | number | undefined,
	absolute: string | undefined,
	now = Date.now(),
): string {
	const relative = formatResetIn(resetAt, now);
	if (!absolute) return relative ? `resets ${relative}` : "resets unknown";
	return relative ? `resets ${relative} (${absolute})` : `resets ${absolute}`;
}

/** Tool output: the same countdown as a machine-readable field per window. */
export interface CountdownWindow extends LimitWindow {
	/** Human countdown to `resetAt` at report time: `in 4d 15h` / `due`. */
	resetsIn?: string;
	/** Whole seconds until `resetAt` at report time; 0 once the deadline passed. */
	resetsInSeconds?: number;
}

export interface CountdownReport extends ModelLimitsReport {
	windows: CountdownWindow[];
}

/**
 * Decorate a report for the `current_model_limits` tool. The countdown is a
 * snapshot taken at report time (like the quota numbers themselves) and is
 * derived only from `resetAt` — no new quota claim is invented, and windows
 * without a reset time are returned untouched.
 */
export function withResetCountdown(report: ModelLimitsReport, now = Date.now()): CountdownReport {
	return {
		...report,
		windows: report.windows.map((w) => {
			const target = resetMs(w.resetAt);
			if (target === undefined) return { ...w };
			return {
				...w,
				resetsIn: formatResetIn(w.resetAt, now),
				resetsInSeconds: Math.max(0, Math.round((target - now) / 1000)),
			};
		}),
	};
}

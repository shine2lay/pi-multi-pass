/**
 * subs-limits — one reliable limits check for every signed-in subscription, shared by
 * `/subs limit-check`, the chat's `multi-pass-subs` box and pi-web-ui's Limits box.
 *
 *   · Claude accounts: Anthropic's free usage page (`GET /api/oauth/usage`, the page
 *     Claude Code's /usage reads). Nothing is sent to a model; nothing is spent.
 *   · Other providers: the existing quota checker (ChatGPT: `/wham/usage`), handed the
 *     same reliable fetch.
 *   · Every account gets a row on every check. A failed check keeps the account's last
 *     good numbers, with their age and the reason in plain words.
 *   · The numbers never depend on which model a chat uses: the check takes no model.
 *   · Readings live in one file, written whole (temp file + rename), so every window and
 *     every chat shows the same numbers.
 *   · Sign-ins are refreshed only through pi's own store (`host.refresh` = pi's
 *     pre-request refresh, under pi's lock, written back by pi). This module never
 *     refreshes a token itself, never writes auth.json and never logs a token.
 *   · Every chat in the process shares the check through a versioned channel on
 *     globalThis (`Symbol.for("pi-multi-pass.limits")`), which pi-web-ui's server listens on.
 *
 * No pi imports: `node tests/subs-limits-check.mjs` drives all of it with fakes.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatResetIn } from "./reset-countdown.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ==========================================================================
// Readings (the shared file's shape, version 1)
// ==========================================================================

export interface LimitWindow {
	/** `5h`, `7d`, `7d:<model>` (per-model weekly window) or `m:<bucket>` (other providers). */
	key: string;
	/** Plain label: `5-hour`, `Weekly`, `Weekly · Opus`. */
	label: string;
	/** 0–100. Absent when the provider sent no number (never shown as 0%). */
	usedPercent?: number;
	/** Unix seconds. */
	resetAt?: number;
	limited?: boolean;
}

export type FailureReason =
	| "signed-out"
	| "sign-in-expired"
	| "busy"
	| "timeout"
	| "no-answer"
	| "not-subscription"
	| "unsupported"
	| "error";

export const REASON_TEXT: Record<FailureReason, string> = {
	"signed-out": "signed out",
	"sign-in-expired": "sign-in expired; refreshes when the account is next used",
	busy: "provider busy (429)",
	timeout: "timed out",
	"no-answer": "no answer",
	"not-subscription": "signed in with an API key; no subscription limits",
	unsupported: "no limits check for this provider",
	error: "check failed",
};

export interface LimitsFailure {
	reason: FailureReason;
	/** Plain words, credential-free. */
	text: string;
	/** ms */
	at: number;
}

export interface LimitsAccount {
	/** pi provider slot: `anthropic`, `anthropic-2`, `openai-codex`. */
	provider: string;
	base: string;
	/** 1 for the base slot, N for `<base>-N`. */
	number: number;
	/** `Claude 2`, `ChatGPT 1`. */
	name: string;
	/** Your label from multi-pass.json (usually the email). */
	label?: string;
	email?: string;
	/** `Max`, `Pro`, `Free`, `Plus`… when known. */
	plan?: string;
	windows: LimitWindow[];
	limited?: boolean;
	/** ms: when these numbers were read. Absent = no numbers yet. */
	checkedAt?: number;
	/** `check` = a limits check; `reply` = seen in a normal reply (free). */
	source?: "check" | "reply";
	/** ms: the latest check attempt for this account. */
	triedAt?: number;
	/** Set when the latest attempt failed; cleared by the next good reading. */
	failure?: LimitsFailure;
	/** ms: when plan/email were last read from the provider. */
	profileAt?: number;
}

export interface LimitsReadings {
	version: 1;
	/** ms: the last write. */
	updatedAt: number;
	/** ms: when the last full check finished. Absent = never checked. */
	checkedAt?: number;
	accounts: LimitsAccount[];
}

export const LIMITS_FILE_NAME = "subs-limits.json";
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A signed-out account that is no longer configured keeps its row this long. */
const KEEP_UNLISTED_MS = 30 * DAY;
/** Plan and email rarely change: read them again at most this often. */
const PROFILE_MAX_AGE_MS = 12 * HOUR;
/** Tokens closer than this to expiry count as expired: pi refreshes at 5 min, and other
 *  checkers would otherwise refresh by themselves (never outside pi's store). */
const EXPIRY_MARGIN_MS = 2 * MINUTE;
/** A reply that changes nothing rewrites the file at most this often. */
const REPLY_WRITE_INTERVAL_MS = MINUTE;

const SHORT_NAMES: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "ChatGPT",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini",
	"google-antigravity": "Antigravity",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax CN",
};
const BASE_ORDER = Object.keys(SHORT_NAMES);

// ==========================================================================
// Small helpers
// ==========================================================================

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, max = 200): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** ISO string, Unix seconds or Unix ms → Unix seconds. */
function toSeconds(value: unknown): number | undefined {
	if (finite(value)) return value > 1e12 ? Math.floor(value / 1000) : value > 0 ? Math.floor(value) : undefined;
	if (typeof value !== "string" || !value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

function titleCase(value: string): string {
	return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";
}

/** `plus` → `Plus`, `claude_max` → `Max`. */
export function planName(value: unknown): string | undefined {
	const raw = text(value, 40);
	if (!raw || raw.toLowerCase() === "unknown") return undefined;
	return titleCase(raw.replace(/^claude[_-]/i, ""));
}

/** `anthropic-3` → `anthropic`; undefined for providers pi-multi-pass doesn't know. */
export function baseOf(provider: string, bases: readonly string[]): string | undefined {
	if (bases.includes(provider)) return provider;
	const match = provider.match(/^(.+)-(\d+)$/);
	return match && bases.includes(match[1]) ? match[1] : undefined;
}

function numberOf(provider: string, base: string): number {
	if (provider === base) return 1;
	const n = Number(provider.slice(base.length + 1));
	return Number.isInteger(n) && n > 0 ? n : 1;
}

function shortError(value: unknown): string {
	return (text(value, 400) ?? "").replace(/\s+/g, " ").slice(0, 80);
}

// ==========================================================================
// Provider replies → windows
// ==========================================================================

function usageWindow(key: string, label: string, used: unknown, resetsAt: unknown): LimitWindow | undefined {
	if (!finite(used)) return undefined;
	const usedPercent = clampPercent(used);
	return { key, label, usedPercent, resetAt: toSeconds(resetsAt), limited: usedPercent >= 100 || undefined };
}

/**
 * Anthropic's usage page. `five_hour` / `seven_day` carry `utilization` as a percent (0–100)
 * and `resets_at` (ISO, or null before the window starts). Per-model weekly windows come as
 * `seven_day_<model>` and, in newer replies, as `limits[]` entries of kind `weekly_scoped`.
 */
export function parseAnthropicUsage(data: unknown): { windows: LimitWindow[]; limited: boolean } | undefined {
	const raw = record(data);
	if (!raw) return undefined;
	const windows: LimitWindow[] = [];
	const add = (window: LimitWindow | undefined) => {
		if (window && !windows.some((w) => w.key === window.key)) windows.push(window);
	};
	const legacy = (field: string, key: string, label: string) => {
		const value = record(raw[field]);
		if (value) add(usageWindow(key, label, value.utilization, value.resets_at));
	};
	legacy("five_hour", "5h", "5-hour");
	legacy("seven_day", "7d", "Weekly");
	for (const model of ["opus", "sonnet", "haiku"]) legacy(`seven_day_${model}`, `7d:${model}`, `Weekly · ${titleCase(model)}`);
	for (const item of Array.isArray(raw.limits) ? raw.limits.slice(0, 32) : []) {
		const limit = record(item);
		if (!limit) continue;
		if (limit.kind === "session") add(usageWindow("5h", "5-hour", limit.percent, limit.resets_at));
		else if (limit.kind === "weekly_all") add(usageWindow("7d", "Weekly", limit.percent, limit.resets_at));
		else if (limit.kind === "weekly_scoped") {
			// Only model-scoped windows: a surface scope (an app, not a model) is not a pi limit.
			const model = record(record(limit.scope)?.model);
			const name = text(model?.display_name, 40) ?? text(model?.id, 40);
			if (name) add(usageWindow(`7d:${slug(name)}`, `Weekly · ${name}`, limit.percent, limit.resets_at));
		}
	}
	if (windows.length === 0) return undefined;
	return { windows, limited: windows.some((w) => w.limited) };
}

/** Anthropic's profile page: the account's email and plan. */
export function parseAnthropicProfile(data: unknown): { email?: string; plan?: string } {
	const raw = record(data);
	const account = record(raw?.account);
	const org = record(raw?.organization);
	const email = text(account?.email, 120);
	let plan: string | undefined;
	if (account?.has_claude_max === true) plan = "Max";
	else if (account?.has_claude_pro === true) plan = "Pro";
	else {
		const type = (text(org?.organization_type, 40) ?? "").toLowerCase();
		if (type.includes("max")) plan = "Max";
		else if (type.includes("pro")) plan = "Pro";
		else if (type.includes("team")) plan = "Team";
		else if (type.includes("enterprise")) plan = "Enterprise";
		else if (account && account.has_claude_max === false && account.has_claude_pro === false) plan = "Free";
	}
	return { email, plan };
}

/** An existing checker's windows (`ModelLimitsData.windows`) → rows. */
export function windowsFromChecker(
	windows: { name: string; usedPercent?: number; remainingPercent?: number; resetAt?: string | number }[] | undefined,
): LimitWindow[] {
	const out: LimitWindow[] = [];
	for (const w of windows ?? []) {
		const used = finite(w.usedPercent) ? w.usedPercent : finite(w.remainingPercent) ? 100 - w.remainingPercent : undefined;
		const name = text(w.name, 60);
		if (used === undefined || !name) continue;
		const key = name === "5h" || name === "7d" ? name : `m:${name}`;
		const label = name === "5h" ? "5-hour" : name === "7d" ? "Weekly" : name;
		const window = usageWindow(key, label, used, w.resetAt);
		if (window && !out.some((x) => x.key === key)) out.push(window);
	}
	return out.slice(0, 20);
}

/** Anthropic reply headers (`parseAnthropicQuotaHeaders`) → rows. */
export function windowsFromQuotaHeaders(
	windows: { name: string; usedPercent?: number; resetAt?: number; limited?: boolean }[],
): LimitWindow[] {
	const out: LimitWindow[] = [];
	for (const w of windows) {
		if (!finite(w.usedPercent)) continue;
		let key: string, label: string;
		if (w.name === "5h") [key, label] = ["5h", "5-hour"];
		else if (w.name === "7d") [key, label] = ["7d", "Weekly"];
		else if (w.name.startsWith("7d_")) [key, label] = [`7d:${slug(w.name.slice(3))}`, `Weekly · ${titleCase(w.name.slice(3))}`];
		else continue;
		const usedPercent = clampPercent(w.usedPercent);
		out.push({ key, label, usedPercent, resetAt: toSeconds(w.resetAt), limited: w.limited || usedPercent >= 100 || undefined });
	}
	return out;
}

/** A ChatGPT window's length → its key and label: 5-hour, Weekly, else "N-day" / "N-hour". */
function codexWindowName(seconds: number): [string, string] {
	if (Math.abs(seconds - 18_000) <= 120) return ["5h", "5-hour"];
	if (Math.abs(seconds - 604_800) <= 120) return ["7d", "Weekly"];
	if (seconds >= 86_400 - 120) {
		const days = Math.round(seconds / 86_400);
		return [`${days}d`, `${days}-day`];
	}
	const hours = Math.max(1, Math.round(seconds / 3_600));
	return [`${hours}h`, `${hours}-hour`];
}

/**
 * ChatGPT's `/wham/usage` reply → rows: `rate_limit.primary_window` / `secondary_window`, of any
 * length. The checker's own parser (`parseResetUsage`, which rotation uses) keeps only 5-hour and
 * weekly windows, so a Free plan's one 30-day window was dropped and its row said "no usage numbers".
 * `reset_at` is Unix seconds; without it, `reset_after_seconds` counts from `now`.
 */
export function windowsFromCodexUsage(data: unknown, now = Date.now()): LimitWindow[] {
	const rate = record(record(data)?.rate_limit);
	if (!rate) return [];
	const out: LimitWindow[] = [];
	for (const value of [rate.primary_window, rate.secondary_window]) {
		const raw = record(value);
		if (!raw || !finite(raw.used_percent) || raw.used_percent < 0) continue;
		if (!finite(raw.limit_window_seconds) || raw.limit_window_seconds <= 0) continue;
		const [key, label] = codexWindowName(raw.limit_window_seconds);
		const resetAt = finite(raw.reset_at) && raw.reset_at > 0 ? raw.reset_at
			: finite(raw.reset_after_seconds) && raw.reset_after_seconds >= 0
				? Math.floor(now / 1000 + raw.reset_after_seconds) : undefined;
		const window = usageWindow(key, label, raw.used_percent, resetAt);
		if (window && !out.some((w) => w.key === window.key)) out.push(window);
	}
	return out;
}

// ==========================================================================
// Reliable fetch: a deadline per attempt, one retry, 429s wait for Retry-After
// ==========================================================================

export interface FetchLog {
	attempts: number;
	status?: number;
	timedOut?: boolean;
	network?: boolean;
}

export interface ReliabilityOptions {
	/** Per attempt, including reading the body. */
	timeoutMs: number;
	/** Pause before the retry after a timeout, a 5xx or a network error. */
	retryDelayMs: number;
	/** Longest wait for a 429's Retry-After before the one retry. */
	retryAfterCapMs: number;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** `Retry-After`: seconds or an HTTP date → ms from now. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

class LimitsFetchError extends Error {
	constructor(message: string) {
		super(message);
		// Not an AbortError: checkers rethrow those; this one must come back as a failed check.
		this.name = "LimitsFetchError";
	}
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function reliableFetch(base: FetchLike, log: FetchLog, options: ReliabilityOptions): FetchLike {
	return async (input, init = {}) => {
		for (let attempt = 1; ; attempt++) {
			Object.assign(log, { attempts: attempt, status: undefined, timedOut: false, network: false });
			const deadline = new AbortController();
			const timer = setTimeout(() => deadline.abort(new LimitsFetchError("timed out")), options.timeoutMs);
			const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
			let response: Response | undefined;
			try {
				const raw = await untilAborted(base(input, { ...init, signal }), signal);
				// The body is read under the same deadline: a stalled body is a timeout too.
				const body = await untilAborted(raw.arrayBuffer(), signal);
				response = new Response(NULL_BODY_STATUS.has(raw.status) ? null : body, {
					status: raw.status, statusText: raw.statusText, headers: raw.headers,
				});
			} catch (error) {
				if (init.signal?.aborted) throw error;
				if (deadline.signal.aborted) log.timedOut = true;
				else log.network = true;
			} finally {
				clearTimeout(timer);
			}
			const last = attempt >= 2;
			if (!response) {
				if (last) throw new LimitsFetchError(log.timedOut ? "timed out" : "no answer");
				await options.sleep(options.retryDelayMs);
				continue;
			}
			log.status = response.status;
			if (response.status === 429 && !last) {
				const wait = retryAfterMs(response.headers.get("retry-after"), options.now()) ?? 1000;
				await options.sleep(Math.min(Math.max(0, wait), options.retryAfterCapMs));
				continue;
			}
			if (response.status >= 500 && !last) {
				await options.sleep(options.retryDelayMs);
				continue;
			}
			return response;
		}
	};
}

// ==========================================================================
// The host: pi's side (sign-in store, configured accounts, existing checkers)
// ==========================================================================

export interface LimitsCredential {
	type?: string;
	access?: unknown;
	expires?: unknown;
	[key: string]: unknown;
}

export interface OtherCheckResult {
	/** The checker's verdict: `missing-auth` = signed out, `error` = failed. */
	kind: string;
	windows?: { name: string; usedPercent?: number; remainingPercent?: number; resetAt?: string | number }[];
	/** Windows read straight from the provider's (2xx) reply, of any length (ChatGPT's 30-day window).
	 *  Used instead of `windows`, and they count even when the checker's own verdict, which knows only
	 *  5-hour and weekly windows, says `error`. */
	usageWindows?: LimitWindow[];
	limited?: boolean;
	plan?: string;
	email?: string;
	summary?: string;
}

export interface LimitsHost {
	/** Numbered subscriptions configured in multi-pass (shown even when signed out). */
	configured(): { provider: string; label?: string }[];
	/** Base providers pi-multi-pass knows (`anthropic`, `openai-codex`, …). */
	bases(): readonly string[];
	/** Read-only view of pi's stored sign-in. */
	stored(provider: string): LimitsCredential | undefined;
	/** pi's own pre-request refresh (under pi's lock, written back by pi). */
	refresh?(provider: string): Promise<unknown>;
	/** The existing checker for a non-Anthropic provider; undefined when it has none. */
	checkOther?(
		provider: string, base: string, credential: LimitsCredential, fetch: FetchLike, signal?: AbortSignal,
	): Promise<OtherCheckResult | undefined>;
}

export interface CheckOptions {
	/** The shared readings file. */
	file: string;
	fetch?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	retryDelayMs?: number;
	retryAfterCapMs?: number;
}

interface Resolved extends ReliabilityOptions {
	file: string;
	fetch: FetchLike;
}

function resolveOptions(options: CheckOptions): Resolved {
	return {
		file: options.file,
		fetch: options.fetch ?? ((input, init) => fetch(input, init)),
		now: options.now ?? Date.now,
		sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
		timeoutMs: options.timeoutMs ?? 10_000,
		retryDelayMs: options.retryDelayMs ?? 750,
		retryAfterCapMs: options.retryAfterCapMs ?? 5_000,
	};
}

interface AccountSlot {
	provider: string;
	base: string;
	number: number;
	name: string;
	label?: string;
}

/**
 * Every account, every time: each base provider with a stored subscription sign-in, every
 * configured numbered slot (even signed out), and any account seen before that has gone
 * missing since (it shows "signed out" with its last numbers instead of vanishing).
 */
export function listAccounts(host: LimitsHost, previous: LimitsReadings | undefined, now = Date.now()): AccountSlot[] {
	const bases = host.bases();
	const slots = new Map<string, AccountSlot>();
	const add = (provider: string, label?: string) => {
		const base = baseOf(provider, bases);
		if (!base) return;
		const existing = slots.get(provider);
		if (existing) {
			existing.label ??= label;
			return;
		}
		const number = numberOf(provider, base);
		slots.set(provider, { provider, base, number, name: `${SHORT_NAMES[base] ?? base} ${number}`, label });
	};
	for (const base of bases) {
		if (host.stored(base)?.type === "oauth") add(base);
	}
	for (const entry of host.configured()) add(entry.provider, text(entry.label, 120));
	for (const row of previous?.accounts ?? []) {
		if (!slots.has(row.provider) && (row.checkedAt ?? row.triedAt ?? 0) > now - KEEP_UNLISTED_MS) add(row.provider, row.label);
	}
	const rank = (base: string) => {
		const index = BASE_ORDER.indexOf(base);
		return index < 0 ? BASE_ORDER.length : index;
	};
	return [...slots.values()].sort((a, b) => rank(a.base) - rank(b.base) || a.base.localeCompare(b.base) || a.number - b.number);
}

function failureFor(status: number): [FailureReason, string?] {
	if (status === 401) return ["sign-in-expired"];
	if (status === 429) return ["busy"];
	if (status >= 500) return ["no-answer"];
	return ["error", `check failed (HTTP ${status})`];
}

function anthropicHeaders(access: string): Record<string, string> {
	return {
		Authorization: `Bearer ${access}`,
		"anthropic-beta": "oauth-2025-04-20",
		Accept: "application/json",
		"User-Agent": "pi-multi-pass (limits check)",
	};
}

async function readProfile(access: string, o: Resolved): Promise<{ email?: string; plan?: string } | undefined> {
	try {
		const response = await reliableFetch(o.fetch, { attempts: 0 }, o)(ANTHROPIC_PROFILE_URL, {
			method: "GET", headers: anthropicHeaders(access),
		});
		if (!response.ok) return undefined;
		const who = parseAnthropicProfile(await response.json());
		return who.email || who.plan ? who : undefined;
	} catch {
		return undefined; // best effort: plan and email are extras, never a failed row
	}
}

/** One account. Never throws: every outcome is a row. */
export async function checkAccount(
	host: LimitsHost, slot: AccountSlot, previous: LimitsAccount | undefined, options: CheckOptions,
): Promise<LimitsAccount> {
	const o = resolveOptions(options);
	let row: LimitsAccount = {
		provider: slot.provider, base: slot.base, number: slot.number, name: slot.name,
		label: slot.label,
		email: previous?.email, plan: previous?.plan, profileAt: previous?.profileAt,
		windows: previous?.windows ?? [], limited: previous?.limited,
		checkedAt: previous?.checkedAt, source: previous?.source,
		triedAt: o.now(),
	};
	const fail = (reason: FailureReason, detail?: string): LimitsAccount =>
		({ ...row, failure: { reason, text: detail ?? REASON_TEXT[reason], at: o.now() } });
	const good = (windows: LimitWindow[], limited: boolean, extra: Partial<LimitsAccount> = {}): LimitsAccount =>
		({ ...row, ...extra, windows, limited: limited || undefined, checkedAt: o.now(), source: "check", failure: undefined });

	try {
		let credential = host.stored(slot.provider);
		if (!credential) return fail("signed-out");
		if (credential.type !== "oauth") return fail("not-subscription");
		if (host.refresh) {
			// pi's own refresh: it runs only when the token is close to expiry, under pi's lock.
			try { await host.refresh(slot.provider); } catch { /* reported by the expiry check below */ }
			credential = host.stored(slot.provider);
			if (!credential) return fail("signed-out");
		}
		const access = typeof credential.access === "string" ? credential.access : "";
		const expires = finite(credential.expires) ? credential.expires : undefined;
		if (!access || (expires !== undefined && expires <= o.now() + EXPIRY_MARGIN_MS)) return fail("sign-in-expired");

		const log: FetchLog = { attempts: 0 };
		const fetchReliably = reliableFetch(o.fetch, log, o);
		if (slot.base === "anthropic") {
			const wantProfile = !row.email || !row.plan || !row.profileAt || o.now() - row.profileAt > PROFILE_MAX_AGE_MS;
			const profile = wantProfile ? readProfile(access, o) : Promise.resolve(undefined);
			let response: Response | undefined;
			try {
				response = await fetchReliably(ANTHROPIC_USAGE_URL, { method: "GET", headers: anthropicHeaders(access) });
			} catch {
				response = undefined;
			}
			const who = await profile;
			if (who) row = { ...row, email: who.email ?? row.email, plan: who.plan ?? row.plan, profileAt: o.now() };
			if (!response) return fail(log.timedOut ? "timeout" : "no-answer");
			if (!response.ok) return fail(...failureFor(response.status));
			let usage: ReturnType<typeof parseAnthropicUsage>;
			try { usage = parseAnthropicUsage(await response.json()); } catch { usage = undefined; }
			if (!usage) return fail("error", "check failed (no usage numbers in the reply)");
			return good(usage.windows, usage.limited);
		}

		// Other checkers may make calls of their own: one deadline for the whole account.
		const overall = new AbortController();
		const timer = setTimeout(() => overall.abort(new LimitsFetchError("timed out")),
			2 * o.timeoutMs + o.retryDelayMs + o.retryAfterCapMs);
		let result: OtherCheckResult | undefined;
		try {
			result = host.checkOther
				? await untilAborted(host.checkOther(slot.provider, slot.base, credential, fetchReliably, overall.signal), overall.signal)
				: undefined;
		} catch (error) {
			// A checker that lets the fetch error escape still gets the plain reason.
			if (overall.signal.aborted || log.timedOut) return fail("timeout");
			if (log.network) return fail("no-answer");
			throw error;
		} finally {
			clearTimeout(timer);
		}
		if (!result) return fail("unsupported");
		if (result.kind === "missing-auth") return fail("signed-out");
		const read = (result.usageWindows ?? []).filter((w) => w && text(w.key, 60) && text(w.label, 60) && finite(w.usedPercent))
			.map((w) => ({ ...w, usedPercent: clampPercent(w.usedPercent!), resetAt: toSeconds(w.resetAt) })).slice(0, 20);
		const windows = read.length > 0 ? read : windowsFromChecker(result.windows);
		if ((result.kind !== "error" || read.length > 0) && windows.length > 0) {
			return good(windows, Boolean(result.limited) || windows.some((w) => w.limited), {
				plan: planName(result.plan) ?? row.plan, email: text(result.email, 120) ?? row.email,
			});
		}
		if (log.timedOut) return fail("timeout");
		if (log.network) return fail("no-answer");
		if (log.status !== undefined && log.status >= 400) return fail(...failureFor(log.status));
		if (log.status !== undefined) return fail("error", "check failed (no usage numbers in the reply)");
		return fail("error", `check failed (${shortError(result.summary) || "unknown"})`);
	} catch (error) {
		return fail("error", `check failed (${shortError(error instanceof Error ? error.message : error) || "unknown"})`);
	}
}

// ==========================================================================
// The shared file
// ==========================================================================

function sanitizeWindow(value: unknown): LimitWindow | undefined {
	const w = record(value);
	const key = text(w?.key, 80), label = text(w?.label, 80);
	if (!w || !key || !label) return undefined;
	return {
		key, label,
		usedPercent: finite(w.usedPercent) ? clampPercent(w.usedPercent) : undefined,
		resetAt: finite(w.resetAt) && w.resetAt > 0 ? w.resetAt : undefined,
		limited: w.limited === true || undefined,
	};
}

function sanitizeAccount(value: unknown): LimitsAccount | undefined {
	const a = record(value);
	const provider = text(a?.provider, 80), base = text(a?.base, 80), name = text(a?.name, 80);
	if (!a || !provider || !base || !name) return undefined;
	const f = record(a.failure);
	const reason = typeof f?.reason === "string" && f.reason in REASON_TEXT ? f.reason as FailureReason : undefined;
	return {
		provider, base, name,
		number: finite(a.number) ? a.number : 1,
		label: text(a.label, 120), email: text(a.email, 120), plan: text(a.plan, 40),
		windows: (Array.isArray(a.windows) ? a.windows : []).map(sanitizeWindow).filter((w): w is LimitWindow => Boolean(w)).slice(0, 20),
		limited: a.limited === true || undefined,
		checkedAt: finite(a.checkedAt) ? a.checkedAt : undefined,
		source: a.source === "check" || a.source === "reply" ? a.source : undefined,
		triedAt: finite(a.triedAt) ? a.triedAt : undefined,
		failure: reason && f
			? { reason, text: text(f.text, 200) ?? REASON_TEXT[reason], at: finite(f.at) ? f.at : 0 }
			: undefined,
		profileAt: finite(a.profileAt) ? a.profileAt : undefined,
	};
}

export function sanitizeReadings(value: unknown): LimitsReadings | undefined {
	const raw = record(value);
	if (!raw || raw.version !== 1) return undefined;
	return {
		version: 1,
		updatedAt: finite(raw.updatedAt) ? raw.updatedAt : 0,
		checkedAt: finite(raw.checkedAt) ? raw.checkedAt : undefined,
		accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map(sanitizeAccount)
			.filter((a): a is LimitsAccount => Boolean(a)).slice(0, 50),
	};
}

export function readLimitsReadings(file: string): LimitsReadings | undefined {
	try {
		return sanitizeReadings(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

/** Written whole: a temp file renamed over the old one, so a reader never sees half a file. */
export function writeLimitsReadings(file: string, readings: LimitsReadings): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(readings, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

// ==========================================================================
// Sharing: one channel per process (every chat, and pi-web-ui's server)
// ==========================================================================

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
}

export interface LimitsChannelV1 {
	v: 1;
	/** Called on every change: a check starting or ending, and every write. */
	listeners: Set<(event: LimitsEvent) => void>;
	/** Set by pi-multi-pass (the latest loaded copy). */
	api?: LimitsApiV1;
}

export const LIMITS_CHANNEL_KEY = Symbol.for("pi-multi-pass.limits");
const STATE_KEY = Symbol.for("pi-multi-pass.limits.state.v1");

interface SharedState {
	/** Chats that can run a check (their pi sign-in store), latest last. */
	hosts: LimitsHost[];
	/** The last chat that closed: its sign-in store still works through pi's files. */
	fallback?: LimitsHost;
	running?: Promise<LimitsReadings>;
	perAccount: Map<string, Promise<LimitsAccount>>;
}

type Globals = Record<symbol, unknown>;

export function limitsChannel(): LimitsChannelV1 {
	const g = globalThis as unknown as Globals;
	const existing = g[LIMITS_CHANNEL_KEY] as LimitsChannelV1 | undefined;
	if (existing && existing.v === 1 && existing.listeners instanceof Set) return existing;
	const channel: LimitsChannelV1 = { v: 1, listeners: new Set() };
	g[LIMITS_CHANNEL_KEY] = channel;
	return channel;
}

function sharedState(): SharedState {
	const g = globalThis as unknown as Globals;
	let state = g[STATE_KEY] as SharedState | undefined;
	if (!state) {
		state = { hosts: [], perAccount: new Map() };
		g[STATE_KEY] = state;
	}
	return state;
}

function emit(event: LimitsEvent): void {
	for (const listener of [...limitsChannel().listeners]) {
		try {
			listener(event);
		} catch {
			// a listener's failure is its own
		}
	}
}

export function limitsChecking(): boolean {
	return Boolean(sharedState().running);
}

function checkOnce(state: SharedState, provider: string, run: () => Promise<LimitsAccount>): Promise<LimitsAccount> {
	const running = state.perAccount.get(provider);
	if (running) return running;
	const started = run().finally(() => {
		if (state.perAccount.get(provider) === started) state.perAccount.delete(provider);
	});
	state.perAccount.set(provider, started);
	return started;
}

/**
 * Check every account, in parallel, at most one check per account at a time. A call while a
 * check runs joins it. The result is written whole to the shared file and announced.
 */
export function checkAllLimits(host: LimitsHost, options: CheckOptions): Promise<LimitsReadings> {
	const state = sharedState();
	if (state.running) return state.running;
	const o = resolveOptions(options);
	const run = (async () => {
		await Promise.resolve(); // let state.running be set before anyone hears about it
		const previous = readLimitsReadings(o.file);
		emit({ checking: true, readings: previous });
		const slots = listAccounts(host, previous, o.now());
		const rows = await Promise.all(slots.map((slot) => checkOnce(state, slot.provider,
			() => checkAccount(host, slot, previous?.accounts.find((a) => a.provider === slot.provider), options))));
		// A reply may have brought newer numbers while the check ran: keep the newer ones.
		const current = readLimitsReadings(o.file);
		const accounts = rows.map((row) => {
			const fresher = current?.accounts.find((a) => a.provider === row.provider);
			return fresher?.checkedAt !== undefined && (row.checkedAt === undefined || fresher.checkedAt > row.checkedAt)
				? { ...row, windows: fresher.windows, limited: fresher.limited, checkedAt: fresher.checkedAt, source: fresher.source }
				: row;
		});
		const now = o.now();
		const readings: LimitsReadings = { version: 1, updatedAt: now, checkedAt: now, accounts };
		writeLimitsReadings(o.file, readings);
		return readings;
	})();
	state.running = run;
	const settle = () => {
		if (state.running === run) state.running = undefined;
		emit({ checking: false, readings: readLimitsReadings(o.file) });
	};
	run.then(settle, settle);
	return run;
}

function sameWindow(a: LimitWindow | undefined, b: LimitWindow): boolean {
	return Boolean(a) && Math.abs((a!.usedPercent ?? -1) - (b.usedPercent ?? -1)) < 0.5
		&& Math.abs((a!.resetAt ?? 0) - (b.resetAt ?? 0)) <= 60 && Boolean(a!.limited) === Boolean(b.limited);
}

/**
 * Numbers seen in a normal reply (free): update that account's row. Only rows a check has
 * created are updated, so before the first check there is nothing to show but "not checked yet".
 */
export function recordReplyLimits(file: string, provider: string, windows: LimitWindow[], now = Date.now()): boolean {
	if (!windows.some((w) => w.usedPercent !== undefined)) return false;
	const readings = readLimitsReadings(file);
	const row = readings?.accounts.find((a) => a.provider === provider);
	if (!readings || !row) return false;
	// The account-wide windows, plus per-model ones the usage page already showed: a reply
	// never adds a window the page doesn't have.
	const usable = windows.filter((w) => w.usedPercent !== undefined
		&& (w.key === "5h" || w.key === "7d" || row.windows.some((x) => x.key === w.key)));
	if (usable.length === 0) return false;
	const changed = usable.some((w) => !sameWindow(row.windows.find((x) => x.key === w.key), w));
	if (!changed && !row.failure && row.checkedAt !== undefined && now - row.checkedAt < REPLY_WRITE_INTERVAL_MS) return false;
	const merged = [...row.windows];
	for (const w of usable) {
		const index = merged.findIndex((x) => x.key === w.key);
		if (index >= 0) merged[index] = { ...w, label: merged[index].label };
		else merged.push(w);
	}
	Object.assign(row, {
		windows: merged, limited: merged.some((w) => w.limited) || undefined,
		checkedAt: now, source: "reply", failure: undefined,
	});
	readings.updatedAt = now;
	writeLimitsReadings(file, readings);
	emit({ checking: limitsChecking(), readings });
	return true;
}

/** A chat offers its sign-in store for checks; the returned function withdraws it. */
export function registerLimitsHost(host: LimitsHost): () => void {
	const state = sharedState();
	state.hosts.push(host);
	return () => {
		const index = state.hosts.indexOf(host);
		if (index >= 0) state.hosts.splice(index, 1);
		state.fallback = host;
	};
}

/** Publish the v1 API on the channel (the latest loaded copy wins; all copies agree). */
export function installLimitsApi(options: CheckOptions): LimitsApiV1 {
	const state = sharedState();
	const api: LimitsApiV1 = {
		file: options.file,
		check: () => {
			const host = state.hosts.at(-1) ?? state.fallback;
			return host
				? checkAllLimits(host, options)
				: Promise.reject(new Error("No chat has loaded pi-multi-pass yet; open a chat and try again."));
		},
		readings: () => readLimitsReadings(options.file),
		checking: limitsChecking,
	};
	limitsChannel().api = api;
	return api;
}

// ==========================================================================
// Text for `/subs limit-check` and the chat's `multi-pass-subs` box
// ==========================================================================

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function formatAgo(at: number | undefined, now = Date.now()): string | undefined {
	if (at === undefined || !Number.isFinite(at)) return undefined;
	const ms = Math.max(0, now - at);
	if (ms < MINUTE) return "just now";
	if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
	if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
	return `${Math.floor(ms / DAY)} d ago`;
}

/** `Weekly 40% used, resets in 4d 2h`. */
export function formatLimitWindow(w: LimitWindow, now = Date.now()): string {
	const used = w.usedPercent === undefined ? "?" : `${Math.round(w.usedPercent)}% used`;
	const reset = w.resetAt === undefined ? undefined : formatResetIn(w.resetAt, now);
	const tail = reset === "due" ? ", has reset since" : reset ? `, resets ${reset}` : "";
	return `${w.label} ${used}${tail}`;
}

export function formatAccountLine(a: LimitsAccount, now = Date.now(), current = false): string {
	const who = [a.name, a.plan, a.label ?? a.email].filter(Boolean).join(" · ") + (current ? " (this chat)" : "");
	const windows = a.windows.map((w) => formatLimitWindow(w, now)).join(" · ");
	const parts: string[] = [];
	if (a.failure) {
		parts.push(a.failure.text);
		if (windows) parts.push(`last numbers ${formatAgo(a.checkedAt, now) ?? "earlier"}: ${windows}`);
	} else {
		parts.push(windows || "no numbers yet");
	}
	if (a.limited) parts.push("LIMITED");
	if (!a.failure && a.checkedAt !== undefined) parts.push(`checked ${formatAgo(a.checkedAt, now)}`);
	return `${who} — ${parts.join(" · ")}`;
}

export function formatLimitsText(
	readings: LimitsReadings | undefined, options: { now?: number; current?: string } = {},
): string {
	const now = options.now ?? Date.now();
	if (!readings?.checkedAt) return "Limits: not checked yet. Run /subs limit-check.";
	return [`Limits · ${readings.accounts.length} account(s) · checked ${formatAgo(readings.checkedAt, now)}`]
		.concat(readings.accounts.map((a) => `  ${formatAccountLine(a, now, a.provider === options.current)}`))
		.join("\n");
}

/** `Limits: checked 4 of 4 accounts` (+ which failed, and why). */
export function limitsCheckSummary(readings: LimitsReadings): { text: string; failed: number } {
	const failed = readings.accounts.filter((a) => a.failure);
	const ok = readings.accounts.length - failed.length;
	const why = failed.map((a) => `${a.name}: ${a.failure!.text}`).join("; ");
	return {
		text: `Limits: checked ${ok} of ${readings.accounts.length} accounts${why ? ` (${why})` : ""}.`,
		failed: failed.length,
	};
}

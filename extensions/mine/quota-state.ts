/** Credential-free quota observations. Provider adapters supply facts; policies consume them. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QuotaWindow {
	name: string;
	scope: "account" | "model";
	modelId?: string;
	modelFamily?: string;
	usedPercent?: number;
	resetAt?: number; // Unix seconds
	limited?: boolean;
	observedAt: number; // Unix milliseconds
}
export interface QuotaFailure {
	modelId: string;
	failedAt: number;
	retryAt: number; // eligibility deadline, NOT proof that quota recovered
	attempts: number;
	observedAt: number;
	succeededAt?: number; // confirmed HTTP success after this failure, independent of quota headers
}
export interface QuotaState {
	version: 1;
	windows: QuotaWindow[];
	failures: QuotaFailure[];
}
export const emptyQuotaState = (): QuotaState => ({ version: 1, windows: [], failures: [] });
const DAY = 86400000;
const RETENTION = 14 * DAY;
const MAX_WINDOWS = 64;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const object = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const windowKey = (w: QuotaWindow) => JSON.stringify([w.name, w.scope, w.modelId, w.modelFamily]);

/** No raw credentials or credential-derived IDs are written to the snapshot body. */
export function quotaAccountKey(provider: string, credential: unknown): string | undefined {
	const auth = object(credential);
	if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access) return undefined;
	// Prefer stable account identity when supplied by the host. Opaque OAuth credentials
	// otherwise invalidate snapshots on refresh/re-login rather than risk cross-account reuse.
	const identity = text(auth.accountId) ? auth.accountId : typeof auth.refresh === "string" && auth.refresh ? auth.refresh : auth.access;
	return createHash("sha256").update(JSON.stringify([provider, identity])).digest("hex");
}

/** Strict allow-list also prevents arbitrary raw header/error fields entering persisted state. */
export function sanitizeQuotaState(raw: unknown, now = Date.now()): QuotaState {
	const obj = object(raw), result = emptyQuotaState();
	if (obj?.version !== 1) return result;
	const timestamp = (v: unknown): v is number => finite(v) && v > now - RETENTION && v <= now + 60000;
	for (const entry of Array.isArray(obj.windows) ? obj.windows.slice(0, MAX_WINDOWS) : []) {
		const w = object(entry);
		if (!w || !text(w.name) || !timestamp(w.observedAt) || !["account", "model"].includes(String(w.scope))) continue;
		if (w.scope === "model" && !text(w.modelId) && !text(w.modelFamily)) continue;
		const usedPercent = finite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 10000 ? w.usedPercent : undefined;
		const resetAt = finite(w.resetAt) && w.resetAt > 0 && w.resetAt * 1000 <= now + RETENTION ? w.resetAt : undefined;
		const limited = typeof w.limited === "boolean" ? w.limited : undefined;
		if (usedPercent === undefined && resetAt === undefined && limited === undefined) continue;
		result.windows.push({ name: w.name, scope: w.scope as QuotaWindow["scope"],
			modelId: text(w.modelId) ? w.modelId : undefined, modelFamily: text(w.modelFamily) ? w.modelFamily : undefined,
			usedPercent, resetAt, limited, observedAt: w.observedAt });
	}
	for (const entry of Array.isArray(obj.failures) ? obj.failures.slice(0, MAX_WINDOWS) : []) {
		const f = object(entry);
		if (!f || !text(f.modelId) || !timestamp(f.observedAt) || !timestamp(f.failedAt)
			|| !finite(f.retryAt) || f.retryAt < f.failedAt || f.retryAt > now + RETENTION
			|| !finite(f.attempts) || f.attempts < 1 || f.attempts > 16) continue;
		result.failures.push({ modelId: f.modelId, failedAt: f.failedAt, retryAt: f.retryAt,
			attempts: Math.floor(f.attempts), observedAt: f.observedAt,
			succeededAt: timestamp(f.succeededAt) && f.succeededAt > f.failedAt && f.succeededAt <= f.observedAt ? f.succeededAt : undefined });
	}
	return result;
}

export function mergeQuotaStates(states: QuotaState[], now = Date.now()): QuotaState {
	const windows = new Map<string, QuotaWindow>(), failures = new Map<string, QuotaFailure>();
	for (const state of states) {
		for (const w of sanitizeQuotaState(state, now).windows) {
			const key = windowKey(w), old = windows.get(key);
			if (!old || w.observedAt >= old.observedAt) windows.set(key, w);
		}
		for (const f of sanitizeQuotaState(state, now).failures) {
			const old = failures.get(f.modelId);
			// A delayed clearance of F1 cannot overwrite F2, even if its write arrives later.
			if (!old || f.failedAt > old.failedAt || f.failedAt === old.failedAt && f.observedAt >= old.observedAt) failures.set(f.modelId, f);
		}
	}
	return { version: 1,
		windows: [...windows.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, MAX_WINDOWS),
		failures: [...failures.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, MAX_WINDOWS) };
}

export function windowApplies(window: QuotaWindow, modelId: string): boolean {
	return window.scope === "account" || window.modelId === modelId
		|| Boolean(window.modelFamily && modelId.toLowerCase().split(/[-_.]/).includes(window.modelFamily.toLowerCase()));
}

/** Past-reset percentages are stale observations, never a fabricated zero-percent new window. */
export function windowIsCurrent(window: QuotaWindow, now = Date.now(), maxAgeMs = DAY): boolean {
	return now - window.observedAt <= maxAgeMs && window.observedAt <= now + 60000
		&& (window.resetAt === undefined || window.resetAt * 1000 > now);
}

export function quotaBlocked(state: QuotaState, modelId: string, now = Date.now()): boolean {
	return state.windows.some((w) => windowApplies(w, modelId)
		&& (w.limited === true || (w.usedPercent ?? -1) >= 100)
		// Keep an explicit block until its real deadline, even when the snapshot is old.
		&& (w.resetAt !== undefined ? w.resetAt * 1000 > now : now - w.observedAt < 5 * 60000))
		|| state.failures.some((f) => f.modelId === modelId && f.retryAt > now);
}

export function failureObservation(state: QuotaState, modelId: string, now = Date.now()): QuotaFailure {
	const old = state.failures.find((f) => f.modelId === modelId);
	const successSinceFailure = old && old.succeededAt !== undefined && old.succeededAt > old.failedAt;
	const attempts = old && !successSinceFailure ? Math.min(old.attempts + 1, 16) : 1;
	const resets = state.windows.filter((w) => windowApplies(w, modelId)
		&& (w.limited === true || (w.usedPercent ?? -1) >= 100) && w.resetAt !== undefined && w.resetAt * 1000 > now)
		.map((w) => w.resetAt! * 1000 + 1000);
	return { modelId, failedAt: now, observedAt: now, attempts,
		retryAt: resets.length ? Math.max(...resets) : now + Math.min(5 * 60000 * 2 ** (attempts - 1), 60 * 60000) };
}

/**
 * Per-writer shards avoid read/modify/write races between pi-web-ui conversations/processes.
 * Merge by observation time, not file mtime. Only this store's private cache directory is touched.
 * I/O failure degrades to session memory; it must never break a model request.
 */
export class QuotaStateStore {
	private writer = randomUUID();
	private memory = new Map<string, QuotaState>();
	private directory: string;
	private clock: () => number;
	constructor(directory: string, clock = () => Date.now()) { this.directory = directory; this.clock = clock; }

	get(key: string | undefined): QuotaState {
		if (!key || !/^[a-f0-9]{64}$/.test(key)) return emptyQuotaState();
		const now = this.clock(), states = [this.memory.get(key) ?? emptyQuotaState()];
		try {
			const dir = join(this.directory, key);
			const files = readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
				.map((name) => ({ name, info: statSync(join(dir, name)) }))
				.filter(({ info }) => info.size <= 65536 && info.mtimeMs > now - RETENTION)
				.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 256);
			for (const { name } of files) {
				try { states.push(sanitizeQuotaState(JSON.parse(readFileSync(join(dir, name), "utf8")), now)); } catch { /* ignore one corrupt shard */ }
			}
		} catch { /* no persisted observations, or unavailable disk */ }
		const state = mergeQuotaStates(states, now);
		this.memory.set(key, state);
		return state;
	}

	update(key: string | undefined, patch: Partial<Pick<QuotaState, "windows" | "failures">>): QuotaState {
		if (!key || !/^[a-f0-9]{64}$/.test(key)) return emptyQuotaState();
		const state = mergeQuotaStates([this.get(key), { version: 1, windows: patch.windows ?? [], failures: patch.failures ?? [] }], this.clock());
		this.memory.set(key, state);
		const dir = join(this.directory, key), target = join(dir, `${this.writer}.json`), temp = `${target}.tmp`;
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
			renameSync(temp, target);
			// Expired shards cannot influence routing; bounded cleanup prevents indefinite growth.
			for (const name of readdirSync(dir).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 256)) {
				try { if (statSync(join(dir, name)).mtimeMs < this.clock() - RETENTION) unlinkSync(join(dir, name)); } catch { /* another writer cleaned up */ }
			}
		} catch { try { unlinkSync(temp); } catch { /* memory remains usable */ } }
		return state;
	}
}

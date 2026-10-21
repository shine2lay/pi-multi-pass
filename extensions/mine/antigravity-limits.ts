/** Read-only compatibility for the external pi-antigravity provider (canonical id: antigravity).
 * Wire schemas: pi-antigravity src/usage/usage.ts and src/types/types.ts.
 * Never registers a provider, reads its account store, selects an account or refreshes OAuth.
 * Shared groups are not account-wide or private per-model allowances. Unknown != zero.
 */
import type { ModelLimitsData, LimitWindow } from "./current-model-limits.ts";

export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const USER_AGENT = "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";
const object = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const name = (v: unknown, fallback: string): string =>
	typeof v === "string" && /^[\p{L}\p{N} ._:+/()\-]{1,80}$/u.test(v) ? v : fallback;
const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const reset = (v: unknown): string | undefined => {
	const ms = typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};

/** Public usage response groups[].buckets[], or catalog models[*].quotaInfo as fallback.
 * Only finite fractions count; a bucket id without a number is not evidence of exhaustion.
 */
export function antigravityModelLimits(data: unknown, catalog = false): ModelLimitsData {
	const raw = object(data), windows: LimitWindow[] = [];
	let unknown = 0;
	if (!catalog) {
		for (const [g, value] of (Array.isArray(raw?.groups) ? raw.groups : []).entries()) {
			const group = object(value);
			for (const [b, item] of (Array.isArray(group?.buckets) ? group.buckets : []).entries()) {
				const bucket = object(item);
				if (!fraction(bucket?.remainingFraction)) { unknown++; continue; }
				windows.push({ name: `Shared ${name(group?.displayName, `group ${g + 1}`)} / ${name(bucket?.displayName ?? bucket?.window ?? bucket?.bucketId, `bucket ${b + 1}`)}`,
					remainingPercent: bucket.remainingFraction * 100, usedPercent: (1 - bucket.remainingFraction) * 100,
					resetAt: reset(bucket.resetTime) });
			}
		}
	} else {
		for (const [id, value] of Object.entries(object(raw?.models) ?? {})) {
			const info = object(value);
			if (!info || info.isInternal || /^(chat_|tab_)/i.test(id)) continue;
			const quota = object(info.quotaInfo);
			if (!fraction(quota?.remainingFraction)) { unknown++; continue; }
			windows.push({ name: `Shared model bucket: ${name(id, "unknown model")}`,
				remainingPercent: quota.remainingFraction * 100, usedPercent: (1 - quota.remainingFraction) * 100,
				resetAt: reset(quota.resetTime) });
		}
	}
	return {
		status: windows.length ? "available" : "unavailable", scope: "provider-model-buckets",
		source: `Antigravity ${catalog ? "fetchAvailableModels" : "retrieveUserQuotaSummary"}`,
		windows: windows.slice(0, 20), omittedWindows: Math.max(0, windows.length - 20),
		note: "Provider-reported shared quota groups/buckets; not a private allowance for the selected model. "
			+ "Group-to-model mapping and account-wide exhaustion are unknown."
			+ (unknown ? ` ${unknown} bucket(s) have unknown usage.` : ""),
	};
}

function endpoints(env: Record<string, string | undefined>): string[] {
	const explicit = (env.ANTIGRAVITY_BASE_URL ?? env.NOAGY_BASE_URL)?.trim();
	if (!explicit) return ANTIGRAVITY_ENDPOINTS;
	const url = new URL(explicit);
	if (url.protocol !== "https:" || url.username || url.password
		|| !(url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))) throw new Error("Unsafe quota endpoint");
	return [`${url.origin}${url.pathname.replace(/\/+$/, "")}`];
}

export async function checkAntigravityLimits(
	credential: { type?: string; access?: unknown; expires?: unknown; projectId?: unknown } | undefined,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	env: Record<string, string | undefined> = process.env,
) {
	const failure = (summary: string, kind: "error" | "missing-auth" = "error") => ({
		kind, summary, score: 0, details: [summary],
		limits: { status: "unavailable", scope: "unknown", windows: [], note: summary } as ModelLimitsData,
	});
	if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access
		|| typeof credential.expires === "number" && credential.expires <= Date.now()) {
		return failure("Authentication is missing or expired; use /login antigravity.", "missing-auth");
	}
	// Refresh, when necessary, is the caller's Pi ModelRegistry.getProviderAuth responsibility.
	const querySignal = signal ?? AbortSignal.timeout(5000);
	let last = "Antigravity quota unavailable (no answer).";
	try {
		for (const endpoint of endpoints(env)) {
			for (const catalog of [false, true]) {
				if (catalog && (typeof credential.projectId !== "string" || !credential.projectId)) continue;
				try {
					querySignal.throwIfAborted();
					const response = await fetchImpl(`${endpoint}/v1internal:${catalog ? "fetchAvailableModels" : "retrieveUserQuotaSummary"}`, {
						method: "POST", redirect: "error", signal: querySignal,
						headers: { Authorization: `Bearer ${credential.access}`, "Content-Type": "application/json", Accept: "application/json",
							"User-Agent": env.ANTIGRAVITY_USER_AGENT ?? env.NOAGY_USER_AGENT ?? USER_AGENT },
						body: JSON.stringify(catalog ? { project: credential.projectId } : {}),
					});
					if (!response.ok) {
						last = `Antigravity quota unavailable (HTTP ${response.status}).`;
						if (response.status === 401 || response.status === 429) return failure(last);
						continue; // aggregate summary may be unavailable on free tier; try model buckets
					}
					const limits = antigravityModelLimits(await response.json(), catalog);
					if (limits.status !== "available") { last = "Antigravity quota unavailable (no known usage in reply)."; continue; }
					// No global limited verdict: an empty shared bucket need not limit the selected model.
					return { kind: "available" as const, summary: limits.note!, details: [limits.note!], score: 0, limits,
						// Preserve shared scope in the Limits box too: its generic converter assumes
						// any full window limits the entire account, which these buckets cannot prove.
						usageWindows: limits.windows.map((w, i) => ({ key: `ag:${i}`, label: w.name.slice(0, 60),
							usedPercent: w.usedPercent, resetAt: w.resetAt ? Date.parse(w.resetAt) / 1000 : undefined })),
					};
				} catch {
					if (querySignal.aborted) return failure("Antigravity quota check timed out or was cancelled.");
					// Never expose the fetch error or a response body: either can contain credentials.
				}
			}
		}
	} catch { return failure("Antigravity quota endpoint configuration is invalid."); }
	return failure(last);
}

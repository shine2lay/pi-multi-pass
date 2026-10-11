// mine/env-allowed-subs: limit one pi process to named subscriptions with an environment variable.
//
// MULTI_PASS_ALLOWED_SUBS="anthropic-4" (provider names, comma-separated) acts like a project's
// .pi/multi-pass.json "allowedSubs", for that process only. pi still registers every subscription, but
// the effective config leaves the others out: pools keep only the listed members, chains drop the pools
// left empty, a session or model on another provider is moved onto a listed one (or refused), and the
// refusal fallback can't leave the list. So rotation, failover and fallback all stay inside it.
// Unset or blank: no change, so chats (which never set it) are as before.
// It replaces a project file's allowedSubs (the variable is the narrower, deliberate choice) and keeps
// the file's other keys. Plain node (no pi imports): tests/env-allowed-subs-check.mjs imports it.

export const ALLOWED_SUBS_ENV = "MULTI_PASS_ALLOWED_SUBS";

type Env = Record<string, string | undefined>;

/** The listed provider names, trimmed and without repeats; undefined when unset or blank. */
export function envAllowedSubs(env: Env = process.env): string[] | undefined {
	const raw = env[ALLOWED_SUBS_ENV];
	if (typeof raw !== "string") return undefined;
	const names = [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))];
	return names.length > 0 ? names : undefined;
}

/** The project config as loaded from its file (or undefined), with the variable's list applied. */
export function withEnvAllowedSubs<T extends { allowedSubs?: string[] }>(project: T | undefined, env: Env = process.env): T | undefined {
	const names = envAllowedSubs(env);
	if (!names) return project;
	return { ...(project ?? ({} as T)), allowedSubs: names };
}

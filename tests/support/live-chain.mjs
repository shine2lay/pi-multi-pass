// The live account chain as a fixture for support/chain-world.mjs: ~/.pi/agent/multi-pass.json as live since
// 2026-11-02 (Codex replaced by Sign in with ChatGPT), the models pi has for it, and provider texts seen live.
// Shared by tests/chatgpt-limit-continue-check.mjs and tests/antigravity-chain-entries-check.mjs.

export const CLAUDE = "claude-opus-5-5", SOL = "gpt-6.1-sol", ARGON = "gemini-4-argon";
export const MEMBERS = ["anthropic", "anthropic-2", "anthropic-3", "anthropic-4"];
export const GPT = { provider: "openai", id: SOL };
export const ARGON_MODEL = { provider: "antigravity", id: ARGON };
export const ANTIGRAVITY_CLAUDE = { provider: "antigravity", id: CLAUDE };

/** The live config: claude-real -> chatgpt-fallback -> antigravity-fallback (Argon, then Claude on Antigravity). */
export const LIVE_CONFIG = {
	subscriptions: [], presets: [],
	pools: [
		{ name: "claude-real", baseProvider: "anthropic", members: MEMBERS, enabled: true,
			quotaRouting: { policy: "weekly-first", recovery: "off", minWeeklyResetAdvantageMinutes: 0, maxObservationAgeMinutes: 1440 } },
		{ name: "chatgpt-fallback", baseProvider: "openai", members: ["openai"], enabled: true, returnOnRefusal: true, fallback: false },
		{ name: "antigravity-fallback", baseProvider: "antigravity", members: ["antigravity"], enabled: true, fallback: false,
			returnOnRefusal: true },
	],
	chains: [
		{ name: "claude-then-sol", enabled: true, entries: [{ pool: "claude-real", model: CLAUDE, enabled: true },
			{ pool: "chatgpt-fallback", model: SOL, enabled: true }, { pool: "antigravity-fallback", model: ARGON, enabled: true },
			{ pool: "antigravity-fallback", model: CLAUDE, enabled: true }] },
		{ name: "fable-then-opus", enabled: false, entries: [{ pool: "claude-real", model: "claude-fable-5-1", enabled: true },
			{ pool: "claude-real", model: "claude-opus-5", enabled: true }] },
	],
	refusalFallback: { enabled: true, provider: "openai", model: SOL },
};

/** pi-ai's built-in catalog: anthropic and openai only. pi-ai has no "antigravity" provider. */
export const LIVE_BUILTIN = { anthropic: [CLAUDE, "claude-fable-5-1", "claude-opus-5"], openai: [SOL] };
/** pi-antigravity registers "antigravity" through pi.registerProvider: only pi's live registry holds it. */
export const LIVE_REGISTERED = [ARGON_MODEL, ANTIGRAVITY_CLAUDE];

/** pi-ai's text for the Sign in with ChatGPT limit (dist/api/openai-responses.js: formatProviderError + the usage
 * link): status 429, then the SDK error body. Only the body's code is the provider's; message and type are placeholders. */
export const CHATGPT_LIMIT = 'OpenAI API error (429): {"message":"...","type":"...","param":null,'
	+ '"code":"subscription_sharing_usage_limit_exceeded"}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage';
/** pi-antigravity's Argon quota text, as nine chats got it on 2026-11-02 at 17:13 PST (wait time varies). */
export const ARGON_QUOTA = "Quota reached. Please wait 85h43m35s. Next: switch models or try again after reset.";

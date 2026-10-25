/** mine/continue-after-note: which message before a failed reply lets the run continue once.
 *
 * fallback-return, refusal-fallback and signin-failover leave the failed reply out of the context and
 * continue the run, without replaying the prompt. Pi can continue only from fresh input: the user's
 * prompt, a tool result, or a custom message. A custom message is a Board or role note
 * (custom_message entry, role "custom"); pi's convertToLlm sends it to the model as user input.
 *
 * Until Ops #555 (2026-10-25) the guards took only user and toolResult, so a Board note delivered
 * between a queued task's prompt and its refused first reply stopped the turn: the chat moved from the
 * limited GPT account to Claude but did not continue (Ops #553, #554).
 * An assistant message (or any other role) before the failed reply still never continues.
 * No pi imports, so plain node can test it.
 */
const FRESH_INPUT_ROLES: ReadonlySet<string> = new Set(["user", "toolResult", "custom"]);

export function isFreshInput(role: string | undefined): boolean {
	return typeof role === "string" && FRESH_INPUT_ROLES.has(role);
}

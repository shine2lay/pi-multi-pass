// pi 1.2.0+ fires before_agent_start for runs an extension starts with a custom message
// (pi.sendMessage(..., { triggerTurn: true })). That event has messageType "custom" and no prompt.
// Such a run must never overwrite the prompt multi-sub.ts keeps for a replay after a pool switch
// (multi-sub.ts `lastUserPrompt`, replayed by sendUserMessage when pi will not retry the error).
// Acceptance test for the pi 1.0.1 -> 1.5.2 upgrade (Ops #857, plan ~/ops-checks/pi-1-5-upgrade-2026-11-12/).
// Plain node; no network (fetch throws), fake credentials only, no model calls.
import assert from "node:assert/strict";
import { blockNetwork, chainWorld, loadSources } from "./support/chain-world.mjs";

const sources = await loadSources(process.env.CUSTOM_TURN_SOURCE_REF);
const network = blockNetwork("custom-message turn checks");

const CLAUDE = "claude-opus-5-5";
const MEMBERS = ["anthropic", "anthropic-2"];
// A limit text pi never retries (no HTTP status), so multi-sub.ts replays the prompt on the next member.
const LIMIT = "usage limit reached";
const PROMPT = "fix the login bug";

const world = (run) => chainWorld({
	sources,
	config: { subscriptions: [], presets: [], chains: [],
		pools: [{ name: "claude", baseProvider: "anthropic", members: MEMBERS, enabled: true }] },
	quotaMembers: MEMBERS, room: ["anthropic-2"], builtin: { anthropic: [CLAUDE] },
	start: { provider: "anthropic", id: CLAUDE },
}, run);

const cases = [
	["control: a plain user turn replays its own prompt after the pool switch", (c) => c.prompt(PROMPT)],
	["a custom-message turn after the user's prompt leaves the stored prompt alone", async (c) => {
		await c.prompt(PROMPT);
		await c.customTurn("[queue] task #12 finished");
	}],
];

let failed = 0;
try {
	for (const [name, turns] of cases) {
		try {
			await world(async (c) => {
				await turns(c);
				await c.fail(LIMIT);
				assert.equal(c.model.provider, "anthropic-2", `pool switch expected: ${c.path.join(" -> ")}`);
				assert.deepEqual(c.replayed, [PROMPT], "the replay after the switch is the user's last typed prompt");
			});
			console.log(`ok    ${name}`);
		} catch (error) {
			failed++;
			console.log(`FAIL  ${name}\n      ${String(error.message).split("\n").join("\n      ")}`);
		}
	}
	assert.deepEqual(network.modelCalls(), [], "no model calls");
} finally {
	network.restore();
}
if (failed) {
	console.error(`custom-message turn: ${failed} of ${cases.length} cases failed`);
	process.exit(1);
}
console.log("custom-message turn: a custom run never overwrites the stored last prompt");

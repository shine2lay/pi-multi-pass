import assert from "node:assert/strict";
import {
  formatDuration, formatResetIn, formatResetPhrase, withResetCountdown,
} from "../extensions/mine/reset-countdown.ts";
import { codexModelLimits, formatModelLimits } from "../extensions/mine/current-model-limits.ts";

/* reset-countdown: "resets in 4d 15h" next to every absolute reset stamp. */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/* --- formatDuration: two units, coarse on purpose --- */
assert.equal(formatDuration(0), "<1m");
assert.equal(formatDuration(30_000), "<1m");
assert.equal(formatDuration(7 * MIN + 30_000), "7m");
assert.equal(formatDuration(3 * HOUR), "3h", "whole hours drop the minutes");
assert.equal(formatDuration(3 * HOUR + 12 * MIN), "3h 12m");
assert.equal(formatDuration(4 * DAY + 15 * HOUR + 59 * MIN), "4d 15h", "minutes are noise next to days");
assert.equal(formatDuration(6 * DAY), "6d");
assert.equal(formatDuration(-1), undefined, "negative has no duration");
assert.equal(formatDuration(Number.NaN), undefined);
assert.equal(formatDuration(Number.POSITIVE_INFINITY), undefined);

/* --- formatResetIn: ISO string or Unix seconds, never invents fresh quota --- */
const now = Date.parse("2026-09-14T20:00:00.000Z");
assert.equal(formatResetIn("2026-09-19T11:13:35.000Z", now), "in 4d 15h");
assert.equal(formatResetIn(Math.floor(Date.parse("2026-09-14T23:12:00.000Z") / 1000), now), "in 3h 12m");
assert.equal(formatResetIn("2026-09-14T20:00:40.000Z", now), "in <1m");
assert.equal(formatResetIn("2026-09-14T19:00:00.000Z", now), "due", "a passed deadline is 'due', not fresh quota");
assert.equal(formatResetIn("2026-09-14T20:00:00.000Z", now), "due", "exactly now is due");
assert.equal(formatResetIn(undefined, now), undefined);
assert.equal(formatResetIn("not a date", now), undefined);
assert.equal(formatResetIn(0, now), undefined, "0 seconds = not reported");
assert.equal(formatResetIn(-5, now), undefined);

/* --- formatResetPhrase: relative first, absolute always kept --- */
assert.equal(
  formatResetPhrase("2026-09-19T11:13:35.000Z", "09-19 11:13Z", now),
  "resets in 4d 15h (09-19 11:13Z)",
);
assert.equal(formatResetPhrase(undefined, undefined, now), "resets unknown");
assert.equal(
  formatResetPhrase("nonsense", "09-19 11:13Z", now), "resets 09-19 11:13Z",
  "unparsable reset time keeps the absolute stamp alone",
);
assert.equal(formatResetPhrase("2026-09-19T11:13:35.000Z", undefined, now), "resets in 4d 15h");

/* --- footer: countdown AND the old absolute stamp --- */
const report = {
  ...codexModelLimits({
    limited: false,
    weekly: { usedPercent: 37, resetAt: Date.parse("2026-09-19T11:13:35.000Z") / 1000 },
    fiveHour: { usedPercent: 10, resetAt: Date.parse("2026-09-14T23:12:00.000Z") / 1000 },
  }),
  provider: "codex", model: "gpt-6-astra", checkedAt: new Date(now).toISOString(), cached: false,
};
const footer = formatModelLimits(report, now);
assert.match(footer, /5h 90% left, resets in 3h 12m \(09-14 23:12Z\)/);
assert.match(footer, /7d 63% left, resets in 4d 15h \(09-19 11:13Z\)/);
// The quota is the subscription's, so the label is the provider slot, never the model.
assert.match(footer, /^codex \(account\):/);
assert.ok(!footer.includes("gpt-6-astra"), "account windows never name the selected model");
// ...except a model-scoped window (e.g. an Opus-only cap), where the model is the point.
const modelWindow = formatModelLimits({
  ...report, scope: "account-and-model",
  windows: [{ name: "7d", remainingPercent: 40, scope: "model", resetAt: "2026-09-16T21:00:00.000Z" }],
}, now);
assert.match(modelWindow, /^codex \(account \+ model\): gpt-6-astra 7d 40% left, resets in 2d 1h/);

const noReset = { ...report, windows: [{ name: "7d", remainingPercent: 50 }] };
assert.match(formatModelLimits(noReset, now), /7d 50% left, resets unknown/, "missing reset time stays explicit");
assert.equal(
  formatModelLimits({ ...report, status: "unsupported" }, now),
  "codex: limits unavailable", "unsupported providers gain no countdown",
);

/* --- tool output: machine-readable countdown per window --- */
const decorated = withResetCountdown(report, now);
assert.equal(decorated.windows[1].resetsIn, "in 4d 15h");
assert.equal(decorated.windows[1].resetsInSeconds, Math.round((Date.parse("2026-09-19T11:13:35.000Z") - now) / 1000));
assert.equal(decorated.windows[1].resetAt, "2026-09-19T11:13:35.000Z", "absolute stamp is preserved");
assert.equal(decorated.status, report.status);
assert.equal(decorated.windows.length, report.windows.length);
assert.equal(
  withResetCountdown({ ...report, windows: [{ name: "7d", remainingPercent: 50 }] }, now).windows[0].resetsIn,
  undefined, "no reset time = no countdown field",
);
const past = withResetCountdown({ ...report, windows: [{ name: "7d", resetAt: "2026-09-14T19:00:00.000Z" }] }, now);
assert.equal(past.windows[0].resetsIn, "due");
assert.equal(past.windows[0].resetsInSeconds, 0, "a passed deadline never reports negative seconds");
assert.notEqual(report.windows[0].resetsIn !== undefined, true, "source report is not mutated");

console.log("reset-countdown-check: ok");

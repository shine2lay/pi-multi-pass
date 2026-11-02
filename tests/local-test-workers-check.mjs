// Synthetic plain executables only: no provider imports, payloads or network calls.
// Reusable adapter proof: --temper-root PATH checks test/*-test.mjs/fail-fast instead.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const temper = process.argv[2] === "--temper-root";
const root = temper ? resolve(process.argv[3]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = temper ? "test" : "tests";
const suffix = temper ? "-test.mjs" : ".mjs";
const fixture = mkdtempSync(join(tmpdir(), "native-test-workers-"));
const resources = join(fixture, "resources");
const names = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, "0")}${i === 11 ? " space" : ""}${suffix}`);
const source = `
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(globalThis.fixtureChanged, undefined);
assert.equal(process.env.FIXTURE_CHANGED, undefined);
globalThis.fixtureChanged = true;
process.env.FIXTURE_CHANGED = "yes";
const name = basename(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(process.env.RESOURCES, "child-"));
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => { rmSync(dir, { recursive: true, force: true }); process.exit(code); });
}
try {
  await fetch(process.env.PROBE + "/start?name=" + encodeURIComponent(name) + "&pid=" + process.pid);
  await fetch(process.env.PROBE + "/end?name=" + encodeURIComponent(name));
  if (name === process.env.FAIL_FILE) process.exitCode = 7;
} finally { rmSync(dir, { recursive: true, force: true }); }
`;

// Scrub policy and Node's nested-run marker: this proof itself also runs under --test.
const cleanEnv = { ...process.env };
for (const key of ["CI", "GITHUB_ACTIONS", "WT_CHECK_WORKERS", "NODE_TEST_CONTEXT", "FAIL_FILE", "FIXTURE_CHANGED"]) delete cleanEnv[key];

async function check(label, { workers = 10, policy = {}, fail = false, invalid = false, interrupt } = {}) {
  const expected = invalid ? 0 : fail && temper && workers === 1 ? 1 : names.length;
  const seen = [];
  const pids = [];
  let active = 0;
  let peak = 0;
  let ended = 0;
  let released = 0;
  let pending = [];
  let child;
  let timedOut = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/start") {
      seen.push(url.searchParams.get("name"));
      pids.push(Number(url.searchParams.get("pid")));
      active++;
      peak = Math.max(peak, active);
      pending.push(res);
      // A barrier, not a sleep: the declared worker count must actually start.
      if (pending.length === Math.min(workers, expected - released)) {
        if (interrupt) {
          process.kill(-child.pid, interrupt);
        } else {
          released += pending.length;
          for (const response of pending) response.end("go");
          pending = [];
        }
      }
    } else {
      active--;
      ended++;
      res.end("done");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    child = spawn("bash", ["scripts/test.sh"], {
      cwd: fixture, detached: true, stdio: "ignore",
      env: { ...cleanEnv, ...policy, CDPATH: ".:/nonexistent", RESOURCES: resources,
        PROBE: `http://127.0.0.1:${server.address().port}`, FAIL_FILE: fail ? names[0] : "" },
    });
    // Test-only deadlock watchdog. Never changes a production test timeout.
    const watchdog = setTimeout(() => { timedOut = true; process.kill(-child.pid, "SIGKILL"); }, 60_000);
    const result = await new Promise((r) => {
      child.on("error", () => r({ startError: true }));
      child.on("exit", (code, signal) => r({ code, signal }));
    });
    clearTimeout(watchdog);
    assert.equal(timedOut, false, `${label}: barrier completed`);
    assert.equal(result.startError, undefined, `${label}: runner started`);
    if (interrupt) {
      assert.ok(result.signal || result.code !== 0, `${label}: interruption cannot pass`);
      assert.equal(seen.length, workers, `${label}: queued files never started`);
    } else {
      assert.equal(result.code, invalid ? 2 : fail ? 1 : 0, `${label}: aggregate exit`);
      assert.equal(peak, invalid ? 0 : workers, `${label}: actual peak`);
      assert.deepEqual([...seen].sort(), names.slice(0, expected), `${label}: full inventory exactly once`);
      if (workers === 1) assert.deepEqual(seen, names.slice(0, expected), `${label}: original serial order`);
      assert.equal(ended, expected, `${label}: completed all admitted files`);
    }
    // Exit of the native parent must not leave its owned fixture processes alive.
    // Give the OS a turn to reap signalled children (bounded proof, not a runner retry).
    const deadline = Date.now() + 5_000;
    const alive = () => pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(), false, `${label}: no surviving file processes`);
    assert.deepEqual(readdirSync(resources), [], `${label}: fixture cleanup`);
    console.log(`ok local-test-workers ${label}: peak=${peak}, started=${seen.length}, ended=${ended}`);
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    for (const response of pending) response.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

try {
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, directory));
  mkdirSync(resources);
  copyFileSync(join(root, "scripts/test.sh"), join(fixture, "scripts/test.sh"));
  assert.equal(spawnSync("git", ["init", "-q", fixture], { stdio: "ignore" }).status, 0);
  for (const name of names) writeFileSync(join(fixture, directory, name), source);
  // Old shell globs ignore these; an accidental recursive/default discovery must fail.
  writeFileSync(join(fixture, directory, "ignored.js"), "throw Error('wrong discovery')");
  mkdirSync(join(fixture, directory, "nested"));
  writeFileSync(join(fixture, directory, "nested", `hidden${suffix}`), "throw Error('recursive discovery')");
  if (temper) writeFileSync(join(fixture, directory, "ignored.mjs"), "throw Error('wrong suffix')");

  await check("local default10");
  await check("override3", { workers: 3, policy: { WT_CHECK_WORKERS: "3" } });
  await check("explicit serial", { workers: 1, policy: { WT_CHECK_WORKERS: "1" } });
  await check("CI serial", { workers: 1, policy: { CI: "1", WT_CHECK_WORKERS: "10" } });
  await check("GitHub serial", { workers: 1, policy: { GITHUB_ACTIONS: "true", WT_CHECK_WORKERS: "3" } });
  await check("nonempty CI wins over invalid override", { workers: 1, policy: { CI: "false", WT_CHECK_WORKERS: "invalid" } });
  await check("failed child local", { fail: true });
  await check("failed child serial", { fail: true, workers: 1, policy: { WT_CHECK_WORKERS: "1" } });
  await check("failed child remote", { fail: true, workers: 1, policy: { CI: "1" } });
  for (const value of ["0", "-1", "1.5", "oops"]) await check(`invalid ${value}`, { invalid: true, policy: { WT_CHECK_WORKERS: value } });
  await check("SIGINT group cleanup", { workers: 3, policy: { WT_CHECK_WORKERS: "3" }, interrupt: "SIGINT" });
  await check("SIGTERM group cleanup", { workers: 3, policy: { WT_CHECK_WORKERS: "3" }, interrupt: "SIGTERM" });
} finally { rmSync(fixture, { recursive: true, force: true }); }

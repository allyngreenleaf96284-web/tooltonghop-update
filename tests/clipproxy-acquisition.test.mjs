import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClipProxyTool } from "../modules/clipproxy.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = { stateProxyEnabled: true, browserApiProvider: "hide", clipProxyKey: "fixture", clipProxyGoodPingMs: 1500, clipProxyPingLimitMs: 3000, clipProxyPoolSize: 5, clipProxyMaxUse: 10, stateProxyStates: ["New York"] };
function slot(port = 443, extra = {}) {
  const raw = `198.51.100.10:${port}:fixture:fixture`;
  return { id: `slot-${port}`, state: "New York", raw,
    proxy: { host: "198.51.100.10", port: String(port), username: "fixture", password: "fixture", raw },
    alive: true, pingMs: 281, ipinfoPingMs: 281, exitIp: "198.51.100.20", region: "New York",
    createdAt: Date.now(), lastCheckedAt: Date.now(), usageCount: 0, ...extra };
}
async function fixture(t, slots = [], overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clipproxy-acquire-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persistedPoolPath = path.join(root, "pool.json");
  await fs.writeFile(persistedPoolPath, JSON.stringify({ proxies: slots }));
  const requests = [], probes = [], assignments = [], logs = [];
  const tool = createClipProxyTool({
    persistedPoolPath, addRuntimeLog: (...args) => logs.push(args),
    fetchText: async (url) => { requests.push(url); return "198.51.100.10:445:fixture:fixture"; },
    probeTcp: async (proxy) => { probes.push(proxy.port); return { alive: true, pingMs: 281 }; },
    fetchInfo: async () => ({ ok: true, ip: "198.51.100.20", pingMs: 281, region: "New York", org: "AS21928" }),
    hideRequest: async (c, endpoint, options = {}) => { if (options.method === "PUT") assignments.push(JSON.parse(JSON.parse(options.body).proxy)); return {}; },
    ...overrides
  });
  return { tool, requests, probes, assignments, logs, persistedPoolPath };
}
function acquire(tool, profileId = "p1") {
  return tool.ensureForProfile({ config, profileId, row: { raw: { bang: "New York" } } });
}

test("a fresh healthy pool proxy is assigned immediately with no API or ipinfo calls", async (t) => {
  const { tool, requests, probes, assignments } = await fixture(t, [slot()]);
  const lease = await acquire(tool);
  assert.equal(lease.slotId, "slot-443");
  assert.equal(requests.length, 0);
  assert.equal(probes.length, 0);
  assert.equal(assignments.length, 1);
});

test("a new 1741ms warm proxy below the maximum is used instead of hunting for a better ping", async (t) => {
  const { tool, requests, assignments, logs } = await fixture(t, [], {
    fetchInfo: async () => ({ ok: true, ip: "198.51.100.20", pingMs: 1741, region: "New York", org: "AS21928" })
  });
  await acquire(tool);
  assert.equal(requests.length, 1);
  assert.equal(assignments.length, 1);
  assert.equal(logs.some(([message]) => message.includes("thu lay con tot hon")), false);
});

test("same-state API work cannot block a cached proxy released while another profile is waiting", async (t) => {
  let releaseApi, apiStarted;
  const started = new Promise((resolve) => { apiStarted = resolve; });
  const apiGate = new Promise((resolve) => { releaseApi = resolve; });
  const { tool, assignments } = await fixture(t, [slot()], {
    fetchText: async () => { apiStarted(); await apiGate; return "198.51.100.10:445:fixture:fixture"; }
  });
  const held = await acquire(tool, "held");
  const slow = acquire(tool, "slow");
  await started;
  const waiting = acquire(tool, "waiting");
  tool.release(held);
  try {
    const fast = await Promise.race([waiting, pause(800).then(() => { throw new Error("cached proxy blocked behind allocation"); })]);
    assert.equal(fast.slotId, held.slotId);
    assert.equal(assignments.length, 2);
  } finally { releaseApi(); }
  assert.notEqual((await slow).slotId, held.slotId);
});

test("recent cached proxies bypass a slow same-state health check without double leasing", async (t) => {
  let completeCheck, checkStarted;
  const started = new Promise((resolve) => { checkStarted = resolve; });
  const gate = new Promise((resolve) => { completeCheck = resolve; });
  const { tool } = await fixture(t, [slot(443, { lastCheckedAt: 1 }), slot(444)], {
    probeTcp: async () => { checkStarted(); await gate; return { alive: true, pingMs: 281 }; }
  });
  const held = await acquire(tool, "held");
  const stale = acquire(tool, "stale");
  await started;
  tool.release(held);
  try {
    const fast = await Promise.race([acquire(tool, "fast"), pause(800).then(() => { throw new Error("cached proxy blocked behind health check"); })]);
    assert.equal(fast.slotId, held.slotId);
  } finally { completeCheck(); }
  assert.notEqual((await stale).slotId, held.slotId);
});

test("all API retries share a bounded budget", async (t) => {
  const budgets = [];
  const { tool, assignments } = await fixture(t, [], { acquireTimeoutMs: 120,
    fetchText: async (url, timeoutMs) => { budgets.push(timeoutMs); await pause(timeoutMs); throw new Error("fixture API timeout"); }
  });
  const start = Date.now();
  await assert.rejects(acquire(tool), (error) => error.status === "hetproxy");
  assert.ok(Date.now() - start < 800);
  assert.equal(assignments.length, 0);
  assert.ok(budgets.every((value) => value <= 120));
});

test("warm ping acceptance still rejects wrong-state and over-limit proxies", async (t) => {
  for (const info of [{ region: "Texas", pingMs: 281 }, { region: "New York", pingMs: 3500 }]) {
    const { tool, assignments } = await fixture(t, [], {
      fetchInfo: async () => ({ ok: true, ip: "198.51.100.20", org: "AS21928", ...info })
    });
    await assert.rejects(acquire(tool));
    assert.equal(assignments.length, 0);
  }
});

test("a waiting profile times out without losing the state lock or blocking later profiles", async (t) => {
  let releaseApi, apiStarted;
  const started = new Promise((resolve) => { apiStarted = resolve; });
  const gate = new Promise((resolve) => { releaseApi = resolve; });
  let calls = 0;
  const { tool } = await fixture(t, [], { acquireTimeoutMs: 120,
    fetchText: async () => { if (++calls === 1) { apiStarted(); await gate; } return "198.51.100.10:445:fixture:fixture"; }
  });
  const holder = acquire(tool, "holder").catch((error) => error);
  await started;
  await assert.rejects(acquire(tool, "waiting"), (error) => error.status === "hetproxy");
  releaseApi();
  assert.equal((await holder).status, "hetproxy");
  const lease = await acquire(tool, "next");
  assert.equal(typeof lease.slotId, "string");
});

test("background Check ping skips proxies currently leased by running profiles", async (t) => {
  const { tool, probes } = await fixture(t, [slot()]);
  await acquire(tool);
  const result = await tool.checkAll(config);
  assert.equal(result.checkedAttempts, 0);
  assert.equal(probes.length, 0);
});

test("California -> New York -> California preserves both state pools, including across restart", async (t) => {
  const { tool, requests, probes, persistedPoolPath } = await fixture(t, [
    slot(443, { state: "California", region: "California" }), slot(444)
  ]);
  const forState = (target, bang, profileId) => target.ensureForProfile({ config, profileId, row: { raw: { bang } } });
  const california = await forState(tool, "California", "ca1");
  tool.release(california);
  const newYork = await forState(tool, "New York", "ny1");
  tool.release(newYork);
  const californiaAgain = await forState(tool, "California", "ca2");
  assert.equal(californiaAgain.slotId, california.slotId);
  assert.notEqual(californiaAgain.slotId, newYork.slotId);
  tool.release(californiaAgain);
  assert.equal(requests.length, 0);
  assert.equal(probes.length, 0);
  assert.deepEqual(new Set(tool.getStatus(config).proxies.map((item) => item.state)), new Set(["California", "New York"]));
  const restarted = createClipProxyTool({ persistedPoolPath, addRuntimeLog() {}, hideRequest: async () => ({}),
    fetchText: async () => { throw new Error("Must reuse persisted pool"); },
    probeTcp: async () => { throw new Error("Fresh pool requires no recheck"); }
  });
  assert.equal((await forState(restarted, "California", "ca3")).slotId, california.slotId);
  assert.equal((await forState(restarted, "New York", "ny2")).slotId, newYork.slotId);
});

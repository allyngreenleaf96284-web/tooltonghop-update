import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClipProxyTool } from "../modules/clipproxy.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("profile stays pending across failed rounds until a usable proxy arrives", async (t) => {
  let calls = 0;
  const { tool, assignments } = await fixture(t, [], {
    retryUntilAvailable: true, acquisitionRetryDelayMs: 1,
    fetchText: async () => ++calls <= 12 ? "" : "198.51.100.10:443:fixture:fixture"
  });
  const updates = [];
  const result = await tool.ensureForProfile({ config: { ...config, clipProxyAsns: ["AS21928", "AS6167"] }, profileId: "same-profile", row: { raw: { bang: "New York" } }, log: (...args) => updates.push(args) });
  assert.equal(calls, 13);
  assert.equal(typeof result.slotId, "string");
  assert.equal(assignments.length, 1);
  assert.ok(updates.some((entry) => entry[1].includes("giu nguyen profile")));
});

test("manual stop interrupts indefinite acquisition during retry delay", async (t) => {
  let stopped = false;
  const { tool, assignments } = await fixture(t, [], {
    retryUntilAvailable: true, acquisitionRetryDelayMs: 2000,
    shouldStop: () => stopped, fetchText: async () => ""
  });
  await assert.rejects(tool.ensureForProfile({ config, profileId: "stop-me", row: { raw: { bang: "New York" } }, log: () => { stopped = true; } }), (error) => error.status === "stopped");
  assert.equal(assignments.length, 0);
});
test("both configured ASNs are tried before requesting without the filter", async (t) => {
  const urls = [];
  const { tool, assignments } = await fixture(t, [], {
    fetchText: async (url) => {
      const parsed = new URL(url);
      urls.push(parsed);
      return parsed.searchParams.has("asn") ? "" : "198.51.100.10:443:fixture:fixture";
    }
  });
  await tool.ensureForProfile({ config: { ...config, clipProxyAsn: "AS999", clipProxyAsns: ["AS21928", "AS6167"] }, profileId: "p1", row: { raw: { bang: "New York" } } });
  assert.equal(urls.length, 3);
  assert.equal(urls[0].searchParams.get("asn"), "AS21928");
  assert.equal(urls[1].searchParams.get("asn"), "AS6167");
  assert.equal(urls[2].searchParams.has("asn"), false);
  assert.equal(urls[0].searchParams.get("num"), urls[1].searchParams.get("num"));
  assert.equal(assignments.length, 1);
});

test("stop during API call prevents fallback, health checks and profile assignment", async (t) => {
  let stopped = false, calls = 0;
  const { tool, assignments, probes } = await fixture(t, [], {
    shouldStop: () => stopped,
    fetchText: async () => { calls++; stopped = true; return ""; }
  });
  await assert.rejects(acquire(tool), (error) => error.status === "stopped");
  assert.equal(calls, 1);
  assert.equal(assignments.length, 0);
  assert.equal(probes.length, 0);
});
test("queued worker receives a fresh API budget after the preceding worker finishes", async (t) => {
  let calls = 0;
  const budgets = [];
  const { tool } = await fixture(t, [], { acquireTimeoutMs: 300,
    fetchText: async (url, budget) => {
      budgets.push(budget);
      const port = 600 + calls++;
      await pause(200);
      return `198.51.100.10:${port}:fixture:fixture`;
    }
  });
  const leases = await Promise.all([acquire(tool, "first"), acquire(tool, "second")]);
  assert.equal(calls, 2);
  assert.notEqual(leases[0].slotId, leases[1].slotId);
  assert.ok(budgets.every((budget) => budget > 250), "queue time must not reduce API time");
});
test("nine California workers fall back quickly from a rejected batch while Texas stays cached", async (t) => {
  const counts = [];
  let nextPort = 500;
  const { tool } = await fixture(t, [slot(443, { state: "Texas", region: "Texas" })], {
    fetchText: async (url, budget) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("state"), "California");
      assert.ok(budget <= 6000);
      const count = Number(parsed.searchParams.get("num"));
      counts.push(count);
      if (count > 4) return JSON.stringify({ error: true, message: "not enough ports" });
      return Array.from({ length: count }, () => `198.51.100.10:${nextPort++}:fixture:fixture`).join("\n");
    },
    fetchInfo: async () => ({ ok: true, ip: "198.51.100.20", pingMs: 281, region: "California", org: "AS21928" })
  });
  const run = (state, id) => tool.ensureForProfile({ config, profileId: id, row: { raw: { bang: state } } });
  const texas = await run("Texas", "tx1");
  tool.release(texas);
  const leases = await Promise.all(Array.from({ length: 9 }, (_, i) => run("California", `ca${i}`)));
  assert.deepEqual(counts.slice(0, 2), [9, 4]);
  assert.equal(new Set(leases.map((lease) => lease.slotId)).size, 9);
  const calls = counts.length;
  assert.equal((await run("Texas", "tx2")).slotId, texas.slotId);
  assert.equal(counts.length, calls);
});
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
    retryUntilAvailable: false,
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

for (const poolSize of [1, 4, 5]) {
  test(`four concurrent workers share all four num=4 ports in one API call (pool setting ${poolSize})`, async (t) => {
    const urls = [];
    let checking = 0, peakChecking = 0;
    const ports = [443, 444, 445, 446];
    const { tool, assignments } = await fixture(t, [], { acquireTimeoutMs: 1000,
      fetchText: async (url) => {
        urls.push(new URL(url));
        assert.equal(urls.length, 1, "the other workers must reuse this batch, not allocate again");
        return ports.map((port) => `198.51.100.10:${port}:session-${port}:fixture`).join("\r\n");
      },
      probeTcp: async () => {
        checking += 1;
        peakChecking = Math.max(peakChecking, checking);
        await pause(20);
        checking -= 1;
        return { alive: true, pingMs: 281 };
      },
      fetchInfo: async () => ({ ok: true, ip: "198.51.100.20", pingMs: 1741, region: "Arizona", org: "AS21928" })
    });
    const batchConfig = { ...config, clipProxyPoolSize: poolSize, stateProxyStates: ["Arizona"] };
    const run = (profileId) => tool.ensureForProfile({ config: batchConfig, profileId, row: { raw: { bang: "Arizona" } } });
    const leases = await Promise.all(["p1", "p2", "p3", "p4"].map(run));
    assert.equal(urls.length, 1);
    assert.equal(urls[0].searchParams.get("num"), "4");
    assert.equal(urls[0].searchParams.get("state"), "Arizona");
    assert.equal(urls[0].searchParams.get("asn"), "AS21928");
    assert.equal(peakChecking, 4, "batch probes run in parallel");
    assert.equal(new Set(leases.map((lease) => lease.slotId)).size, 4);
    assert.deepEqual(new Set(assignments.map((proxy) => Number(proxy.port))), new Set(ports));
    assert.equal(tool.getStatus(batchConfig).proxies.length, 4);
    assert.ok(tool.getStatus(batchConfig).proxies.every((proxy) => proxy.inUse));
    for (const lease of leases) tool.release(lease);
    await run("p5");
    assert.equal(urls.length, 1, "released batch ports remain reusable");
  });
}

test("batch allocation retains every healthy returned port and excludes failed endpoints", async (t) => {
  const { tool } = await fixture(t, [], {
    fetchText: async () => [443, 444, 445, 446].map((port) => `198.51.100.10:${port}:u${port}:fixture`).join("\n"),
    probeTcp: async (proxy) => ({ alive: Number(proxy.port) !== 444, pingMs: 281, error: "fixture failed port" })
  });
  await acquire(tool);
  const proxies = tool.getStatus(config).proxies;
  assert.equal(proxies.length, 3);
  assert.equal(proxies.some((proxy) => Number(proxy.port) === 444), false);
});

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

test("each ASN has a bounded budget before trying the next ASN", async (t) => {
  const budgets = [];
  const { tool, assignments } = await fixture(t, [], { acquireTimeoutMs: 120,
    fetchText: async (url, timeoutMs) => { budgets.push(timeoutMs); await pause(timeoutMs); throw new Error("fixture API timeout"); }
  });
  const start = Date.now();
  await assert.rejects(acquire(tool), (error) => error.status === "proxytimeout");
  assert.ok(Date.now() - start < 1500);
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
  await assert.rejects(acquire(tool, "waiting"), (error) => error.status === "proxytimeout");
  releaseApi();
  const recovered = await holder;
  assert.equal(typeof recovered.slotId, "string");
  tool.release(recovered);
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

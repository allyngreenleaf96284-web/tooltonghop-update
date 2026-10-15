import assert from "node:assert/strict";
import { test } from "node:test";
import { createNineCloudTool, nineCloudStateCode, normalizeNineCloudConfig } from "../modules/nineproxy_cloud.js";
import { sanitizeProxyPanelConfigInput } from "../modules/proxypanel.js";

const config = {
  stateProxyEnabled: true,
  stateProxyProvider: "nineproxy",
  browserApiProvider: "gpm",
  nineCloudLocalHost: "192.168.100.28",
  nineCloudApiPort: 10100,
  nineCloudProxyPortStart: 24584,
  nineCloudPoolSize: 2,
  nineCloudIsps: ["Verizon", "T-mobile Usa, Inc."],
  stateProxyStates: ["New York", "Texas"]
};

function fixture({ response = ["192.168.100.28:24584", "192.168.100.28:24585"], probeFailure = false } = {}) {
  const calls = [], requests = [];
  const tool = createNineCloudTool({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ error: false, message: "Success", data: response }) };
    },
    probe: async (proxy) => probeFailure
      ? { ok: false, error: "proxy timeout" }
      : { ok: true, ip: `198.51.100.${proxy.port % 255}`, region: "New York", org: "Verizon" },
    hideRequest: async (c, endpoint, options = {}) => {
      requests.push({ endpoint, options });
      return {};
    }
  });
  return { tool, calls, requests };
}

test("local 9Proxy configuration has an editable host, ports, and comma-separated ISP list", () => {
  const normalized = normalizeNineCloudConfig({ nineCloudLocalHost: "http://192.168.100.28/", nineCloudIsps: " Verizon, Verizon Business, Verizon " });
  assert.deepEqual(normalized.nineCloudIsps, ["Verizon", "Verizon Business"]);
  assert.equal(normalized.nineCloudLocalHost, "192.168.100.28");
  assert.equal(nineCloudStateCode("New York"), "NY");
  assert.equal(nineCloudStateCode("US-TX"), "TX");
  assert.equal(sanitizeProxyPanelConfigInput({ stateProxyProvider: "nineproxy" }).stateProxyProvider, "nineproxy");
});

test("local API requests the documented t=2 state and ISP parameters without a cloud key", async () => {
  const { tool, calls } = fixture();
  const result = await tool.checkAll(config);
  assert.equal(calls.length, 2);
  assert.equal(result.errors.length, 0);
  const ny = calls[0];
  assert.equal(ny.origin, "http://192.168.100.28:10100");
  assert.equal(ny.pathname, "/api/proxy");
  assert.equal(ny.searchParams.get("t"), "2");
  assert.equal(ny.searchParams.get("num"), "2");
  assert.equal(ny.searchParams.get("port"), "24584");
  assert.equal(ny.searchParams.get("country"), "US");
  assert.equal(ny.searchParams.get("state"), "New York");
  assert.equal(ny.searchParams.get("isp"), "Verizon,T-mobile Usa, Inc.");
  assert.equal(calls[1].searchParams.get("port"), "24586");
  assert.equal(result.status.proxies.length, 4);
  assert.ok(result.status.proxies.every((proxy) => proxy.alive && proxy.exitIp));
  assert.equal(JSON.stringify(result).includes("api-key"), false);
});

test("a failed local proxy is visible and never assigned to a profile", async () => {
  const { tool, requests } = fixture({ probeFailure: true });
  const result = await tool.checkAll(config);
  assert.equal(result.errors.length, 4);
  assert.ok(result.status.proxies.every((proxy) => proxy.alive === false && proxy.lastError === "proxy timeout"));
  await assert.rejects(tool.ensureForProfile({ config, profileId: "profile-a", row: { bang: "New York" } }), /proxy timeout/);
  assert.equal(requests.length, 0);
});

test("a free local endpoint is assigned as an unauthenticated HTTP proxy and released", async () => {
  const { tool, requests } = fixture();
  const lease = await tool.ensureForProfile({ config, profileId: "profile-a", row: { raw: { "Bảng": "New York" } } });
  assert.equal(lease.provider, "nineproxy");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.raw_proxy, "192.168.100.28:24584");
  assert.equal(tool.getStatus(config).proxies.find((proxy) => proxy.id === lease.slotId).inUse, true);
  tool.release(lease);
  assert.equal(tool.getStatus(config).proxies.find((proxy) => proxy.id === lease.slotId).inUse, false);
});

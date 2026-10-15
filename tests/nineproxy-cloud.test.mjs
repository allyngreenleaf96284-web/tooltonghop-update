import assert from "node:assert/strict";
import { test } from "node:test";
import { createNineCloudTool, nineCloudStateCode, normalizeNineCloudConfig } from "../modules/nineproxy_cloud.js";
import { sanitizeProxyPanelConfigInput } from "../modules/proxypanel.js";

const key = "fixture-private-key";
const config = { stateProxyEnabled: true, stateProxyProvider: "nineproxy", browserApiProvider: "gpm", stateProxyStates: ["California"] };
const user = { status: 1, user_name: "fixture-sub-user", use_key: "fixture-password" };
const connection = { country_code: "US", state_code: "CA", is_keep: 1, start_port: 12000, end_port: 12001 };

function fixture({ users = [user], connections = [connection], pages = false, failure = null, assignmentFails = false, probeFailure = false } = {}) {
  const calls = [], requests = [], logs = [], profiles = new Map(), mutableConnections = [...connections];
  const tool = createNineCloudTool({
    getApiKey: () => key,
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://api.9proxy.com");
      assert.equal(url.searchParams.get("api-key"), key);
      assert.equal(options.redirect, "error");
      assert.ok(["GET", "POST"].includes(options.method || "GET"));
      calls.push(url.pathname);
      if (failure) return { ok: false, status: 403, json: async () => ({ success: false, message: `${key} ${user.use_key}` }) };
      const isUser = url.pathname.includes("user-passes");
      if (url.pathname.endsWith("/proxy-connection/create")) {
        const body = JSON.parse(options.body);
        mutableConnections.push({ country_code: body.country_code, state_code: body.state_code, is_keep: body.session_type === 2 ? 1 : 0, start_port: 13000 + mutableConnections.length, end_port: 13000 + mutableConnections.length });
        return { ok: true, status: 200, json: async () => ({ success: true, result: { created: true } }) };
      }
      const page = Number(url.searchParams.get("page"));
      const items = isUser ? users : pages && page === 1 ? [] : mutableConnections;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { items, totalPages: pages && !isUser ? 2 : items.length ? 1 : 0, configs: isUser ? {} : { server_ip: "gateway.example.test" } } }) };
    },
    ping: async (host, port) => { assert.equal(host, "gateway.example.test"); assert.ok(port >= 12000); },
    probe: async (proxy, mode) => {
      assert.equal(proxy.host, "gateway.example.test");
      assert.ok(["http", "socks5"].includes(mode));
      if (probeFailure) throw new Error("HTTP proxy rejected tunnel (407)");
      return "198.51.100.42";
    },
    hideRequest: async (c, endpoint, options = {}) => {
      requests.push({ endpoint, options });
      if (assignmentFails) throw new Error(`${key} ${user.use_key}`);
      if (options.method === "PUT") profiles.set(endpoint, JSON.parse(options.body));
      return profiles.get(endpoint) || {};
    },
    addRuntimeLog: (...args) => logs.push(args)
  });
  return { tool, calls, requests, profiles, logs };
}

test("provider settings survive all existing sanitizers without changing the old providers", () => {
  for (const provider of ["clipproxy", "proxypanel", "nineproxy"]) assert.equal(sanitizeProxyPanelConfigInput({ stateProxyProvider: provider }).stateProxyProvider, provider);
  assert.equal(sanitizeProxyPanelConfigInput({ stateProxyProvider: "unknown" }).stateProxyProvider, "clipproxy");
  assert.deepEqual(normalizeNineCloudConfig({ nineCloudApiKey: key, nineCloudUsername: " sub " }), { nineCloudUsername: "sub", nineCloudProtocol: "http" });
  assert.equal(nineCloudStateCode("California"), "CA");
  assert.equal(nineCloudStateCode("US-TX"), "TX");
  assert.equal(nineCloudStateCode("invalid"), "");
});

test("API discovery supports the live camelCase pagination and empty account responses", async () => {
  const { tool, requests } = fixture({ users: [], connections: [] });
  const result = await tool.checkAll(config);
  assert.match(result.errors[0], /chua co sub-user active/);
  assert.equal(result.status.api.ready, false);
  assert.equal(result.status.api.subUsers, 0);
  assert.equal(result.status.api.connections, 0);
  assert.equal(result.status.api.keyConfigured, true);
  assert.equal(requests.length, 0);
});

test("valid configurations are listed without revealing API keys, usernames, or passwords", async () => {
  const { tool } = fixture({ pages: true });
  const result = await tool.checkAll(config);
  assert.deepEqual(result.errors, []);
  assert.equal(result.status.proxies.length, 2);
  assert.equal(result.status.api.ready, true);
  assert.ok(result.status.proxies.every((proxy) => proxy.alive && proxy.exitIp === "198.51.100.42"));
  for (const secret of [key, user.user_name, user.use_key]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("connection checks use authenticated proxy traffic and report an unusable port without credentials", async () => {
  const { tool, requests } = fixture({ probeFailure: true });
  const result = await tool.checkAll(config);
  assert.equal(result.checked, 2);
  assert.equal(result.errors.length, 2);
  assert.ok(result.status.proxies.every((proxy) => proxy.alive === false && proxy.lastError === "Proxy từ chối xác thực"));
  await assert.rejects(tool.ensureForProfile({ config, profileId: "a", row: { bang: "California" } }), /khong ket noi duoc gateway/);
  assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(result).includes(user.use_key), false);
});

test("creates one sticky Proxy2Web connection for each missing configured state", async () => {
  const { tool, calls } = fixture({ connections: [] });
  const result = await tool.createConnections({ ...config, stateProxyStates: ["California", "Texas"] });
  assert.deepEqual(result.created, ["California", "Texas"]);
  assert.equal(result.status.proxies.length, 2);
  assert.equal(calls.filter((path) => path.endsWith("/proxy-connection/create")).length, 2);
});

test("simultaneous workers use different ports, release leases, and assign through the shared GPM adapter", async () => {
  const { tool, requests, logs } = fixture();
  const options = (profileId) => ({ config, profileId, row: { raw: { "Bảng": "California" } } });
  const [first, second] = await Promise.all([tool.ensureForProfile(options("a")), tool.ensureForProfile(options("b"))]);
  assert.notEqual(first.slotId, second.slotId);
  assert.equal(first.provider, "nineproxy");
  await assert.rejects(tool.ensureForProfile(options("c")), /khong co port/);
  assert.equal(requests.filter((r) => r.options.method === "PUT").length, 2);
  assert.ok(requests.every((r) => /^\/profiles\/[ab]$/.test(r.endpoint)));
  for (const secret of [key, user.user_name, user.use_key]) assert.equal(JSON.stringify(logs).includes(secret), false);
  tool.release({ ...first, provider: "clipproxy" });
  assert.equal(tool.getStatus(config).proxies.filter((p) => p.inUse).length, 2);
  tool.release(first);
  const third = await tool.ensureForProfile(options("c"));
  assert.equal(third.slotId, first.slotId);
});

test("HideMyAcc keeps proxy credentials in its expected JSON payload", async () => {
  const { tool, requests } = fixture();
  await tool.ensureForProfile({ config: { ...config, browserApiProvider: "hide", nineCloudProtocol: "socks5" }, profileId: "a", row: { bang: "CA" } });
  const body = JSON.parse(requests.find((r) => r.options.method === "PUT").options.body);
  assert.deepEqual(JSON.parse(body.proxy), { host: "gateway.example.test", port: 12000, mode: "socks5", username: user.user_name, password: user.use_key });
});

test("wrong state, non-US, rotating sessions and missing connection configs never fall back to random proxies", async () => {
  for (const connections of [[], [{ ...connection, country_code: "VN" }], [{ ...connection, is_keep: 0 }], [{ ...connection, state_code: "TX" }]]) {
    const { tool, requests } = fixture({ connections });
    await assert.rejects(tool.ensureForProfile({ config, profileId: "a", row: { bang: "California" } }));
    assert.equal(requests.length, 0);
  }
});

test("multiple sub-users require explicit selection, inactive users are never selected", async () => {
  const { tool } = fixture({ users: [user, { ...user, user_name: "other" }] });
  const invalid = await tool.checkAll(config);
  assert.match(invalid.errors[0], /nhieu sub-user/);
  const valid = await tool.checkAll({ ...config, nineCloudUsername: "other" });
  assert.deepEqual(valid.errors, []);
  const inactive = fixture({ users: [{ ...user, status: 2 }] });
  assert.match((await inactive.tool.checkAll(config)).errors[0], /chua co sub-user/);
});

test("failed requests and profile updates do not leak credentials and release reserved ports", async () => {
  const failedApi = fixture({ failure: true });
  const checked = await failedApi.tool.checkAll(config);
  assert.match(checked.errors[0], /HTTP 403/);
  for (const secret of [key, user.use_key]) assert.equal(JSON.stringify(checked).includes(secret), false);
  const failedProfile = fixture({ assignmentFails: true });
  await assert.rejects(failedProfile.tool.ensureForProfile({ config, profileId: "a", row: { bang: "California" } }), (error) => !error.message.includes(key) && !error.message.includes(user.use_key));
  assert.equal(failedProfile.tool.getStatus(config).proxies.some((p) => p.inUse), false);
});

test("disabled mode and missing Sheet state do not call external APIs", async () => {
  const { tool, calls } = fixture();
  assert.equal(await tool.ensureForProfile({ config: { ...config, stateProxyEnabled: false } }), null);
  assert.equal(await tool.ensureForProfile({ config: { ...config, stateProxyProvider: "clipproxy" } }), null);
  await assert.rejects(tool.ensureForProfile({ config, profileId: "a", row: {} }), (error) => error.status === "thieubang");
  assert.equal(calls.length, 0);
});

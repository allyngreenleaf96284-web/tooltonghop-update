import net from "node:net";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const credentialsPath = fileURLToPath(new URL("../data/nineproxy-cloud-credentials.json", import.meta.url));
const stateCodes = new Map(Object.entries({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia"
}));

export function normalizeNineCloudConfig(config = {}) {
  return {
    nineCloudUsername: String(config.nineCloudUsername || "").trim(),
    nineCloudProtocol: config.nineCloudProtocol === "socks5" ? "socks5" : "http"
  };
}

export function saveNineCloudApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return;
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify({ apiKey: key }, null, 2), { encoding: "utf8", mode: 0o600 });
}

function storedKey() {
  try { return String(JSON.parse(readFileSync(credentialsPath, "utf8")).apiKey || "").trim(); }
  catch { return ""; }
}

export function nineCloudStateCode(value) {
  const text = String(value || "").trim().replace(/^US[-_]/i, "");
  for (const [code, name] of stateCodes) if ([code, name].some((item) => item.toLowerCase() === text.toLowerCase())) return code;
  return "";
}

function fail(message, status = "hetproxy") {
  const error = new Error(message);
  error.status = status;
  return error;
}

function field(object, key) {
  return object?.[key] ?? object?.[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
}

function rowState(row) {
  for (const source of [row.raw, row]) {
    for (const [key, value] of Object.entries(source || {})) {
      const normalized = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
      if (["bang", "proxy"].includes(normalized) && String(value || "").trim()) return value;
    }
  }
  return "";
}

export function createNineCloudTool({ hideRequest, addRuntimeLog = () => {}, fetchImpl = fetch, getApiKey = storedKey, ping = tcpPing } = {}) {
  const leases = new Map();
  let snapshot = { proxies: [], checkedAt: 0, subUsers: 0, connections: 0, lastError: "", ready: false };
  let pending = Promise.resolve();

  async function api(endpoint, page = 1) {
    const key = getApiKey();
    if (!key) throw fail("9Proxy API: chua cau hinh API key.");
    const url = new URL(endpoint, "https://api.9proxy.com");
    url.searchParams.set("api-key", key);
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    let response, body;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
      body = await response.json();
    } catch { throw fail("9Proxy API: khong ket noi duoc hoac phan hoi khong phai JSON."); }
    // Never propagate a provider response or request URL containing credentials into logs.
    if (!response.ok || body.success !== true) throw fail(`9Proxy API: yeu cau bi tu choi (HTTP ${response.status}).`);
    if (!Array.isArray(body.result?.items)) throw fail("9Proxy API: cau truc phan hoi chua duoc ho tro.");
    return body.result;
  }

  async function list(endpoint) {
    let items = [], configs = {};
    for (let page = 1; page <= 100; page += 1) {
      const data = await api(endpoint, page);
      items.push(...data.items);
      configs = { ...configs, ...data.configs };
      const total = Number(data.totalPages ?? data.total_pages ?? 1);
      if (total === 0 && page === 1 && !data.items.length) return { items, configs };
      if (!Number.isInteger(total) || total < 1 || total > 100) throw fail("9Proxy API: so trang khong hop le.");
      if (page >= total) return { items, configs };
    }
    throw fail("9Proxy API: vuot gioi han so trang.");
  }

  async function discover(config) {
    const users = await list("/client/v1/user-passes/get-list");
    const connections = await list("/client/v1/proxy-connection/get-list");
    const wanted = normalizeNineCloudConfig(config).nineCloudUsername;
    const active = users.items.filter((user) => Number(user.status) === 1 && (!wanted || field(user, "user_name") === wanted));
    snapshot.subUsers = users.items.length;
    snapshot.connections = connections.items.length;
    if (active.length !== 1) throw fail(active.length === 0
      ? "9Proxy API hop le nhung chua co sub-user active. Tao sub-user cho goi IP/Proxy2Web tren 9Proxy, sau do kiem tra lai."
      : "9Proxy co nhieu sub-user active; can chon username trong cau hinh.");
    const user = { user_name: field(active[0], "user_name"), use_key: field(active[0], "use_key") };
    if (!user.user_name || !user.use_key || /[:\r\n]/.test(`${user.user_name}${user.use_key}`)) throw fail("9Proxy: thong tin xac thuc proxy khong hop le.");
    if (!connections.items.length) throw fail("9Proxy: chua co cau hinh ket noi. Tao Proxy2Web cho goi IP tren 9Proxy truoc khi chay.");
    const host = String(field(connections.configs, "server_ip") || "").trim();
    if (!host || /[\s/@:]/.test(host)) throw fail("9Proxy: API chua tra gateway hop le; khong tu doan dia chi proxy.");
    const proxies = [];
    for (const connection of connections.items) {
      const code = nineCloudStateCode(field(connection, "state_code"));
      const start = Number(field(connection, "start_port")), end = Number(field(connection, "end_port"));
      // A session must not rotate IP per request while a profile is running.
      if (String(field(connection, "country_code")).toUpperCase() !== "US" || !code || Number(field(connection, "is_keep")) !== 1) continue;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || end < start || end - start > 10000) continue;
      for (let port = start; port <= end; port += 1) {
        proxies.push({ id: `${host}:${port}`, host, port, state: stateCodes.get(code), code, username: user.user_name, password: user.use_key });
      }
    }
    if (!proxies.length) throw fail("9Proxy: chua co ket noi US theo bang va Sticky Session duoc ho tro. Kiem tra cau hinh Proxy2Web.");
    return proxies;
  }

  async function refresh(config) {
    try {
      const proxies = await discover(config);
      snapshot = { ...snapshot, proxies: proxies.map(({ username, password, ...proxy }) => proxy), ready: true, checkedAt: Date.now(), lastError: "" };
      return proxies;
    } catch (error) {
      snapshot = { ...snapshot, proxies: [], ready: false, checkedAt: Date.now(), lastError: error.message };
      throw error;
    }
  }

  function getStatus(config = {}) {
    return {
      config: { stateProxyEnabled: Boolean(config.stateProxyEnabled), stateProxyProvider: "nineproxy", stateProxyStates: config.stateProxyStates || [], ...normalizeNineCloudConfig(config) },
      states: config.stateProxyStates || [], enabled: Boolean(config.stateProxyEnabled),
      api: { ...snapshot, proxies: undefined, keyConfigured: Boolean(getApiKey()) },
      proxies: snapshot.proxies.map((proxy) => ({ ...proxy, raw: `${proxy.host}:${proxy.port}`, alive: null, inUse: leases.has(proxy.id), assignedProfileId: leases.get(proxy.id)?.profileId || "", lastError: "" }))
    };
  }

  async function checkAll(config) {
    const errors = [];
    try { await refresh(config); } catch (error) { errors.push(error.message); }
    return { checked: snapshot.proxies.length, errors, status: getStatus(config) };
  }

  async function ensureForProfile({ config = {}, profileId, row = {}, log } = {}) {
    if (!config.stateProxyEnabled || config.stateProxyProvider !== "nineproxy") return null;
    const code = nineCloudStateCode(rowState(row));
    if (!code) throw fail("9Proxy: thieu bang US hop le trong cot bang cua Sheet.", "thieubang");
    const work = pending.then(async () => {
      const available = await refresh(config);
      const slot = available.find((proxy) => proxy.code === code && !leases.has(proxy.id));
      if (!slot) throw fail(`9Proxy: khong co port Sticky US ${stateCodes.get(code)} con trong; khong gan trung port dang dung.`);
      const lease = { provider: "nineproxy", slotId: slot.id, profileId, state: slot.state };
      leases.set(slot.id, lease);
      try {
        await ping(slot.host, slot.port);
        const mode = normalizeNineCloudConfig(config).nineCloudProtocol;
        const proxy = { host: slot.host, port: slot.port, mode, username: slot.username, password: slot.password };
        const raw = `${slot.host}:${slot.port}:${slot.username}:${slot.password}`;
        const hide = String(config.browserApiProvider || "").toLowerCase() === "hide";
        const expected = mode === "socks5" ? `socks5://${raw}` : raw;
        await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(hide ? { proxy: JSON.stringify(proxy) } : { raw_proxy: expected }), hideRetryAttempts: 2 });
        const saved = await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { hideRetryAttempts: 2 });
        if (!hide && String(saved?.raw_proxy || saved?.proxy || "") !== expected) throw new Error("Profile proxy verification failed");
        log?.("gan proxy bang", `9Proxy ${slot.state}: da gan ${slot.host}:${slot.port}`, "success");
        addRuntimeLog(`[${profileId}] 9Proxy ${slot.state}: da gan proxy ${slot.host}:${slot.port}`, "success", profileId);
        return lease;
      } catch {
        leases.delete(slot.id);
        throw fail("9Proxy: khong ket noi duoc gateway hoac khong luu duoc proxy vao profile.");
      }
    });
    pending = work.catch(() => {});
    return work;
  }

  return {
    getStatus, checkAll, ensureForProfile,
    applyNow: checkAll,
    addState(config, state) {
      const code = nineCloudStateCode(state);
      if (!code) throw fail("9Proxy: bang US khong hop le.", "thieubang");
      return { ...config, stateProxyStates: [...new Set([...(config.stateProxyStates || []), stateCodes.get(code)])] };
    },
    release(lease) {
      if (lease?.provider === "nineproxy" && leases.get(lease.slotId)?.profileId === lease.profileId) leases.delete(lease.slotId);
    }
  };
}

function tcpPing(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(10000);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Gateway timeout")); });
    socket.once("error", reject);
  });
}

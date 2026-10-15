import net from "node:net";
import tls from "node:tls";
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

function connectTcp(host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const stop = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => stop(new Error("Gateway timeout")));
    socket.once("error", stop);
    socket.once("connect", () => {
      socket.off("error", stop);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function readBytes(socket, length, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Proxy response timeout")), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(data);
    };
    const onError = () => finish(new Error("Proxy connection closed"));
    const onClose = () => finish(new Error("Proxy connection closed"));
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < length) return;
      const extra = data.subarray(length);
      data = data.subarray(0, length);
      if (extra.length) socket.unshift(extra);
      finish();
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function readHttpHeaders(socket, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Proxy response timeout")), timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(result);
    };
    const onError = () => finish(new Error("Proxy connection closed"));
    const onClose = () => finish(new Error("Proxy connection closed"));
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      const marker = data.indexOf("\r\n\r\n");
      if (marker < 0) {
        if (data.length > 32768) finish(new Error("Proxy returned invalid response"));
        return;
      }
      const remainder = data.subarray(marker + 4);
      if (remainder.length) socket.unshift(remainder);
      finish(null, data.subarray(0, marker).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function httpTunnel(proxy) {
  const socket = await connectTcp(proxy.host, proxy.port);
  const authorization = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
  socket.write(`CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: Basic ${authorization}\r\nConnection: keep-alive\r\n\r\n`);
  const head = await readHttpHeaders(socket);
  const code = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1]);
  if (code !== 200) throw new Error(`HTTP proxy rejected tunnel (${Number.isFinite(code) ? code : "invalid response"})`);
  return socket;
}

async function socksTunnel(proxy) {
  const socket = await connectTcp(proxy.host, proxy.port);
  const user = Buffer.from(proxy.username, "utf8"), password = Buffer.from(proxy.password, "utf8");
  if (!user.length || user.length > 255 || password.length > 255) throw new Error("Invalid SOCKS credentials");
  socket.write(Buffer.from([5, 2, 0, 2]));
  const greeting = await readBytes(socket, 2);
  if (greeting[0] !== 5 || greeting[1] !== 2) throw new Error("SOCKS proxy rejected authentication");
  socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
  const authentication = await readBytes(socket, 2);
  if (authentication[1] !== 0) throw new Error("SOCKS proxy rejected credentials");
  const hostname = Buffer.from("api.ipify.org", "ascii");
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hostname.length]), hostname, Buffer.from([1, 187])]));
  const response = await readBytes(socket, 5);
  if (response[0] !== 5 || response[1] !== 0) throw new Error("SOCKS proxy rejected tunnel");
  const remaining = response[3] === 1 ? 5 : response[3] === 4 ? 17 : response[3] === 3 ? response[4] + 2 : 0;
  if (!remaining) throw new Error("SOCKS proxy returned invalid response");
  await readBytes(socket, remaining);
  return socket;
}

function readHttpsIp(socket, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: "api.ipify.org" });
    let response = "";
    let done = false;
    const timer = setTimeout(() => finish(new Error("Proxy response timeout")), timeoutMs);
    const finish = (error, ip) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      secure.destroy();
      if (error) reject(error); else resolve(ip);
    };
    secure.once("error", () => finish(new Error("Proxy TLS connection failed")));
    secure.once("secureConnect", () => secure.write("GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n"));
    secure.on("data", (chunk) => { response += chunk.toString("utf8"); });
    secure.once("end", () => {
      try {
        const separator = response.indexOf("\r\n\r\n");
        if (separator < 0) return finish(new Error("Proxy returned invalid response"));
        const ip = String(JSON.parse(response.slice(separator + 4) || "{}").ip || "").trim();
        if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) return finish(new Error("Proxy returned no exit IP"));
        finish(null, ip);
      } catch { finish(new Error("Proxy returned invalid response")); }
    });
  });
}

async function probeProxyConnection(proxy, mode) {
  const tunnel = mode === "socks5" ? await socksTunnel(proxy) : await httpTunnel(proxy);
  return readHttpsIp(tunnel);
}

function safeProbeError(error) {
  const message = String(error?.message || "Proxy check failed");
  if (/\b(401|407)\b/.test(message)) return "Proxy từ chối xác thực";
  if (/timeout/i.test(message)) return "Proxy timeout";
  if (/TLS/i.test(message)) return "Proxy không tạo được kết nối HTTPS";
  if (/rejected/i.test(message)) return "Proxy từ chối kết nối";
  return "Không kiểm tra được kết nối proxy";
}

export function createNineCloudTool({ hideRequest, addRuntimeLog = () => {}, fetchImpl = fetch, getApiKey = storedKey, ping = tcpPing, probe = probeProxyConnection } = {}) {
  const leases = new Map();
  const health = new Map();
  let snapshot = { proxies: [], checkedAt: 0, subUsers: 0, connections: 0, lastError: "", ready: false };
  let pending = Promise.resolve();

  async function api(endpoint, page = 1, options = {}) {
    const key = getApiKey();
    if (!key) throw fail("9Proxy API: chua cau hinh API key.");
    const url = new URL(endpoint, "https://api.9proxy.com");
    url.searchParams.set("api-key", key);
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    let response, body;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        method: options.method || "GET",
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      body = await response.json();
    } catch { throw fail("9Proxy API: khong ket noi duoc hoac phan hoi khong phai JSON."); }
    // Never propagate a provider response or request URL containing credentials into logs.
    if (!response.ok || body.success !== true) throw fail(`9Proxy API: yeu cau bi tu choi (HTTP ${response.status}).`);
    if (options.list !== false && !Array.isArray(body.result?.items)) throw fail("9Proxy API: cau truc phan hoi chua duoc ho tro.");
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

  async function activeUser(config) {
    const users = await list("/client/v1/user-passes/get-list");
    const wanted = normalizeNineCloudConfig(config).nineCloudUsername;
    const active = users.items.filter((user) => Number(user.status) === 1 && (!wanted || field(user, "user_name") === wanted));
    snapshot.subUsers = users.items.length;
    if (active.length !== 1) throw fail(active.length === 0
      ? wanted
        ? `9Proxy: khong tim thay sub-user active \"${wanted}\". Kiem tra lai username trong 9Proxy.`
        : "9Proxy API hop le nhung chua co sub-user active. Tao sub-user cho goi IP/Proxy2Web tren 9Proxy, sau do kiem tra lai."
      : "9Proxy co nhieu sub-user active; can chon username trong cau hinh.");
    const user = { user_name: field(active[0], "user_name"), use_key: field(active[0], "use_key") };
    if (!user.user_name || !user.use_key || /[:\r\n]/.test(`${user.user_name}${user.use_key}`)) throw fail("9Proxy: thong tin xac thuc proxy khong hop le.");
    return user;
  }

  function stickyUsConnection(connection, code) {
    return String(field(connection, "country_code")).toUpperCase() === "US"
      && nineCloudStateCode(field(connection, "state_code")) === code
      && Number(field(connection, "is_keep")) === 1;
  }

  async function discover(config) {
    const connections = await list("/client/v1/proxy-connection/get-list");
    const user = await activeUser(config);
    snapshot.connections = connections.items.length;
    if (!connections.items.length) throw fail("9Proxy: chua co connection Proxy2Web. Bam 'Tao Proxy2Web' trong tool hoac Create Proxy tren 9Proxy, sau do kiem tra lai.");
    const host = String(field(connections.configs, "server_ip") || "").trim();
    if (!host || /[\s/@:]/.test(host)) throw fail("9Proxy: API chua tra gateway hop le; khong tu doan dia chi proxy.");
    const proxies = [];
    for (const connection of connections.items) {
      const code = nineCloudStateCode(field(connection, "state_code"));
      const start = Number(field(connection, "start_port")), end = Number(field(connection, "end_port"));
      // A session must not rotate IP per request while a profile is running.
      if (!stickyUsConnection(connection, code)) continue;
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
      proxies: snapshot.proxies.map((proxy) => ({ ...proxy, raw: `${proxy.host}:${proxy.port}`, alive: null, inUse: leases.has(proxy.id), assignedProfileId: leases.get(proxy.id)?.profileId || "", ...(health.get(proxy.id) || {}) }))
    };
  }

  async function verifyProxy(proxy, mode) {
    const startedAt = Date.now();
    try {
      const exitIp = await probe(proxy, mode);
      const result = { alive: true, exitIp, pingMs: Date.now() - startedAt, checkedAt: Date.now(), lastError: "" };
      health.set(proxy.id, result);
      return result;
    } catch (error) {
      const result = { alive: false, exitIp: "", pingMs: null, checkedAt: Date.now(), lastError: safeProbeError(error) };
      health.set(proxy.id, result);
      return result;
    }
  }

  async function checkAll(config) {
    const errors = [];
    let proxies = [];
    try { proxies = await refresh(config); } catch (error) { errors.push(error.message); }
    const mode = normalizeNineCloudConfig(config).nineCloudProtocol;
    await Promise.all(proxies.map(async (proxy) => {
      const result = await verifyProxy(proxy, mode);
      if (!result.alive) errors.push(`${proxy.state}: ${result.lastError}`);
    }));
    return { checked: proxies.length, errors, status: getStatus(config) };
  }

  async function createConnections(config) {
    await activeUser(config);
    const connections = await list("/client/v1/proxy-connection/get-list");
    snapshot.connections = connections.items.length;
    const codes = [...new Set((config.stateProxyStates || []).map(nineCloudStateCode).filter(Boolean))];
    if (!codes.length) throw fail("9Proxy: hay them it nhat mot bang US truoc khi tao Proxy2Web.", "thieubang");
    const created = [];
    for (const code of codes) {
      if (connections.items.some((connection) => stickyUsConnection(connection, code))) continue;
      await api("/client/v1/proxy-connection/create", 1, {
        method: "POST",
        list: false,
        body: { country_code: "US", state_code: code, quantity: 1, session_type: 2, session_time: 1440 }
      });
      created.push(stateCodes.get(code));
    }
    const proxies = await refresh(config);
    addRuntimeLog(`9Proxy Proxy2Web: ${created.length ? `da tao ${created.join(", ")}` : "cac bang da co san"}.`, "success", "", {
      tool: "proxy theo bang",
      step: "tao Proxy2Web"
    });
    return { created, checked: proxies.length, status: getStatus(config) };
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
        let checked = health.get(slot.id);
        if (!checked || Date.now() - checked.checkedAt > 60_000) checked = await verifyProxy(slot, mode);
        if (checked?.alive === false) throw new Error(checked.lastError || "Proxy check failed");
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
    getStatus, checkAll, createConnections, ensureForProfile,
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

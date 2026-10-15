import { execFile } from "node:child_process";

const stateCodes = new Map(Object.entries({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia"
}));

const DEFAULT_ISPS = ["Verizon", "Verizon Business", "Verizon Internet Services", "T-mobile Usa, Inc."];

function clamp(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeHost(value) {
  const text = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return /^[a-z0-9.-]+$/i.test(text) ? text : "127.0.0.1";
}

function normalizeIsps(input) {
  const seen = new Set();
  const result = [];
  for (const value of (Array.isArray(input) ? input : String(input || "").split(/[\n,;]+/))) {
    const isp = String(value || "").trim().replace(/\s+/g, " ");
    const key = isp.toLowerCase();
    if (isp && !seen.has(key)) {
      seen.add(key);
      result.push(isp);
    }
  }
  return result.length ? result : [...DEFAULT_ISPS];
}

export function nineCloudStateCode(value) {
  const text = String(value || "").trim().replace(/^US[-_]/i, "");
  for (const [code, name] of stateCodes) if ([code, name].some((item) => item.toLowerCase() === text.toLowerCase())) return code;
  return "";
}

function normalizeStates(states) {
  const result = [];
  for (const state of Array.isArray(states) ? states : []) {
    const name = stateCodes.get(nineCloudStateCode(state));
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

export function normalizeNineCloudConfig(config = {}) {
  return {
    nineCloudLocalHost: normalizeHost(config.nineCloudLocalHost || "127.0.0.1"),
    nineCloudApiPort: clamp(config.nineCloudApiPort, 10100, 1, 65535),
    nineCloudProxyPortStart: clamp(config.nineCloudProxyPortStart, 24584, 1, 65535),
    nineCloudPoolSize: clamp(config.nineCloudPoolSize, 1, 1, 20),
    nineCloudIsps: normalizeIsps(config.nineCloudIsps),
    nineCloudProtocol: config.nineCloudProtocol === "socks5" ? "socks5" : "http",
    nineCloudRequestTimeoutMs: clamp(config.nineCloudRequestTimeoutMs, 30000, 5000, 120000),
    nineCloudInfoTimeoutMs: clamp(config.nineCloudInfoTimeoutMs, 30000, 5000, 120000),
    stateProxyEnabled: Boolean(config.stateProxyEnabled),
    stateProxyProvider: "nineproxy",
    stateProxyStates: normalizeStates(config.stateProxyStates)
  };
}

// Compatibility for older saved configurations. Local 9Proxy uses no cloud key.
export function saveNineCloudApiKey() {}

function fail(message, status = "hetproxy") {
  const error = new Error(message);
  error.status = status;
  return error;
}

function rowState(row) {
  for (const source of [row?.raw, row]) {
    for (const [key, value] of Object.entries(source || {})) {
      const normalized = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
      if (["bang", "proxy"].includes(normalized) && String(value || "").trim()) return value;
    }
  }
  return "";
}

function parseEndpoint(value) {
  const text = String(value || "").trim().replace(/^https?:\/\//i, "");
  const match = text.match(/^([a-z0-9.-]+):(\d{1,5})$/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port, username: "", password: "", raw: `${match[1]}:${port}` };
}

function localApiUrl(config, state, port, quantity) {
  const url = new URL(`http://${config.nineCloudLocalHost}:${config.nineCloudApiPort}/api/proxy`);
  url.search = new URLSearchParams({
    t: "2",
    num: String(quantity),
    port: String(port),
    country: "US",
    state,
    isp: config.nineCloudIsps.join(",")
  }).toString();
  return url;
}

function probeLocalProxy(proxy, timeoutMs) {
  const proxyUrl = `http://${proxy.host}:${proxy.port}`;
  return new Promise((resolve) => {
    execFile("curl.exe", ["-sS", "--proxy", proxyUrl, "https://ipinfo.io/json", "--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000)))], {
      windowsHide: true,
      timeout: timeoutMs + 1500,
      maxBuffer: 1024 * 128
    }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: /timed out/i.test(String(error.message || "")) ? "proxy timeout" : String(stderr || "proxy khong ket noi duoc").slice(0, 160) });
      try {
        const info = JSON.parse(String(stdout || ""));
        const ip = String(info.ip || "").trim();
        if (!ip) return resolve({ ok: false, error: "proxy khong tra IP" });
        resolve({ ok: true, ip, region: String(info.region || ""), org: String(info.org || info.isp || "") });
      } catch { resolve({ ok: false, error: "proxy tra du lieu khong hop le" }); }
    });
  });
}

export function createNineCloudTool({ hideRequest, addRuntimeLog = () => {}, fetchImpl = fetch, probe = probeLocalProxy } = {}) {
  const pool = new Map();
  const leases = new Map();
  const locks = new Map();
  let snapshot = { checkedAt: 0, lastError: "", ready: false, requests: 0 };

  function slotsFor(state) {
    if (!pool.has(state)) pool.set(state, []);
    return pool.get(state);
  }

  async function withStateLock(state, action) {
    const previous = locks.get(state) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(state, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (locks.get(state) === current) locks.delete(state);
    }
  }

  async function requestState(config, state) {
    const stateIndex = config.stateProxyStates.indexOf(state);
    const startPort = config.nineCloudProxyPortStart + Math.max(0, stateIndex) * config.nineCloudPoolSize;
    const url = localApiUrl(config, state, startPort, config.nineCloudPoolSize);
    let response, payload;
    try {
      response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.nineCloudRequestTimeoutMs) });
      payload = await response.json();
    } catch { throw fail(`9Proxy local: khong ket noi duoc ${config.nineCloudLocalHost}:${config.nineCloudApiPort}. Kiem tra 9Proxy dang chay va IP local.`); }
    if (!response.ok || payload?.error === true) throw fail(`9Proxy local: ${String(payload?.message || `API loi ${response.status}`).slice(0, 160)}`);
    const endpoints = Array.isArray(payload?.data) ? payload.data.map(parseEndpoint).filter(Boolean) : [];
    if (!endpoints.length) throw fail("9Proxy local: API khong tra host:port hop le.");
    snapshot.requests += 1;
    const now = Date.now();
    const items = endpoints.map((proxy) => ({
      id: `${state}|${proxy.raw}`,
      state,
      proxy,
      alive: null,
      exitIp: "",
      region: "",
      org: "",
      pingMs: null,
      lastError: "",
      createdAt: now,
      checkedAt: 0,
      inUse: false,
      assignedProfileId: ""
    }));
    pool.set(state, items);
    return items;
  }

  async function verify(config, slot) {
    const startedAt = Date.now();
    const result = await probe(slot.proxy, config.nineCloudInfoTimeoutMs);
    slot.checkedAt = Date.now();
    slot.pingMs = result.ok ? Date.now() - startedAt : null;
    slot.alive = Boolean(result.ok);
    slot.exitIp = result.ok ? String(result.ip || "") : "";
    slot.region = result.ok ? String(result.region || "") : "";
    slot.org = result.ok ? String(result.org || "") : "";
    slot.lastError = result.ok ? "" : String(result.error || "proxy khong ket noi duoc").slice(0, 180);
    return slot;
  }

  async function ensureState(config, state) {
    return withStateLock(state, async () => {
      const existing = slotsFor(state);
      return existing.length ? existing : requestState(config, state);
    });
  }

  function status(config) {
    const safe = normalizeNineCloudConfig(config);
    const proxies = [];
    for (const state of safe.stateProxyStates) {
      for (const slot of slotsFor(state)) proxies.push({
        id: slot.id,
        state: slot.state,
        raw: slot.proxy.raw,
        host: slot.proxy.host,
        port: slot.proxy.port,
        alive: slot.alive,
        exitIp: slot.exitIp,
        region: slot.region,
        org: slot.org,
        pingMs: slot.pingMs,
        inUse: slot.inUse,
        assignedProfileId: slot.assignedProfileId,
        ageSeconds: Math.floor((Date.now() - slot.createdAt) / 1000),
        lastError: slot.lastError
      });
    }
    return {
      config: safe,
      states: safe.stateProxyStates,
      enabled: safe.stateProxyEnabled,
      api: { ...snapshot, endpoint: `http://${safe.nineCloudLocalHost}:${safe.nineCloudApiPort}/api/proxy` },
      proxies
    };
  }

  async function checkAll(config) {
    const safe = normalizeNineCloudConfig(config);
    const errors = [];
    for (const state of safe.stateProxyStates) {
      try {
        let slots = await ensureState(safe, state);
        if (slots.length && slots.every((slot) => slot.alive === false && !slot.inUse)) {
          slots = await withStateLock(state, () => requestState(safe, state));
        }
        for (const slot of slots) {
          await verify(safe, slot);
          if (!slot.alive) errors.push(`${state}: ${slot.lastError}`);
        }
      } catch (error) { errors.push(`${state}: ${error.message}`); }
    }
    snapshot = { ...snapshot, checkedAt: Date.now(), ready: errors.length === 0, lastError: errors[0] || "" };
    const current = status(safe);
    return { checked: current.proxies.length, checkedAttempts: current.proxies.length, errors, status: current };
  }

  async function ensureForProfile({ config = {}, profileId, row = {}, log } = {}) {
    if (!config.stateProxyEnabled || config.stateProxyProvider !== "nineproxy") return null;
    const safe = normalizeNineCloudConfig(config);
    const state = stateCodes.get(nineCloudStateCode(rowState(row)));
    if (!state) throw fail("9Proxy local: thieu bang US hop le trong cot bang cua Sheet.", "thieubang");
    if (!safe.stateProxyStates.includes(state)) throw fail(`9Proxy local: bang ${state} chua duoc them vao cau hinh.`, "thieubang");
    const slot = await withStateLock(state, async () => {
      const existing = slotsFor(state);
      let items = existing.length ? existing : await requestState(safe, state);
      let candidate = items.find((item) => !item.inUse && item.alive !== false);
      if (!candidate && items.length && items.every((item) => item.alive === false && !item.inUse)) {
        items = await requestState(safe, state);
        candidate = items.find((item) => !item.inUse && item.alive !== false);
      }
      if (!candidate) {
        const failed = items.find((item) => !item.inUse && item.lastError);
        if (failed) throw fail(`9Proxy local: ${state} ${failed.lastError}`);
        throw fail(`9Proxy local: khong con port ranh cho bang ${state}. Tang so proxy/bang neu can chay nhieu luong.`);
      }
      if (!candidate.checkedAt || Date.now() - candidate.checkedAt > 120000) await verify(safe, candidate);
      if (!candidate.alive) throw fail(`9Proxy local: ${state} ${candidate.lastError}`);
      candidate.inUse = true;
      candidate.assignedProfileId = profileId;
      return candidate;
    });
    try {
      const provider = String(config.browserApiProvider || "").toLowerCase();
      const rawProxy = slot.proxy.raw;
      const body = provider === "hide"
        ? { proxy: JSON.stringify({ host: slot.proxy.host, port: slot.proxy.port, mode: safe.nineCloudProtocol, username: "", password: "" }) }
        : { raw_proxy: safe.nineCloudProtocol === "socks5" ? `socks5://${rawProxy}` : rawProxy };
      await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), hideRetryAttempts: 2 });
      leases.set(slot.id, { provider: "nineproxy", slotId: slot.id, profileId, state });
      log?.("gan proxy bang", `9Proxy local ${state}: da gan ${rawProxy}`, "success");
      addRuntimeLog(`[${profileId}] 9Proxy local ${state}: da gan ${rawProxy}`, "success", profileId, { tool: "proxy theo bang", step: "9proxy local" });
      return { provider: "nineproxy", slotId: slot.id, profileId, state };
    } catch {
      slot.inUse = false;
      slot.assignedProfileId = "";
      throw fail("9Proxy local: khong luu duoc proxy vao profile.");
    }
  }

  return {
    getStatus: status,
    checkAll,
    createConnections: checkAll,
    ensureForProfile,
    applyNow: checkAll,
    addState(config, state) {
      const name = stateCodes.get(nineCloudStateCode(state));
      if (!name) throw fail("9Proxy local: bang US khong hop le.", "thieubang");
      const safe = normalizeNineCloudConfig(config);
      return { ...safe, stateProxyStates: [...new Set([...safe.stateProxyStates, name])] };
    },
    release(lease) {
      if (lease?.provider !== "nineproxy") return;
      const slot = slotsFor(lease.state).find((item) => item.id === lease.slotId);
      if (!slot || slot.assignedProfileId !== lease.profileId) return;
      slot.inUse = false;
      slot.assignedProfileId = "";
      leases.delete(slot.id);
    }
  };
}

import net from "node:net";

const STATES = [
  { code: "CA", name: "California" },
  { code: "NY", name: "New York" },
  { code: "FL", name: "Florida" },
  { code: "TX", name: "Texas" },
  { code: "GA", name: "Georgia" },
  { code: "IL", name: "Illinois" },
  { code: "AL", name: "Alabama" },
  { code: "MD", name: "Maryland" },
  { code: "MI", name: "Michigan" },
  { code: "NC", name: "North Carolina" },
  { code: "OH", name: "Ohio" },
  { code: "PA", name: "Pennsylvania" },
  { code: "TN", name: "Tennessee" }
];

const DEFAULT_PROXY_TOOL_CONFIG = {
  nineProxyBaseUrl: "http://127.0.0.1:22999",
  nineProxyToken: "",
  nineProxyHost: "127.0.0.1",
  nineProxyPortStart: 7000,
  nineProxyPortCount: 10,
  nineProxyState: "CA",
  nineProxyCountry: "US",
  nineProxyIsp: "T-Mobile",
  nineProxyPingLimitMs: 50,
  nineProxyMinGoodPorts: 5,
  nineProxyMaxIpAgeMinutes: 60,
  nineProxyPingUrl: "https://api.ipify.org?format=json"
};

function clampNumber(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeProxyConfig(config = {}) {
  return {
    nineProxyBaseUrl: String(config.nineProxyBaseUrl || DEFAULT_PROXY_TOOL_CONFIG.nineProxyBaseUrl).trim().replace(/\/+$/, ""),
    nineProxyToken: String(config.nineProxyToken || "").trim(),
    nineProxyHost: String(config.nineProxyHost || DEFAULT_PROXY_TOOL_CONFIG.nineProxyHost).trim(),
    nineProxyPortStart: clampNumber(config.nineProxyPortStart, DEFAULT_PROXY_TOOL_CONFIG.nineProxyPortStart, 1, 65535),
    nineProxyPortCount: clampNumber(config.nineProxyPortCount, DEFAULT_PROXY_TOOL_CONFIG.nineProxyPortCount, 1, 10),
    nineProxyState: normalizeState(config.nineProxyState || DEFAULT_PROXY_TOOL_CONFIG.nineProxyState).code,
    nineProxyCountry: String(config.nineProxyCountry || DEFAULT_PROXY_TOOL_CONFIG.nineProxyCountry).trim().toUpperCase() || "US",
    nineProxyIsp: String(config.nineProxyIsp || DEFAULT_PROXY_TOOL_CONFIG.nineProxyIsp).trim() || "T-Mobile",
    nineProxyPingLimitMs: clampNumber(config.nineProxyPingLimitMs, DEFAULT_PROXY_TOOL_CONFIG.nineProxyPingLimitMs, 1, 10000),
    nineProxyMinGoodPorts: clampNumber(config.nineProxyMinGoodPorts, DEFAULT_PROXY_TOOL_CONFIG.nineProxyMinGoodPorts, 1, 10),
    nineProxyMaxIpAgeMinutes: clampNumber(config.nineProxyMaxIpAgeMinutes, DEFAULT_PROXY_TOOL_CONFIG.nineProxyMaxIpAgeMinutes, 1, 1440),
    nineProxyPingUrl: String(config.nineProxyPingUrl || DEFAULT_PROXY_TOOL_CONFIG.nineProxyPingUrl).trim()
  };
}

function normalizeState(input) {
  const value = String(input || "").trim().toLowerCase();
  return STATES.find((state) =>
    state.code.toLowerCase() === value ||
    state.name.toLowerCase() === value
  ) || STATES[0];
}

export function mergeProxyDefaults(config) {
  return { ...config, ...normalizeProxyConfig(config) };
}

export function sanitizeProxyConfigInput(input = {}, current = {}) {
  return normalizeProxyConfig({ ...current, ...input });
}

export function createNineProxyTool({ hideRequest, addRuntimeLog }) {
  const state = {
    cursor: 0,
    ports: new Map(),
    lastIps: []
  };

  function configuredPorts(config) {
    const proxyConfig = normalizeProxyConfig(config);
    return Array.from({ length: proxyConfig.nineProxyPortCount }, (_, index) => proxyConfig.nineProxyPortStart + index);
  }

  function rememberIp(ip) {
    const value = String(ip || "").trim();
    if (!value) return;
    state.lastIps = [value, ...state.lastIps.filter((item) => item !== value)].slice(0, 30);
  }

  function portState(port) {
    if (!state.ports.has(port)) {
      state.ports.set(port, {
        port,
        ip: "",
        online: null,
        pingMs: null,
        assignedAt: 0,
        rotatedAt: 0,
        rotateCount: 0,
        lastCheckedAt: 0,
        lastProfileId: "",
        lastError: ""
      });
    }
    return state.ports.get(port);
  }

  function headers(config) {
    const token = String(config.nineProxyToken || "").trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function nineProxyRequest(config, endpoint, options = {}) {
    const base = String(config.nineProxyBaseUrl || "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("Chua cau hinh 9Proxy API URL.");
    const response = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: {
        accept: "application/json",
        ...headers(config),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.status === false || data.success === false) {
      throw new Error(`9Proxy API loi ${response.status}: ${text || response.statusText}`);
    }
    return data.data ?? data;
  }

  function extractIp(payload) {
    if (!payload) return "";
    if (typeof payload === "string") {
      const match = payload.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      return match?.[0] || "";
    }
    if (Array.isArray(payload)) return extractIp(payload[0]);
    return String(payload.public_ip || payload.ip || payload.proxy_ip || payload.host || "").trim();
  }

  function extractPortStatus(data) {
    const rows = Array.isArray(data) ? data : Array.isArray(data?.ports) ? data.ports : Array.isArray(data?.items) ? data.items : [];
    const result = new Map();
    for (const item of rows) {
      const port = Number(item.port || item.local_port || item.listen_port);
      if (!Number.isFinite(port)) continue;
      result.set(port, {
        online: item.online ?? item.is_online ?? item.status === "online",
        ip: extractIp(item),
        raw: item
      });
    }
    return result;
  }

  async function refreshPortStatus(config) {
    const ports = configuredPorts(config);
    let statuses = new Map();
    try {
      const data = await nineProxyRequest(config, `/api/port_check?ports=${encodeURIComponent(ports.join(","))}`);
      statuses = extractPortStatus(data);
    } catch {
      const data = await nineProxyRequest(config, "/api/port_status");
      statuses = extractPortStatus(data);
    }
    const checkedAt = Date.now();
    for (const port of ports) {
      const local = portState(port);
      const remote = statuses.get(port);
      local.lastCheckedAt = checkedAt;
      if (!remote) continue;
      local.online = Boolean(remote.online);
      if (remote.ip) {
        local.ip = remote.ip;
        rememberIp(remote.ip);
      }
      local.lastError = "";
    }
    return getStatus(config);
  }

  async function measurePort(config, port) {
    const local = portState(port);
    const startedAt = Date.now();
    const timeoutMs = Math.max(2000, Number(config.nineProxyPingLimitMs || 50) * 20);
    try {
      await new Promise((resolve, reject) => {
        const target = new URL(config.nineProxyPingUrl || DEFAULT_PROXY_TOOL_CONFIG.nineProxyPingUrl);
        const socket = net.createConnection({ host: config.nineProxyHost, port });
        let buffer = "";
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("ping timeout"));
        }, timeoutMs);
        socket.setEncoding("utf8");
        socket.on("connect", () => {
          socket.write([
            `GET ${target.href} HTTP/1.1`,
            `Host: ${target.host}`,
            "User-Agent: ToolTongHop/9proxy-ping",
            "Connection: close",
            "",
            ""
          ].join("\r\n"));
        });
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (buffer.includes("\r\n\r\n")) {
            const statusLine = buffer.split("\r\n")[0] || "";
            if (/^HTTP\/\d(?:\.\d)?\s+2\d\d\b/.test(statusLine)) {
              clearTimeout(timeout);
              socket.end();
              resolve(true);
            }
          }
        });
        socket.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        socket.on("close", () => {
          clearTimeout(timeout);
          if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d\b/.test(buffer.split("\r\n")[0] || "")) {
            reject(new Error(buffer.split("\r\n")[0] || "proxy ping failed"));
          }
        });
      });
      local.pingMs = Date.now() - startedAt;
      local.online = true;
      local.lastCheckedAt = Date.now();
      local.lastError = "";
    } catch (error) {
      local.pingMs = null;
      local.online = false;
      local.lastCheckedAt = Date.now();
      local.lastError = String(error?.message || error || "ping loi");
    }
    return local;
  }

  async function rotatePort(config, port, reason = "manual") {
    const proxyConfig = normalizeProxyConfig(config);
    const stateInfo = normalizeState(proxyConfig.nineProxyState);
    const params = new URLSearchParams({
      country: proxyConfig.nineProxyCountry,
      state: stateInfo.name,
      isp: proxyConfig.nineProxyIsp,
      port: String(port),
      today: "true"
    });
    const previousIp = portState(port).ip;
    const data = await nineProxyRequest(proxyConfig, `/api/proxy?${params.toString()}`);
    const ip = extractIp(data);
    if (ip && (state.lastIps.includes(ip) || ip === previousIp)) {
      const retryParams = new URLSearchParams(params);
      retryParams.set("skip_ip", [previousIp, ...state.lastIps].filter(Boolean).join(","));
      const retryData = await nineProxyRequest(proxyConfig, `/api/proxy?${retryParams.toString()}`).catch(() => data);
      const retryIp = extractIp(retryData);
      if (retryIp) data.ip = retryIp;
    }
    const local = portState(port);
    const nextIp = extractIp(data) || ip || local.ip;
    local.ip = nextIp;
    local.online = data.online ?? data.is_online ?? true;
    local.assignedAt = Date.now();
    local.rotatedAt = Date.now();
    local.rotateCount += 1;
    local.lastError = "";
    rememberIp(nextIp);
    addRuntimeLog(`[9proxy] port ${port} doi IP (${reason}) -> ${nextIp || "unknown"}`, "info", "", {
      tool: "gan proxy",
      step: "rotate",
      detail: `${stateInfo.name} ${proxyConfig.nineProxyIsp}`
    });
    await measurePort(proxyConfig, port).catch(() => local);
    return local;
  }

  async function ensureFreshPorts(config, neededCount) {
    const proxyConfig = normalizeProxyConfig(config);
    const ports = configuredPorts(proxyConfig);
    const maxAgeMs = Math.max(1, Number(proxyConfig.nineProxyMaxIpAgeMinutes || 60)) * 60 * 1000;
    const selected = [];
    for (let index = 0; index < Math.min(neededCount, ports.length); index += 1) {
      const port = ports[(state.cursor + index) % ports.length];
      const local = portState(port);
      const tooOld = !local.assignedAt || Date.now() - local.assignedAt >= maxAgeMs;
      if (tooOld || local.online === false || Number(local.pingMs || 0) > proxyConfig.nineProxyPingLimitMs) {
        await rotatePort(proxyConfig, port, tooOld ? "qua 1 gio" : "offline/ping cao");
      } else {
        await measurePort(proxyConfig, port).catch(() => local);
      }
      selected.push(portState(port));
    }
    state.cursor = (state.cursor + selected.length) % ports.length;
    return selected;
  }

  async function updateHideProxy(config, profileId, slot) {
    const proxy = {
      host: config.nineProxyHost,
      mode: "http",
      port: slot.port,
      username: "",
      password: ""
    };
    const current = await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { hideRetryAttempts: 2 }).catch(() => ({}));
    const body = {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      proxy: JSON.stringify(proxy)
    };
    await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      hideRetryAttempts: 2
    });
    slot.lastProfileId = profileId;
    return { profileId, port: slot.port, ip: slot.ip, pingMs: slot.pingMs, proxy };
  }

  async function assign(config, profileIds = []) {
    const proxyConfig = normalizeProxyConfig(config);
    const ids = [...new Set((profileIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de gan proxy.");
    const slots = await ensureFreshPorts(proxyConfig, Math.min(ids.length, proxyConfig.nineProxyPortCount));
    const good = slots.filter((slot) => slot.online !== false && Number(slot.pingMs || 999999) <= proxyConfig.nineProxyPingLimitMs);
    const warnings = [];
    if (good.length < proxyConfig.nineProxyMinGoodPorts) {
      warnings.push(`Bang ${normalizeState(proxyConfig.nineProxyState).name} chi co ${good.length} port dat ping <= ${proxyConfig.nineProxyPingLimitMs}ms.`);
    }
    if (!good.length) throw new Error(warnings[0] || "Khong co port proxy dat dieu kien.");
    const result = [];
    for (let index = 0; index < ids.length; index += 1) {
      const slot = good[index % good.length];
      result.push(await updateHideProxy({ ...config, ...proxyConfig }, ids[index], slot));
    }
    return { assigned: result.length, results: result, warnings, status: getStatus(proxyConfig) };
  }

  async function maintain(config) {
    const proxyConfig = normalizeProxyConfig(config);
    const maxAgeMs = Math.max(1, Number(proxyConfig.nineProxyMaxIpAgeMinutes || 60)) * 60 * 1000;
    const changed = [];
    for (const port of configuredPorts(proxyConfig)) {
      const local = portState(port);
      if (!local.assignedAt) continue;
      await measurePort(proxyConfig, port).catch(() => local);
      const tooOld = Date.now() - local.assignedAt >= maxAgeMs;
      const pingHigh = local.pingMs !== null && Number(local.pingMs) > proxyConfig.nineProxyPingLimitMs;
      if (tooOld || local.online === false || pingHigh) {
        changed.push(await rotatePort(proxyConfig, port, tooOld ? "tu dong qua tuoi IP" : "tu dong ping/offline"));
      }
    }
    return { changed, status: getStatus(proxyConfig) };
  }

  function getStatus(config = {}) {
    const proxyConfig = normalizeProxyConfig(config);
    const ports = configuredPorts(proxyConfig).map((port) => {
      const local = portState(port);
      return {
        ...local,
        ageSeconds: local.assignedAt ? Math.floor((Date.now() - local.assignedAt) / 1000) : null,
        healthy: local.online !== false && Number(local.pingMs || 999999) <= proxyConfig.nineProxyPingLimitMs
      };
    });
    return {
      config: proxyConfig,
      states: STATES,
      cursor: state.cursor,
      goodCount: ports.filter((port) => port.healthy).length,
      warning: ports.filter((port) => port.healthy).length < proxyConfig.nineProxyMinGoodPorts
        ? `Canh bao: chua du ${proxyConfig.nineProxyMinGoodPorts} port ping <= ${proxyConfig.nineProxyPingLimitMs}ms.`
        : "",
      ports
    };
  }

  return {
    STATES,
    getStatus,
    assign,
    refreshPortStatus,
    ensureFreshPorts,
    rotatePort,
    maintain
  };
}

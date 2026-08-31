import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSISTED_POOL_PATH = path.join(__dirname, "..", "data", "clipproxy-pool.json");
const DEFAULT_STATES = [
  "Georgia",
  "Texas",
  "North Carolina",
  "Missouri",
  "Virginia",
  "New Mexico",
  "California"
];

const DEFAULT_CONFIG = {
  stateProxyEnabled: false,
  clipProxyKey: "",
  clipProxyPort: 443,
  clipProxyCountry: "US",
  clipProxyType: 2,
  clipProxyAsn: "AS21928",
  clipProxyFormat: "n",
  clipProxyMaxUse: 10,
  clipProxyPoolSize: 5,
  clipProxyMaxAgeMinutes: 60,
  clipProxyGoodPingMs: 1500,
  clipProxyPingLimitMs: 3000,
  clipProxySlowCooldownMinutes: 10,
  clipProxyReserveSize: 2,
  clipProxyRequestTimeoutMs: 30000,
  clipProxyInfoTimeoutMs: 30000,
  stateProxyStates: DEFAULT_STATES
};

function clampNumber(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeStateName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const found = DEFAULT_STATES.find((state) => state.toLowerCase() === text.toLowerCase());
  return found || text.replace(/\s+/g, " ");
}

function normalizeStates(input) {
  const source = Array.isArray(input) ? input : String(input || "").split(/[\n,;]/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const state = normalizeStateName(item);
    const key = state.toLowerCase();
    if (!state || seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result.length ? result : [...DEFAULT_STATES];
}

export function normalizeClipProxyConfig(config = {}) {
  return {
    stateProxyEnabled: Boolean(config.stateProxyEnabled),
    clipProxyKey: String(config.clipProxyKey || DEFAULT_CONFIG.clipProxyKey).trim(),
    clipProxyPort: clampNumber(config.clipProxyPort, DEFAULT_CONFIG.clipProxyPort, 1, 65535),
    clipProxyCountry: String(config.clipProxyCountry || DEFAULT_CONFIG.clipProxyCountry).trim().toUpperCase() || "US",
    clipProxyType: clampNumber(config.clipProxyType, DEFAULT_CONFIG.clipProxyType, 1, 3),
    clipProxyAsn: String(config.clipProxyAsn || DEFAULT_CONFIG.clipProxyAsn).trim() || "AS21928",
    clipProxyFormat: String(config.clipProxyFormat || DEFAULT_CONFIG.clipProxyFormat).trim() || "n",
    clipProxyMaxUse: clampNumber(config.clipProxyMaxUse, DEFAULT_CONFIG.clipProxyMaxUse, 1, 100),
    clipProxyPoolSize: clampNumber(config.clipProxyPoolSize, DEFAULT_CONFIG.clipProxyPoolSize, 1, 50),
    clipProxyMaxAgeMinutes: clampNumber(config.clipProxyMaxAgeMinutes, DEFAULT_CONFIG.clipProxyMaxAgeMinutes, 1, 1440),
    clipProxyGoodPingMs: clampNumber(config.clipProxyGoodPingMs, DEFAULT_CONFIG.clipProxyGoodPingMs, 100, 60000),
    clipProxyPingLimitMs: clampNumber(config.clipProxyPingLimitMs, DEFAULT_CONFIG.clipProxyPingLimitMs, 100, 60000),
    clipProxySlowCooldownMinutes: clampNumber(config.clipProxySlowCooldownMinutes, DEFAULT_CONFIG.clipProxySlowCooldownMinutes, 1, 240),
    clipProxyReserveSize: clampNumber(config.clipProxyReserveSize, DEFAULT_CONFIG.clipProxyReserveSize, 0, 20),
    clipProxyRequestTimeoutMs: clampNumber(config.clipProxyRequestTimeoutMs, DEFAULT_CONFIG.clipProxyRequestTimeoutMs, 5000, 120000),
    clipProxyInfoTimeoutMs: clampNumber(config.clipProxyInfoTimeoutMs, DEFAULT_CONFIG.clipProxyInfoTimeoutMs, 2000, 30000),
    stateProxyStates: normalizeStates(config.stateProxyStates)
  };
}

export function mergeClipProxyDefaults(config = {}) {
  return { ...config, ...normalizeClipProxyConfig(config) };
}

export function sanitizeClipProxyConfigInput(input = {}, current = {}) {
  return normalizeClipProxyConfig({ ...current, ...input });
}

function rowValue(row, ...keys) {
  const wanted = keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean);
  for (const [key, value] of Object.entries(row || {})) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!wanted.includes(normalizedKey)) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function isFatalProxyError(message) {
  const text = String(message || "").toLowerCase();
  return /\b407\b/.test(text) || text.includes("proxy authentication required") || text.includes("auth loi") || text.includes("authentication required");
}

function parseClipProxyLine(line) {
  const text = String(line || "").trim();
  let host = "";
  let port = "";
  let username = "";
  let password = "";
  const hostFirst = text.match(/^([^\s:@]+):(\d+):([^:\s@]+):([^\s@]+)$/);
  const authFirst = text.match(/^([^:\s@]+):([^@\s]+)@([^\s:@]+):(\d+)$/);
  if (hostFirst) {
    [, host, port, username, password] = hostFirst;
  } else if (authFirst) {
    [, username, password, host, port] = authFirst;
  } else {
    return null;
  }
  return {
    host,
    port: Number(port),
    username,
    password,
    raw: `${host}:${port}:${username}:${password}`,
    uri: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/plain,*/*" } });
    const text = await response.text();
    if (!response.ok) throw new Error(`ClipProxy API loi ${response.status}: ${text || response.statusText}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function buildClipProxyUrl(config, stateName) {
  const proxyConfig = normalizeClipProxyConfig(config);
  const params = new URLSearchParams({
    key: proxyConfig.clipProxyKey,
    port: String(proxyConfig.clipProxyPort),
    num: "1",
    country: proxyConfig.clipProxyCountry,
    state: stateName
  });
  params.set("type", String(proxyConfig.clipProxyType));
  if (proxyConfig.clipProxyAsn) params.set("asn", proxyConfig.clipProxyAsn);
  if (proxyConfig.clipProxyFormat) params.set("format", proxyConfig.clipProxyFormat);
  return `https://webipapi.cliproxy.com/api/getIpInfo?${params.toString()}`;
}

function measureTcp(proxy, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ alive: false, pingMs: null, error: "ping timeout" });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      const pingMs = Date.now() - startedAt;
      socket.end();
      resolve({ alive: true, pingMs, error: "" });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ alive: false, pingMs: null, error: String(error?.message || error || "proxy error") });
    });
  });
}
function decodeHttpBody(header, body) {
  if (!/transfer-encoding:\s*chunked/i.test(header)) return body;
  let offset = 0;
  let decoded = "";
  while (offset < body.length) {
    const next = body.indexOf("\r\n", offset);
    if (next === -1) break;
    const sizeText = body.slice(offset, next).split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = next + 2;
    decoded += body.slice(start, start + size);
    offset = start + size + 2;
  }
  return decoded || body;
}

function parseIpInfoResponse(text, startedAt, source) {
  const headerEnd = text.indexOf("\r\n\r\n");
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : "";
  const rawBody = headerEnd >= 0 ? text.slice(headerEnd + 4) : text;
  const statusLine = header.split("\r\n")[0] || "";
  if (statusLine && !/^HTTP\/1\.[01] 2\d\d/i.test(statusLine)) {
    return { ok: false, error: `${source} ${statusLine}`.trim() };
  }
  const body = decodeHttpBody(header, rawBody).trim();
  try {
    const info = JSON.parse(body);
    return {
      ok: true,
      pingMs: Date.now() - startedAt,
      ip: info.ip || "",
      city: info.city || "",
      region: info.region || info.regionName || "",
      country: info.country || "",
      org: info.org || info.isp || "",
      timezone: info.timezone || "",
      error: ""
    };
  } catch (error) {
    return { ok: false, error: `${source} parse loi: ${String(error?.message || error)} | ${body.slice(0, 80)}` };
  }
}

function requestIpInfoHttpProxy(proxy, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    let socket;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: "ipinfo http timeout" }), timeoutMs);
    socket = net.createConnection({ host: proxy.host, port: proxy.port });
    socket.once("connect", () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      socket.write([
        "GET http://ipinfo.io/json HTTP/1.1",
        "Host: ipinfo.io",
        "Accept: application/json",
        "Accept-Encoding: identity",
        `Proxy-Authorization: Basic ${auth}`,
        "Connection: close",
        "",
        ""
      ].join("\r\n"));
    });
    let response = Buffer.alloc(0);
    socket.on("data", (chunk) => { response = Buffer.concat([response, chunk]); });
    socket.once("end", () => done(parseIpInfoResponse(response.toString("utf8"), startedAt, "ipinfo http")));
    socket.once("error", (error) => done({ ok: false, error: String(error?.message || error || "ipinfo http proxy error") }));
  });
}

function requestIpInfoHttpsConnect(proxy, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    let tunnel;
    let secure;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      tunnel?.destroy();
      secure?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: "ipinfo https timeout" }), timeoutMs);
    tunnel = net.createConnection({ host: proxy.host, port: proxy.port });
    tunnel.once("connect", () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      tunnel.write([
        "CONNECT ipinfo.io:443 HTTP/1.1",
        "Host: ipinfo.io:443",
        `Proxy-Authorization: Basic ${auth}`,
        "Connection: keep-alive",
        "",
        ""
      ].join("\r\n"));
    });
    let connectBuffer = "";
    tunnel.on("data", function onTunnelData(chunk) {
      connectBuffer += chunk.toString("latin1");
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      tunnel.off("data", onTunnelData);
      const header = connectBuffer.slice(0, headerEnd);
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(header)) {
        done({ ok: false, error: header.split("\r\n")[0] || "proxy connect failed" });
        return;
      }
      secure = tls.connect({ socket: tunnel, servername: "ipinfo.io" }, () => {
        secure.write([
          "GET /json HTTP/1.1",
          "Host: ipinfo.io",
          "Accept: application/json",
          "Accept-Encoding: identity",
          "Connection: close",
          "",
          ""
        ].join("\r\n"));
      });
      let response = Buffer.alloc(0);
      secure.on("data", (data) => { response = Buffer.concat([response, data]); });
      secure.once("end", () => done(parseIpInfoResponse(response.toString("utf8"), startedAt, "ipinfo https")));
      secure.once("error", (error) => done({ ok: false, error: String(error?.message || error || "ipinfo tls error") }));
    });
    tunnel.once("error", (error) => done({ ok: false, error: String(error?.message || error || "proxy connect error") }));
  });
}

function requestIpInfoCurl(proxy, timeoutMs) {
  const startedAt = Date.now();
  const proxyUrl = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
  const args = [
    "-sS",
    "-x", proxyUrl,
    "https://ipinfo.io/json",
    "--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000)))
  ];
  return new Promise((resolve) => {
    execFile("curl.exe", args, { windowsHide: true, timeout: timeoutMs + 1500, maxBuffer: 1024 * 256 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: `curl ipinfo loi: ${String(stderr || error.message || error).trim()}` });
        return;
      }
      const result = parseIpInfoResponse(String(stdout || ""), startedAt, "curl ipinfo");
      resolve(result.ok ? result : { ...result, error: `${result.error} | curl stdout=${String(stdout || "").slice(0, 80)}` });
    });
  });
}
async function fetchIpInfoViaProxy(proxy, timeoutMs) {
  const curlResult = await requestIpInfoCurl(proxy, timeoutMs);
  if (curlResult.ok) return { ...curlResult, source: "curl" };
  const httpResult = await requestIpInfoHttpProxy(proxy, Math.min(timeoutMs, 5000));
  if (httpResult.ok) return { ...httpResult, source: "http" };
  const httpsResult = await requestIpInfoHttpsConnect(proxy, Math.min(timeoutMs, 5000));
  if (httpsResult.ok) return { ...httpsResult, source: "https" };
  return { ok: false, error: `${curlResult.error}; ${httpResult.error}; ${httpsResult.error}` };
}

function proxyToHidePayload(proxy) {
  return JSON.stringify({
    host: proxy.host,
    port: proxy.port,
    mode: "http",
    username: proxy.username,
    password: proxy.password
  });
}

function proxyToGpmRaw(proxy) {
  const username = String(proxy.username || "");
  const password = String(proxy.password || "");
  if (!username && !password) return `${proxy.host}:${proxy.port}`;
  return `http://${proxy.host}:${proxy.port}:${username}:${password}`;
}

function parseComparableProxy(rawProxy) {
  const text = String(rawProxy || "").trim();
  if (!text) return null;
  const parts = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1] || "")) {
    return {
      host: parts[0],
      port: parts[1],
      username: decodeURIComponent(parts.slice(2, -1).join(":")),
      password: decodeURIComponent(parts.at(-1) || "")
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return {
        host: url.hostname,
        port: String(url.port || ""),
        username: decodeURIComponent(url.username || ""),
        password: decodeURIComponent(url.password || "")
      };
    } catch {}
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1] || "")) {
    return { host: parts[0], port: parts[1], username: "", password: "" };
  }
  return null;
}

function sameProxyValue(a, b) {
  const left = parseComparableProxy(a);
  const right = parseComparableProxy(b);
  if (!left || !right) return String(a || "").trim() === String(b || "").trim();
  return left.host === right.host
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password;
}

export function createClipProxyTool({ hideRequest, addRuntimeLog }) {
  const pool = new Map();
  const locks = new Map();
  const cursors = new Map();

  function log(message, type = "info", profileId = "", detail = "") {
    addRuntimeLog(message, type, profileId, { tool: "proxy theo bang", step: "clipproxy", detail });
  }

  function statePool(stateName) {
    const state = normalizeStateName(stateName);
    if (!pool.has(state)) pool.set(state, []);
    return pool.get(state);
  }
  function serializeSlot(slot) {
    return {
      id: slot.id,
      state: slot.state,
      proxy: slot.proxy,
      raw: slot.raw,
      alive: slot.alive,
      pingMs: slot.pingMs,
      ipinfoPingMs: slot.ipinfoPingMs,
      exitIp: slot.exitIp || "",
      city: slot.city || "",
      region: slot.region || "",
      country: slot.country || "",
      org: slot.org || "",
      timezone: slot.timezone || "",
      ipinfoSource: slot.ipinfoSource || "",
      lastError: slot.lastError || "",
      coldUntil: Number(slot.coldUntil || 0),
      coldReason: slot.coldReason || "",
      createdAt: slot.createdAt || Date.now(),
      lastCheckedAt: slot.lastCheckedAt || 0,
      lastAssignedAt: slot.lastAssignedAt || 0,
      releasedAt: slot.releasedAt || 0,
      usageCount: Number(slot.usageCount || 0)
    };
  }

  function savePool() {
    try {
      mkdirSync(path.dirname(PERSISTED_POOL_PATH), { recursive: true });
      const proxies = [];
      for (const [stateName, items] of pool.entries()) {
        for (const slot of items) {
          if (!slot?.proxy?.host || !slot?.proxy?.port || slot.alive === false || isFatalProxyError(slot.lastError)) continue;
          proxies.push(serializeSlot({ ...slot, state: stateName, inUse: false, assignedProfileId: "" }));
        }
      }
      writeFileSync(PERSISTED_POOL_PATH, JSON.stringify({ savedAt: new Date().toISOString(), proxies }, null, 2), "utf8");
    } catch (error) {
      log(`[clipproxy] khong luu duoc pool proxy: ${String(error?.message || error)}`, "warn");
    }
  }

  function loadPool() {
    try {
      if (!existsSync(PERSISTED_POOL_PATH)) return;
      const payload = JSON.parse(readFileSync(PERSISTED_POOL_PATH, "utf8"));
      const proxies = Array.isArray(payload?.proxies) ? payload.proxies : [];
      for (const saved of proxies) {
        const proxy = saved.proxy?.host ? saved.proxy : parseClipProxyLine(saved.raw);
        if (!proxy?.host || !proxy?.port || saved.alive === false || isFatalProxyError(saved.lastError)) continue;
        const stateName = normalizeStateName(saved.state);
        if (!stateName) continue;
        const items = statePool(stateName);
        if (items.some((slot) => slot.raw === (saved.raw || proxy.raw))) continue;
        items.push({
          ...saved,
          id: saved.id || `${proxy.raw}|persisted|${Math.random().toString(36).slice(2, 8)}`,
          state: stateName,
          proxy,
          raw: saved.raw || proxy.raw,
          alive: saved.alive !== false,
          pingMs: saved.pingMs ?? null,
          ipinfoPingMs: saved.ipinfoPingMs ?? null,
          inUse: false,
          assignedProfileId: "",
          usageCount: Number(saved.usageCount || 0),
          createdAt: Number(saved.createdAt || Date.now()),
          lastCheckedAt: Number(saved.lastCheckedAt || 0),
          lastAssignedAt: Number(saved.lastAssignedAt || 0),
          releasedAt: Number(saved.releasedAt || 0),
          lastError: saved.lastError || "",
          coldUntil: Number(saved.coldUntil || 0),
          coldReason: saved.coldReason || ""
        });
      }
    } catch (error) {
      log(`[clipproxy] khong doc duoc pool proxy da luu: ${String(error?.message || error)}`, "warn");
    }
  }

  function dropSlot(stateName, slotId) {
    const items = statePool(stateName);
    const index = items.findIndex((slot) => slot.id === slotId);
    if (index >= 0) items.splice(index, 1);
  }

  loadPool();

  function slotPingMs(slot) {
    const ipinfo = Number(slot?.ipinfoPingMs);
    if (Number.isFinite(ipinfo) && ipinfo > 0) return ipinfo;
    const tcp = Number(slot?.pingMs);
    if (Number.isFinite(tcp) && tcp > 0) return tcp;
    return Infinity;
  }

  function isCooling(slot) {
    return Number(slot?.coldUntil || 0) > Date.now();
  }

  function markCold(slot, config, reason) {
    const proxyConfig = normalizeClipProxyConfig(config);
    slot.coldUntil = Date.now() + proxyConfig.clipProxySlowCooldownMinutes * 60 * 1000;
    slot.coldReason = reason || "proxy cham, tam nghi";
    slot.lastError = slot.coldReason;
  }

  function clearCold(slot) {
    slot.coldUntil = 0;
    slot.coldReason = "";
    if (/proxy cham|tam nghi|ping cao/i.test(String(slot.lastError || ""))) slot.lastError = "";
  }

  function shouldReplace(slot) {
    return !slot?.createdAt || slot.alive === false || isFatalProxyError(slot.lastError);
  }

  function isTooSlow(slot, config) {
    const proxyConfig = normalizeClipProxyConfig(config);
    return slotPingMs(slot) > proxyConfig.clipProxyPingLimitMs;
  }

  function isGoodPing(slot, config) {
    const proxyConfig = normalizeClipProxyConfig(config);
    return slotPingMs(slot) <= proxyConfig.clipProxyGoodPingMs;
  }

  function isUsageExhausted(slot, config) {
    const proxyConfig = normalizeClipProxyConfig(config);
    return Number(slot?.usageCount || 0) >= proxyConfig.clipProxyMaxUse;
  }

  function isAssignable(slot, config) {
    return slot && !slot.inUse && !isUsageExhausted(slot, config) && !shouldReplace(slot, config) && !isCooling(slot) && !isTooSlow(slot, config);
  }

  function activeSlotCount(items, config) {
    return items.filter((slot) => slot?.inUse || isAssignable(slot, config)).length;
  }

  function retainedSlotCount(items, config) {
    return items.filter((slot) => slot && !shouldReplace(slot, config) && !isUsageExhausted(slot, config)).length;
  }

  function healthFromChecks(config, stateName, checked, info) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const expectedAsn = String(proxyConfig.clipProxyAsn || "").trim().toUpperCase();
    const expectedState = normalizeStateName(stateName).toLowerCase();
    const actualRegion = normalizeStateName(info?.region || "").toLowerCase();
    const org = String(info?.org || "").toUpperCase();
    const infoOk = Boolean(info?.ok && info?.ip);
    const asnOk = !expectedAsn || org.includes(expectedAsn);
    const regionOk = !expectedState || !actualRegion || actualRegion === expectedState;
    const alive = Boolean(checked.alive && infoOk && asnOk && regionOk);
    const error = !checked.alive
      ? (checked.error || "tcp ping loi")
      : !infoOk
        ? (info?.error || "ipinfo loi hoac proxy auth loi")
        : !asnOk
          ? `ASN sai: ${info?.org || "-"}`
          : !regionOk
            ? `Region sai: ${info?.region || "-"}, can ${stateName}`
            : "";
    return { alive, error };
  }

  function nextCursor(stateName, itemCount) {
    const key = normalizeStateName(stateName);
    const current = Number(cursors.get(key) || 0);
    cursors.set(key, itemCount > 0 ? (current + 1) % itemCount : 0);
    return itemCount > 0 ? current % itemCount : 0;
  }

  async function withStateLock(stateName, action) {
    const key = normalizeStateName(stateName);
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const nextLock = previous.then(() => current);
    locks.set(key, nextLock);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === nextLock) locks.delete(key);
    }
  }

  async function getNewProxy(config, stateName) {
    const proxyConfig = normalizeClipProxyConfig(config);
    if (!proxyConfig.clipProxyKey) throw new Error("Chua cau hinh ClipProxy key.");
    const url = buildClipProxyUrl(proxyConfig, stateName);
    const text = await fetchWithTimeout(url, proxyConfig.clipProxyRequestTimeoutMs);
    const proxy = parseClipProxyLine(text.split(/\r?\n/).find((line) => line.trim()) || text);
    if (!proxy) throw new Error(`ClipProxy tra ve sai dinh dang: ${text.slice(0, 120)}`);
    const checked = await measureTcp(proxy, proxyConfig.clipProxyPingLimitMs);
    const info = checked.alive ? await fetchIpInfoViaProxy(proxy, proxyConfig.clipProxyInfoTimeoutMs) : null;
    const health = healthFromChecks(proxyConfig, stateName, checked, info);
    const slot = {
      id: `${proxy.raw}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`,
      state: stateName,
      proxy,
      raw: proxy.raw,
      alive: health.alive,
      pingMs: checked.pingMs,
      ipinfoPingMs: info?.pingMs ?? null,
      exitIp: info?.ip || "",
      city: info?.city || "",
      region: info?.region || "",
      country: info?.country || "",
      org: info?.org || "",
      timezone: info?.timezone || "",
      ipinfoSource: info?.source || "",
      lastError: health.error,
      createdAt: Date.now(),
      lastCheckedAt: Date.now(),
      lastAssignedAt: 0,
      usageCount: 0,
      coldUntil: 0,
      coldReason: "",
      inUse: false,
      assignedProfileId: ""
    };
    return slot;
  }

  async function checkSlot(config, slot) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const checked = await measureTcp(slot.proxy, proxyConfig.clipProxyPingLimitMs);
    const info = checked.alive ? await fetchIpInfoViaProxy(slot.proxy, proxyConfig.clipProxyInfoTimeoutMs) : null;
    const health = healthFromChecks(proxyConfig, slot.state, checked, info);
    slot.alive = health.alive;
    slot.pingMs = checked.pingMs;
    slot.ipinfoPingMs = info?.pingMs ?? slot.ipinfoPingMs ?? null;
    slot.exitIp = info?.ip || slot.exitIp || "";
    slot.city = info?.city || slot.city || "";
    slot.region = info?.region || slot.region || "";
    slot.country = info?.country || slot.country || "";
    slot.org = info?.org || slot.org || "";
    slot.timezone = info?.timezone || slot.timezone || "";
    slot.ipinfoSource = info?.source || slot.ipinfoSource || "";
    slot.lastError = health.error;
    if (slot.alive && isTooSlow(slot, proxyConfig)) markCold(slot, proxyConfig, `ping cao ${slotPingMs(slot)}ms > ${proxyConfig.clipProxyPingLimitMs}ms`);
    else if (slot.alive && !isTooSlow(slot, proxyConfig)) clearCold(slot);
    slot.lastCheckedAt = Date.now();
    return slot;
  }

  function goodSlotCount(items, config) {
    return items.filter((slot) => {
      if (!slot?.inUse && !isAssignable(slot, config)) return false;
      return isGoodPing(slot, config);
    }).length;
  }

  function selectAssignableSlot(items, config, stateName) {
    const candidates = [];
    for (let round = 0; round < Math.max(items.length, 1); round += 1) {
      if (!items.length) break;
      const index = nextCursor(stateName, items.length);
      const slot = items[index];
      if (!isAssignable(slot, config)) continue;
      candidates.push({ slot, index });
    }
    candidates.sort((a, b) => {
      const aGood = isGoodPing(a.slot, config) ? 0 : 1;
      const bGood = isGoodPing(b.slot, config) ? 0 : 1;
      if (aGood !== bGood) return aGood - bGood;
      const pingDiff = slotPingMs(a.slot) - slotPingMs(b.slot);
      if (pingDiff !== 0) return pingDiff;
      return Number(a.slot.usageCount || 0) - Number(b.slot.usageCount || 0);
    });
    return candidates[0] || null;
  }

  async function acquire(config, stateName, profileId) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const normalizedState = normalizeStateName(stateName);
    return withStateLock(normalizedState, async () => {
      const items = statePool(normalizedState);
      let lastError = null;
      const targetActive = proxyConfig.clipProxyPoolSize;
      const maxRetained = proxyConfig.clipProxyPoolSize + proxyConfig.clipProxyReserveSize;

      if (goodSlotCount(items, proxyConfig) < targetActive && retainedSlotCount(items, proxyConfig) < maxRetained) {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            const slot = await getNewProxy(proxyConfig, normalizedState);
            if (!slot.alive) {
              lastError = new Error(slot.lastError || "proxy moi ping loi");
              continue;
            }
            if (isTooSlow(slot, proxyConfig)) {
              markCold(slot, proxyConfig, `ping cao ${slotPingMs(slot)}ms > ${proxyConfig.clipProxyPingLimitMs}ms`);
              items.push(slot);
              savePool();
              lastError = new Error(slot.lastError || "proxy moi ping cao");
              continue;
            }
            if (!isGoodPing(slot, proxyConfig) && retainedSlotCount(items, proxyConfig) < maxRetained - 1) {
              items.push(slot);
              savePool();
              lastError = new Error(`proxy moi ping am ${slotPingMs(slot)}ms, thu lay con tot hon`);
              continue;
            }
            items.push(slot);
            slot.inUse = true;
            slot.assignedProfileId = profileId;
            slot.lastAssignedAt = Date.now();
            savePool();
            return slot;
          } catch (error) {
            lastError = error;
          }
        }
      }

      for (let scan = 0; scan < Math.max(items.length, 1); scan += 1) {
        const picked = selectAssignableSlot(items, proxyConfig, normalizedState);
        if (!picked) break;
        let { slot, index } = picked;
        await checkSlot(proxyConfig, slot);
        if (shouldReplace(slot)) {
          dropSlot(normalizedState, slot.id);
          savePool();
          continue;
        }
        if (!slot.alive || isCooling(slot) || isTooSlow(slot, proxyConfig)) {
          if (slot.alive && isTooSlow(slot, proxyConfig)) markCold(slot, proxyConfig, `ping cao ${slotPingMs(slot)}ms > ${proxyConfig.clipProxyPingLimitMs}ms`);
          savePool();
          continue;
        }
        if (isUsageExhausted(slot, proxyConfig)) continue;
        slot.inUse = true;
        slot.assignedProfileId = profileId;
        slot.lastAssignedAt = Date.now();
        savePool();
        return slot;
      }

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const currentItems = statePool(normalizedState);
          const replaceIndex = currentItems.findIndex((item) => !item.inUse && (shouldReplace(item) || isUsageExhausted(item, proxyConfig) || (isCooling(item) && retainedSlotCount(currentItems, proxyConfig) >= maxRetained)));
          const slot = await getNewProxy(proxyConfig, normalizedState);
          if (!slot.alive) {
            lastError = new Error(slot.lastError || "proxy moi ping loi");
            continue;
          }
          if (isTooSlow(slot, proxyConfig)) {
            markCold(slot, proxyConfig, `ping cao ${slotPingMs(slot)}ms > ${proxyConfig.clipProxyPingLimitMs}ms`);
            if (replaceIndex >= 0) currentItems[replaceIndex] = slot;
            else if (retainedSlotCount(currentItems, proxyConfig) < maxRetained) currentItems.push(slot);
            savePool();
            lastError = new Error(slot.lastError || "proxy moi ping cao");
            continue;
          }
          if (!isGoodPing(slot, proxyConfig) && retainedSlotCount(currentItems, proxyConfig) < maxRetained - 1) {
            if (replaceIndex >= 0) currentItems[replaceIndex] = slot;
            else currentItems.push(slot);
            savePool();
            lastError = new Error(`proxy moi ping am ${slotPingMs(slot)}ms, thu lay con tot hon`);
            continue;
          }
          if (replaceIndex >= 0) currentItems[replaceIndex] = slot;
          else currentItems.push(slot);
          slot.inUse = true;
          slot.assignedProfileId = profileId;
          slot.lastAssignedAt = Date.now();
          savePool();
          return slot;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error(`Khong lay duoc proxy bang ${normalizedState}.`);
    });
  }
  async function assignToProfile(config, profileId, slot) {
    const provider = String(config.browserApiProvider || "").toLowerCase();
    const expectedRawProxy = proxyToGpmRaw(slot.proxy);
    const payload = provider === "hide"
      ? { proxy: proxyToHidePayload(slot.proxy) }
      : { raw_proxy: expectedRawProxy };
    await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      hideRetryAttempts: 2
    });
    const updated = await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { hideRetryAttempts: 2 }).catch(() => null);
    if (provider !== "hide") {
      const actualRawProxy = String(updated?.raw_proxy || updated?.proxy || "").trim();
      if (!sameProxyValue(actualRawProxy, expectedRawProxy)) {
        throw new Error(`GPM chua luu proxy vao profile. expected=${expectedRawProxy}, actual=${actualRawProxy || "rong"}`);
      }
    }
  }

  async function ensureForProfile({ config, profileId, row = {}, log: runLog } = {}) {
    const proxyConfig = normalizeClipProxyConfig(config);
    if (!proxyConfig.stateProxyEnabled) return null;
    const bang = normalizeStateName(
      rowValue(row.raw || {}, "bang", "proxy") ||
      rowValue(row, "bang", "proxy")
    );
    const uid = String(row.uid || row.raw?.uid || profileId || "").trim();
    if (!bang) {
      const error = new Error(`UID/profile ${uid || profileId} chua gan bang trong Sheet.`);
      error.status = "thieubang";
      throw error;
    }
    const slot = await acquire(proxyConfig, bang, profileId);
    try {
      await assignToProfile({ ...config, ...proxyConfig }, profileId, slot);
    } catch (error) {
      release({ state: bang, slotId: slot.id });
      throw error;
    }
    const profileProvider = String(config.browserApiProvider || "").toLowerCase() === "hide" ? "HideMyAcc" : "GPM";
    runLog?.("gan proxy bang", `da gan proxy ${bang} vao ${profileProvider} ${slot.proxy.host}:${slot.proxy.port} ping=${slot.pingMs ?? "?"}ms`, "success");
    log(`[${profileId}] da gan proxy bang ${bang} vao ${profileProvider}: ${slot.proxy.host}:${slot.proxy.port} ping=${slot.pingMs ?? "?"}ms`, "success", profileId, bang);
    return { state: bang, slotId: slot.id, raw: slot.raw };
  }

  function release(lease) {
    if (!lease?.state || !lease?.slotId) return;
    const items = statePool(lease.state);
    const slot = items.find((item) => item.id === lease.slotId);
    if (!slot) return;
    slot.inUse = false;
    slot.assignedProfileId = "";
    slot.usageCount = Number(slot.usageCount || 0) + 1;
    slot.releasedAt = Date.now();
    savePool();
  }

  async function checkAll(config) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const errors = [];
    let checkedAttempts = 0;
    let removed = 0;
    for (const [stateName, items] of pool.entries()) {
      for (const slot of [...items]) {
        try {
          checkedAttempts += 1;
          await checkSlot(proxyConfig, slot);
          if (!slot.alive) {
            dropSlot(stateName, slot.id);
            removed += 1;
            errors.push(`${stateName}: ${slot.raw} da chet, da xoa khoi danh sach`);
            continue;
          }
        } catch (error) {
          slot.lastError = String(error?.message || error || "check proxy loi");
          errors.push(slot.lastError);
        }
      }
    }
    savePool();
    const status = getStatus(proxyConfig);
    return { checked: status.proxies.length, checkedAttempts, removed, errors, status };
  }

  function addState(config, stateName) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const state = normalizeStateName(stateName);
    const states = normalizeStates([...proxyConfig.stateProxyStates, state]);
    return { ...proxyConfig, stateProxyStates: states };
  }

  function getStatus(config = {}) {
    const proxyConfig = normalizeClipProxyConfig(config);
    const states = proxyConfig.stateProxyStates;
    const visibleStates = normalizeStates([...states, ...pool.keys()]);
    const proxies = [];
    for (const state of visibleStates) {
      for (const slot of statePool(state)) {
        if (slot.alive === false || isFatalProxyError(slot.lastError) || isUsageExhausted(slot, proxyConfig)) continue;
        const cooling = isCooling(slot);
        const ping = slotPingMs(slot);
        proxies.push({
          id: slot.id,
          state,
          raw: slot.raw,
          host: slot.proxy.host,
          port: slot.proxy.port,
          alive: slot.alive,
          pingMs: slot.pingMs,
          ipinfoPingMs: slot.ipinfoPingMs,
          exitIp: slot.exitIp || "",
          city: slot.city || "",
          region: slot.region || "",
          country: slot.country || "",
          org: slot.org || "",
          timezone: slot.timezone || "",
          ipinfoSource: slot.ipinfoSource || "",
          inUse: slot.inUse,
          cooling,
          coldUntil: Number(slot.coldUntil || 0),
          coldSeconds: cooling ? Math.max(0, Math.ceil((Number(slot.coldUntil || 0) - Date.now()) / 1000)) : 0,
          coldReason: slot.coldReason || "",
          pingQuality: cooling ? "cold" : ping <= proxyConfig.clipProxyGoodPingMs ? "good" : ping <= proxyConfig.clipProxyPingLimitMs ? "warm" : "slow",
          assignedProfileId: slot.assignedProfileId,
          usageCount: slot.usageCount,
          maxUse: proxyConfig.clipProxyMaxUse,
          poolSize: proxyConfig.clipProxyPoolSize,
          ageSeconds: slot.createdAt ? Math.floor((Date.now() - slot.createdAt) / 1000) : null,
          lastError: slot.lastError || ""
        });
      }
    }
    return {
      config: proxyConfig,
      states,
      proxies,
      enabled: proxyConfig.stateProxyEnabled
    };
  }

  return {
    DEFAULT_STATES,
    getStatus,
    addState,
    ensureForProfile,
    release,
    checkAll
  };
}











































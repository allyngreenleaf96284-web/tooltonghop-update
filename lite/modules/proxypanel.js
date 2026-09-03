import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSISTED_STATE_PATH = path.join(__dirname, "..", "data", "proxypanel-state.json");

const DEFAULT_STATES = [
  "Georgia",
  "Texas",
  "North Carolina",
  "Missouri",
  "Virginia",
  "New Mexico",
  "California"
];

const STATE_ABBR = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY"
};

const DEFAULT_CONFIG = {
  stateProxyEnabled: false,
  stateProxyProvider: "clipproxy",
  proxyPanelBaseUrl: "https://proxypanel.io/api/v1",
  proxyPanelApiKey: "",
  proxyPanelProxyId: "",
  proxyPanelStateOverride: "",
  proxyPanelCarrier: "tmobile",
  proxyPanelProtocol: "socks5",
  proxyPanelUsername: "",
  proxyPanelPassword: "",
  proxyPanelRotateCooldownSeconds: 60,
  proxyPanelReadyDelaySeconds: 8,
  proxyPanelVerifyAttempts: 5,
  proxyPanelRequestTimeoutMs: 30000,
  proxyPanelInfoTimeoutMs: 30000,
  stateProxyStates: DEFAULT_STATES
};
const BAD_CARRIER_TTL_MS = 6 * 60 * 60 * 1000;

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

function normalizeCarrier(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (text === "verizon") return "verizon";
  return "tmobile";
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_CONFIG.proxyPanelBaseUrl).trim().replace(/\/+$/, "");
  return raw.endsWith("/api/v1") ? raw : `${raw}/api/v1`;
}

export function normalizeProxyPanelConfig(config = {}) {
  return {
    stateProxyEnabled: Boolean(config.stateProxyEnabled),
    stateProxyProvider: String(config.stateProxyProvider || DEFAULT_CONFIG.stateProxyProvider).toLowerCase() === "proxypanel" ? "proxypanel" : "clipproxy",
    proxyPanelBaseUrl: normalizeBaseUrl(config.proxyPanelBaseUrl),
    proxyPanelApiKey: String(config.proxyPanelApiKey || "").trim(),
    proxyPanelProxyId: String(config.proxyPanelProxyId || "").trim(),
    proxyPanelStateOverride: normalizeStateName(config.proxyPanelStateOverride || ""),
    proxyPanelCarrier: normalizeCarrier(config.proxyPanelCarrier),
    proxyPanelProtocol: String(config.proxyPanelProtocol || DEFAULT_CONFIG.proxyPanelProtocol).trim().toLowerCase() === "http" ? "http" : "socks5",
    proxyPanelUsername: String(config.proxyPanelUsername || "").trim(),
    proxyPanelPassword: String(config.proxyPanelPassword || "").trim(),
    proxyPanelRotateCooldownSeconds: clampNumber(config.proxyPanelRotateCooldownSeconds, DEFAULT_CONFIG.proxyPanelRotateCooldownSeconds, 0, 600),
    proxyPanelReadyDelaySeconds: clampNumber(config.proxyPanelReadyDelaySeconds, DEFAULT_CONFIG.proxyPanelReadyDelaySeconds, 0, 120),
    proxyPanelVerifyAttempts: clampNumber(config.proxyPanelVerifyAttempts, DEFAULT_CONFIG.proxyPanelVerifyAttempts, 1, 20),
    proxyPanelRequestTimeoutMs: clampNumber(config.proxyPanelRequestTimeoutMs, DEFAULT_CONFIG.proxyPanelRequestTimeoutMs, 5000, 120000),
    proxyPanelInfoTimeoutMs: clampNumber(config.proxyPanelInfoTimeoutMs, DEFAULT_CONFIG.proxyPanelInfoTimeoutMs, 2000, 60000),
    stateProxyStates: normalizeStates(config.stateProxyStates)
  };
}

export function mergeProxyPanelDefaults(config = {}) {
  return { ...config, ...normalizeProxyPanelConfig(config) };
}

export function sanitizeProxyPanelConfigInput(input = {}, current = {}) {
  const merged = { ...current, ...input };
  const nextKey = String(input.proxyPanelApiKey || "").trim();
  if (!nextKey) merged.proxyPanelApiKey = current.proxyPanelApiKey || "";
  const keyChanged = Boolean(nextKey && String(current.proxyPanelApiKey || "").trim() && nextKey !== String(current.proxyPanelApiKey || "").trim());
  if (!String(input.proxyPanelProxyId || "").trim()) merged.proxyPanelProxyId = keyChanged ? "" : current.proxyPanelProxyId || "";
  if (!String(input.proxyPanelUsername || "").trim()) merged.proxyPanelUsername = keyChanged ? "" : current.proxyPanelUsername || "";
  if (!String(input.proxyPanelPassword || "").trim()) merged.proxyPanelPassword = keyChanged ? "" : current.proxyPanelPassword || "";
  return normalizeProxyPanelConfig(merged);
}

export function isProxyPanelStateProxy(config = {}) {
  const proxyConfig = normalizeProxyPanelConfig(config);
  return Boolean(proxyConfig.stateProxyEnabled && proxyConfig.stateProxyProvider === "proxypanel");
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

function stateCode(stateName) {
  const state = normalizeStateName(stateName).toLowerCase();
  return STATE_ABBR[state] || state.slice(0, 2).toUpperCase();
}

function carrierText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function locationMatchesState(location, stateName) {
  const state = normalizeStateName(stateName);
  const code = stateCode(state);
  const values = [
    location.state,
    location.region,
    location.region_name,
    location.state_name,
    location.city,
    location.name,
    location.label,
    location.display_name,
    location.location
  ].map((value) => String(value || "").trim().toLowerCase());
  return values.some((value) => value === state.toLowerCase() || value === code.toLowerCase() || value.includes(` ${code.toLowerCase()}`) || value.includes(state.toLowerCase()));
}

function locationMatchesCarrier(location, carrier) {
  const wanted = normalizeCarrier(carrier);
  const text = carrierText([
    location.carrier,
    location.isp,
    location.network,
    location.provider,
    location.city,
    location.name,
    location.label,
    location.display_name,
    location.location_id,
    ...(Array.isArray(location.carriers) ? location.carriers.map((item) => item?.carrier) : [])
  ].filter(Boolean).join(" "));
  if (wanted === "tmobile") return text.includes("tmobile");
  return text.includes("verizon");
}

function carrierOfLocation(location, fallback = "tmobile") {
  if (locationMatchesCarrier(location, "verizon")) return "verizon";
  if (locationMatchesCarrier(location, "tmobile")) return "tmobile";
  return normalizeCarrier(fallback);
}

function infoMatchesCarrier(info, carrier) {
  const wanted = normalizeCarrier(carrier);
  const text = carrierText([info?.org, info?.isp, info?.carrier, info?.network].filter(Boolean).join(" "));
  if (wanted === "tmobile") return text.includes("tmobile");
  return text.includes("verizon");
}

function carrierFromInfo(info, fallback = "tmobile") {
  const text = carrierText([info?.org, info?.isp, info?.carrier, info?.network].filter(Boolean).join(" "));
  if (text.includes("verizon")) return "verizon";
  if (text.includes("tmobile")) return "tmobile";
  return normalizeCarrier(fallback);
}

function infoMatchesState(info, stateName) {
  const expected = normalizeStateName(stateName);
  const expectedCode = stateCode(expected).toLowerCase();
  const region = normalizeStateName(info?.region || "").toLowerCase();
  const city = String(info?.city || "").trim().toLowerCase();
  if (!expected) return true;
  if (region === expected.toLowerCase()) return true;
  if (region === expectedCode) return true;
  return city === expected.toLowerCase();
}

function carrierLabel(carrier) {
  return normalizeCarrier(carrier) === "verizon" ? "Verizon" : "T-Mobile";
}

function carrierFallbackOrder(preferred) {
  const first = normalizeCarrier(preferred);
  const second = first === "verizon" ? "tmobile" : "verizon";
  return [first, second];
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.result?.data)) return payload.result.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.locations)) return payload.locations;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.proxies)) return payload.proxies;
  return [];
}

function proxyIdOf(proxy) {
  return String(proxy?.id || proxy?.proxy_id || proxy?.public_id || proxy?.name || "").trim();
}

function proxyStatusText(proxy) {
  return String(
    proxy?.status ||
    proxy?.state ||
    proxy?.proxy_status ||
    proxy?.server_status ||
    proxy?.active_status ||
    ""
  ).trim().toLowerCase();
}

function proxyLooksActive(proxy) {
  const status = proxyStatusText(proxy);
  if (proxy?.is_active === false || proxy?.active === false || proxy?.enabled === false || proxy?.running === false) return false;
  if (["not_active", "inactive", "disabled", "expired", "deleted", "stopped", "stop", "off"].includes(status)) return false;
  if (["active", "running", "online", "live", "enabled"].includes(status)) return true;
  return true;
}

function pickActiveProxy(proxies, excludedId = "") {
  const excluded = String(excludedId || "").trim();
  return (Array.isArray(proxies) ? proxies : [])
    .filter((proxy) => proxyIdOf(proxy))
    .filter((proxy) => !excluded || proxyIdOf(proxy) !== excluded)
    .find(proxyLooksActive) || null;
}

function locationIdOf(location) {
  return String(location?.id || location?.location_id || location?.public_id || location?.slug || location?.name || "").trim();
}

function parseProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const protocol = url.protocol.replace(":", "").toLowerCase() === "socks5" ? "socks5" : "http";
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
      protocol,
      raw: `${url.hostname}:${url.port}:${decodeURIComponent(url.username || "")}:${decodeURIComponent(url.password || "")}`
    };
  } catch {
    return null;
  }
}

function proxyFromCredentials(payload, protocol) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
  const urlValue = protocol === "http"
    ? data.http_url || data.http || data.url
    : data.socks5_url || data.socks_url || data.socks5 || data.url;
  const parsed = parseProxyUrl(urlValue);
  if (parsed?.host && parsed?.port) return parsed;
  const host = String(data.host || data.hostname || data.server || "").trim();
  const port = Number(data.port || data[`${protocol}_port`] || data.socks5_port || data.http_port);
  const username = String(data.username || data.user || "").trim();
  const password = String(data.password || data.pass || data.token || "").trim();
  if (!host || !port) return null;
  return {
    host,
    port,
    username,
    password,
    protocol,
    raw: username || password ? `${host}:${port}:${username}:${password}` : `${host}:${port}`
  };
}

function applyManualProxyAuth(proxy, config) {
  const proxyConfig = normalizeProxyPanelConfig(config);
  if (!proxy) return proxy;
  const username = proxyConfig.proxyPanelUsername || proxy.username || "";
  const password = proxyConfig.proxyPanelPassword || proxy.password || "";
  const protocol = proxyConfig.proxyPanelProtocol || proxy.protocol || "socks5";
  return {
    ...proxy,
    username,
    password,
    protocol,
    raw: username || password ? `${proxy.host}:${proxy.port}:${username}:${password}` : `${proxy.host}:${proxy.port}`
  };
}

function proxyToHidePayload(proxy) {
  return JSON.stringify({
    host: proxy.host,
    port: proxy.port,
    mode: proxy.protocol === "socks5" ? "socks5" : "http",
    username: proxy.username,
    password: proxy.password
  });
}

function proxyToGpmRaw(proxy) {
  const scheme = proxy.protocol === "http" ? "http" : "socks5";
  const username = String(proxy.username || "");
  const password = String(proxy.password || "");
  const raw = !username && !password
    ? `${proxy.host}:${proxy.port}`
    : `${proxy.host}:${proxy.port}:${username}:${password}`;
  return scheme === "socks5" ? `socks5://${raw}` : raw;
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

function requestIpInfoCurl(proxy, timeoutMs) {
  const startedAt = Date.now();
  const scheme = proxy.protocol === "socks5" ? "socks5h" : "http";
  const auth = proxy.username || proxy.password
    ? `${encodeURIComponent(proxy.username || "")}:${encodeURIComponent(proxy.password || "")}@`
    : "";
  const proxyUrl = `${scheme}://${auth}${proxy.host}:${proxy.port}`;
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
      try {
        const info = JSON.parse(String(stdout || "").trim());
        resolve({
          ok: Boolean(info.ip),
          pingMs: Date.now() - startedAt,
          ip: info.ip || "",
          city: info.city || "",
          region: info.region || "",
          country: info.country || "",
          org: info.org || "",
          timezone: info.timezone || "",
          error: info.ip ? "" : `ipinfo khong co IP: ${String(stdout || "").slice(0, 100)}`
        });
      } catch {
        resolve({ ok: false, error: `ipinfo tra ve sai JSON: ${String(stdout || stderr || "").slice(0, 120)}` });
      }
    });
  });
}

function readPersistedState() {
  try {
    if (!existsSync(PERSISTED_STATE_PATH)) return {};
    return JSON.parse(readFileSync(PERSISTED_STATE_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function writePersistedState(data) {
  mkdirSync(path.dirname(PERSISTED_STATE_PATH), { recursive: true });
  writeFileSync(PERSISTED_STATE_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function wait(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithProgress(totalMs, makeProgress) {
  const endAt = Date.now() + Math.max(0, Number(totalMs || 0));
  while (Date.now() < endAt) {
    const leftMs = Math.max(0, endAt - Date.now());
    if (typeof makeProgress === "function") {
      makeProgress(leftMs, endAt);
    }
    await wait(Math.min(1000, leftMs));
  }
}

function progressSecondsLeft(progress = {}) {
  const until = Number(progress.waitUntil || 0);
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function proxyPanelConfigFingerprint(config = {}) {
  const proxyConfig = normalizeProxyPanelConfig(config);
  const key = proxyConfig.proxyPanelApiKey;
  return JSON.stringify({
    baseUrl: proxyConfig.proxyPanelBaseUrl,
    keyTail: key ? key.slice(-10) : "",
    proxyId: proxyConfig.proxyPanelProxyId || "",
    protocol: proxyConfig.proxyPanelProtocol || "socks5",
    username: proxyConfig.proxyPanelUsername || "",
    passwordTail: proxyConfig.proxyPanelPassword ? proxyConfig.proxyPanelPassword.slice(-6) : ""
  });
}

export function createProxyPanelTool({ hideRequest, addRuntimeLog }) {
  const lock = { current: Promise.resolve() };
  const persistedState = readPersistedState();
  const state = {
    ...persistedState,
    stateCarrierPreference: persistedState.stateCarrierPreference || {},
    stateLocationPreference: persistedState.stateLocationPreference || {},
    badStateCarriers: persistedState.badStateCarriers || {},
    badStateLocations: persistedState.badStateLocations || {},
    inUse: false,
    assignedProfileId: ""
  };
  let locationsCache = { loadedAt: 0, items: [] };

  function log(message, type = "info", profileId = "", detail = "") {
    addRuntimeLog(message, type, profileId, { tool: "proxy theo bang", step: "proxypanel", detail });
  }

  function saveState() {
    writePersistedState({
      proxyId: state.proxyId || "",
      currentState: state.currentState || "",
      currentLocationId: state.currentLocationId || "",
      carrier: state.carrier || "",
      raw: state.raw || "",
      host: state.host || "",
      port: state.port || "",
      protocol: state.protocol || "",
      exitIp: state.exitIp || "",
      city: state.city || "",
      region: state.region || "",
      org: state.org || "",
      ipinfoPingMs: state.ipinfoPingMs ?? null,
      lastRotateAt: Number(state.lastRotateAt || 0),
      lastRelocateAt: Number(state.lastRelocateAt || 0),
      lastAssignedAt: Number(state.lastAssignedAt || 0),
      usageCount: Number(state.usageCount || 0),
      stateCarrierPreference: state.stateCarrierPreference || {},
      stateLocationPreference: state.stateLocationPreference || {},
      badStateCarriers: state.badStateCarriers || {},
      badStateLocations: state.badStateLocations || {},
      progress: state.progress || null,
      configFingerprint: state.configFingerprint || "",
      lastError: state.lastError || ""
    });
  }

  function ensureConfigState(config = {}) {
    const fingerprint = proxyPanelConfigFingerprint(config);
    if (!fingerprint || state.configFingerprint === fingerprint) return;
    const keepState = normalizeStateName(state.currentState || normalizeProxyPanelConfig(config).proxyPanelStateOverride || "");
    state.proxyId = normalizeProxyPanelConfig(config).proxyPanelProxyId || "";
    state.currentState = keepState;
    state.currentLocationId = "";
    state.carrier = normalizeProxyPanelConfig(config).proxyPanelCarrier;
    state.raw = "";
    state.host = "";
    state.port = "";
    state.exitIp = "";
    state.city = "";
    state.region = "";
    state.org = "";
    state.ipinfoPingMs = null;
    state.lastRotateAt = 0;
    state.lastRelocateAt = 0;
    state.stateCarrierPreference = {};
    state.stateLocationPreference = {};
    state.badStateCarriers = {};
    state.badStateLocations = {};
    state.progress = null;
    state.lastError = "";
    state.configFingerprint = fingerprint;
    saveState();
  }

  function setProgress(progress = {}) {
    state.progress = {
      phase: progress.phase || "",
      targetState: normalizeStateName(progress.targetState || state.currentState || ""),
      carrier: progress.carrier ? normalizeCarrier(progress.carrier) : "",
      locationId: progress.locationId || state.currentLocationId || "",
      attempt: Number(progress.attempt || 0),
      maxAttempts: Number(progress.maxAttempts || 0),
      message: progress.message || "",
      waitUntil: Number(progress.waitUntil || 0)
    };
    saveState();
  }

  function clearProgress() {
    state.progress = null;
  }

  async function withLock(action) {
    const previous = lock.current;
    let release;
    lock.current = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async function api(config, endpoint, options = {}) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    if (!proxyConfig.proxyPanelApiKey) throw new Error("Chua cau hinh ProxyPanel API key.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proxyConfig.proxyPanelRequestTimeoutMs);
    try {
      const response = await fetch(`${proxyConfig.proxyPanelBaseUrl}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${proxyConfig.proxyPanelApiKey}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      if (!response.ok) {
        const error = new Error(`ProxyPanel API loi ${response.status}: ${text || response.statusText}`);
        error.status = response.status;
        error.payload = payload;
        error.retryAfter = Number(payload?.retry_after || response.headers.get("retry-after") || 0);
        error.code = payload?.error || payload?.code || "";
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listProxies(config) {
    return pickArray(await api(config, "/proxies"));
  }

  async function listLocations(config) {
    if (Date.now() - locationsCache.loadedAt < 5 * 60 * 1000 && locationsCache.items.length) return locationsCache.items;
    const items = pickArray(await api(config, "/locations"));
    locationsCache = { loadedAt: Date.now(), items };
    return items;
  }

  async function resolveProxyId(config) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const proxies = await listProxies(proxyConfig);
    const configured = proxies.find((proxy) => proxyIdOf(proxy) === proxyConfig.proxyPanelProxyId && proxyLooksActive(proxy));
    if (configured) return proxyConfig.proxyPanelProxyId;
    const remembered = proxies.find((proxy) => proxyIdOf(proxy) === state.proxyId && proxyLooksActive(proxy));
    if (remembered) return state.proxyId;
    const picked = pickActiveProxy(proxies);
    const id = proxyIdOf(picked);
    if (!id) throw new Error("ProxyPanel khong co proxy nao de dung.");
    state.proxyId = id;
    saveState();
    return id;
  }

  function isProxyUnavailable(error) {
    const status = Number(error?.status || 0);
    const text = String(error?.code || error?.message || "").toLowerCase();
    return (status === 404 && text.includes("proxy_not_found")) ||
      (status === 409 && (text.includes("not_active") || text.includes("port is not active")));
  }

  async function refreshProxyId(config, previousProxyId = "") {
    const proxies = await listProxies(config);
    const next = pickActiveProxy(proxies, previousProxyId) || pickActiveProxy(proxies) || proxies.find((proxy) => proxyIdOf(proxy) && proxyIdOf(proxy) !== previousProxyId) || proxies[0];
    const id = proxyIdOf(next);
    if (!id) throw new Error("ProxyPanel khong co proxy nao de dung.");
    state.proxyId = id;
    state.lastError = "";
    saveState();
    log(`ProxyPanel proxy id cu ${previousProxyId || "-"} khong con, doi sang ${id}`, "warn", "", state.currentState || "");
    return id;
  }

  async function withLiveProxyId(config, proxyId, action) {
    try {
      return await action(proxyId);
    } catch (error) {
      if (!isProxyUnavailable(error)) throw error;
      const nextProxyId = await refreshProxyId(config, proxyId);
      return action(nextProxyId);
    }
  }

  async function pickLocation(config, stateName, carrier = "") {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const wantedCarrier = normalizeCarrier(carrier || proxyConfig.proxyPanelCarrier);
    const stateKey = normalizeStateName(stateName).toLowerCase();
    const preferredLocationId = String(state.stateLocationPreference?.[stateKey] || "").trim();
    const badLocations = state.badStateLocations?.[stateKey] || {};
    const isBadLocation = (location) => Number(badLocations[locationIdOf(location)] || 0) > Date.now();
    const locations = await listLocations(proxyConfig);
    const sameState = locations.filter((location) => locationMatchesState(location, stateName));
    const sameCarrier = sameState
      .filter((location) => locationMatchesCarrier(location, wantedCarrier))
      .sort((a, b) => {
        const aId = locationIdOf(a);
        const bId = locationIdOf(b);
        if (preferredLocationId && aId === preferredLocationId && !isBadLocation(a)) return -1;
        if (preferredLocationId && bId === preferredLocationId && !isBadLocation(b)) return 1;
        const aBad = isBadLocation(a);
        const bBad = isBadLocation(b);
        if (aBad !== bBad) return aBad ? 1 : -1;
        return Number(b.available_slots || 0) - Number(a.available_slots || 0);
      });
    const validPreferredLocationId = preferredLocationId && sameCarrier.some((location) => locationIdOf(location) === preferredLocationId)
      ? preferredLocationId
      : "";
    const preferred = sameCarrier.find((location) => validPreferredLocationId && locationIdOf(location) === validPreferredLocationId && !isBadLocation(location))
      || sameCarrier.find((location) => Number(location.available_slots ?? 1) > 0 && !isBadLocation(location))
      || sameCarrier[0];
    const fallback = sameState[0] || locations.find((location) => locationMatchesCarrier(location, wantedCarrier));
    const picked = preferred || fallback;
    const id = locationIdOf(picked);
    if (!id) throw new Error(`ProxyPanel khong tim thay location cho bang ${stateName}.`);
    return { location: picked, id, carrier: carrierOfLocation(picked, wantedCarrier) };
  }

  async function getCredentials(config, proxyId) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const payload = await api(proxyConfig, `/proxies/${encodeURIComponent(proxyId)}/credentials`);
    const proxy = applyManualProxyAuth(proxyFromCredentials(payload, proxyConfig.proxyPanelProtocol), proxyConfig);
    if (!proxy?.host || !proxy?.port) throw new Error("ProxyPanel credentials tra ve thieu host/port.");
    return proxy;
  }

  async function getProxy(config, proxyId) {
    return api(config, `/proxies/${encodeURIComponent(proxyId)}?probe=true`).catch(() => ({}));
  }

  function extractIp(payload) {
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
    return String(data.current_ip || data.ip || data.exit_ip || data.public_ip || "").trim();
  }

  async function rotateSameLocation(config, proxyId) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const elapsed = Date.now() - Number(state.lastRotateAt || 0);
    const waitMs = Math.max(0, proxyConfig.proxyPanelRotateCooldownSeconds * 1000 - elapsed);
    if (waitMs > 0) {
      setProgress({
        phase: "wait",
        targetState: state.currentState || "",
        carrier: state.carrier || proxyConfig.proxyPanelCarrier,
        locationId: state.currentLocationId || "",
        message: `Cho fresh IP ${Math.ceil(waitMs / 1000)}s`,
        waitUntil: Date.now() + waitMs
      });
    }
    await waitWithProgress(waitMs, (leftMs, endAt) => {
      setProgress({
        phase: "wait",
        targetState: state.currentState || "",
        carrier: state.carrier || proxyConfig.proxyPanelCarrier,
        locationId: state.currentLocationId || "",
        message: `Cho fresh IP ${Math.ceil(leftMs / 1000)}s`,
        waitUntil: endAt
      });
    });
    for (let attempt = 1; ; attempt += 1) {
      setProgress({
        phase: "rotate",
        targetState: state.currentState || "",
        carrier: state.carrier || proxyConfig.proxyPanelCarrier,
        locationId: state.currentLocationId || "",
        attempt,
        maxAttempts: null,
        message: attempt === 1 ? "Dang fresh IP" : `Dang fresh IP lai lan ${attempt}`
      });
      try {
        await api(proxyConfig, `/proxies/${encodeURIComponent(proxyId)}/rotate`, { method: "POST" });
        break;
      } catch (error) {
        const retryAfter = Number(error?.retryAfter || 0);
        const cooldown = Number(error?.status) === 409 && retryAfter > 0;
        if (!cooldown) throw error;
        const waitSeconds = Math.min(180, Math.ceil(retryAfter + 2));
        state.lastError = `ProxyPanel dang cooldown fresh IP, cho ${waitSeconds}s roi thu lai.`;
        await waitWithProgress(waitSeconds * 1000, (leftMs, endAt) => {
          setProgress({
            phase: "cooldown",
            targetState: state.currentState || "",
            carrier: state.carrier || proxyConfig.proxyPanelCarrier,
            locationId: state.currentLocationId || "",
            message: `ProxyPanel dang cooldown fresh IP, cho ${Math.ceil(leftMs / 1000)}s roi thu lai.`,
            waitUntil: endAt
          });
        });
        saveState();
        log(state.lastError, "warn", "", state.currentState || "");
      }
    }
    state.lastRotateAt = Date.now();
    await wait(proxyConfig.proxyPanelReadyDelaySeconds * 1000);
  }

  async function relocate(config, proxyId, stateName, carrier = "") {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const wantedCarrier = normalizeCarrier(carrier || proxyConfig.proxyPanelCarrier);
    const { id, carrier: actualCarrier } = await pickLocation(config, stateName, wantedCarrier);
    state.currentLocationId = id;
    state.currentState = normalizeStateName(stateName);
    state.carrier = actualCarrier;
    state.exitIp = "";
    state.city = "";
    state.region = "";
    state.org = "";
    state.ipinfoPingMs = null;
    state.lastError = `ProxyPanel dang doi ${state.currentState} ${carrierLabel(actualCarrier)}...`;
    saveState();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        log(`ProxyPanel relocate ${normalizeStateName(stateName)} ${carrierLabel(actualCarrier)} -> ${id}`, "info", "", stateName);
        await api(proxyConfig, `/proxies/${encodeURIComponent(proxyId)}/relocate`, {
          method: "POST",
          body: JSON.stringify({ location_id: id })
        });
        break;
      } catch (error) {
        const retryAfter = Number(error?.retryAfter || 0);
        const cooldown = error?.status === 409 && retryAfter > 0;
        if (!cooldown || attempt >= 2) throw error;
        const waitSeconds = Math.min(180, Math.ceil(retryAfter + 2));
        state.lastError = `ProxyPanel dang cooldown doi location, cho ${waitSeconds}s roi thu lai.`;
        setProgress({
          phase: "cooldown",
          targetState: stateName,
          carrier: actualCarrier,
          locationId: id,
          message: state.lastError,
          waitUntil: Date.now() + waitSeconds * 1000
        });
        saveState();
        log(state.lastError, "warn", "", stateName);
        await wait(waitSeconds * 1000);
      }
    }
    state.lastRelocateAt = Date.now();
    state.lastRotateAt = Date.now();
    await wait(proxyConfig.proxyPanelReadyDelaySeconds * 1000);
  }

  async function assignToProfile(config, profileId, proxy) {
    const provider = String(config.browserApiProvider || "").toLowerCase();
    const expectedRawProxy = proxyToGpmRaw(proxy);
    const payload = provider === "hide"
      ? { proxy: proxyToHidePayload(proxy) }
      : { raw_proxy: expectedRawProxy };
    await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      hideRetryAttempts: 2
    });
    if (provider !== "hide") {
      const updated = await hideRequest(config, `/profiles/${encodeURIComponent(profileId)}`, { hideRetryAttempts: 2 }).catch(() => null);
      const actualRawProxy = String(updated?.raw_proxy || updated?.proxy || "").trim();
      if (!sameProxyValue(actualRawProxy, expectedRawProxy)) {
        throw new Error(`GPM chua luu proxy ProxyPanel vao profile. expected=${expectedRawProxy}, actual=${actualRawProxy || "rong"}`);
      }
    }
  }

  function rememberVerifiedProxy(proxyConfig, proxy, info, targetState, locationId = "") {
    state.raw = proxy.raw || "";
    state.host = proxy.host || "";
    state.port = proxy.port || "";
    state.protocol = proxy.protocol || proxyConfig.proxyPanelProtocol;
    state.exitIp = info.ip || "";
    state.city = info.city || "";
    state.region = info.region || targetState;
    state.org = info.org || "";
    state.ipinfoPingMs = info.pingMs ?? null;
    state.carrier = carrierFromInfo(info, proxyConfig.proxyPanelCarrier);
    state.currentState = normalizeStateName(targetState);
    state.stateCarrierPreference = state.stateCarrierPreference || {};
    state.stateCarrierPreference[state.currentState.toLowerCase()] = state.carrier;
    const stateKey = state.currentState.toLowerCase();
    state.stateLocationPreference = state.stateLocationPreference || {};
    const verifiedLocationId = locationId || state.currentLocationId || "";
    if (verifiedLocationId) state.stateLocationPreference[stateKey] = verifiedLocationId;
    if (state.badStateCarriers?.[stateKey]) delete state.badStateCarriers[stateKey][state.carrier];
    if (state.badStateLocations?.[stateKey] && verifiedLocationId) delete state.badStateLocations[stateKey][verifiedLocationId];
    clearProgress();
    state.lastError = "";
  }

  function markBadRoute(stateKey, carrier = "", locationId = "") {
    state.badStateCarriers = state.badStateCarriers || {};
    state.badStateCarriers[stateKey] = state.badStateCarriers[stateKey] || {};
    if (carrier) state.badStateCarriers[stateKey][normalizeCarrier(carrier)] = Date.now() + BAD_CARRIER_TTL_MS;
    state.badStateLocations = state.badStateLocations || {};
    state.badStateLocations[stateKey] = state.badStateLocations[stateKey] || {};
    if (locationId) state.badStateLocations[stateKey][locationId] = Date.now() + BAD_CARRIER_TTL_MS;
    if (state.stateCarrierPreference?.[stateKey] === normalizeCarrier(carrier)) delete state.stateCarrierPreference[stateKey];
    if (locationId && state.stateLocationPreference?.[stateKey] === locationId) delete state.stateLocationPreference[stateKey];
  }

  async function verifyCurrentProxy(proxyConfig, proxyId, targetState) {
    const proxy = await getCredentials(proxyConfig, proxyId);
    const info = await requestIpInfoCurl(proxy, proxyConfig.proxyPanelInfoTimeoutMs);
    if (!info.ok) {
      return { ok: false, proxy, info, error: info.error || "ProxyPanel proxy khong ra mang." };
    }
    if (!infoMatchesState(info, targetState)) {
      return {
        ok: false,
        proxy,
        info,
        error: `ProxyPanel sai bang: dang ra ${info.region || info.city || info.ip || "khong ro"}, can ${normalizeStateName(targetState)}.`
      };
    }
    return { ok: true, proxy, info, error: "" };
  }

  async function prepareVerifiedProxy(proxyConfig, proxyId, targetState, options = {}) {
    const normalizedState = normalizeStateName(targetState);
    const normalizedStateKey = normalizedState.toLowerCase();
    let last = null;
    const previousStateMatches = normalizeStateName(state.currentState).toLowerCase() === normalizedStateKey;
    const requireNewIp = Boolean(options.sameState && !options.forceRelocate);
    let previousIp = requireNewIp ? String(state.exitIp || "").trim() : "";
    if (!previousStateMatches || state.lastError) {
      state.currentState = normalizedState;
      state.exitIp = "";
      state.city = "";
      state.region = "";
      state.org = "";
      state.ipinfoPingMs = null;
      state.lastError = `ProxyPanel dang ap dung ${normalizedState}...`;
      saveState();
    }
    if (previousStateMatches) {
      const current = await verifyCurrentProxy(proxyConfig, proxyId, normalizedState).catch((error) => ({
        ok: false,
        error: String(error?.message || error || "")
      }));
      if (current.ok) {
        previousIp = previousIp || String(current.info?.ip || "").trim();
        if (!requireNewIp) {
          rememberVerifiedProxy(proxyConfig, current.proxy, current.info, normalizedState);
          saveState();
          return current;
        }
        state.exitIp = previousIp;
        state.region = current.info?.region || state.region || "";
        state.city = current.info?.city || state.city || "";
        state.org = current.info?.org || state.org || "";
        state.ipinfoPingMs = current.info?.pingMs ?? state.ipinfoPingMs ?? null;
        saveState();
        log(`ProxyPanel same location ${normalizedState}: IP cu ${previousIp || "?"}, bat buoc fresh sang IP moi.`, "info", "", normalizedState);
      } else if (!requireNewIp) {
        markBadRoute(normalizedStateKey, state.carrier || proxyConfig.proxyPanelCarrier, state.currentLocationId || "");
        saveState();
      }
      if (!current.ok && requireNewIp) {
        log(`ProxyPanel khong verify duoc IP cu truoc khi fresh: ${current.error || "khong ro"}`, "warn", "", normalizedState);
      }
    }
    const preferredCarrier = state.stateCarrierPreference?.[normalizedState.toLowerCase()] || "verizon";
    let carriers = carrierFallbackOrder(preferredCarrier);
    const badForState = state.badStateCarriers?.[normalizedStateKey] || {};
      carriers.sort((a, b) => {
      const aBad = Number(badForState[a] || 0) > Date.now();
      const bBad = Number(badForState[b] || 0) > Date.now();
      if (aBad === bBad) return 0;
      return aBad ? 1 : -1;
    });
    for (let carrierIndex = 0; carrierIndex < carriers.length; carrierIndex += 1) {
      const carrier = carriers[carrierIndex];
      const carrierConfig = { ...proxyConfig, proxyPanelCarrier: carrier };
      const sameCarrier = normalizeCarrier(state.carrier || proxyConfig.proxyPanelCarrier) === carrier;
      const forceRelocate = Boolean(options.forceRelocate || carrierIndex > 0 || !sameCarrier);
      const maxAttempts = requireNewIp ? Number.POSITIVE_INFINITY : proxyConfig.proxyPanelVerifyAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const progressMaxAttempts = Number.isFinite(maxAttempts) ? maxAttempts : null;
        setProgress({
          phase: "attempt",
          targetState: normalizedState,
          carrier,
          locationId: state.currentLocationId || "",
          attempt,
          maxAttempts: progressMaxAttempts,
          message: progressMaxAttempts
            ? `Dang thu ${normalizedState} ${carrierLabel(carrier)} lan ${attempt}/${progressMaxAttempts}`
            : `Dang doi fresh IP moi ${normalizedState} ${carrierLabel(carrier)} lan ${attempt}`
        });
        if (attempt === 1) {
          if (!forceRelocate && options.sameState) await rotateSameLocation(carrierConfig, proxyId);
          else await relocate(carrierConfig, proxyId, normalizedState, carrier);
        } else {
          await rotateSameLocation(carrierConfig, proxyId);
        }
        const attemptedLocationId = state.currentLocationId || "";
        last = await verifyCurrentProxy(carrierConfig, proxyId, normalizedState);
        if (last.ok) {
          const nextIp = String(last.info?.ip || "").trim();
          if (requireNewIp && previousIp && nextIp && nextIp === previousIp) {
            last = {
              ...last,
              ok: false,
              error: `ProxyPanel fresh IP chua doi: van la ${nextIp}, can IP moi.`
            };
          } else {
            rememberVerifiedProxy(carrierConfig, last.proxy, last.info, normalizedState, attemptedLocationId);
            saveState();
            return last;
          }
        }
        state.lastError = `${last.error} (${carrierLabel(carrier)} thu ${attempt}/${proxyConfig.proxyPanelVerifyAttempts})`;
        if (last.info?.ip) {
          state.exitIp = last.info.ip;
          state.region = last.info.region || "";
          state.city = last.info.city || "";
          state.org = last.info.org || "";
          state.ipinfoPingMs = last.info.pingMs ?? null;
        }
        saveState();
        log(state.lastError, "warn", "", normalizedState);
        if (requireNewIp && attempt % Math.max(1, proxyConfig.proxyPanelVerifyAttempts) === 0) {
          const pauseMs = 5000;
          await waitWithProgress(pauseMs, (leftMs, endAt) => {
            setProgress({
              phase: "retry_wait",
              targetState: normalizedState,
              carrier,
              locationId: state.currentLocationId || "",
              attempt,
              maxAttempts: null,
              message: `ProxyPanel van chua ra IP moi, cho ${Math.ceil(leftMs / 1000)}s roi fresh tiep`,
              waitUntil: endAt
            });
          });
        }
      }
      markBadRoute(normalizedStateKey, carrier, state.currentLocationId || "");
      if (carrierIndex < carriers.length - 1) {
        state.exitIp = "";
        state.city = "";
        state.region = "";
        state.org = "";
        state.ipinfoPingMs = null;
        state.lastError = `ProxyPanel ${carrierLabel(carrier)} chua ra dung ${normalizedState}, dang thu ${carrierLabel(carriers[carrierIndex + 1])}.`;
        saveState();
        log(`ProxyPanel ${carrierLabel(carrier)} chua ra dung ${normalizedState}, thu ${carrierLabel(carriers[carrierIndex + 1])}.`, "warn", "", normalizedState);
      }
    }
    throw new Error(`ProxyPanel khong lay duoc IP dung bang ${normalizedState} bang ${carriers.map(carrierLabel).join(" hoac ")}.`);
  }

  async function prepareVerifiedProxyWithActiveId(proxyConfig, proxyId, targetState, options = {}) {
    let activeProxyId = proxyId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const verified = await prepareVerifiedProxy(proxyConfig, activeProxyId, targetState, options);
        return { proxyId: activeProxyId, verified };
      } catch (error) {
        if (!isProxyUnavailable(error) || attempt >= 3) throw error;
        const previousProxyId = activeProxyId;
        activeProxyId = await refreshProxyId(proxyConfig, previousProxyId);
        state.proxyId = activeProxyId;
        state.lastError = `ProxyPanel proxy ${previousProxyId} khong active, da doi sang ${activeProxyId}.`;
        saveState();
        log(state.lastError, "warn", "", targetState);
      }
    }
    throw new Error("ProxyPanel khong tim duoc proxy active de dung.");
  }

  async function ensureForProfile({ config, profileId, row = {}, log: runLog } = {}) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    if (!proxyConfig.stateProxyEnabled || proxyConfig.stateProxyProvider !== "proxypanel") return null;
    ensureConfigState(proxyConfig);
    const bang = normalizeStateName(
      proxyConfig.proxyPanelStateOverride ||
      rowValue(row.raw || {}, "bang", "proxy") ||
      rowValue(row, "bang", "proxy")
    );
    const uid = String(row.uid || row.raw?.uid || profileId || "").trim();
    if (!bang) {
      const error = new Error(`UID/profile ${uid || profileId} chua gan bang trong Sheet.`);
      error.status = "thieubang";
      throw error;
    }
    return withLock(async () => {
      const proxyId = await resolveProxyId(proxyConfig);
      state.proxyId = proxyId;
      const sameState = normalizeStateName(state.currentState).toLowerCase() === bang.toLowerCase();
      const forceRelocate = !sameState || Boolean(state.lastError);
      const prepared = await prepareVerifiedProxyWithActiveId(proxyConfig, proxyId, bang, { sameState: sameState && !forceRelocate, forceRelocate });
      const verified = prepared.verified;
      const activeProxyId = prepared.proxyId;
      const proxy = verified.proxy;
      const live = await getProxy(proxyConfig, activeProxyId).catch(() => ({}));
      state.proxyId = activeProxyId;
      state.exitIp = state.exitIp || extractIp(live) || "";
      state.inUse = true;
      state.assignedProfileId = profileId;
      state.lastAssignedAt = Date.now();
      state.lastError = "";
      await assignToProfile({ ...config, ...proxyConfig }, profileId, proxy);
      saveState();
      const action = sameState ? "fresh IP" : "doi location";
      const profileProvider = String(config.browserApiProvider || "").toLowerCase() === "hide" ? "HideMyAcc" : "GPM";
      runLog?.("gan proxy bang", `ProxyPanel ${action} ${bang} vao ${profileProvider} ${proxy.host}:${proxy.port} IP=${state.exitIp || "?"}`, "success");
      log(`[${profileId}] ProxyPanel ${action} ${bang} vao ${profileProvider}: ${proxy.host}:${proxy.port} IP=${state.exitIp || "?"}`, "success", profileId, bang);
      return { provider: "proxypanel", state: bang, slotId: activeProxyId, raw: proxy.raw };
    });
  }

  function release(lease) {
    if (lease?.provider !== "proxypanel") return;
    state.inUse = false;
    state.assignedProfileId = "";
    state.usageCount = Number(state.usageCount || 0) + 1;
    saveState();
  }

  async function checkAll(config) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    ensureConfigState(proxyConfig);
    try {
      const proxyId = await resolveProxyId(proxyConfig);
      const targetState = normalizeStateName(state.currentState || proxyConfig.stateProxyStates[0]);
      const checked = await withLiveProxyId(proxyConfig, proxyId, (id) => verifyCurrentProxy(proxyConfig, id, targetState));
      if (!checked.ok) throw new Error(checked.error);
      const proxy = checked.proxy;
      const info = checked.info;
      const activeProxyId = state.proxyId || proxyId;
      const live = await getProxy(proxyConfig, activeProxyId).catch(() => ({}));
      state.proxyId = activeProxyId;
      rememberVerifiedProxy(proxyConfig, proxy, { ...info, ip: info.ip || extractIp(live) }, targetState);
      state.lastError = "";
      saveState();
      return { checked: 1, checkedAttempts: 1, removed: 0, errors: [], status: getStatus({ ...proxyConfig, _proxy: proxy }) };
    } catch (error) {
      state.lastError = String(error?.message || error || "ProxyPanel check loi");
      saveState();
      return { checked: 0, checkedAttempts: 1, removed: 0, errors: [state.lastError], status: getStatus(proxyConfig) };
    }
  }

  async function applyNow(config, stateName = "") {
    const proxyConfig = normalizeProxyPanelConfig(config);
    ensureConfigState(proxyConfig);
    return withLock(async () => {
      try {
        const targetState = normalizeStateName(stateName || state.currentState || proxyConfig.stateProxyStates[0]);
        if (!targetState) throw new Error("Chua co bang de ap dung ProxyPanel.");
        const proxyId = await resolveProxyId(proxyConfig);
        state.proxyId = proxyId;
        const prepared = await prepareVerifiedProxyWithActiveId(proxyConfig, proxyId, targetState, { forceRelocate: true });
        state.proxyId = prepared.proxyId;
        const proxy = prepared.verified.proxy;
        log(`ProxyPanel da ap dung ${targetState} ${carrierLabel(state.carrier || proxyConfig.proxyPanelCarrier)} IP=${state.exitIp || "?"}`, "success", "", targetState);
        return { checked: 1, checkedAttempts: 1, removed: 0, errors: [], status: getStatus({ ...proxyConfig, _proxy: proxy }) };
      } catch (error) {
        state.lastError = String(error?.message || error || "ProxyPanel ap dung loi");
        saveState();
        throw error;
      }
    });
  }

  function addState(config, stateName) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    const states = normalizeStates([...proxyConfig.stateProxyStates, stateName]);
    return { ...proxyConfig, stateProxyStates: states };
  }

  function getStatus(config = {}) {
    const proxyConfig = normalizeProxyPanelConfig(config);
    ensureConfigState(proxyConfig);
    const proxy = config._proxy || {};
    return {
      config: proxyConfig,
      states: proxyConfig.stateProxyStates,
      enabled: proxyConfig.stateProxyEnabled,
      proxies: proxyConfig.proxyPanelProxyId || state.proxyId ? [{
        id: proxyConfig.proxyPanelProxyId || state.proxyId,
        state: state.currentState || "",
        raw: proxy.raw || state.raw || "",
        host: proxy.host || state.host || "",
        port: proxy.port || state.port || "",
        alive: Boolean(state.exitIp && !state.lastError),
        pingMs: null,
        ipinfoPingMs: state.ipinfoPingMs ?? null,
        exitIp: state.exitIp || "",
        city: state.city || "",
        region: state.region || state.currentState || "",
        country: "US",
        org: state.org || (normalizeCarrier(state.carrier || proxyConfig.proxyPanelCarrier) === "verizon" ? "Verizon" : "T-Mobile"),
        timezone: "",
        ipinfoSource: "proxypanel",
        inUse: Boolean(state.inUse),
        cooling: false,
        coldSeconds: 0,
        pingQuality: "good",
        assignedProfileId: state.assignedProfileId || "",
        usageCount: Number(state.usageCount || 0),
        maxUse: 0,
        poolSize: 1,
        ageSeconds: state.lastAssignedAt ? Math.floor((Date.now() - Number(state.lastAssignedAt || 0)) / 1000) : null,
        progress: state.progress ? { ...state.progress, secondsLeft: progressSecondsLeft(state.progress) } : null,
        lastError: state.lastError || ""
      }] : []
    };
  }

  return {
    DEFAULT_STATES,
    getStatus,
    addState,
    ensureForProfile,
    release,
    checkAll,
    applyNow
  };
}

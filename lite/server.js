import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, createSign } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDangNhap } from "./modules/dangnhap.js";
import { createCheckTb } from "./modules/checktb.js";
import { createLamFull } from "./modules/lamfull.js";
import { createDienMatKhau } from "./modules/dienmatkhau.js";
import { createDangBai } from "./modules/dangbai.js";
import { createTuongTac } from "./modules/tuongtac.js";
import { createRenewDocLapTool } from "./modules/renewdoclap.js";
import { createTaoPage } from "./modules/taopage.js";
import { createAvatarTool } from "./modules/avatar.js";
import { createCheckOrderTool, CHECK_ORDER_HEADERS } from "./modules/checkorder.js";
import { buildStandardName } from "./modules/profile_name.js";
import { createNineProxyTool, mergeProxyDefaults, sanitizeProxyConfigInput } from "./modules/nineproxy.js";
import { createClipProxyTool, mergeClipProxyDefaults, sanitizeClipProxyConfigInput } from "./modules/clipproxy.js";
import { createProxyPanelTool, isProxyPanelStateProxy, mergeProxyPanelDefaults, sanitizeProxyPanelConfigInput } from "./modules/proxypanel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const publicDir = path.join(__dirname, "public");
const configPath = path.join(__dirname, "config.json");
const electronPopupWatchdogPath = path.join(__dirname, "scripts", "close-electron-error-popups.ps1");
const updateVersionPath = path.join(__dirname, "data", "update-version.json");
const updateBackupRoot = path.join(__dirname, "data", "update-backups");
const DEFAULT_UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/allyngreenleaf96284-web/tooltonghop-update/main/manifest-lite.json";
const UPDATE_DOWNLOAD_TIMEOUT_MS = 60000;
const originalToolRoot = path.resolve(__dirname, "..", "..", "tooltonghop-portable", "tooltonghop");
const limitedUpdateFiles = [
  "modules/dangnhap.js",
  "modules/dienmatkhau.js",
  "modules/lamfull.js",
  "modules/tuongtac.js",
  "modules/facebook_locale.js",
  "modules/profile_name.js",
  "modules/nineproxy.js",
  "modules/clipproxy.js",
  "modules/proxypanel.js"
];
const limitedOnlineUpdateFiles = [
  "server.js",
  "public/app.js",
  "public/index.html",
  "public/styles.css",
  ...limitedUpdateFiles
];
function resolveAppPath(relativePath, fallbackAbsolutePath) {
  const bundledPath = path.join(__dirname, relativePath);
  return existsSync(bundledPath) ? bundledPath : fallbackAbsolutePath;
}
const OLD_XEM_TB_APP = resolveAppPath(
  path.join("bundled-apps", "tool-xem-tb-portable-20260427", "app"),
  "C:\\Users\\CPT\\Documents\\New project\\tool-xem-tb-portable-20260427\\app"
);
const SHIPPING_FULL_APP = resolveAppPath(
  path.join("bundled-apps", "Shipping-Full-Studio", "app"),
  "C:\\Users\\CPT\\Documents\\New project\\Shipping-Full-Studio\\app"
);
const HMA_STUDIO_APP = resolveAppPath(
  path.join("bundled-apps", "HMA-Studio-Portable-20260420", "app"),
  "C:\\Users\\CPT\\Documents\\New project\\dist\\HMA-Studio-Portable-20260420\\app"
);
const TOOL_TUONG_TAC_APP = resolveAppPath(
  path.join("bundled-apps", "tool-tuong-tac", "app"),
  "C:\\Users\\CPT\\Documents\\New project\\tool tuong tac\\app"
);
const SERVER_STARTED_AT = new Date().toISOString();
const runtimeLogDir = path.join(__dirname, "logs");
const crashLogPath = path.join(runtimeLogDir, "backend-crash.log");
let restartScheduled = false;
let restartLaunchStarted = false;
let electronPopupWatchdogProcess = null;
const backgroundSyncState = {
  timer: null,
  isTicking: false,
  lastSignature: "",
  lastCheckedAt: 0,
  lastSyncedAt: 0,
  lastError: "",
  enabled: false
};
const proxyMonitorState = {
  timer: null,
  isTicking: false,
  lastCheckedAt: 0,
  lastChangedAt: 0,
  lastError: ""
};
const gpmBaseCache = {
  baseUrl: "",
  checkedAt: 0
};

function resetProfileManagers(reason = "") {
  toolRuntime.manager = null;
  shippingFullManager = null;
  hmaStudioManager = null;
  interactionManager = null;
  clearManagedSheetCache(reason || "profile-provider-changed");
}

const DEFAULT_CONFIG = {
  browserApiProvider: "gpm",
  gpmBaseUrl: "http://127.0.0.1:9495/api/v1",
  hideBaseUrl: "http://127.0.0.1:2268",
  spreadsheetId: "",
  spreadsheetIds: [],
  accountSheets: {},
  lastHideAccountId: "",
  knownHideAccounts: {},
  credentialsPath: "",
  credentialSourceSpreadsheetId: "",
  sellerSpreadsheetId: "",
  fullDataRoot: "E:\\dangbai",
  fullPriceMin: "",
  fullPriceMax: "",
  fullConcurrency: 4,
  postConcurrency: 4,
  checkConcurrency: 4,
  checkOrderSpreadsheetId: "",
  checkOrderSheetName: "check order",
  checkOrderConcurrency: 1,
  interactionConcurrency: 4,
  pageConcurrency: 4,
  avatarConcurrency: 2,
  avatarImagePath: "",
  avatarReplaceExisting: false,
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
  nineProxyPingUrl: "http://api.ipify.org?format=json",
  stateProxyEnabled: false,
  stateProxyProvider: "clipproxy",
  clipProxyKey: "",
  clipProxyPort: 443,
  clipProxyCountry: "US",
  clipProxyType: 2,
  clipProxyAsn: "",
  clipProxyAsns: ["AS21928", "AS22773", "AS11351", "AS7922", "AS5650"],
  clipProxyFormat: "",
  clipProxyMaxUse: 10,
  clipProxyPoolSize: 5,
  clipProxyMaxAgeMinutes: 60,
  clipProxyPingLimitMs: 3000,
  clipProxyRequestTimeoutMs: 30000,
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
  stateProxyStates: ["Georgia", "Texas", "North Carolina", "Missouri", "Virginia", "New Mexico", "California"],
  interactionHomeTimeMin: 30,
  interactionHomeTimeMax: 60,
  interactionReelsTotalMin: 30,
  interactionReelsTotalMax: 60,
  interactionClipViewMin: 5,
  interactionClipViewMax: 10,
  interactionMarketPostsMin: 3,
  interactionMarketPostsMax: 5,
  interactionEnableRandomOrder: true,
  interactionHumanDelayMode: false,
  interactionSlowScrollMode: false,
  interactionEnableRenewListings: false,
  interactionEnableMarkAsSold: false,
  trashSheetName: "rác",
  autoRefreshSeconds: 2,
  autoSyncSeconds: 30,
  headers: [
    "tên profile hiện tại",
    "tên profile khóa cứng",
    "id hide",
    "uid",
    "Tool",
    "trạng thái",
    "số vạch",
    "địa chỉ ban đầu",
    "số lượng page",
    "chi tiết",
    "mật khẩu",
    "2fa",
    "cookie",
    "bang",
    "tên chuẩn"
  ]
};
const META_SHEET = "_tooltonghop_meta";
const NOT_LOCKED_TEXT = "chưa có id khóa cứng";
const sheetCache = {
  key: "",
  loadedAt: 0,
  byId: new Map(),
  titles: [],
  data: null,
  headers: [],
  source: "",
  reads: 0
};
let sellerInfoLock = Promise.resolve();
const sellerInfoCache = {
  key: "",
  loadedAt: 0,
  ttlMs: 5 * 60 * 1000,
  data: null
};
const toolRuntime = {
  jobs: new Map(),
  running: false,
  stopRequested: false,
  currentTool: "",
  queue: [],
  manager: null,
  logs: [],
  sheetSessions: new Set()
};

function makeHideSignature(hideState) {
  return JSON.stringify({
    folders: (hideState?.folders || []).map((folder) => [folder.id, folder.name]),
    profiles: (hideState?.profiles || []).map((profile) => [
      profile.id,
      profile.name,
      profile.folderId,
      profile.status,
      profile.uid
    ])
  });
}

function addRuntimeLog(message, type = "info", profileId = "", meta = {}) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    message: String(message || ""),
    type,
    profileId,
    tool: meta.tool || toolRuntime.jobs.get(profileId)?.tool || "",
    jobStatus: meta.jobStatus || toolRuntime.jobs.get(profileId)?.status || "",
    step: meta.step || "",
    detail: meta.detail || "",
    createdAt: new Date().toISOString()
  };
  toolRuntime.logs.push(entry);
  if (toolRuntime.logs.length > 5000) toolRuntime.logs = toolRuntime.logs.slice(-4000);
  if (profileId && toolRuntime.jobs.has(profileId)) {
    const job = toolRuntime.jobs.get(profileId);
    job.liveStatus = entry.message;
    job.logs.push(entry);
    if (job.logs.length > 80) job.logs.shift();
  }
  return entry;
}

function appendCrashLog(title, errorLike) {
  try {
    if (!existsSync(runtimeLogDir)) mkdirSync(runtimeLogDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const message = String(errorLike?.message || errorLike || "");
    const stack = String(errorLike?.stack || "");
    const block = [
      "",
      "============================================================",
      `[${timestamp}] ${title}`,
      `startedAt=${SERVER_STARTED_AT}`,
      `restartScheduled=${restartScheduled}`,
      `running=${toolRuntime.running}`,
      `jobCount=${toolRuntime.jobs.size}`,
      `message=${message}`,
      stack ? `stack=\n${stack}` : ""
    ].filter(Boolean).join("\n");
    appendFileSync(crashLogPath, `${block}\n`, "utf8");
  } catch {}
}

function scheduleManualBackendRestart(reason = "manual") {
  restartScheduled = true;
  if (restartLaunchStarted) return;
  restartLaunchStarted = true;
  let launched = false;
  const launch = () => {
    if (launched) return;
    launched = true;
    try {
      const child = spawn(process.execPath, ["server.js"], {
        cwd: __dirname,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } catch (error) {
      appendCrashLog("restart-launch-error", error);
    } finally {
      setTimeout(() => process.exit(0), 120).unref?.();
    }
  };

  setTimeout(() => {
    appendCrashLog("restart-force-timeout", reason);
    launch();
  }, 1800).unref?.();

  setTimeout(() => {
    try { server.closeIdleConnections?.(); } catch {}
    try { server.closeAllConnections?.(); } catch {}
    try {
      server.close(() => launch());
    } catch (error) {
      appendCrashLog("restart-close-error", error);
      launch();
    }
  }, 200).unref?.();
}
function startElectronPopupWatchdog() {
  if (process.platform !== "win32" || electronPopupWatchdogProcess || !existsSync(electronPopupWatchdogPath)) return;
  try {
    electronPopupWatchdogProcess = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", electronPopupWatchdogPath
    ], {
      detached: false,
      stdio: "ignore",
      windowsHide: true
    });
    electronPopupWatchdogProcess.unref();
    electronPopupWatchdogProcess.on("exit", () => {
      electronPopupWatchdogProcess = null;
    });
    addRuntimeLog("Da bat watchdog dong popup loi Electron/EBUSY.", "info", "", {
      tool: "he thong",
      step: "popup watchdog"
    });
  } catch (error) {
    appendCrashLog("popup-watchdog-start-failed", error);
  }
}

function normalizeBrowserApiProvider(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["hide", "hidemyacc", "hma", "hide my acc", "hide-my-acc"].includes(text) ? "hide" : "gpm";
}

function isGpmProvider(config = {}) {
  return normalizeBrowserApiProvider(config.browserApiProvider) === "gpm";
}

function isHideProvider(config = {}) {
  return normalizeBrowserApiProvider(config.browserApiProvider) === "hide";
}

function providerDisplayName(config = {}) {
  return isHideProvider(config) ? "HideMyAcc" : "GPM";
}
function sanitizeAccountSheetAssignments(accountSheets = {}, spreadsheetIds = []) {
  const validSheets = new Set((spreadsheetIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  const pairs = Object.entries(accountSheets || {})
    .map(([accountId, spreadsheetId]) => [String(accountId || "").trim(), String(spreadsheetId || "").trim()])
    .filter(([accountId, spreadsheetId]) => accountId && !accountId.startsWith("local:") && validSheets.has(spreadsheetId));

  const gpmSheets = new Set(pairs.filter(([accountId]) => accountId.startsWith("gpm:")).map(([, spreadsheetId]) => spreadsheetId));
  const result = {};
  for (const [accountId, spreadsheetId] of pairs) {
    if (accountId.startsWith("hide:") && gpmSheets.has(spreadsheetId)) continue;
    result[accountId] = spreadsheetId;
  }
  return result;
}

function normalizeHideBaseUrl(config = {}) {
  const raw = String(config.hideBaseUrl || DEFAULT_CONFIG.hideBaseUrl || "http://127.0.0.1:2268").trim() || "http://127.0.0.1:2268";
  return raw.replace(/\/+$/, "");
}
function normalizeGpmBaseUrl(config = {}) {
  const raw = String(config.gpmBaseUrl || "").trim()
    || (String(config.hideBaseUrl || "").includes("/api/v1") ? String(config.hideBaseUrl || "").trim() : "")
    || DEFAULT_CONFIG.gpmBaseUrl;
  const withoutSlash = raw.replace(/\/+$/, "");
  return withoutSlash.endsWith("/api/v1") ? withoutSlash : `${withoutSlash}/api/v1`;
}

async function probeGpmBaseUrl(baseUrl, timeoutMs = 450) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/profiles?page=1&page_size=1`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    return response.ok && data && (data.success === true || data.data !== undefined);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverGpmBaseUrl(config = {}) {
  const configured = normalizeGpmBaseUrl(config);
  const now = Date.now();
  if (gpmBaseCache.baseUrl && now - gpmBaseCache.checkedAt < 30_000) return gpmBaseCache.baseUrl;
  if (await probeGpmBaseUrl(configured, 650)) {
    gpmBaseCache.baseUrl = configured;
    gpmBaseCache.checkedAt = now;
    return configured;
  }
  const candidates = [];
  for (let port = 8000; port <= 10000; port += 1) {
    if (port === 9495) continue;
    candidates.push(`http://127.0.0.1:${port}/api/v1`);
  }
  for (let index = 0; index < candidates.length; index += 40) {
    const chunk = candidates.slice(index, index + 40);
    const results = await Promise.all(chunk.map((base) => probeGpmBaseUrl(base, 260)));
    const foundIndex = results.findIndex(Boolean);
    if (foundIndex >= 0) {
      const found = chunk[foundIndex];
      gpmBaseCache.baseUrl = found;
      gpmBaseCache.checkedAt = now;
      addRuntimeLog(`[GPM API] tu dong phat hien port: ${found}`, "success", "", {
        tool: "he thong",
        step: "GPM API discover"
      });
      return found;
    }
  }
  gpmBaseCache.baseUrl = configured;
  gpmBaseCache.checkedAt = now;
  return configured;
}

function safeDecodeProxyPart(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function buildGpmProxyRaw(host, port, username = "", password = "", scheme = "socks5") {
  const cleanHost = String(host || "").trim();
  const cleanPort = String(port || "").trim();
  if (!cleanHost || !cleanPort) return "";
  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "").trim();
  const cleanScheme = String(scheme || "socks5").toLowerCase().startsWith("http") ? "http" : "socks5";
  const raw = !cleanUser && !cleanPass
    ? `${cleanHost}:${cleanPort}`
    : `${cleanHost}:${cleanPort}:${cleanUser}:${cleanPass}`;
  return cleanScheme === "socks5" ? `socks5://${raw}` : raw;
}

function normalizeGpmProxy(rawProxy) {
  const text = String(rawProxy || "").trim();
  if (!text) return "";
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const scheme = (text.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1] || "socks5").toLowerCase();
  const parts = withoutScheme.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1] || "")) {
    const host = parts[0];
    const port = parts[1];
    const username = parts.slice(2, -1).join(":");
    const password = parts.at(-1) || "";
    return buildGpmProxyRaw(host, port, safeDecodeProxyPart(username), safeDecodeProxyPart(password), scheme);
  }
  const authFirst = withoutScheme.match(/^([^:\s@]+):([^@\s]*)@([^:\s@]+):(\d+)$/);
  if (authFirst) {
    const [, username, password, host, port] = authFirst;
    return buildGpmProxyRaw(host, port, safeDecodeProxyPart(username), safeDecodeProxyPart(password || ""), scheme);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return buildGpmProxyRaw(
        url.hostname,
        url.port || (url.protocol === "https:" ? "443" : "80"),
        safeDecodeProxyPart(url.username || ""),
        safeDecodeProxyPart(url.password || ""),
        url.protocol.replace(":", "")
      );
    } catch {}
  }
  const hostPort = withoutScheme.match(/^([^\s:@]+):(\d+)$/);
  if (hostPort) return `${hostPort[1]}:${hostPort[2]}`;
  return withoutScheme;
}

function hideProxyToGpmRawProxy(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return hideProxyToGpmRawProxy(JSON.parse(trimmed));
    } catch {
      return normalizeGpmProxy(trimmed);
    }
  }
  if (typeof value !== "object") return "";
  const host = String(value.host || value.ip || value.server || "").trim();
  const port = String(value.port || "").trim();
  if (!host || !port) return "";
  const username = String(value.username || value.user || "").trim();
  const password = String(value.password || value.pass || "").trim();
  return buildGpmProxyRaw(host, port, username, password, value.mode || value.protocol || "socks5");
}

function mapGpmProfile(profile = {}, groupLookup = new Map()) {
  const groupId = String(profile.group_id || profile.groupId || "all").trim() || "all";
  const groupName = groupLookup.get(groupId) || (groupId === "all" ? "Tất cả" : groupId);
  const browserName = String(profile.browser?.name || profile.browserType || profile.browser_type || "").trim();
  return {
    ...profile,
    id: String(profile.id || "").trim(),
    name: String(profile.name || "").trim(),
    folder: groupId,
    folderId: groupId,
    folderName: groupName,
    group_id: groupId,
    raw_proxy: String(profile.raw_proxy || "").trim(),
    proxy: String(profile.raw_proxy || "").trim(),
    status: String(profile.status || profile.state || "ready").trim() || "ready",
    browserType: browserName || "chrome",
    browserSource: browserName || "chrome",
    os: String(profile.os || profile.os_type || "windows").trim() || "windows",
    notes: String(profile.note || profile.notes || "").trim()
  };
}

async function gpmRequest(config, endpoint, options = {}) {
  const base = await discoverGpmBaseUrl(config);
  const url = `${base}${endpoint}`;
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    ...options,
    method,
    headers: {
      accept: "application/json",
      ...(method !== "GET" && method !== "HEAD" ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  };
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text ? { message: text } : {};
  }
  const allowOkCode0 = Boolean(options.allowOkCode0) && response.ok && /^ok$/i.test(String(data.message || text || "").trim());
  if (!response.ok || (data.success === false && !allowOkCode0) || (data.code === 0 && !allowOkCode0)) {
    const error = new Error(`GPM API lỗi ${response.status}: ${data.message || text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data.data ?? data;
}

async function gpmRequestWithRetry(config, endpoint, options = {}) {
  const maxAttempts = Number(options.hideRetryAttempts || options.gpmRetryAttempts || 5);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await gpmRequest(config, endpoint, options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      const retryableStatus = [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status));
      const retryableNetwork = /fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket|aborted/i.test(message);
      if (attempt >= maxAttempts || (!retryableStatus && !retryableNetwork)) break;
      if (retryableNetwork) {
        gpmBaseCache.baseUrl = "";
        gpmBaseCache.checkedAt = 0;
      }
      const delay = Math.min(8000, 600 * attempt + Math.floor(Math.random() * 400));
      addRuntimeLog(`[GPM API] ket noi loi, thu lai ${attempt}/${maxAttempts}: ${message}`, "warn", "", {
        tool: "he thong",
        step: "GPM API retry"
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function getGpmGroups(config) {
  const groups = [];
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({ page: String(page), page_size: "100", sort: "2" });
    const payload = await gpmRequestWithRetry(config, `/groups?${params.toString()}`);
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    groups.push(...items);
    const lastPage = Number(payload?.last_page || 1);
    if (!payload?.last_page || page >= lastPage) break;
  }
  const normalized = groups
    .map((group) => ({
      id: String(group.id || "").trim(),
      name: String(group.name || group.title || "").trim() || "Không tên"
    }))
    .filter((group) => group.id);
  if (!normalized.some((group) => group.id === "all")) {
    normalized.unshift({ id: "all", name: "Tất cả" });
  }
  return normalized;
}

async function getGpmProfiles(config, groupLookup = new Map()) {
  const profiles = [];
  for (let page = 1; page <= 1000; page += 1) {
    const params = new URLSearchParams({ page: String(page), page_size: "100", sort: "0" });
    const payload = await gpmRequestWithRetry(config, `/profiles?${params.toString()}`);
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    profiles.push(...items.map((profile) => mapGpmProfile(profile, groupLookup)).filter((profile) => profile.id));
    const lastPage = Number(payload?.last_page || 1);
    if (!payload?.last_page || page >= lastPage) break;
  }
  return profiles;
}

async function getGpmProfile(config, profileId, groupLookup = new Map()) {
  const profile = await gpmRequestWithRetry(config, `/profiles/${encodeURIComponent(profileId)}`);
  return mapGpmProfile(profile, groupLookup);
}

async function updateGpmProfile(config, profileId, payload = {}) {
  const body = {};
  if (payload.name !== undefined) body.name = String(payload.name || "");
  if (payload.raw_proxy !== undefined) body.raw_proxy = normalizeGpmProxy(payload.raw_proxy);
  if (payload.proxy !== undefined && body.raw_proxy === undefined) body.raw_proxy = hideProxyToGpmRawProxy(payload.proxy);
  if (payload.note !== undefined || payload.notes !== undefined) body.note = String(payload.note ?? payload.notes ?? "");
  if (!Object.keys(body).length) return getGpmProfile(config, profileId).catch(() => ({ id: profileId }));
  return gpmRequestWithRetry(config, `/profiles/update/${encodeURIComponent(profileId)}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function hideApiRequest(config, endpoint, options = {}) {
  const base = normalizeHideBaseUrl(config);
  const url = `${base}${endpoint}`;
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    ...options,
    method,
    headers: {
      accept: "application/json",
      ...(method !== "GET" && method !== "HEAD" ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  };
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text ? { message: text } : {};
  }
  if (!response.ok || data.success === false || data.code === 0) {
    const error = new Error(`HideMyAcc API loi ${response.status}: ${data.message || text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data.data ?? data;
}

async function hideApiRequestWithRetry(config, endpoint, options = {}) {
  const maxAttempts = Number(options.hideRetryAttempts || 5);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await hideApiRequest(config, endpoint, options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      const retryableStatus = [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status));
      const retryableNetwork = /fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket|aborted/i.test(message);
      if (attempt >= maxAttempts || (!retryableStatus && !retryableNetwork)) break;
      const delay = Math.min(8000, 600 * attempt + Math.floor(Math.random() * 400));
      addRuntimeLog(`[HideMyAcc API] ket noi loi, thu lai ${attempt}/${maxAttempts}: ${message}`, "warn", "", {
        tool: "he thong",
        step: "HideMyAcc API retry"
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function mapHideProfile(profile = {}) {
  const folderId = String(profile.folderId || profile.folder_id || profile.folder || profile.group || profile.group_id || "all").trim() || "all";
  const folderName = String(profile.folderName || profile.folder_name || profile.folder || profile.groupName || profile.group_name || (folderId === "all" ? "Tất cả" : folderId)).trim() || "Tất cả";
  const proxyValue = typeof profile.proxy === "string" ? profile.proxy : JSON.stringify(profile.proxy || "");
  return {
    ...profile,
    id: String(profile.id || profile.profileId || profile.uuid || "").trim(),
    name: String(profile.name || profile.title || "").trim(),
    folder: folderId,
    folderId,
    folderName,
    group_id: folderId,
    raw_proxy: String(profile.raw_proxy || proxyValue || "").trim(),
    proxy: profile.proxy || profile.raw_proxy || "",
    status: String(profile.status || profile.state || "ready").trim() || "ready",
    browserType: String(profile.browserType || profile.browser_type || profile.browser || "chrome").trim() || "chrome",
    browserSource: String(profile.browserSource || profile.browser_source || "").trim(),
    os: String(profile.os || profile.os_type || "windows").trim() || "windows",
    notes: String(profile.note || profile.notes || "").trim()
  };
}

async function getHideProfiles(config) {
  const payload = await hideApiRequestWithRetry(config, "/profiles", { hideRetryAttempts: 5 });
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return items.map(mapHideProfile).filter((profile) => profile.id);
}

async function getHideFolders(config) {
  try {
    const payload = await hideApiRequestWithRetry(config, "/folders", { hideRetryAttempts: 2 });
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const folders = items.map((folder) => ({
      id: String(folder.id || folder.folderId || folder.name || "").trim(),
      name: String(folder.name || folder.title || folder.id || "Không tên").trim() || "Không tên"
    })).filter((folder) => folder.id);
    if (folders.length) return folders;
  } catch {}
  const profiles = await getHideProfiles(config);
  const byId = new Map();
  for (const profile of profiles) {
    const id = String(profile.folderId || "all").trim() || "all";
    if (!byId.has(id)) byId.set(id, { id, name: String(profile.folderName || (id === "all" ? "Tất cả" : id)).trim() || "Tất cả" });
  }
  if (!byId.size) byId.set("all", { id: "all", name: "Tất cả" });
  return [...byId.values()];
}

function normalizeHideStartResult(data = {}) {
  const payload = data?.data && typeof data.data === "object" ? data.data : data;
  return {
    ...payload,
    wsUrl: payload.wsUrl || payload.webSocketDebuggerUrl || payload.wsEndpoint || payload.websocket_debugging_url || "",
    webSocketDebuggerUrl: payload.wsUrl || payload.webSocketDebuggerUrl || payload.wsEndpoint || payload.websocket_debugging_url || "",
    wsEndpoint: payload.wsUrl || payload.webSocketDebuggerUrl || payload.wsEndpoint || payload.websocket_debugging_url || "",
    port: payload.port || payload.debugPort || payload.remote_debugging_port || "",
    debugPort: payload.port || payload.debugPort || payload.remote_debugging_port || "",
    pid: payload.pid || payload.processId || payload.browserPid || payload.process_id || null
  };
}

async function updateHideProfile(config, profileId, payload = {}) {
  const current = await getHideProfiles(config).then((items) => items.find((item) => item.id === String(profileId || "").trim())).catch(() => null);
  const body = {
    ...(current || {}),
    ...payload
  };
  if (payload.raw_proxy !== undefined && payload.proxy === undefined) body.proxy = payload.raw_proxy;
  return hideApiRequestWithRetry(config, `/profiles/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
    hideRetryAttempts: 2
  });
}
function normalizeGpmStartResult(data = {}) {
  const payload = data?.data && typeof data.data === "object" ? data.data : data;
  return {
    ...payload,
    wsUrl: payload.websocket_debugging_url || payload.webSocketDebuggerUrl || payload.wsUrl || payload.wsEndpoint || "",
    webSocketDebuggerUrl: payload.websocket_debugging_url || payload.webSocketDebuggerUrl || payload.wsUrl || payload.wsEndpoint || "",
    wsEndpoint: payload.websocket_debugging_url || payload.webSocketDebuggerUrl || payload.wsUrl || payload.wsEndpoint || "",
    port: payload.remote_debugging_port || payload.debugPort || payload.port || "",
    debugPort: payload.remote_debugging_port || payload.debugPort || payload.port || "",
    pid: payload.addition_info?.process_id || payload.process_id || payload.pid || payload.processId || payload.browserPid || null
  };
}

function patchProfileManager(manager, toolName = "he thong") {
  if (!manager || manager.__profileApiPatched) return manager;
  manager.__profileApiPatched = true;
  manager.__profileConfig = async () => readConfig();

  manager.listProfiles = async function listProviderProfiles() {
    const config = await this.__profileConfig();
    if (isHideProvider(config)) return getHideProfiles(config);
    const groups = await getGpmGroups(config).catch(() => []);
    const groupLookup = new Map(groups.map((group) => [group.id, group.name]));
    return getGpmProfiles(config, groupLookup);
  };

  manager.getProfileById = async function getProviderProfileById(profileId) {
    const config = await this.__profileConfig();
    if (isHideProvider(config)) {
      const profiles = await getHideProfiles(config);
      return profiles.find((profile) => String(profile.id || "").trim() === String(profileId || "").trim()) || null;
    }
    const groups = await getGpmGroups(config).catch(() => []);
    return getGpmProfile(config, profileId, new Map(groups.map((group) => [group.id, group.name])));
  };

  manager.getProfileNameById = async function getProviderProfileNameById(profileId) {
    const profile = await this.getProfileById(profileId).catch(() => null);
    return String(profile?.name || "").trim();
  };

  manager.resolveProfileId = async function resolveProviderProfileId(uid, fallbackProfileId = "") {
    const current = String(fallbackProfileId || "").trim();
    if (current) return current;
    const token = String(uid || "").trim();
    if (/^[a-f0-9-]{16,}$/i.test(token)) return token;
    const items = await this.listProfiles();
    const match = items.find((item) => String(item?.name || "").includes(token));
    return String(match?.id || "").trim();
  };

  manager.updateProfileName = async function updateProviderProfileName(profileId, nextName) {
    if (!profileId || !nextName) return false;
    const config = await this.__profileConfig();
    if (isHideProvider(config)) await updateHideProfile(config, profileId, { name: nextName });
    else await updateGpmProfile(config, profileId, { name: nextName });
    const actualName = await this.getProfileNameById(profileId).catch(() => "");
    if (actualName && actualName !== nextName) {
      throw new Error(`${providerDisplayName(config)} chua doi ten profile. expected=${nextName}, actual=${actualName}`);
    }
    return true;
  };

  manager.startHideMyAccProfile = async function startProviderProfile(profileId) {
    const config = await this.__profileConfig();
    if (isHideProvider(config)) {
      const data = await hideApiRequestWithRetry(config, `/profiles/start/${encodeURIComponent(profileId)}`, {
        method: "POST",
        body: "{}",
        hideRetryAttempts: 2
      });
      const startInfo = normalizeHideStartResult(data);
      if (!startInfo.wsUrl && !startInfo.port) throw new Error("HideMyAcc opened profile but did not return websocket debugger URL or debug port.");
      return startInfo;
    }
    const params = new URLSearchParams({ skip_proxy_check: "true" });
    const data = await gpmRequestWithRetry(config, `/profiles/start/${encodeURIComponent(profileId)}?${params.toString()}`, {
      method: "GET",
      hideRetryAttempts: 2
    });
    const startInfo = normalizeGpmStartResult(data);
    if (!startInfo.wsUrl && !startInfo.port) throw new Error("GPM opened profile but did not return websocket debugger URL or debug port.");
    return startInfo;
  };

  manager.stopHideMyAccProfile = async function stopProviderProfile(profileId) {
    if (!profileId) return;
    const config = await this.__profileConfig();
    const providerName = providerDisplayName(config);
    try {
      if (isHideProvider(config)) {
        await hideApiRequestWithRetry(config, `/profiles/stop/${encodeURIComponent(profileId)}`, {
          method: "POST",
          body: "{}",
          hideRetryAttempts: 2
        });
      } else {
        await gpmRequestWithRetry(config, `/profiles/stop/${encodeURIComponent(profileId)}`, {
          method: "GET",
          hideRetryAttempts: 2,
          allowOkCode0: true
        });
      }
    } catch (error) {
      this.sendLog?.(`[${profileId}] stop ${providerName} profile error: ${error.message}`, "warn");
    }
  };

  manager.sendLog?.(`[Profile API] ${toolName} san sang dung GPM/HideMyAcc theo cong tac`, "info");
  return manager;
}

const patchGpmManager = patchProfileManager;

function getXemTbManager(options = {}) {
  if (options?.fresh) {
    const { MarketplaceManager } = require(path.join(OLD_XEM_TB_APP, "marketplace.js"));
    return patchGpmManager(new MarketplaceManager({
      appRoot: path.resolve(OLD_XEM_TB_APP, ".."),
      sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "xem thong bao" })
    }), "xem thong bao");
  }
  if (toolRuntime.manager) return toolRuntime.manager;
  const { MarketplaceManager } = require(path.join(OLD_XEM_TB_APP, "marketplace.js"));
  toolRuntime.manager = patchGpmManager(new MarketplaceManager({
    appRoot: path.resolve(OLD_XEM_TB_APP, ".."),
    sendLog: (message, type = "info") => addRuntimeLog(message, type)
  }), "xem thong bao");
  return toolRuntime.manager;
}

let shippingFullManager = null;
function getShippingFullManager() {
  if (arguments[0]?.fresh) {
    const { MarketplaceManager } = require(path.join(SHIPPING_FULL_APP, "marketplace.js"));
    return patchGpmManager(new MarketplaceManager({
      appRoot: path.resolve(SHIPPING_FULL_APP, ".."),
      sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "lam full" })
    }), "lam full");
  }
  if (shippingFullManager) return shippingFullManager;
  const { MarketplaceManager } = require(path.join(SHIPPING_FULL_APP, "marketplace.js"));
  shippingFullManager = patchGpmManager(new MarketplaceManager({
    appRoot: path.resolve(SHIPPING_FULL_APP, ".."),
    sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "lam full" })
  }), "lam full");
  return shippingFullManager;
}

let hmaStudioManager = null;
function getHmaStudioManager() {
  if (arguments[0]?.fresh) {
    const { MarketplaceManager } = require(path.join(HMA_STUDIO_APP, "marketplace.js"));
    return patchGpmManager(new MarketplaceManager({
      appRoot: path.resolve(HMA_STUDIO_APP, ".."),
      sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "lam full" })
    }), "lam full");
  }
  if (hmaStudioManager) return hmaStudioManager;
  const { MarketplaceManager } = require(path.join(HMA_STUDIO_APP, "marketplace.js"));
  hmaStudioManager = patchGpmManager(new MarketplaceManager({
    appRoot: path.resolve(HMA_STUDIO_APP, ".."),
    sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "lam full" })
  }), "lam full");
  return hmaStudioManager;
}

let interactionManager = null;
function getInteractionManager() {
  if (arguments[0]?.fresh) {
    const { MarketplaceManager } = require(path.join(TOOL_TUONG_TAC_APP, "marketplace.js"));
    return patchGpmManager(new MarketplaceManager({
      appRoot: path.resolve(TOOL_TUONG_TAC_APP, ".."),
      sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "tuong tac" })
    }), "tuong tac");
  }
  if (interactionManager) return interactionManager;
  const { MarketplaceManager } = require(path.join(TOOL_TUONG_TAC_APP, "marketplace.js"));
  interactionManager = patchGpmManager(new MarketplaceManager({
    appRoot: path.resolve(TOOL_TUONG_TAC_APP, ".."),
    sendLog: (message, type = "info") => addRuntimeLog(message, type, "", { tool: "tuong tac" })
  }), "tuong tac");
  return interactionManager;
}

const dangNhapModule = createDangNhap({ addRuntimeLog });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

async function readConfig() {
  try {
    const loaded = mergeProxyPanelDefaults(mergeClipProxyDefaults(mergeProxyDefaults({ ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath, "utf8")) })));
    const bundledCredentialsPath = path.join(__dirname, "service_account.json");
    if ((!loaded.credentialsPath || !existsSync(String(loaded.credentialsPath))) && existsSync(bundledCredentialsPath)) {
      loaded.credentialsPath = bundledCredentialsPath;
    }
    loaded.browserApiProvider = normalizeBrowserApiProvider(loaded.browserApiProvider);
    loaded.gpmBaseUrl = normalizeGpmBaseUrl(loaded);
    loaded.hideBaseUrl = normalizeHideBaseUrl(loaded);
    loaded.spreadsheetIds = normalizeSpreadsheetIds([
      loaded.spreadsheetId,
      ...(Array.isArray(loaded.spreadsheetIds) ? loaded.spreadsheetIds : [])
    ], { rejectDuplicates: false });
    loaded.spreadsheetId = String(loaded.spreadsheetId || loaded.spreadsheetIds[0] || "").trim();
    loaded.accountSheets = loaded.accountSheets && typeof loaded.accountSheets === "object" ? loaded.accountSheets : {};
    loaded.accountSheets = sanitizeAccountSheetAssignments(loaded.accountSheets, loaded.spreadsheetIds);
    loaded.knownHideAccounts = loaded.knownHideAccounts && typeof loaded.knownHideAccounts === "object" ? loaded.knownHideAccounts : {};
    loaded.lastHideAccountId = String(loaded.lastHideAccountId || "").trim();
    loaded.fullConcurrency = clampConcurrency(loaded.fullConcurrency, DEFAULT_CONFIG.fullConcurrency, 4);
    loaded.postConcurrency = clampConcurrency(loaded.postConcurrency, DEFAULT_CONFIG.postConcurrency, 4);
    loaded.checkConcurrency = clampConcurrency(loaded.checkConcurrency, DEFAULT_CONFIG.checkConcurrency, 4);
    loaded.checkOrderSpreadsheetId = String(loaded.checkOrderSpreadsheetId || "").trim();
    loaded.checkOrderSheetName = String(loaded.checkOrderSheetName || DEFAULT_CONFIG.checkOrderSheetName).trim() || DEFAULT_CONFIG.checkOrderSheetName;
    loaded.checkOrderConcurrency = clampConcurrency(loaded.checkOrderConcurrency, DEFAULT_CONFIG.checkOrderConcurrency, 4);
    loaded.interactionConcurrency = clampConcurrency(loaded.interactionConcurrency, DEFAULT_CONFIG.interactionConcurrency, 4);
    loaded.pageConcurrency = clampConcurrency(loaded.pageConcurrency, DEFAULT_CONFIG.pageConcurrency, 4);
    loaded.avatarConcurrency = clampConcurrency(loaded.avatarConcurrency, DEFAULT_CONFIG.avatarConcurrency, 2);
    loaded.avatarImagePath = String(loaded.avatarImagePath || "").trim();
    loaded.avatarReplaceExisting = Boolean(loaded.avatarReplaceExisting);
    const legacyHeaders = loaded.headers || [];
    const extraHeaders = legacyHeaders.filter(
      (header) =>
        header &&
        !looksLikeMojibakeHeader(header) &&
        header !== "run" &&
        header !== "tên profile" &&
        !DEFAULT_CONFIG.headers.includes(header) &&
        normalizeHeaderName(header) !== "proxy"
    );
    loaded.headers = [...DEFAULT_CONFIG.headers, ...extraHeaders];
    return loaded;
  } catch {
    await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(input) {
  const current = await readConfig();
  const proxyConfig = sanitizeProxyConfigInput(input, current);
  const clipProxyConfig = sanitizeClipProxyConfigInput(input, current);
  const proxyPanelConfig = sanitizeProxyPanelConfigInput(input, current);
  const next = {
    ...current,
    browserApiProvider: normalizeBrowserApiProvider(input.browserApiProvider !== undefined ? input.browserApiProvider : current.browserApiProvider),
    gpmBaseUrl: normalizeGpmBaseUrl({ ...current, ...input }),
    hideBaseUrl: normalizeHideBaseUrl({ ...current, ...input }),
    spreadsheetId: String(input.spreadsheetId || "").trim(),
    credentialsPath: String(input.credentialsPath || "").trim(),
    credentialSourceSpreadsheetId: String(input.credentialSourceSpreadsheetId !== undefined ? input.credentialSourceSpreadsheetId : current.credentialSourceSpreadsheetId || DEFAULT_CONFIG.credentialSourceSpreadsheetId).trim(),
    sellerSpreadsheetId: String(input.sellerSpreadsheetId || current.sellerSpreadsheetId || "").trim(),
    fullDataRoot: String(input.fullDataRoot || current.fullDataRoot || DEFAULT_CONFIG.fullDataRoot).trim(),
    fullPriceMin: String(input.fullPriceMin || current.fullPriceMin || "").trim(),
    fullPriceMax: String(input.fullPriceMax || current.fullPriceMax || "").trim(),
    fullConcurrency: clampConcurrency(input.fullConcurrency, current.fullConcurrency || DEFAULT_CONFIG.fullConcurrency, 4),
    postConcurrency: clampConcurrency(input.postConcurrency, current.postConcurrency || DEFAULT_CONFIG.postConcurrency, 4),
    checkConcurrency: clampConcurrency(input.checkConcurrency, current.checkConcurrency || DEFAULT_CONFIG.checkConcurrency),
    checkOrderSpreadsheetId: String(input.checkOrderSpreadsheetId !== undefined ? input.checkOrderSpreadsheetId : current.checkOrderSpreadsheetId || "").trim(),
    checkOrderSheetName: String(input.checkOrderSheetName !== undefined ? input.checkOrderSheetName : current.checkOrderSheetName || DEFAULT_CONFIG.checkOrderSheetName).trim() || DEFAULT_CONFIG.checkOrderSheetName,
    checkOrderConcurrency: clampConcurrency(input.checkOrderConcurrency, current.checkOrderConcurrency || DEFAULT_CONFIG.checkOrderConcurrency, 4),
    interactionConcurrency: clampConcurrency(input.interactionConcurrency, current.interactionConcurrency || DEFAULT_CONFIG.interactionConcurrency, 4),
    pageConcurrency: clampConcurrency(input.pageConcurrency, current.pageConcurrency || DEFAULT_CONFIG.pageConcurrency, 4),
    avatarConcurrency: clampConcurrency(input.avatarConcurrency, current.avatarConcurrency || DEFAULT_CONFIG.avatarConcurrency, 2),
    avatarImagePath: String(input.avatarImagePath !== undefined ? input.avatarImagePath : current.avatarImagePath || "").trim(),
    avatarReplaceExisting: input.avatarReplaceExisting !== undefined ? Boolean(input.avatarReplaceExisting) : Boolean(current.avatarReplaceExisting),
    ...proxyConfig,
    ...clipProxyConfig,
    ...proxyPanelConfig,
    interactionHomeTimeMin: Math.max(1, Math.floor(Number(input.interactionHomeTimeMin ?? current.interactionHomeTimeMin ?? DEFAULT_CONFIG.interactionHomeTimeMin)) || DEFAULT_CONFIG.interactionHomeTimeMin),
    interactionHomeTimeMax: Math.max(1, Math.floor(Number(input.interactionHomeTimeMax ?? current.interactionHomeTimeMax ?? DEFAULT_CONFIG.interactionHomeTimeMax)) || DEFAULT_CONFIG.interactionHomeTimeMax),
    interactionReelsTotalMin: Math.max(1, Math.floor(Number(input.interactionReelsTotalMin ?? current.interactionReelsTotalMin ?? DEFAULT_CONFIG.interactionReelsTotalMin)) || DEFAULT_CONFIG.interactionReelsTotalMin),
    interactionReelsTotalMax: Math.max(1, Math.floor(Number(input.interactionReelsTotalMax ?? current.interactionReelsTotalMax ?? DEFAULT_CONFIG.interactionReelsTotalMax)) || DEFAULT_CONFIG.interactionReelsTotalMax),
    interactionClipViewMin: Math.max(1, Math.floor(Number(input.interactionClipViewMin ?? current.interactionClipViewMin ?? DEFAULT_CONFIG.interactionClipViewMin)) || DEFAULT_CONFIG.interactionClipViewMin),
    interactionClipViewMax: Math.max(1, Math.floor(Number(input.interactionClipViewMax ?? current.interactionClipViewMax ?? DEFAULT_CONFIG.interactionClipViewMax)) || DEFAULT_CONFIG.interactionClipViewMax),
    interactionMarketPostsMin: Math.max(1, Math.floor(Number(input.interactionMarketPostsMin ?? current.interactionMarketPostsMin ?? DEFAULT_CONFIG.interactionMarketPostsMin)) || DEFAULT_CONFIG.interactionMarketPostsMin),
    interactionMarketPostsMax: Math.max(1, Math.floor(Number(input.interactionMarketPostsMax ?? current.interactionMarketPostsMax ?? DEFAULT_CONFIG.interactionMarketPostsMax)) || DEFAULT_CONFIG.interactionMarketPostsMax),
    interactionEnableRandomOrder: input.interactionEnableRandomOrder !== undefined ? Boolean(input.interactionEnableRandomOrder) : current.interactionEnableRandomOrder ?? DEFAULT_CONFIG.interactionEnableRandomOrder,
    interactionHumanDelayMode: input.interactionHumanDelayMode !== undefined ? Boolean(input.interactionHumanDelayMode) : current.interactionHumanDelayMode ?? DEFAULT_CONFIG.interactionHumanDelayMode,
    interactionSlowScrollMode: input.interactionSlowScrollMode !== undefined ? Boolean(input.interactionSlowScrollMode) : current.interactionSlowScrollMode ?? DEFAULT_CONFIG.interactionSlowScrollMode,
    interactionEnableRenewListings: input.interactionEnableRenewListings !== undefined ? Boolean(input.interactionEnableRenewListings) : current.interactionEnableRenewListings ?? DEFAULT_CONFIG.interactionEnableRenewListings,
    interactionEnableMarkAsSold: input.interactionEnableMarkAsSold !== undefined ? Boolean(input.interactionEnableMarkAsSold) : current.interactionEnableMarkAsSold ?? DEFAULT_CONFIG.interactionEnableMarkAsSold,
    trashSheetName: String(input.trashSheetName || current.trashSheetName || "rác").trim() || "rác"
  };
  const providerChanged = normalizeBrowserApiProvider(current.browserApiProvider) !== normalizeBrowserApiProvider(next.browserApiProvider)
    || normalizeGpmBaseUrl(current) !== normalizeGpmBaseUrl(next)
    || normalizeHideBaseUrl(current) !== normalizeHideBaseUrl(next);
  await writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
  if (providerChanged) resetProfileManagers("profile-provider-changed");
  return next;
}

function normalizeSpreadsheetIds(input, options = {}) {
  const { rejectDuplicates = true } = options;
  const items = Array.isArray(input) ? input : String(input || "").split(/[\n,;]/);
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const id = String(item || "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      if (rejectDuplicates) throw new Error(`Spreadsheet ID bi trung: ${id}`);
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function clampConcurrency(value, fallback = 1, max = 4) {
  const parsed = Math.floor(Number(value));
  const safeFallback = Math.max(1, Math.min(max, Math.floor(Number(fallback)) || 1));
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.max(1, Math.min(max, parsed));
}

function stateProxyUsesProxyPanel(config = {}) {
  return isProxyPanelStateProxy(config);
}

function stateProxyProviderIsProxyPanel(config = {}) {
  return String(config.stateProxyProvider || "").toLowerCase() === "proxypanel";
}

function forceSingleThreadForProxyPanel(config = {}) {
  if (!stateProxyUsesProxyPanel(config)) return config;
  return {
    ...config,
    fullConcurrency: 1,
    postConcurrency: 1,
    checkConcurrency: 1,
    checkOrderConcurrency: 1,
    interactionConcurrency: 1,
    pageConcurrency: 1,
    avatarConcurrency: 1
  };
}

function looksLikeMojibakeHeader(header) {
  return /[\u00c3\u00c4\u00c6\u00c2\u00aa\u00ba\u00bf\u00b1\u2021]|\u00e1[\u00ba\u00bb]/.test(String(header || ""));
}

async function saveConfigV2(input) {
  const current = await readConfig();
  const proxyConfig = sanitizeProxyConfigInput(input, current);
  const clipProxyConfig = sanitizeClipProxyConfigInput(input, current);
  const proxyPanelConfig = sanitizeProxyPanelConfigInput(input, current);
  const spreadsheetIds = normalizeSpreadsheetIds(input.spreadsheetIds !== undefined ? input.spreadsheetIds : [
    input.spreadsheetId,
    ...current.spreadsheetIds
  ]);
  const wantedAccountSheets = input.accountSheets && typeof input.accountSheets === "object" ? input.accountSheets : current.accountSheets;
  const accountSheets = sanitizeAccountSheetAssignments(wantedAccountSheets, spreadsheetIds);
  const next = {
    ...current,
    browserApiProvider: normalizeBrowserApiProvider(input.browserApiProvider !== undefined ? input.browserApiProvider : current.browserApiProvider),
    gpmBaseUrl: normalizeGpmBaseUrl({ ...current, ...input }),
    hideBaseUrl: normalizeHideBaseUrl({ ...current, ...input }),
    spreadsheetId: String(input.spreadsheetId || spreadsheetIds[0] || "").trim(),
    spreadsheetIds,
    accountSheets,
    lastHideAccountId: current.lastHideAccountId || "",
    knownHideAccounts: current.knownHideAccounts || {},
    credentialsPath: String(input.credentialsPath || "").trim(),
    credentialSourceSpreadsheetId: String(input.credentialSourceSpreadsheetId !== undefined ? input.credentialSourceSpreadsheetId : current.credentialSourceSpreadsheetId || DEFAULT_CONFIG.credentialSourceSpreadsheetId).trim(),
    sellerSpreadsheetId: String(input.sellerSpreadsheetId || current.sellerSpreadsheetId || "").trim(),
    fullDataRoot: String(input.fullDataRoot || current.fullDataRoot || DEFAULT_CONFIG.fullDataRoot).trim(),
    fullPriceMin: String(input.fullPriceMin || current.fullPriceMin || "").trim(),
    fullPriceMax: String(input.fullPriceMax || current.fullPriceMax || "").trim(),
    fullConcurrency: clampConcurrency(input.fullConcurrency, current.fullConcurrency || DEFAULT_CONFIG.fullConcurrency, 4),
    postConcurrency: clampConcurrency(input.postConcurrency, current.postConcurrency || DEFAULT_CONFIG.postConcurrency, 4),
    checkConcurrency: clampConcurrency(input.checkConcurrency, current.checkConcurrency || DEFAULT_CONFIG.checkConcurrency),
    checkOrderSpreadsheetId: String(input.checkOrderSpreadsheetId !== undefined ? input.checkOrderSpreadsheetId : current.checkOrderSpreadsheetId || "").trim(),
    checkOrderSheetName: String(input.checkOrderSheetName !== undefined ? input.checkOrderSheetName : current.checkOrderSheetName || DEFAULT_CONFIG.checkOrderSheetName).trim() || DEFAULT_CONFIG.checkOrderSheetName,
    checkOrderConcurrency: clampConcurrency(input.checkOrderConcurrency, current.checkOrderConcurrency || DEFAULT_CONFIG.checkOrderConcurrency, 4),
    interactionConcurrency: clampConcurrency(input.interactionConcurrency, current.interactionConcurrency || DEFAULT_CONFIG.interactionConcurrency, 4),
    pageConcurrency: clampConcurrency(input.pageConcurrency, current.pageConcurrency || DEFAULT_CONFIG.pageConcurrency, 4),
    avatarConcurrency: clampConcurrency(input.avatarConcurrency, current.avatarConcurrency || DEFAULT_CONFIG.avatarConcurrency, 2),
    avatarImagePath: String(input.avatarImagePath !== undefined ? input.avatarImagePath : current.avatarImagePath || "").trim(),
    avatarReplaceExisting: input.avatarReplaceExisting !== undefined ? Boolean(input.avatarReplaceExisting) : Boolean(current.avatarReplaceExisting),
    ...proxyConfig,
    ...clipProxyConfig,
    ...proxyPanelConfig,
    interactionHomeTimeMin: Math.max(1, Math.floor(Number(input.interactionHomeTimeMin ?? current.interactionHomeTimeMin ?? DEFAULT_CONFIG.interactionHomeTimeMin)) || DEFAULT_CONFIG.interactionHomeTimeMin),
    interactionHomeTimeMax: Math.max(1, Math.floor(Number(input.interactionHomeTimeMax ?? current.interactionHomeTimeMax ?? DEFAULT_CONFIG.interactionHomeTimeMax)) || DEFAULT_CONFIG.interactionHomeTimeMax),
    interactionReelsTotalMin: Math.max(1, Math.floor(Number(input.interactionReelsTotalMin ?? current.interactionReelsTotalMin ?? DEFAULT_CONFIG.interactionReelsTotalMin)) || DEFAULT_CONFIG.interactionReelsTotalMin),
    interactionReelsTotalMax: Math.max(1, Math.floor(Number(input.interactionReelsTotalMax ?? current.interactionReelsTotalMax ?? DEFAULT_CONFIG.interactionReelsTotalMax)) || DEFAULT_CONFIG.interactionReelsTotalMax),
    interactionClipViewMin: Math.max(1, Math.floor(Number(input.interactionClipViewMin ?? current.interactionClipViewMin ?? DEFAULT_CONFIG.interactionClipViewMin)) || DEFAULT_CONFIG.interactionClipViewMin),
    interactionClipViewMax: Math.max(1, Math.floor(Number(input.interactionClipViewMax ?? current.interactionClipViewMax ?? DEFAULT_CONFIG.interactionClipViewMax)) || DEFAULT_CONFIG.interactionClipViewMax),
    interactionMarketPostsMin: Math.max(1, Math.floor(Number(input.interactionMarketPostsMin ?? current.interactionMarketPostsMin ?? DEFAULT_CONFIG.interactionMarketPostsMin)) || DEFAULT_CONFIG.interactionMarketPostsMin),
    interactionMarketPostsMax: Math.max(1, Math.floor(Number(input.interactionMarketPostsMax ?? current.interactionMarketPostsMax ?? DEFAULT_CONFIG.interactionMarketPostsMax)) || DEFAULT_CONFIG.interactionMarketPostsMax),
    interactionEnableRandomOrder: input.interactionEnableRandomOrder !== undefined ? Boolean(input.interactionEnableRandomOrder) : current.interactionEnableRandomOrder ?? DEFAULT_CONFIG.interactionEnableRandomOrder,
    interactionHumanDelayMode: input.interactionHumanDelayMode !== undefined ? Boolean(input.interactionHumanDelayMode) : current.interactionHumanDelayMode ?? DEFAULT_CONFIG.interactionHumanDelayMode,
    interactionSlowScrollMode: input.interactionSlowScrollMode !== undefined ? Boolean(input.interactionSlowScrollMode) : current.interactionSlowScrollMode ?? DEFAULT_CONFIG.interactionSlowScrollMode,
    interactionEnableRenewListings: input.interactionEnableRenewListings !== undefined ? Boolean(input.interactionEnableRenewListings) : current.interactionEnableRenewListings ?? DEFAULT_CONFIG.interactionEnableRenewListings,
    interactionEnableMarkAsSold: input.interactionEnableMarkAsSold !== undefined ? Boolean(input.interactionEnableMarkAsSold) : current.interactionEnableMarkAsSold ?? DEFAULT_CONFIG.interactionEnableMarkAsSold,
    trashSheetName: String(input.trashSheetName || current.trashSheetName || "rac").trim() || "rac"
  };
  if (next.spreadsheetId && !next.spreadsheetIds.includes(next.spreadsheetId)) next.spreadsheetId = next.spreadsheetIds[0] || "";
  const providerChanged = normalizeBrowserApiProvider(current.browserApiProvider) !== normalizeBrowserApiProvider(next.browserApiProvider)
    || normalizeGpmBaseUrl(current) !== normalizeGpmBaseUrl(next)
    || normalizeHideBaseUrl(current) !== normalizeHideBaseUrl(next);
  await writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
  if (providerChanged) resetProfileManagers("profile-provider-changed");
  return next;
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const resolved = path.normalize(path.join(publicDir, pathname));
  if (!resolved.startsWith(publicDir)) return jsonResponse(res, 403, { ok: false, error: "Forbidden" });

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Not a file");
    const ext = path.extname(resolved).toLowerCase();
    const data = await readFile(resolved);
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    jsonResponse(res, 404, { ok: false, error: "Not found" });
  }
}

function extractUid(profileName) {
  const matches = String(profileName || "").match(/\b[61]\d{12,14}\b/g) || [];
  return [...new Set(matches)].join(",");
}

function splitUids(uidText) {
  return String(uidText || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);
}

function hashText(value) {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function sheetCacheKey(config) {
  return `${config.spreadsheetId || ""}|${config.credentialsPath || ""}`;
}

function cloneSheetDataMap(data) {
  const cloned = new Map();
  for (const [title, sheet] of data || new Map()) {
    cloned.set(title, {
      headers: [...(sheet.headers || [])],
      rows: (sheet.rows || []).map((row) => ({ ...row }))
    });
  }
  return cloned;
}

function rebuildSheetCacheById(data) {
  const byId = new Map();
  for (const sheet of data?.values?.() || []) {
    for (const row of sheet.rows || []) {
      const id = String(row["id hide"] || "").trim();
      if (id) byId.set(id, row);
    }
  }
  return byId;
}

function storeManagedSheetCache(config, { titles, data, headers, source = "remote" }) {
  const cachedData = cloneSheetDataMap(data);
  sheetCache.key = sheetCacheKey(config);
  sheetCache.loadedAt = Date.now();
  sheetCache.titles = [...(titles || [])];
  sheetCache.data = cachedData;
  sheetCache.headers = [...(headers || [])];
  sheetCache.byId = rebuildSheetCacheById(cachedData);
  sheetCache.source = source;
  sheetCache.reads += source === "remote" ? 1 : 0;
  return sheetCache;
}

function clearManagedSheetCache(reason = "") {
  sheetCache.key = "";
  sheetCache.loadedAt = 0;
  sheetCache.byId = new Map();
  sheetCache.titles = [];
  sheetCache.data = null;
  sheetCache.headers = [];
  sheetCache.source = reason;
}

function updateManagedSheetCacheRows(rowsById) {
  if (!sheetCache.data || !(rowsById instanceof Map)) return;
  for (const [id, nextRow] of rowsById.entries()) {
    const key = String(id || "").trim();
    if (!key) continue;
    sheetCache.byId.set(key, nextRow);
    const title = String(nextRow?._sheetTitle || "").trim();
    const rowNumber = Number(nextRow?._rowNumber || 0);
    if (!title || !rowNumber || !sheetCache.data.has(title)) continue;
    const sheet = sheetCache.data.get(title);
    const index = rowNumber - 2;
    if (index >= 0 && index < sheet.rows.length) sheet.rows[index] = nextRow;
  }
  sheetCache.loadedAt = Date.now();
  sheetCache.source = "local-write";
}

function mergeSheetCacheIntoActiveSessions() {
  if (!(toolRuntime.sheetSessions instanceof Set) || !(sheetCache.byId instanceof Map)) return 0;
  let merged = 0;
  for (const session of toolRuntime.sheetSessions) {
    if (!session?.rows || !(session.rows instanceof Map)) continue;
    for (const [profileId, currentRow] of session.rows.entries()) {
      if (session.pending?.has?.(profileId)) continue;
      const jobStatus = String(toolRuntime.jobs.get(profileId)?.status || "").trim().toLowerCase();
      if (jobStatus && jobStatus !== "queued") continue;
      const latest = sheetCache.byId.get(profileId);
      if (!latest) continue;
      session.rows.set(profileId, {
        ...latest,
        _sheetTitle: currentRow._sheetTitle,
        _rowNumber: currentRow._rowNumber
      });
      merged += 1;
    }
  }
  return merged;
}

function analyzeDuplicateUids(profiles) {
  const owners = new Map();
  for (const profile of profiles) {
    for (const uid of splitUids(profile.uid)) {
      if (!owners.has(uid)) owners.set(uid, []);
      owners.get(uid).push({
        profileId: profile.id,
        profileName: profile.name,
        folderId: profile.folderId,
        folderName: profile.folderName
      });
    }
  }

  const duplicateUids = new Set();
  const duplicateProfileIds = new Set();
  const details = [];
  for (const [uid, profiles] of owners) {
    if (profiles.length > 1) {
      duplicateUids.add(uid);
      profiles.forEach((profile) => duplicateProfileIds.add(profile.profileId));
      const folderCountsMap = new Map();
      for (const profile of profiles) {
        folderCountsMap.set(profile.folderName, (folderCountsMap.get(profile.folderName) || 0) + 1);
      }
      details.push({
        uid,
        count: profiles.length,
        folders: [...folderCountsMap.entries()].map(([folderName, count]) => ({ folderName, count })),
        profiles
      });
    }
  }

  details.sort((a, b) => b.count - a.count || a.uid.localeCompare(b.uid));

  return {
    duplicateUids: [...duplicateUids],
    duplicateProfileIds: [...duplicateProfileIds],
    details
  };
}

function isProfileRunning(status) {
  const value = String(status || "").toLowerCase();
  return Boolean(value && !["ready", "stop", "stopped", "closed", "close"].includes(value));
}

function sanitizeSheetTitle(name) {
  const cleaned = String(name || "Không folder")
    .replace(/[\[\]\*\/\\\?:]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Không folder").slice(0, 90);
}

async function hideRequest(config, endpoint, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const pathname = String(endpoint || "").split("?")[0];

  if (isGpmProvider(config)) {
    if (pathname === "/folders") {
      return getGpmGroups(config);
    }
    if (pathname === "/profiles") {
      const groups = await getGpmGroups(config).catch(() => []);
      const groupLookup = new Map(groups.map((group) => [group.id, group.name]));
      const profiles = await getGpmProfiles(config, groupLookup);
      const url = new URL(`http://local${endpoint}`);
      const folder = String(url.searchParams.get("folder") || "").trim();
      return folder ? profiles.filter((profile) => String(profile.folderId || profile.group_id || "") === folder) : profiles;
    }
    const profileMatch = pathname.match(/^\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const profileId = decodeURIComponent(profileMatch[1]);
      if (method === "PUT" || method === "POST" || method === "PATCH") {
        let payload = {};
        try {
          payload = typeof options.body === "string" ? JSON.parse(options.body || "{}") : options.body || {};
        } catch {
          payload = {};
        }
        return updateGpmProfile(config, profileId, payload);
      }
      return getGpmProfile(config, profileId);
    }
    const startMatch = pathname.match(/^\/profiles\/start\/([^/]+)$/);
    if (startMatch) {
      const profileId = decodeURIComponent(startMatch[1]);
      const data = await gpmRequestWithRetry(config, `/profiles/start/${encodeURIComponent(profileId)}?skip_proxy_check=true`, {
        ...options,
        method: "GET"
      });
      return normalizeGpmStartResult(data);
    }
    const stopMatch = pathname.match(/^\/profiles\/stop\/([^/]+)$/);
    if (stopMatch) {
      const profileId = decodeURIComponent(stopMatch[1]);
      return gpmRequestWithRetry(config, `/profiles/stop/${encodeURIComponent(profileId)}`, {
        ...options,
        method: "GET",
        allowOkCode0: true
      });
    }
    if (pathname.startsWith("/groups") || pathname.startsWith("/proxies") || pathname.startsWith("/extensions") || pathname.startsWith("/browsers")) {
      return gpmRequestWithRetry(config, endpoint, options);
    }
  } else {
    if (pathname === "/folders") return getHideFolders(config);
    if (pathname === "/profiles") {
      const profiles = await getHideProfiles(config);
      const url = new URL(`http://local${endpoint}`);
      const folder = String(url.searchParams.get("folder") || "").trim();
      return folder ? profiles.filter((profile) => String(profile.folderId || "") === folder) : profiles;
    }
    const profileMatch = pathname.match(/^\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const profileId = decodeURIComponent(profileMatch[1]);
      if (method === "PUT" || method === "POST" || method === "PATCH") {
        let payload = {};
        try {
          payload = typeof options.body === "string" ? JSON.parse(options.body || "{}") : options.body || {};
        } catch {
          payload = {};
        }
        return updateHideProfile(config, profileId, payload);
      }
      const profiles = await getHideProfiles(config);
      return profiles.find((profile) => String(profile.id || "").trim() === profileId) || null;
    }
    const startMatch = pathname.match(/^\/profiles\/start\/([^/]+)$/);
    if (startMatch) {
      const profileId = decodeURIComponent(startMatch[1]);
      const data = await hideApiRequestWithRetry(config, `/profiles/start/${encodeURIComponent(profileId)}`, {
        ...options,
        method: "POST",
        body: options.body || "{}"
      });
      return normalizeHideStartResult(data);
    }
    const stopMatch = pathname.match(/^\/profiles\/stop\/([^/]+)$/);
    if (stopMatch) {
      const profileId = decodeURIComponent(stopMatch[1]);
      return hideApiRequestWithRetry(config, `/profiles/stop/${encodeURIComponent(profileId)}`, {
        ...options,
        method: "POST",
        body: options.body || "{}"
      });
    }
  }

  const requestOptions = { ...options, method };
  return isHideProvider(config)
    ? hideApiRequestWithRetry(config, endpoint, requestOptions)
    : gpmRequestWithRetry(config, endpoint, requestOptions);
}

async function getHideAccount(config) {
  const provider = normalizeBrowserApiProvider(config.browserApiProvider);
  const folders = await hideRequest(config, "/folders");
  const folderIds = folders.map((folder) => String(folder.id || "").trim()).filter(Boolean).sort();
  const base = provider === "hide" ? normalizeHideBaseUrl(config) : normalizeGpmBaseUrl(config);
  const fingerprint = hashText([
    provider,
    base,
    ...folderIds
  ].join("|"));
  const label = provider === "hide" ? "HideMyAcc" : "GPM Login";
  return {
    id: `${provider}:${fingerprint}`,
    email: `${label} (${folders.length} ${provider === "hide" ? "folder" : "group"})`,
    plan: "",
    profiles: "",
    provider,
    providerLabel: label,
    fallback: true,
    fingerprint
  };
}

async function resolveAccountSheetConfig(config, options = {}) {
  const { requireSheet = true, autoAssign = true } = options;
  const account = await getHideAccount(config);
  const spreadsheetIds = normalizeSpreadsheetIds(config.spreadsheetIds?.length ? config.spreadsheetIds : [config.spreadsheetId]);
  const accountSheets = config.accountSheets && typeof config.accountSheets === "object" ? { ...config.accountSheets } : {};
  let spreadsheetId = String(accountSheets[account.id] || "").trim();

  if (spreadsheetId && !spreadsheetIds.includes(spreadsheetId)) {
    delete accountSheets[account.id];
    spreadsheetId = "";
  }

  if (!spreadsheetId && autoAssign) {
    const used = new Set(Object.entries(accountSheets)
      .filter(([accountId]) => accountId !== account.id)
      .map(([, id]) => String(id || "").trim())
      .filter(Boolean));
    spreadsheetId = spreadsheetIds.find((id) => !used.has(id)) || "";
    if (spreadsheetId) {
      accountSheets[account.id] = spreadsheetId;
      const next = {
        ...config,
        spreadsheetIds,
        spreadsheetId,
        accountSheets,
        lastHideAccountId: account.id,
        knownHideAccounts: {
          ...(config.knownHideAccounts || {}),
          [account.id]: {
            id: account.id,
            email: account.email || "",
            plan: account.plan || ""
          }
        }
      };
      await writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
      config = next;
      clearManagedSheetCache("account-sheet-changed");
    }
  }

  if (spreadsheetId && !account.fallback) {
    const existingAccountSheet = String(config.accountSheets?.[account.id] || "").trim();
    const existingKnown = config.knownHideAccounts?.[account.id] || {};
    const unchanged =
      String(config.spreadsheetId || "").trim() === spreadsheetId &&
      existingAccountSheet === spreadsheetId &&
      String(config.lastHideAccountId || "").trim() === account.id &&
      String(existingKnown.email || "").trim() === String(account.email || "").trim() &&
      String(existingKnown.plan || "").trim() === String(account.plan || "").trim();
    if (unchanged) {
      return {
        ...config,
        spreadsheetId,
        spreadsheetIds,
        accountSheets,
        hideAccount: account
      };
    }
    const next = {
      ...config,
      spreadsheetIds,
      spreadsheetId,
      accountSheets: {
        ...accountSheets,
        [account.id]: spreadsheetId
      },
      lastHideAccountId: account.id,
      knownHideAccounts: {
        ...(config.knownHideAccounts || {}),
        [account.id]: {
          id: account.id,
          email: account.email || "",
          plan: account.plan || ""
        }
      }
    };
    await writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
    config = next;
    clearManagedSheetCache("account-sheet-changed");
  }

  if (requireSheet && !spreadsheetId) {
    const name = account.email || account.id;
    throw new Error(`Tai khoan ${providerDisplayName(config)} ${name} chua co Spreadsheet rieng. Hay them Spreadsheet ID moi, moi Sheet chi duoc gan cho 1 tai khoan.`);
  }

  return {
    ...config,
    spreadsheetId,
    spreadsheetIds,
    accountSheets,
    hideAccount: account
  };
}

async function getHideState(config) {
  const folders = await hideRequest(config, "/folders");
  const normalizedFolders = folders.map((folder) => ({
    id: String(folder.id),
    name: String(folder.name || "Không tên"),
    sheetTitle: sanitizeSheetTitle(folder.name)
  }));

  const profilesByFolder = [];
  const folderById = new Map(normalizedFolders.map((folder) => [folder.id, folder]));
  const allProfiles = await hideRequest(config, "/profiles");
  for (const profile of allProfiles) {
    const folder = folderById.get(String(profile.folderId || profile.group_id || "all")) || normalizedFolders[0] || {
      id: "all",
      name: "Tất cả",
      sheetTitle: sanitizeSheetTitle("Tất cả")
    };
    profilesByFolder.push({
      id: String(profile.id),
      name: String(profile.name || ""),
      uid: extractUid(profile.name),
      status: String(profile.status || ""),
      isRunning: isProfileRunning(profile.status),
      folderId: folder.id,
      folderName: folder.name,
      sheetTitle: folder.sheetTitle
    });
  }

  const duplicates = analyzeDuplicateUids(profilesByFolder);
  return { folders: normalizedFolders, profiles: profilesByFolder, duplicates };
}

function base64Url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getGoogleAccessToken(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(credentials.private_key, "base64url");
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Không lấy được Google access token");
  return data.access_token;
}

class SheetsClient {
  static writeState = {
    lastAt: 0,
    calls: 0,
    retries: 0,
    startedAt: Date.now(),
    queue: Promise.resolve()
  };
  static readState = {
    lastAt: 0,
    calls: 0,
    retries: 0,
    startedAt: Date.now(),
    queue: Promise.resolve()
  };

  constructor(config, token) {
    this.config = config;
    this.token = token;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}`;
  }

  isWriteRequest(options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    return method !== "GET" && method !== "HEAD";
  }

  isQuotaError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("quota exceeded")
      || message.includes("write requests per minute")
      || message.includes("read requests per minute")
      || message.includes("rate limit")
      || message.includes("429");
  }

  isRetryableNetworkError(error) {
    const message = String(error?.message || error || "");
    return /fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket|aborted/i.test(message);
  }

  async waitGlobalWriteSlot(endpoint) {
    const state = SheetsClient.writeState;
    const minGapMs = 600;
    const run = async () => {
      const elapsed = Date.now() - state.lastAt;
      if (elapsed < minGapMs) await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
      state.lastAt = Date.now();
      state.calls += 1;
      const elapsedMinutes = Math.max(1 / 60, (Date.now() - state.startedAt) / 60000);
      console.log(`[sheets-api] write endpoint=${endpoint} calls=${state.calls} rpm=${(state.calls / elapsedMinutes).toFixed(1)} retries=${state.retries}`);
    };
    const next = state.queue.then(run, run);
    state.queue = next.catch(() => {});
    return next;
  }

  async waitGlobalReadSlot(endpoint) {
    const state = SheetsClient.readState;
    const minGapMs = 1200;
    const run = async () => {
      const elapsed = Date.now() - state.lastAt;
      if (elapsed < minGapMs) await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
      state.lastAt = Date.now();
      state.calls += 1;
      const elapsedMinutes = Math.max(1 / 60, (Date.now() - state.startedAt) / 60000);
      if (state.calls % 10 === 0) {
        console.log(`[sheets-api] read endpoint=${endpoint} calls=${state.calls} rpm=${(state.calls / elapsedMinutes).toFixed(1)} retries=${state.retries}`);
      }
    };
    const next = state.queue.then(run, run);
    state.queue = next.catch(() => {});
    return next;
  }

  async request(endpoint, options = {}) {
    const writeRequest = this.isWriteRequest(options);
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (writeRequest) await this.waitGlobalWriteSlot(endpoint);
      else await this.waitGlobalReadSlot(endpoint);
      try {
        const response = await fetch(`${this.base}${endpoint}`, {
          ...options,
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            ...(options.headers || {})
          }
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) return data;
        const error = new Error(data.error?.message || `Google Sheets lỗi ${response.status}`);
        error.status = response.status;
        throw error;
      } catch (error) {
        if (!this.isQuotaError(error) && !this.isRetryableNetworkError(error)) throw error;
        if (attempt >= maxAttempts) throw error;
        const state = writeRequest ? SheetsClient.writeState : SheetsClient.readState;
        state.retries += 1;
        const delay = Math.min(90000, 5000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 1000);
        console.warn(`[sheets-api] ${writeRequest ? "write" : "read"} retry ${attempt}/${maxAttempts} endpoint=${endpoint} after ${delay}ms: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Google Sheets request failed.");
  }

  async metadata() {
    return this.request("?fields=sheets.properties");
  }

  async batchUpdate(requests) {
    if (!requests.length) return {};
    return this.request(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests })
    });
  }

  async getValues(title) {
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A:ZZ`);
    const data = await this.request(`/values/${range}`);
    return data.values || [];
  }

  async batchGetValues(titles) {
    const result = new Map();
    const chunks = [];
    const uniqueTitles = [...new Set((titles || []).filter(Boolean))];
    for (let index = 0; index < uniqueTitles.length; index += 40) {
      chunks.push(uniqueTitles.slice(index, index + 40));
    }
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const params = new URLSearchParams();
      for (const title of chunk) {
        params.append("ranges", `'${String(title).replace(/'/g, "''")}'!A:ZZ`);
      }
      const data = await this.request(`/values:batchGet?${params.toString()}`);
      const valueRanges = Array.isArray(data.valueRanges) ? data.valueRanges : [];
      for (let index = 0; index < chunk.length; index += 1) {
        result.set(chunk[index], valueRanges[index]?.values || []);
      }
    }
    return result;
  }

  async updateValues(title, values) {
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A1`);
    return this.request(`/values/${range}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({ values })
    });
  }

  async updateRowValues(title, rowNumber, values) {
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A${rowNumber}`);
    return this.request(`/values/${range}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({ values: [values] })
    });
  }

  async batchUpdateValues(data) {
    if (!data.length) return {};
    return this.request("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data
      })
    });
  }

  async clearValues(title) {
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A:ZZ`);
    return this.request(`/values/${range}:clear`, { method: "POST", body: "{}" });
  }
}

function rowToObject(headers, row) {
  const object = {};
  headers.forEach((header, index) => {
    object[header] = row[index] ?? "";
  });
  return object;
}

function objectToRow(headers, object) {
  const aliases = {
    "dia chi ban dau": ["diaChiBanDau"],
    "trang thai": ["trangThai"],
    "so vach": ["soVach"],
    "chi tiet": ["chiTiet"],
    "ten chuan": ["tenChuan"],
    "so luong page": ["soLuongPage"]
  };
  const objectEntries = Object.entries(object || {});
  return headers.map((header) => {
    if (object[header] !== undefined && object[header] !== null) return object[header];
    const normalizedHeader = normalizeHeaderName(header);
    const normalizedMatch = objectEntries.find(([key, value]) =>
      value !== undefined && value !== null && normalizeHeaderName(key) === normalizedHeader
    );
    if (normalizedMatch) return normalizedMatch[1];
    const candidates = aliases[normalizedHeader] || [];
    for (const key of candidates) {
      if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return "";
  });
}

async function ensureSheets(client, titles) {
  const meta = await client.metadata();
  const existing = new Map(meta.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const requests = [];
  for (const title of titles) {
    if (!existing.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  await client.batchUpdate(requests);
}

async function readManagedTitles(client) {
  try {
    const values = await client.getValues(META_SHEET);
    const row = values.find((item) => item[0] === "managed_sheets");
    return row?.[1] ? JSON.parse(row[1]) : [];
  } catch {
    return [];
  }
}

async function writeManagedTitles(client, titles) {
  await client.clearValues(META_SHEET);
  await client.updateValues(META_SHEET, [
    ["key", "value"],
    ["managed_sheets", JSON.stringify(titles)]
  ]);
}

async function formatDuplicateRows(client, sheetIdsByTitle, headers, rowsByTarget, duplicateProfileIds, trashSheetName) {
  const idIndex = headers.indexOf("id hide");
  if (idIndex === -1) return;

  const requests = [];
  for (const [title, rows] of rowsByTarget) {
    if (title === trashSheetName) continue;
    const sheetId = sheetIdsByTitle.get(title);
    if (sheetId === undefined) continue;

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: Math.max(rows.length + 1, 2),
          startColumnIndex: 0,
          endColumnIndex: headers.length
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 }
          }
        },
        fields: "userEnteredFormat.backgroundColor"
      }
    });

    rows.forEach((row, rowIndex) => {
      if (!duplicateProfileIds.has(String(row["id hide"] || ""))) return;
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: rowIndex + 1,
            endRowIndex: rowIndex + 2,
            startColumnIndex: 0,
            endColumnIndex: headers.length
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 0.82, blue: 0.82 }
            }
          },
          fields: "userEnteredFormat.backgroundColor"
        }
      });
    });
  }

  await client.batchUpdate(requests);
}

async function readAllRows(client, sheetTitles, defaultHeaders) {
  const result = new Map();
  const valuesByTitle = await client.batchGetValues(sheetTitles);
  for (const title of sheetTitles) {
    const values = valuesByTitle.get(title) || [];
    const headers = values[0]?.length ? values[0] : defaultHeaders;
    const rows = values.slice(1).map((row) => rowToObject(headers, row));
    result.set(title, { headers, rows });
  }
  return result;
}

function mergeHeaders(defaultHeaders, sheetsData) {
  const merged = [...defaultHeaders];
  for (const sheet of sheetsData.values()) {
    for (const header of sheet.headers) {
      if (header === "run" || header === "tên profile") continue;
      if (header && !merged.includes(header)) merged.push(header);
    }
  }
  for (const extra of ["_deleted_at", "_from_sheet"]) {
    if (!merged.includes(extra)) merged.push(extra);
  }
  return merged;
}

async function ensureRequiredHeadersForSession(client, data, requiredHeaders, touchedTitles) {
  const wantedTitles = new Set([...touchedTitles].filter(Boolean));
  for (const [title, sheet] of data) {
    if (!wantedTitles.has(title)) continue;
    const currentHeaders = [...(sheet.headers || [])].filter(Boolean);
    const normalized = new Set(currentHeaders.map((header) => normalizeHeaderName(header)));
    const missing = [];
    for (const header of requiredHeaders || []) {
      if (!header || header === "run" || header === "tên profile") continue;
      const normalizedHeader = normalizeHeaderName(header);
      if (!normalizedHeader || normalized.has(normalizedHeader)) continue;
      missing.push(header);
      normalized.add(normalizedHeader);
    }
    if (!missing.length) {
      sheet.headers = currentHeaders;
      continue;
    }
    const nextHeaders = [...currentHeaders, ...missing];
    sheet.headers = nextHeaders;
    await client.updateRowValues(title, 1, nextHeaders);
    if (sheetCache.data instanceof Map && sheetCache.data.has(title)) {
      sheetCache.data.get(title).headers = [...nextHeaders];
    }
    sheetCache.headers = mergeHeaders(sheetCache.headers?.length ? sheetCache.headers : requiredHeaders, data);
  }
}

function hasLockedValue(value) {
  const text = String(value || "").trim();
  return Boolean(text && text !== NOT_LOCKED_TEXT);
}

function preserveStableSheetFields(nextRow, oldRow) {
  const stableFields = [
    "Tool",
    "trạng thái",
    "số vạch",
    "địa chỉ ban đầu",
    "số lượng page",
    "chi tiết",
    "mật khẩu",
    "2fa",
    "cookie",
    "bang",
    "tên chuẩn"
  ];
  const aliasMap = {
    "trạng thái": ["trangThai", "trang thai"],
    "số vạch": ["soVach", "so vach"],
    "địa chỉ ban đầu": ["diaChiBanDau", "dia chi ban dau"],
    "số lượng page": ["soLuongPage", "so luong page"],
    "chi tiết": ["chiTiet", "chi tiet"],
    "bang": ["proxy"],
    "tên chuẩn": ["tenChuan", "ten chuan"]
  };
  for (const field of stableFields) {
    const currentValue = String(sheetRowValue(nextRow, field, ...(aliasMap[field] || [])) || "").trim();
    if (currentValue) continue;
    const oldValue = String(sheetRowValue(oldRow, field, ...(aliasMap[field] || [])) || "").trim();
    if (!oldValue) continue;
    nextRow[field] = oldValue;
    for (const alias of aliasMap[field] || []) nextRow[alias] = oldValue;
  }
  return nextRow;
}

async function syncSheets(config) {
  if (!config.spreadsheetId || !config.credentialsPath) {
    throw new Error("Bạn cần cấu hình Spreadsheet ID và Service Account JSON trước khi đồng bộ.");
  }

  const hideState = await getHideState(config);
  const token = await getGoogleAccessToken(config.credentialsPath);
  const client = new SheetsClient(config, token);
  const activeTitles = hideState.folders.map((folder) => folder.sheetTitle);
  const requiredTitles = [...new Set([...activeTitles, config.trashSheetName, META_SHEET])];

  await ensureSheets(client, requiredTitles);
  const previousManagedTitles = await readManagedTitles(client);
  const meta = await client.metadata();
  const allTitles = meta.sheets.map((sheet) => sheet.properties.title);
  const sheetIdsByTitle = new Map(meta.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const syncTitles = [
    ...new Set([
      ...previousManagedTitles.filter((title) => allTitles.includes(title)),
      ...activeTitles,
      config.trashSheetName
    ])
  ];
  const sheetsData = await readAllRows(client, syncTitles, config.headers);
  const headers = mergeHeaders(config.headers, sheetsData);

  const existingById = new Map();
  const trashRows = [...(sheetsData.get(config.trashSheetName)?.rows || [])];
  const trashById = new Map();
  for (const row of trashRows) {
    const id = String(row["id hide"] || "").trim();
    if (id && !trashById.has(id)) trashById.set(id, row);
  }
  for (const [sheetTitle, sheet] of sheetsData) {
    if (sheetTitle === config.trashSheetName) continue;
    for (const row of sheet.rows) {
      const id = String(row["id hide"] || "").trim();
      if (id) {
        const normalizedRow = { ...row };
        if (!normalizedRow["tên profile khóa cứng"] && normalizedRow["tên profile"]) {
          normalizedRow["tên profile khóa cứng"] = normalizedRow["tên profile"];
        }
        existingById.set(id, { ...normalizedRow, _from_sheet: sheetTitle });
      }
    }
  }

  for (const profile of hideState.profiles) {
    const oldRow = existingById.get(profile.id) || trashById.get(profile.id) || {};
    const oldLockedName = hasLockedValue(oldRow["tên profile khóa cứng"])
      ? oldRow["tên profile khóa cứng"]
      : "";
    const oldLockedUid = hasLockedValue(oldRow.uid) ? oldRow.uid : "";
    profile.lockedName = oldLockedName || oldRow["tên profile"] || (profile.uid ? profile.name : "");
    profile.lockedUid = oldLockedUid || (profile.lockedName ? profile.uid : "");
    profile.uid = profile.lockedUid || profile.uid;
  }
  hideState.duplicates = analyzeDuplicateUids(hideState.profiles);

  const profilesById = new Map(hideState.profiles.map((profile) => [profile.id, profile]));
  const activeProfileIds = new Set(hideState.profiles.map((profile) => profile.id));
  const restoredFromTrash = new Set();
  for (const profile of hideState.profiles) {
    if (trashById.has(profile.id) && !existingById.has(profile.id)) restoredFromTrash.add(profile.id);
  }
  const rowsByTarget = new Map(activeTitles.map((title) => [title, []]));
  let movedToTrash = 0;
  let updated = 0;

  for (const [id, oldRow] of existingById) {
    if (!profilesById.has(id)) {
      trashRows.push({
        ...oldRow,
        "tên profile hiện tại": oldRow["tên profile hiện tại"] || "",
        "tên profile khóa cứng": hasLockedValue(oldRow["tên profile khóa cứng"])
          ? oldRow["tên profile khóa cứng"]
          : oldRow["tên profile"] || NOT_LOCKED_TEXT,
        uid: hasLockedValue(oldRow.uid) ? oldRow.uid : NOT_LOCKED_TEXT,
        _deleted_at: new Date().toISOString(),
        _from_sheet: oldRow._from_sheet || ""
      });
      movedToTrash += 1;
    }
  }

  for (const profile of hideState.profiles) {
    const oldRow = existingById.get(profile.id) || trashById.get(profile.id) || {};
    const lockedName = profile.lockedName || "";
    const lockedUid = profile.lockedUid || "";
    const nextRow = {
      ...oldRow,
      "tên profile hiện tại": profile.name,
      "tên profile khóa cứng": lockedName || NOT_LOCKED_TEXT,
      "id hide": profile.id,
      uid: lockedUid || NOT_LOCKED_TEXT,
      "tên chuẩn": oldRow["tên chuẩn"] || buildStandardName({
        currentName: profile.name,
        sheetRow: oldRow,
        uid: lockedUid || profile.uid || ""
      }),
      _deleted_at: "",
      _from_sheet: ""
    };
    preserveStableSheetFields(nextRow, oldRow);
    if (!rowsByTarget.has(profile.sheetTitle)) rowsByTarget.set(profile.sheetTitle, []);
    rowsByTarget.get(profile.sheetTitle).push(nextRow);
    updated += 1;
  }

  for (const title of activeTitles) {
    const rows = rowsByTarget.get(title) || [];
    await client.clearValues(title);
    await client.updateValues(title, [headers, ...rows.map((row) => objectToRow(headers, row))]);
  }

  const nextTrashRows = trashRows.filter((row) => {
    const id = String(row["id hide"] || "").trim();
    return !id || !activeProfileIds.has(id);
  });
  await client.clearValues(config.trashSheetName);
  await client.updateValues(config.trashSheetName, [headers, ...nextTrashRows.map((row) => objectToRow(headers, row))]);
  await formatDuplicateRows(
    client,
    sheetIdsByTitle,
    headers,
    rowsByTarget,
    new Set(hideState.duplicates.duplicateProfileIds),
    config.trashSheetName
  );
  for (const oldTitle of previousManagedTitles) {
    if (!activeTitles.includes(oldTitle) && allTitles.includes(oldTitle)) {
      await client.clearValues(oldTitle);
      await client.updateValues(oldTitle, [headers]);
    }
  }
  await writeManagedTitles(client, activeTitles);
  const cacheRowsByTarget = new Map(activeTitles.map((title) => [title, {
    headers,
    rows: rowsByTarget.get(title) || []
  }]));
  cacheRowsByTarget.set(config.trashSheetName, { headers, rows: nextTrashRows });
  storeManagedSheetCache(config, {
    titles: [...activeTitles],
    data: cacheRowsByTarget,
    headers,
    source: "sync-write"
  });

  return {
    folders: hideState.folders.length,
    profiles: hideState.profiles.length,
    updated,
    movedToTrash,
    restoredFromTrash: restoredFromTrash.size,
    duplicateUids: hideState.duplicates.duplicateUids.length,
    hideAccount: config.hideAccount || null,
    spreadsheetId: config.spreadsheetId || ""
  };
}

async function preview(config) {
  const hideState = await getHideState(config);
  const sheetRowsById = await getSheetRowsCache(config).catch(() => new Map());
  for (const profile of hideState.profiles) {
    const row = sheetRowsById.get(profile.id);
    const jobResult = toolRuntime.jobs.get(profile.id)?.result || null;
    const mergedRow = { ...(row || {}), ...(jobResult || {}) };
    if (!row && !jobResult) continue;
    const lockedUid = hasLockedValue(sheetRowValue(mergedRow, "uid")) ? sheetRowValue(mergedRow, "uid") : "";
    profile.uid = lockedUid || profile.uid;
    profile.sheetData = {
      Tool: sheetRowValue(mergedRow, "Tool"),
      "trạng thái": sheetRowValue(mergedRow, "trạng thái", "trang thai"),
      "số vạch": sheetRowValue(mergedRow, "số vạch", "so vach"),
      "chi tiết": sheetRowValue(mergedRow, "chi tiết", "chi tiet"),
      "mật khẩu": sheetRowValue(mergedRow, "mật khẩu", "mat khau"),
      "2fa": sheetRowValue(mergedRow, "2fa"),
      "cookie": sheetRowValue(mergedRow, "cookie"),
      "tên chuẩn": sheetRowValue(mergedRow, "tên chuẩn", "ten chuan"),
      "địa chỉ ban đầu": sheetRowValue(mergedRow, "địa chỉ ban đầu", "dia chi ban dau")
    };
  }
  hideState.duplicates = analyzeDuplicateUids(hideState.profiles);
  return {
    ...hideState,
    hideAccount: config.hideAccount || null,
    spreadsheetId: config.spreadsheetId || "",
    totals: {
      folders: hideState.folders.length,
      profiles: hideState.profiles.length
    }
  };
}

async function getSheetRowsCache(config) {
  if (!config.spreadsheetId || !config.credentialsPath) return new Map();
  const key = sheetCacheKey(config);
  if (sheetCache.key === key && sheetCache.byId instanceof Map) {
    return sheetCache.byId;
  }
  await readManagedSheetData(config, { forceRefresh: true, source: "preview-cache-miss" });
  return sheetCache.byId;
}

async function readManagedSheetData(config, options = {}) {
  if (!config.spreadsheetId || !config.credentialsPath) {
    throw new Error("Bạn cần cấu hình Google Sheet trước khi chạy tool.");
  }
  const token = await getGoogleAccessToken(config.credentialsPath);
  const client = new SheetsClient(config, token);
  const key = sheetCacheKey(config);
  if (!options.forceRefresh && sheetCache.key === key && sheetCache.data) {
    return {
      client,
      titles: [...sheetCache.titles],
      data: cloneSheetDataMap(sheetCache.data),
      headers: [...sheetCache.headers],
      fromCache: true,
      cacheLoadedAt: sheetCache.loadedAt
    };
  }
  const managedTitles = await readManagedTitles(client);
  const meta = await client.metadata();
  const allTitles = meta.sheets.map((sheet) => sheet.properties.title);
  const titles = [
    ...new Set([
      ...managedTitles.filter((title) => allTitles.includes(title)),
      ...allTitles.filter((title) => title !== config.trashSheetName && title !== META_SHEET)
    ])
  ];
  const data = await readAllRows(client, titles, config.headers);
  const headers = mergeHeaders(config.headers, data);
  storeManagedSheetCache(config, {
    titles,
    data,
    headers,
    source: options.source || "manual-refresh"
  });
  return { client, titles, data: cloneSheetDataMap(data), headers, fromCache: false, cacheLoadedAt: sheetCache.loadedAt };
}

async function refreshManagedSheetCache(config) {
  const startedAt = Date.now();
  const previousIds = new Set(sheetCache.byId.keys());
  const { titles, data, headers } = await readManagedSheetData(config, {
    forceRefresh: true,
    source: "manual-cache-refresh"
  });
  const nextIds = new Set(sheetCache.byId.keys());
  let added = 0;
  let removed = 0;
  for (const id of nextIds) if (!previousIds.has(id)) added += 1;
  for (const id of previousIds) if (!nextIds.has(id)) removed += 1;
  const mergedQueuedRows = mergeSheetCacheIntoActiveSessions();
  return {
    spreadsheetId: config.spreadsheetId || "",
    sheetCount: titles.length,
    rowCount: sheetCache.byId.size,
    added,
    removed,
    mergedQueuedRows,
    headerCount: headers.length,
    loadedAt: new Date(sheetCache.loadedAt).toISOString(),
    elapsedMs: Date.now() - startedAt
  };
}

function normalizeHeaderName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\u00c4\u2018/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sheetRowValue(row, ...keys) {
  const entries = Object.entries(row || {});
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
    const normalizedKey = normalizeHeaderName(key);
    const match = entries.find(([entryKey, entryValue]) =>
      entryValue !== undefined &&
      entryValue !== null &&
      normalizeHeaderName(entryKey) === normalizedKey
    );
    if (match) return match[1];
  }
  return "";
}

async function readCredentialSourceMap(config, spreadsheetId) {
  if (!spreadsheetId || !config.credentialsPath) {
    throw new Error("Ban can cau hinh Service Account JSON va Spreadsheet ID nguon.");
  }
  const normalizeUid = (value) => String(value || "").replace(/\D+/g, "").trim();
  const scoreCredentialRow = (item) =>
    (String(item.password || "").trim() ? 4 : 0) +
    (String(item.twofa || "").trim() ? 2 : 0) +
    (String(item.cookie || "").trim() ? 1 : 0);
  const token = await getGoogleAccessToken(config.credentialsPath);
  const client = new SheetsClient({ ...config, spreadsheetId }, token);
  const meta = await client.metadata();
  const titles = meta.sheets.map((sheet) => sheet.properties.title).filter(Boolean);
  const byUid = new Map();
  const matchedTitles = [];
  const valuesByTitle = await client.batchGetValues(titles);
  for (const title of titles) {
    const values = valuesByTitle.get(title) || [];
    if (!values.length) continue;
    const headers = values[0] || [];
    const uidIndex = headers.findIndex((header) => normalizeHeaderName(header) === "uid");
    const passwordIndex = headers.findIndex((header) => {
      const normalized = normalizeHeaderName(header);
      return normalized === "mat khau" || normalized === "password";
    });
    if (uidIndex < 0 || passwordIndex < 0) continue;
    matchedTitles.push(title);
    const twofaIndex = headers.findIndex((header) => normalizeHeaderName(header) === "2fa");
    const cookieIndex = headers.findIndex((header) => normalizeHeaderName(header) === "cookie");
    for (const row of values.slice(1)) {
      const uid = normalizeUid(row[uidIndex]);
      if (!uid) continue;
      const nextItem = {
        uid,
        password: String(row[passwordIndex] || "").trim(),
        twofa: twofaIndex >= 0 ? String(row[twofaIndex] || "").trim() : "",
        cookie: cookieIndex >= 0 ? String(row[cookieIndex] || "").trim() : ""
      };
      const currentItem = byUid.get(uid);
      if (!currentItem || scoreCredentialRow(nextItem) >= scoreCredentialRow(currentItem)) {
        byUid.set(uid, nextItem);
      }
    }
  }
  if (!matchedTitles.length) throw new Error("Khong tim thay bang tinh nao trong file nguon co cot uid va mat khau.");
  return { title: matchedTitles.join(", "), byUid };
}

async function withSellerInfoLock(task) {
  const previous = sellerInfoLock;
  let release;
  sellerInfoLock = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

async function readSellerInfoSheet(config) {
  if (!config.sellerSpreadsheetId || !config.credentialsPath) {
    throw new Error("Ban can cau hinh Seller Info Spreadsheet ID va Service Account JSON.");
  }
  const cacheKey = `${config.sellerSpreadsheetId}|${config.credentialsPath}`;
  if (
    sellerInfoCache.key === cacheKey &&
    sellerInfoCache.data &&
    Date.now() - sellerInfoCache.loadedAt < sellerInfoCache.ttlMs
  ) {
    const token = await getGoogleAccessToken(config.credentialsPath);
    const sellerConfig = { ...config, spreadsheetId: config.sellerSpreadsheetId };
    const client = new SheetsClient(sellerConfig, token);
    return { ...sellerInfoCache.data, client };
  }
  const token = await getGoogleAccessToken(config.credentialsPath);
  const sellerConfig = { ...config, spreadsheetId: config.sellerSpreadsheetId };
  const client = new SheetsClient(sellerConfig, token);
  const meta = await client.metadata();
  const title = meta.sheets?.[0]?.properties?.title;
  if (!title) throw new Error("Seller Info Spreadsheet khong co trang tinh nao.");
  const values = await client.getValues(title);
  const headers = values[0] || [];
  if (!headers.length) throw new Error("Seller Info Sheet chua co header.");
  const uidIndex = headers.findIndex((header) => normalizeHeaderName(header) === "uid");
  if (uidIndex < 0) throw new Error("Seller Info Sheet thieu cot uid.");
  const rows = values.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    raw: rowToObject(headers, row),
    values: headers.map((_, colIndex) => row[colIndex] ?? "")
  }));
  const data = { title, headers, uidIndex, rows };
  sellerInfoCache.key = cacheKey;
  sellerInfoCache.loadedAt = Date.now();
  sellerInfoCache.data = data;
  return { ...data, client };
}

async function allocateSellerInfoRow(config, profileUid) {
  return withSellerInfoLock(async () => {
    const sheet = await readSellerInfoSheet(config);
    const available = sheet.rows.find((row) => !String(row.raw.uid || row.raw.UID || "").trim());
    if (!available) throw new Error("Seller Info Sheet khong con dong trong cot uid de dung.");
    const lockValue = `dang dung:${profileUid}`;
    available.values[sheet.uidIndex] = lockValue;
    available.raw.uid = lockValue;
    await sheet.client.updateRowValues(sheet.title, available.rowNumber, available.values);
    return {
      sheetTitle: sheet.title,
      rowNumber: available.rowNumber,
      headers: sheet.headers,
      values: available.values,
      raw: { ...available.raw, uid: lockValue },
      lockValue
    };
  });
}

async function updateSellerInfoUid(config, allocation, value) {
  if (!allocation) return false;
  return withSellerInfoLock(async () => {
    const sheet = await readSellerInfoSheet(config);
    const row = sheet.rows.find((item) => item.rowNumber === allocation.rowNumber);
    if (!row) return false;
    row.values[sheet.uidIndex] = String(value || "");
    row.raw.uid = String(value || "");
    await sheet.client.updateRowValues(sheet.title, allocation.rowNumber, row.values);
    return true;
  });
}

async function getRowsByProfileIds(config, profileIds) {
  const { data } = await readManagedSheetData(config);
  const wanted = new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean));
  const rows = new Map();
  for (const [sheetTitle, sheet] of data) {
    for (const row of sheet.rows) {
      const id = String(row["id hide"] || "").trim();
      if (!wanted.has(id)) continue;
      rows.set(id, { ...row, _sheetTitle: sheetTitle });
    }
  }
  return rows;
}

async function createSheetRowSession(config, profileIds) {
  const { client, data, headers } = await readManagedSheetData(config);
  const wanted = new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean));
  const rows = new Map();
  const canonicalFieldMap = new Map([
    ["trang thai", ["trangThai", "trạng thái", "trang thai"]],
    ["chi tiet", ["chiTiet", "chi tiết", "chi tiet"]],
    ["so vach", ["soVach", "số vạch", "so vach"]],
    ["dia chi ban dau", ["diaChiBanDau", "địa chỉ ban đầu", "dia chi ban dau"]],
    ["ten chuan", ["tenChuan", "tên chuẩn", "ten chuan"]],
    ["so luong page", ["soLuongPage", "số lượng page", "so luong page"]],
    ["bang", ["bang", "proxy"]]
  ]);

  const touchedTitles = new Set();
  for (const [sheetTitle, sheet] of data) {
    if ((sheet.rows || []).some((row) => wanted.has(String(row["id hide"] || "").trim()))) touchedTitles.add(sheetTitle);
  }
  await ensureRequiredHeadersForSession(client, data, config.headers || DEFAULT_CONFIG.headers, touchedTitles);

  for (const [sheetTitle, sheet] of data) {
    sheet.rows.forEach((row, index) => {
      const id = String(row["id hide"] || "").trim();
      if (!wanted.has(id)) return;
      rows.set(id, {
        ...row,
        _sheetTitle: sheetTitle,
        _rowNumber: index + 2,
        _headers: [...(sheet.headers || headers)]
      });
    });
  }

  const session = {
    rows,
    pending: new Map(),
    flushTimer: null,
    flushing: null,
    waiters: [],
    stats: {
      writeCalls: 0,
      writeRanges: 0,
      skippedUnchanged: 0,
      retries: 0,
      lastWriteAt: 0,
      startedAt: Date.now()
    },
    async updateOne(profileId, update) {
      const current = rows.get(String(profileId || "").trim());
      if (!current) return 0;
      const normalizedUpdate = { ...update };
      const nonClearableGroups = [
        ["Tool"],
        ["trangThai", "trạng thái", "trang thai"],
        ["soVach", "số vạch", "so vach"],
        ["diaChiBanDau", "địa chỉ ban đầu", "dia chi ban dau"],
        ["soLuongPage", "số lượng page", "so luong page"],
        ["chiTiet", "chi tiết", "chi tiet"],
        ["mật khẩu", "mat khau"],
        ["2fa"],
        ["cookie"],
        ["bang", "proxy"],
        ["tenChuan", "tên chuẩn", "ten chuan"]
      ];
      for (const keys of nonClearableGroups) {
        const candidate = keys
          .map((key) => normalizedUpdate[key])
          .find((value) => value !== undefined && value !== null);
        if (candidate === undefined || candidate === null) continue;
        if (String(candidate).trim()) continue;
        for (const key of keys) delete normalizedUpdate[key];
      }
      const next = { ...current, ...normalizedUpdate };
      for (const [normalizedField, aliases] of canonicalFieldMap.entries()) {
        const incoming = aliases
          .map((key) => normalizedUpdate[key])
          .find((value) => value !== undefined && value !== null);
        if (incoming === undefined || incoming === null) continue;
        for (const key of Object.keys(next)) {
          if (normalizeHeaderName(key) === normalizedField) next[key] = incoming;
        }
      }
      preserveStableSheetFields(next, current);
      const rowHeaders = Array.isArray(current._headers) && current._headers.length ? current._headers : headers;
      const currentValues = objectToRow(rowHeaders, current);
      const nextValues = objectToRow(rowHeaders, next);
      const changed = currentValues.length !== nextValues.length || nextValues.some((value, index) => String(value ?? "") !== String(currentValues[index] ?? ""));
      if (!changed) {
        this.stats.skippedUnchanged += 1;
        return 0;
      }
      rows.set(String(profileId || "").trim(), next);
      this.pending.set(String(profileId || "").trim(), next);
      this.flushSoon();
      return 1;
    },
    flushSoon() {
      if (this.pending.size >= 80) return this.flush();
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flush().catch((error) => console.warn(`[sheet-writer] scheduled flush failed: ${error.message}`));
        }, 5000);
      }
      return Promise.resolve(true);
    },
    async waitForWriteSlot() {
      const minGapMs = 2500;
      const elapsed = Date.now() - this.stats.lastWriteAt;
      if (elapsed < minGapMs) await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
    },
    isQuotaError(error) {
      const message = String(error?.message || error || "").toLowerCase();
      return message.includes("quota exceeded")
        || message.includes("write requests per minute")
        || message.includes("rate limit")
        || message.includes("429");
    },
    async writeBatchWithRetry(client, batchData) {
      const maxAttempts = 6;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await this.waitForWriteSlot();
        try {
          await client.batchUpdateValues(batchData);
          this.stats.writeCalls += 1;
          this.stats.writeRanges += batchData.length;
          this.stats.lastWriteAt = Date.now();
          const elapsedMinutes = Math.max(1 / 60, (Date.now() - this.stats.startedAt) / 60000);
          console.log(`[sheet-writer] endpoint=values:batchUpdate call=${this.stats.writeCalls} ranges=${batchData.length} pending=${this.pending.size} rpm=${(this.stats.writeCalls / elapsedMinutes).toFixed(1)} skipped=${this.stats.skippedUnchanged} retries=${this.stats.retries}`);
          return;
        } catch (error) {
          if (!this.isQuotaError(error) || attempt >= maxAttempts) throw error;
          this.stats.retries += 1;
          const delay = Math.min(60000, 5000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 1000);
          console.warn(`[sheet-writer] quota retry ${attempt}/${maxAttempts} after ${delay}ms: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
    async flush() {
      if (this.flushing) return this.flushing;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (!this.pending.size) {
        const waiters = this.waiters.splice(0);
        waiters.forEach((waiter) => waiter.resolve(true));
        return true;
      }
      this.flushing = (async () => {
        const batchRows = [...this.pending.entries()];
        this.pending.clear();
        const data = batchRows.map(([, row]) => {
          const range = `'${row._sheetTitle.replace(/'/g, "''")}'!A${row._rowNumber}`;
          const rowHeaders = Array.isArray(row._headers) && row._headers.length ? row._headers : headers;
          return { range, values: [objectToRow(rowHeaders, row)] };
        });
        try {
          const token = await getGoogleAccessToken(config.credentialsPath);
          const client = new SheetsClient(config, token);
          await this.writeBatchWithRetry(client, data);
          updateManagedSheetCacheRows(new Map(batchRows));
          const waiters = this.waiters.splice(0);
          waiters.forEach((waiter) => waiter.resolve(true));
          return true;
        } catch (error) {
          for (const [id, row] of batchRows) this.pending.set(id, row);
          const waiters = this.waiters.splice(0);
          waiters.forEach((waiter) => waiter.reject(error));
          throw error;
        } finally {
          this.flushing = null;
        }
      })();
      return this.flushing;
    },
    async flushAll() {
      while (this.pending.size || this.flushing) {
        await this.flush();
      }
      return true;
    }
  };
  if (!(toolRuntime.sheetSessions instanceof Set)) toolRuntime.sheetSessions = new Set();
  toolRuntime.sheetSessions.add(session);
  if (toolRuntime.sheetSessions.size > 20) {
    const [oldest] = toolRuntime.sheetSessions;
    if (oldest) toolRuntime.sheetSessions.delete(oldest);
  }
  return session;
}

async function updateSheetRowsByProfileId(config, updatesById) {
  const { client, titles, data, headers } = await readManagedSheetData(config);
  let changed = 0;
  const changedRows = new Map();
  for (const title of titles) {
    const sheet = data.get(title);
    if (!sheet) continue;
    const nextRows = sheet.rows.map((row) => {
      const id = String(row["id hide"] || "").trim();
      const update = updatesById.get(id);
      if (!update) return row;
      changed += 1;
      const next = { ...row, ...update };
      changedRows.set(id, next);
      return next;
    });
    await client.clearValues(title);
    await client.updateValues(title, [headers, ...nextRows.map((row) => objectToRow(headers, row))]);
  }
  updateManagedSheetCacheRows(changedRows);
  return changed;
}

async function writeCheckOrderRow(config, row) {
  const spreadsheetId = String(config.checkOrderSpreadsheetId || "").trim();
  if (!spreadsheetId) throw new Error("Chua cau hinh Check order Spreadsheet ID.");
  if (!config.credentialsPath) throw new Error("Chua cau hinh Service Account JSON.");
  const sheetTitle = sanitizeSheetTitle(config.checkOrderSheetName || DEFAULT_CONFIG.checkOrderSheetName || "check order");
  const token = await getGoogleAccessToken(config.credentialsPath);
  const client = new SheetsClient({ ...config, spreadsheetId }, token);
  await ensureSheets(client, [sheetTitle]);
  const values = await client.getValues(sheetTitle);
  const headers = values[0]?.length ? [...values[0]] : [...CHECK_ORDER_HEADERS];
  const isLegacyCheckOrderHeader = (header) => {
    const text = String(header || "").trim().toLowerCase();
    if (!text) return true;
    if (CHECK_ORDER_HEADERS.includes(header)) return false;
    return /ng.*y.*l.*m|tr.*ng.*th.*i|chi.*ti.*t/.test(text);
  };
  const orderedHeaders = [
    ...CHECK_ORDER_HEADERS,
    ...headers.filter((header) => !CHECK_ORDER_HEADERS.includes(header) && !isLegacyCheckOrderHeader(header))
  ];
  headers.splice(0, headers.length, ...orderedHeaders);
  const rows = values.slice(1).map((valueRow) => rowToObject(headers, valueRow));
  const uid = String(row.uid || "").trim();
  if (!uid) throw new Error("Khong co UID de ghi Sheet check order.");
  const nextRow = { ...row };
  const existingIndex = rows.findIndex((item) => String(item.uid || "").trim() === uid);
  if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...nextRow };
  else rows.push(nextRow);
  await client.updateValues(sheetTitle, [headers, ...rows.map((item) => objectToRow(headers, item))]);
  return { updated: true, rowNumber: existingIndex >= 0 ? existingIndex + 2 : rows.length + 1, sheetTitle };
}
function buildToolRow(profileId, sheetRow) {
  const raw = { ...sheetRow };
  return {
    uid: String(sheetRow.uid || sheetRow["uid"] || profileId).trim(),
    profile_id: profileId,
    raw
  };
}

function mapErrorForSheet(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  const message = String(error?.message || "Lỗi không rõ.").trim();
  if (status === "cp282") return { renameStatus: "cp282", detail: message || "Checkpoint cp282 khi đăng nhập." };
  if (status === "cp956") return { renameStatus: "cp956", detail: message || "Checkpoint cp956 khi đăng nhập." };
  if (status === "loicapcha") return { renameStatus: "loicapcha", detail: message || "Facebook yeu cau reCAPTCHA khi dang nhap." };
  if (status === "biout") return { renameStatus: "biout", detail: message || "Nick bi out giua chung, tool da dung." };
  if (status === "hetproxy") return { renameStatus: "hetproxy", detail: message || "Hết proxy khi mở Facebook." };
  if (status === "thieubang") return { renameStatus: "thieubang", detail: message || "Chua gan bang trong Sheet." };
  if (status === "loipb") return { renameStatus: "loipb", detail: message || "Lỗi phiên bản browser profile." };
  const lower = message.toLowerCase();
  if (
    lower.includes("err_tunnel_connection_failed") ||
    lower.includes("err_proxy_connection_failed") ||
    lower.includes("err_timed_out") ||
    lower.includes("proxy connection failed") ||
    lower.includes("proxy_connection_failed") ||
    lower.includes("checking the proxy") ||
    lower.includes("took too long to respond") ||
    lower.includes("site can’t be reached") ||
    lower.includes("site can't be reached") ||
    lower.includes("het proxy")
  ) {
    return { renameStatus: "hetproxy", detail: message };
  }
  if (lower.includes("recaptcha") || lower.includes("captcha") || lower.includes("i'm not a robot") || lower.includes("not a robot")) {
    return { renameStatus: "loicapcha", detail: message };
  }
  if (lower.includes("bi out") || lower.includes("bị out") || lower.includes("logged out") || lower.includes("see more on facebook")) {
    return { renameStatus: "biout", detail: message };
  }
  if (lower.includes("about:blank") || lower.includes("loi phien ban") || lower.includes("lỗi phiên bản")) {
    return { renameStatus: "loipb", detail: message };
  }
  return { renameStatus: "loi", detail: message };
}

function getToolStatusPayload() {
  return {
    running: toolRuntime.running,
    stopRequested: toolRuntime.stopRequested,
    currentTool: toolRuntime.currentTool || "",
    jobs: [...toolRuntime.jobs.values()],
    logs: toolRuntime.logs.slice(-1000),
    autoSync: {
      enabled: backgroundSyncState.enabled,
      isTicking: backgroundSyncState.isTicking,
      lastCheckedAt: backgroundSyncState.lastCheckedAt || null,
      lastSyncedAt: backgroundSyncState.lastSyncedAt || null,
      lastError: backgroundSyncState.lastError || ""
    }
  };
}

const clipProxyTool = createClipProxyTool({
  hideRequest,
  addRuntimeLog
});

const proxyPanelTool = createProxyPanelTool({
  hideRequest,
  addRuntimeLog
});

function activeStateProxyTool(config = {}) {
  return stateProxyProviderIsProxyPanel(config) ? proxyPanelTool : clipProxyTool;
}

const stateProxyTool = {
  getStatus(config) {
    return activeStateProxyTool(config).getStatus(config);
  },
  addState(config, state) {
    return activeStateProxyTool(config).addState(config, state);
  },
  ensureForProfile(options = {}) {
    return activeStateProxyTool(options.config || {}).ensureForProfile(options);
  },
  release(lease) {
    if (lease?.provider === "proxypanel") return proxyPanelTool.release(lease);
    return clipProxyTool.release(lease);
  },
  checkAll(config) {
    return activeStateProxyTool(config).checkAll(config);
  },
  applyNow(config, state) {
    const tool = activeStateProxyTool(config);
    if (typeof tool.applyNow === "function") return tool.applyNow(config, state);
    return tool.checkAll(config);
  }
};

const checkTbModule = createCheckTb({
  getManager: getXemTbManager,
  getLoginManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  mapErrorForSheet,
  getRowsByProfileIds,
  updateSheetRowsByProfileId,
  createSheetRowSession,
  readConfig,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const lamFullModule = createLamFull({
  getManager: getShippingFullManager,
  getLocationManager: getHmaStudioManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  allocateSellerInfoRow,
  updateSellerInfoUid,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const dienMatKhauModule = createDienMatKhau({
  addRuntimeLog,
  createSheetRowSession,
  readCredentialSourceMap,
  runtime: toolRuntime
});

const dangBaiModule = createDangBai({
  getManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  allocateSellerInfoRow,
  updateSellerInfoUid,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const tuongTacModule = createTuongTac({
  getManager: getShippingFullManager,
  getInteractionManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});
const renewDocLapModule = createRenewDocLapTool({
  getManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const taoPageModule = createTaoPage({
  getManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const avatarModule = createAvatarTool({
  getManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});

const checkOrderModule = createCheckOrderTool({
  getManager: getShippingFullManager,
  dangNhap: dangNhapModule,
  addRuntimeLog,
  buildToolRow,
  mapErrorForSheet,
  writeCheckOrderRow,
  stateProxy: stateProxyTool,
  runtime: toolRuntime
});
const nineProxyTool = createNineProxyTool({
  hideRequest,
  addRuntimeLog
});

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function updateLimitedToolFromOriginal() {
  if (!existsSync(originalToolRoot)) {
    throw new Error(`Khong tim thay tool goc tai ${originalToolRoot}`);
  }

  const files = [];
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const relativePath of limitedUpdateFiles) {
    const sourcePath = path.resolve(originalToolRoot, relativePath);
    const targetPath = path.resolve(__dirname, relativePath);
    if (!isPathInside(originalToolRoot, sourcePath) || !isPathInside(__dirname, targetPath)) {
      skipped += 1;
      files.push({ path: relativePath, status: "skipped", reason: "duong dan khong hop le" });
      continue;
    }
    if (!existsSync(sourcePath)) {
      missing += 1;
      files.push({ path: relativePath, status: "missing_source" });
      continue;
    }
    if (!existsSync(targetPath)) {
      skipped += 1;
      files.push({ path: relativePath, status: "not_in_limited" });
      continue;
    }

    const [sourceContent, targetContent] = await Promise.all([
      readFile(sourcePath),
      readFile(targetPath)
    ]);
    if (sourceContent.equals(targetContent)) {
      skipped += 1;
      files.push({ path: relativePath, status: "same" });
      continue;
    }

    await writeFile(targetPath, sourceContent);
    updated += 1;
    files.push({ path: relativePath, status: "updated" });
  }

  const result = {
    source: originalToolRoot,
    updated,
    skipped,
    missing,
    files,
    needsRestart: updated > 0
  };
  addRuntimeLog(`[update] Cap nhat ban gian luoc tu ban goc: ${updated} file moi, ${skipped} file bo qua`, updated ? "success" : "info", "", {
    tool: "he thong",
    step: "cap nhat ban gian luoc"
  });
  return result;
}

function normalizeUpdatePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isLimitedUpdatePathAllowed(relativePath) {
  const normalized = normalizeUpdatePath(relativePath);
  return Boolean(normalized && !normalized.includes("..") && limitedOnlineUpdateFiles.includes(normalized));
}

async function readUpdateVersion() {
  try {
    const data = JSON.parse(await readFile(updateVersionPath, "utf8"));
    return {
      version: String(data.version || "local").trim() || "local",
      updatedAt: String(data.updatedAt || "").trim(),
      manifestUrl: String(data.manifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim() || DEFAULT_UPDATE_MANIFEST_URL
    };
  } catch {
    return { version: "local", updatedAt: "", manifestUrl: DEFAULT_UPDATE_MANIFEST_URL };
  }
}

async function saveUpdateVersion(data = {}) {
  await mkdir(path.dirname(updateVersionPath), { recursive: true });
  const payload = {
    version: String(data.version || "local").trim() || "local",
    updatedAt: new Date().toISOString(),
    manifestUrl: String(data.manifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim() || DEFAULT_UPDATE_MANIFEST_URL
  };
  await writeFile(updateVersionPath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function fetchUpdateJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "cache-control": "no-cache" } });
    if (!response.ok) throw new Error(`Khong tai duoc manifest cap nhat: HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpdateBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "cache-control": "no-cache" } });
    if (!response.ok) throw new Error(`Khong tai duoc file cap nhat: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function updateFileUrl(manifest, file) {
  if (file.url) return String(file.url);
  const rawBase = String(manifest.rawBase || "").replace(/\/+$/, "");
  if (!rawBase) throw new Error(`Manifest thieu rawBase cho file ${file.path}`);
  return `${rawBase}/${normalizeUpdatePath(file.path).split("/").map(encodeURIComponent).join("/")}`;
}

async function runOnlineUpdate(input = {}) {
  if (toolRuntime.running) {
    throw new Error("Tool dang chay job, hay dung job truoc khi cap nhat online.");
  }
  const manifestUrl = String(input.manifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim() || DEFAULT_UPDATE_MANIFEST_URL;
  const manifest = await fetchUpdateJson(manifestUrl);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const version = String(manifest.version || "").trim();
  if (String(manifest.channel || "").trim() !== "lite") throw new Error("Manifest khong phai ban gian luoc.");
  if (!version) throw new Error("Manifest cap nhat thieu version.");
  if (!files.length) throw new Error("Manifest cap nhat khong co file.");

  const backupDir = path.join(updateBackupRoot, `${version}-${Date.now()}`);
  const results = [];
  let updated = 0;
  let skipped = 0;

  for (const item of files) {
    const relativePath = normalizeUpdatePath(item.path);
    if (!isLimitedUpdatePathAllowed(relativePath)) {
      skipped += 1;
      results.push({ path: relativePath, status: "blocked" });
      continue;
    }
    const targetPath = path.resolve(__dirname, relativePath);
    if (!isPathInside(__dirname, targetPath)) {
      skipped += 1;
      results.push({ path: relativePath, status: "blocked" });
      continue;
    }

    const buffer = await fetchUpdateBuffer(updateFileUrl(manifest, { ...item, path: relativePath }));
    const hash = sha256Buffer(buffer);
    const expectedHash = String(item.sha256 || "").trim().toLowerCase();
    if (expectedHash && hash !== expectedHash) {
      throw new Error(`File ${relativePath} sai hash, dung cap nhat de tranh hong tool.`);
    }

    let current = null;
    try {
      current = await readFile(targetPath);
    } catch {}
    if (current && sha256Buffer(current) === hash) {
      skipped += 1;
      results.push({ path: relativePath, status: "same" });
      continue;
    }

    if (current) {
      const backupPath = path.join(backupDir, relativePath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(targetPath, backupPath);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, buffer);
    updated += 1;
    results.push({ path: relativePath, status: "updated", sha256: hash });
  }

  const current = await saveUpdateVersion({ version, manifestUrl });
  addRuntimeLog(`[update-online-lite] Cap nhat online ban gian luoc ${version}: ${updated} file moi, ${skipped} file bo qua`, updated ? "success" : "info", "", {
    tool: "he thong",
    step: "cap nhat online"
  });
  return { version, updated, skipped, files: results, backupDir: updated ? backupDir : "", needsRestart: updated > 0, current };
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/api/runtime") {
      return jsonResponse(res, 200, { ok: true, data: { startedAt: SERVER_STARTED_AT, restarting: restartScheduled } });
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return jsonResponse(res, 200, { ok: true, config: await readConfig() });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      return jsonResponse(res, 200, { ok: true, config: await saveConfigV2(await parseBody(req)) });
    }
    if (req.method === "GET" && url.pathname === "/api/update/status") {
      return jsonResponse(res, 200, { ok: true, data: await readUpdateVersion() });
    }
    if (req.method === "POST" && url.pathname === "/api/update/online") {
      return jsonResponse(res, 200, { ok: true, data: await runOnlineUpdate(await parseBody(req)) });
    }
    if (req.method === "POST" && url.pathname === "/api/limited/update-from-original") {
      return jsonResponse(res, 200, { ok: true, data: await updateLimitedToolFromOriginal() });
    }
    if (req.method === "GET" && url.pathname === "/api/preview") {
      return jsonResponse(res, 200, { ok: true, data: await preview(await resolveAccountSheetConfig(await readConfig())) });
    }
    if (req.method === "POST" && url.pathname === "/api/sync") {
      return jsonResponse(res, 200, { ok: true, data: await syncSheets(await resolveAccountSheetConfig(await readConfig())) });
    }
    if (req.method === "POST" && url.pathname === "/api/sheet-cache/refresh") {
      return jsonResponse(res, 200, { ok: true, data: await refreshManagedSheetCache(await resolveAccountSheetConfig(await readConfig())) });
    }
    if (req.method === "GET" && url.pathname === "/api/sheet-cache/status") {
      return jsonResponse(res, 200, {
        ok: true,
        data: {
          spreadsheetId: sheetCache.key.split("|")[0] || "",
          loadedAt: sheetCache.loadedAt ? new Date(sheetCache.loadedAt).toISOString() : "",
          rowCount: sheetCache.byId?.size || 0,
          sheetCount: sheetCache.titles?.length || 0,
          source: sheetCache.source || "",
          reads: sheetCache.reads || 0
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/api/proxy-tool/status") {
      return jsonResponse(res, 200, { ok: true, data: { ...nineProxyTool.getStatus(await readConfig()), monitor: { enabled: Boolean(proxyMonitorState.timer), isTicking: proxyMonitorState.isTicking, lastCheckedAt: proxyMonitorState.lastCheckedAt, lastChangedAt: proxyMonitorState.lastChangedAt, lastError: proxyMonitorState.lastError } } });
    }
    if (req.method === "POST" && url.pathname === "/api/proxy-tool/save") {
      const body = await parseBody(req);
      const config = await saveConfigV2({ ...(await readConfig()), ...body });
      return jsonResponse(res, 200, { ok: true, config, data: nineProxyTool.getStatus(config) });
    }
    if (req.method === "POST" && url.pathname === "/api/proxy-tool/check") {
      const body = await parseBody(req);
      const config = sanitizeProxyConfigInput(body, await readConfig());
      const data = await nineProxyTool.refreshPortStatus(config);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/proxy-tool/prepare") {
      const body = await parseBody(req);
      const config = sanitizeProxyConfigInput(body, await readConfig());
      const slots = await nineProxyTool.ensureFreshPorts(config, Math.max(1, Math.min(10, Number(body.count || config.nineProxyPortCount || 10))));
      return jsonResponse(res, 200, { ok: true, data: { slots, status: nineProxyTool.getStatus(config) } });
    }
    if (req.method === "POST" && url.pathname === "/api/proxy-tool/assign") {
      const body = await parseBody(req);
      const saved = body.saveConfig === false ? await readConfig() : await saveConfigV2({ ...(await readConfig()), ...body });
      const config = sanitizeProxyConfigInput(body, saved);
      const data = await nineProxyTool.assign({ ...saved, ...config }, body.profileIds || []);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "GET" && url.pathname === "/api/state-proxy/status") {
      const config = await readConfig();
      return jsonResponse(res, 200, { ok: true, data: stateProxyTool.getStatus(config) });
    }
    if (req.method === "POST" && url.pathname === "/api/state-proxy/save") {
      const body = await parseBody(req);
      const config = await saveConfigV2({ ...(await readConfig()), ...body });
      return jsonResponse(res, 200, { ok: true, config, data: stateProxyTool.getStatus(config) });
    }
    if (req.method === "POST" && url.pathname === "/api/state-proxy/add-state") {
      const body = await parseBody(req);
      const current = await readConfig();
      const nextProxyConfig = stateProxyTool.addState({ ...current, ...body }, body.state);
      const config = await saveConfigV2({ ...current, ...nextProxyConfig });
      return jsonResponse(res, 200, { ok: true, config, data: stateProxyTool.getStatus(config) });
    }
    if (req.method === "POST" && url.pathname === "/api/state-proxy/check") {
      const body = await parseBody(req).catch(() => ({}));
      const current = await readConfig();
      const config = stateProxyUsesProxyPanel({ ...current, ...body })
        ? sanitizeProxyPanelConfigInput(body, current)
        : sanitizeClipProxyConfigInput(body, current);
      const data = await stateProxyTool.checkAll({ ...current, ...config });
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/state-proxy/apply") {
      const body = await parseBody(req).catch(() => ({}));
      const current = await readConfig();
      const requestedState = String(body.state || body.proxyPanelStateOverride || "").trim();
      const config = await saveConfigV2({
        ...current,
        ...body,
        ...(requestedState ? { proxyPanelStateOverride: requestedState } : {})
      });
      addRuntimeLog(`ProxyPanel apply request state=${requestedState || "-"} carrier=${config.proxyPanelCarrier || "-"}`, "info", "", { tool: "proxy theo bang", step: "proxypanel", detail: requestedState });
      const data = await stateProxyTool.applyNow(config, requestedState);
      return jsonResponse(res, 200, { ok: true, config, data });
    }
    const disabledLimitedToolRoutes = new Set([
      "/api/tools/check-notifications",
      "/api/tools/check-order",
      "/api/tools/dang-bai",
      "/api/tools/renew-doc-lap",
      "/api/tools/tao-page",
      "/api/tools/avatar"
    ]);
    if (disabledLimitedToolRoutes.has(url.pathname)) {
      return jsonResponse(res, 404, { ok: false, error: "Tool nay khong co trong ban Full & Tuong tac." });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/check-notifications") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.checkConcurrency = clampConcurrency(body.concurrency, config.checkConcurrency || DEFAULT_CONFIG.checkConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.checkConcurrency = 1;
      const data = await checkTbModule.runNotificationQueue(body.profileIds || [], config, {
        concurrency: clampConcurrency(config.checkConcurrency, DEFAULT_CONFIG.checkConcurrency)
      });
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/check-order") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await readConfig());
      const profileIds = Array.isArray(body.profileIds) ? body.profileIds : [];
      if (body.concurrency !== undefined) config.checkOrderConcurrency = clampConcurrency(body.concurrency, config.checkOrderConcurrency || DEFAULT_CONFIG.checkOrderConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.checkOrderConcurrency = 1;
      if (body.checkOrderSpreadsheetId !== undefined) config.checkOrderSpreadsheetId = String(body.checkOrderSpreadsheetId || "").trim();
      if (body.checkOrderSheetName !== undefined) config.checkOrderSheetName = String(body.checkOrderSheetName || DEFAULT_CONFIG.checkOrderSheetName).trim() || DEFAULT_CONFIG.checkOrderSheetName;
      const rowsById = config.spreadsheetId && profileIds.length ? await getRowsByProfileIds(config, profileIds).catch(() => new Map()) : new Map();
      const data = await checkOrderModule.runQueue(profileIds, config, {
        concurrency: clampConcurrency(config.checkOrderConcurrency, DEFAULT_CONFIG.checkOrderConcurrency, 4),
        rowsById
      });
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/lam-full") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.fullConcurrency = clampConcurrency(body.concurrency, config.fullConcurrency || DEFAULT_CONFIG.fullConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.fullConcurrency = 1;
      const data = await lamFullModule.runQueue(body.profileIds || [], config);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/dien-mat-khau") {
      const body = await parseBody(req);
      const data = await dienMatKhauModule.runQueue(
        body.profileIds || [],
        await resolveAccountSheetConfig(await readConfig()),
        { sourceSpreadsheetId: body.sourceSpreadsheetId }
      );
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/dang-bai") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.postConcurrency = clampConcurrency(body.concurrency, config.postConcurrency || DEFAULT_CONFIG.postConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.postConcurrency = 1;
      const data = await dangBaiModule.runQueue(
        body.profileIds || [],
        config
      );
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/tuong-tac") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.interactionConcurrency = clampConcurrency(body.concurrency, config.interactionConcurrency || DEFAULT_CONFIG.interactionConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.interactionConcurrency = 1;
      const data = await tuongTacModule.runQueue(body.profileIds || [], config);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/renew-doc-lap") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      const concurrency = clampConcurrency(body.concurrency, config.interactionConcurrency || DEFAULT_CONFIG.interactionConcurrency, 4);
      const data = await renewDocLapModule.runQueue(body.profileIds || [], config, { concurrency: stateProxyUsesProxyPanel(config) ? 1 : concurrency });
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/tao-page") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.pageConcurrency = clampConcurrency(body.concurrency, config.pageConcurrency || DEFAULT_CONFIG.pageConcurrency, 4);
      if (stateProxyUsesProxyPanel(config)) config.pageConcurrency = 1;
      const data = await taoPageModule.runQueue(body.profileIds || [], config);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/avatar") {
      const body = await parseBody(req);
      const config = forceSingleThreadForProxyPanel(await resolveAccountSheetConfig(await readConfig()));
      if (body.concurrency !== undefined) config.avatarConcurrency = clampConcurrency(body.concurrency, config.avatarConcurrency || DEFAULT_CONFIG.avatarConcurrency, 2);
      if (stateProxyUsesProxyPanel(config)) config.avatarConcurrency = 1;
      if (body.avatarImagePath !== undefined) config.avatarImagePath = String(body.avatarImagePath || "").trim();
      if (body.avatarReplaceExisting !== undefined) config.avatarReplaceExisting = Boolean(body.avatarReplaceExisting);
      const data = await avatarModule.runQueue(body.profileIds || [], config);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/stop") {
      toolRuntime.stopRequested = true;
      addRuntimeLog("[stop] Da nhan lenh dung han batch hien tai", "warn", "", {
        tool: toolRuntime.currentTool || "he thong",
        step: "dung han"
      });
      try {
        const manager = toolRuntime.manager;
        if (manager?.activeJobs instanceof Map) {
          for (const [, activeJob] of manager.activeJobs.entries()) {
            if (activeJob && typeof activeJob === "object") {
              activeJob.stopRequested = true;
              activeJob.pauseRequested = false;
            }
          }
        }
        if (toolRuntime.activeManagers instanceof Map) {
          for (const [, active] of toolRuntime.activeManagers.entries()) {
            const activeManager = active?.manager;
            const uid = active?.uid;
            if (!activeManager) continue;
            const shouldFinish = typeof active?.shouldFinish === "function" ? active.shouldFinish() : false;
            if (shouldFinish) {
              addRuntimeLog("[stop] Worker da qua diem khong quay dau, cho finish sach", "warn", "", {
                tool: toolRuntime.currentTool || "he thong",
                step: "dung han"
              });
              continue;
            }
            activeManager.stopAllRequested = true;
            const activeJob = activeManager.activeJobs instanceof Map ? activeManager.activeJobs.get(uid) : null;
            if (activeJob && typeof activeJob === "object") {
              activeJob.stopRequested = true;
              activeJob.pauseRequested = false;
            }
          }
        }
      } catch {}
      return jsonResponse(res, 200, {
        ok: true,
        data: {
          running: toolRuntime.running,
          stopRequested: toolRuntime.stopRequested,
          tool: toolRuntime.currentTool || ""
        }
      });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/lam-full/pause") {
      return jsonResponse(res, 200, { ok: true, data: lamFullModule.pauseCurrent() });
    }
    if (req.method === "POST" && url.pathname === "/api/tools/lam-full/resume") {
      return jsonResponse(res, 200, { ok: true, data: lamFullModule.resumeCurrent() });
    }
    if (req.method === "GET" && url.pathname === "/api/tools/status") {
      return jsonResponse(res, 200, { ok: true, data: getToolStatusPayload() });
    }
    if (req.method === "POST" && url.pathname === "/api/restart") {
      addRuntimeLog("[restart] Endpoint khoi dong lai backend da bi khoa", "warn", "", {
        tool: "he thong",
        step: "restart",
        detail: `${req.socket?.remoteAddress || ""} ${req.headers["user-agent"] || ""}`.trim()
      });
      appendCrashLog("restart-blocked", `${req.socket?.remoteAddress || ""}\n${req.headers["user-agent"] || ""}`.trim());
      return jsonResponse(res, 410, {
        ok: false,
        error: "Da khoa tinh nang khoi dong lai backend tu giao dien de tranh mat job dang chay."
      });
    }
    if (req.method === "POST" && url.pathname === "/api/restart-manual") {
      if (restartScheduled) {
        scheduleManualBackendRestart("manual-repeat");
        return jsonResponse(res, 200, { ok: true, data: { restarting: true, startedAt: SERVER_STARTED_AT } });
      }
      const activeJobs = [...toolRuntime.jobs.values()].filter((job) => ["queued", "running"].includes(String(job?.status || "").toLowerCase()));
      if (toolRuntime.running || activeJobs.length > 0) {
        addRuntimeLog(`[restart] Force reset backend khi van con ${activeJobs.length} job dang chay`, "warn", "", {
          tool: "he thong",
          step: "restart",
          detail: "Nguoi dung yeu cau reset ngay, cac job dang chay se bi dung."
        });
      }
      addRuntimeLog("[restart] Nhan yeu cau reset backend thu cong", "warn", "", {
        tool: "he thong",
        step: "restart",
        detail: `${req.socket?.remoteAddress || ""} ${req.headers["user-agent"] || ""}`.trim()
      });
      appendCrashLog("restart-request-manual", `${req.socket?.remoteAddress || ""}\n${req.headers["user-agent"] || ""}`.trim());
      jsonResponse(res, 200, { ok: true, data: { restarting: true, startedAt: SERVER_STARTED_AT } });
      scheduleManualBackendRestart("manual");
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
      const profileId = decodeURIComponent(url.pathname.replace("/api/run/", ""));
      addRuntimeLog(`[${profileId}] gui lenh Run profile ${providerDisplayName(await readConfig())}`, "info", profileId);
      const data = await hideRequest(await readConfig(), `/profiles/start/${profileId}`, { method: "POST" });
      addRuntimeLog(`[${profileId}] Run profile thành công`, "success", profileId);
      return jsonResponse(res, 200, { ok: true, data });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/stop/")) {
      const profileId = decodeURIComponent(url.pathname.replace("/api/stop/", ""));
      addRuntimeLog(`[${profileId}] gui lenh Stop profile ${providerDisplayName(await readConfig())}`, "info", profileId);
      const data = await hideRequest(await readConfig(), `/profiles/stop/${profileId}`, { method: "POST" });
      addRuntimeLog(`[${profileId}] Stop profile thành công`, "success", profileId);
      return jsonResponse(res, 200, { ok: true, data });
    }
    return jsonResponse(res, 404, { ok: false, error: "API không tồn tại" });
  } catch (error) {
    return jsonResponse(res, 500, { ok: false, error: error.message });
  }
}

async function runBackgroundHideSheetSync() {
  return false;
}

function startBackgroundHideSheetSync() {
  backgroundSyncState.enabled = false;
  backgroundSyncState.isTicking = false;
  backgroundSyncState.lastError = "";
  if (backgroundSyncState.timer) {
    clearInterval(backgroundSyncState.timer);
    backgroundSyncState.timer = null;
  }
}

function startProxyMonitor() {
  if (proxyMonitorState.timer) clearInterval(proxyMonitorState.timer);
  proxyMonitorState.timer = setInterval(async () => {
    if (proxyMonitorState.isTicking) return;
    proxyMonitorState.isTicking = true;
    proxyMonitorState.lastCheckedAt = Date.now();
    try {
      const result = await nineProxyTool.maintain(await readConfig());
      if (result.changed?.length) {
        proxyMonitorState.lastChangedAt = Date.now();
        addRuntimeLog(`[9proxy] Tu dong doi ${result.changed.length} port do qua tuoi/offline/ping cao`, "warn", "", {
          tool: "gan proxy",
          step: "auto rotate"
        });
      }
      proxyMonitorState.lastError = "";
    } catch (error) {
      proxyMonitorState.lastError = String(error?.message || error || "");
    } finally {
      proxyMonitorState.isTicking = false;
    }
  }, 30000);
}

process.on("uncaughtException", (error) => {
  appendCrashLog("uncaughtException", error);
  addRuntimeLog(`[backend-crash] ${String(error?.message || error || "uncaughtException")}`, "error", "", {
    tool: "he thong",
    step: "backend crash"
  });
});

process.on("unhandledRejection", (reason) => {
  appendCrashLog("unhandledRejection", reason);
  addRuntimeLog(`[backend-crash] ${String(reason?.message || reason || "unhandledRejection")}`, "error", "", {
    tool: "he thong",
    step: "backend crash"
  });
});

process.on("SIGINT", () => {
  appendCrashLog("signal", "SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  appendCrashLog("signal", "SIGTERM");
  process.exit(0);
});

process.on("exit", (code) => {
  if (electronPopupWatchdogProcess) {
    try { electronPopupWatchdogProcess.kill(); } catch {}
  }
  if (proxyMonitorState.timer) {
    try { clearInterval(proxyMonitorState.timer); } catch {}
  }
  appendCrashLog("process.exit", `code=${code}`);
});

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(5188, "127.0.0.1", () => {
  console.log("Tool Full & Tương tác đang chạy tại http://127.0.0.1:5188");
  startElectronPopupWatchdog();
  startBackgroundHideSheetSync();
  startProxyMonitor();
});












































const state = {
  folders: [],
  profiles: [],
  duplicates: { duplicateUids: [], duplicateProfileIds: [], details: [] },
  selectedFolderId: "all",
  selectedIds: new Set(),
  selectedNotificationIds: new Set(),
  selectedCheckOrderIds: new Set(),
  selectedFullIds: new Set(),
  selectedPostIds: new Set(),
  selectedInteractionIds: new Set(),
  selectedPageIds: new Set(),
  selectedAvatarIds: new Set(),
  selectedPasswordIds: new Set(),
  selectedProxyIds: new Set(),
  notificationBatchIds: [],
  checkOrderBatchIds: [],
  linkOrderBatchIds: [],
  fullBatchIds: [],
  postBatchIds: [],
  interactionBatchIds: [],
  pageBatchIds: [],
  avatarBatchIds: [],
  passwordBatchIds: [],
  proxyStatus: null,
  stateProxyStatus: null,
  stateProxyStatusTimer: null,
  stateProxyApplyRunning: false,
  stateProxyCheckTimer: null,
  proxyStatusTimer: null,
  activeModule: "profiles",
  notificationSearchQuery: "",
  notificationBulkSearchQuery: "",
  notificationProgressFilter: "all",
  notificationResultFilter: "all",
  checkOrderSearchQuery: "",
  checkOrderBulkSearchQuery: "",
  fullSearchQuery: "",
  fullBulkSearchQuery: "",
  fullProgressFilter: "all",
  fullResultFilter: "all",
  postSearchQuery: "",
  postBulkSearchQuery: "",
  postProgressFilter: "all",
  postResultFilter: "all",
  interactionSearchQuery: "",
  interactionBulkSearchQuery: "",
  interactionProgressFilter: "all",
  interactionResultFilter: "all",
  pageSearchQuery: "",
  pageBulkSearchQuery: "",
  pageProgressFilter: "all",
  pageResultFilter: "all",
  avatarSearchQuery: "",
  avatarBulkSearchQuery: "",
  avatarProgressFilter: "all",
  avatarResultFilter: "all",
  passwordSearchQuery: "",
  passwordBulkSearchQuery: "",
  logs: [],
  logSearchQuery: "",
  logTypeFilter: "all",
  logToolFilter: "all",
  config: null,
  searchQuery: "",
  bulkSearchQuery: "",
  sortKey: "name",
  sortDir: "asc",
  lastSignature: "",
  lastAutoSyncAt: 0,
  toolStatusTimer: null,
  hideRefreshTimer: null,
  currentHideAccount: null,
  currentSpreadsheetId: "",
  isLoading: false,
  isSyncing: false
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  $("statusText").textContent = message;
  $("statusText").className = isError ? "error" : "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Có lỗi xảy ra");
  return data;
}

function currentEngineKey() {
  return String(state.config?.browserApiProvider || $("browserApiProvider")?.value || "gpm").trim().toLowerCase() === "hide" ? "hide" : "gpm";
}

function currentEngineLabel() {
  return currentEngineKey() === "hide" ? "HideMyAcc" : "GPM";
}

function updateEngineUi() {
  const key = currentEngineKey();
  const label = currentEngineLabel();
  if ($("browserApiProvider")) $("browserApiProvider").value = key;
  if ($("engineBadge")) $("engineBadge").textContent = label;
  if ($("engineLiveText")) $("engineLiveText").textContent = label;
  if ($("engineHeroText")) $("engineHeroText").textContent = label;
  if ($("refreshEngineText")) $("refreshEngineText").textContent = `Tải từ ${label}`;
  if ($("syncEngineText")) $("syncEngineText").textContent = `Cập nhật ${label} → Sheet`;
  if ($("profileEngineMenuLabel")) $("profileEngineMenuLabel").textContent = `${label} + Sheet`;
  if ($("proxyEngineMenuLabel")) $("proxyEngineMenuLabel").textContent = `9Proxy + ${label}`;
  if ($("engineSwitchGpm")) $("engineSwitchGpm").classList.toggle("active", key === "gpm");
  if ($("engineSwitchHide")) $("engineSwitchHide").classList.toggle("active", key === "hide");
  document.body.dataset.engine = key;
}
async function switchEngine(engine) {
  const nextEngine = String(engine || "").toLowerCase() === "hide" ? "hide" : "gpm";
  if (!state.config) state.config = {};
  if (currentEngineKey() === nextEngine) {
    updateEngineUi();
    return;
  }
  state.config = { ...state.config, browserApiProvider: nextEngine };
  if ($("browserApiProvider")) $("browserApiProvider").value = nextEngine;
  state.currentHideAccount = null;
  state.currentSpreadsheetId = "";
  state.folders = [];
  state.profiles = [];
  state.lastSignature = "";
  updateEngineUi();
  renderSpreadsheetList();
  setStatus(`Đang chuyển sang ${currentEngineLabel()}...`);
  await saveConfig();
  await refreshHide({ silent: false });
}
async function loadConfig() {
  const { config } = await api("/api/config");
  state.config = config;
  renderSpreadsheetList();
  if ($("browserApiProvider")) $("browserApiProvider").value = String(config.browserApiProvider || "gpm") === "hide" ? "hide" : "gpm";
  $("gpmBaseUrl").value = config.gpmBaseUrl || "http://127.0.0.1:9495/api/v1";
  if ($("hideBaseUrl")) $("hideBaseUrl").value = config.hideBaseUrl || "http://127.0.0.1:2268";
  updateEngineUi();
  $("credentialsPath").value = config.credentialsPath || "";
  if ($("credentialSourceSpreadsheetId")) $("credentialSourceSpreadsheetId").value = config.credentialSourceSpreadsheetId || "";
  $("sellerSpreadsheetId").value = config.sellerSpreadsheetId || "";
  $("fullDataRoot").value = config.fullDataRoot || "E:\\dangbai";
  $("fullPriceMin").value = config.fullPriceMin || "";
  $("fullPriceMax").value = config.fullPriceMax || "";
  if ($("postSellerSpreadsheetId")) $("postSellerSpreadsheetId").value = config.sellerSpreadsheetId || "";
  if ($("postDataRoot")) $("postDataRoot").value = config.fullDataRoot || "E:\\dangbai";
  if ($("postPriceMin")) $("postPriceMin").value = config.fullPriceMin || "";
  if ($("postPriceMax")) $("postPriceMax").value = config.fullPriceMax || "";
  if ($("checkConcurrency")) $("checkConcurrency").value = config.checkConcurrency || 4;
  if ($("checkOrderSpreadsheetId")) $("checkOrderSpreadsheetId").value = config.checkOrderSpreadsheetId || "";
  if ($("checkOrderSheetName")) $("checkOrderSheetName").value = config.checkOrderSheetName || "check order";
  if ($("checkOrderConcurrency")) $("checkOrderConcurrency").value = config.checkOrderConcurrency || 1;
  if ($("marketplaceCheckSpreadsheetId")) $("marketplaceCheckSpreadsheetId").value = config.marketplaceCheckSpreadsheetId || "";
  if ($("marketplaceCheckSheetName")) $("marketplaceCheckSheetName").value = config.marketplaceCheckSheetName || "";
  if ($("marketplaceCheckNick1Id")) $("marketplaceCheckNick1Id").value = config.marketplaceCheckNick1Id || "";
  if ($("marketplaceCheckNick2Id")) $("marketplaceCheckNick2Id").value = config.marketplaceCheckNick2Id || "";
  if ($("marketplaceCheckTabsPerNick")) $("marketplaceCheckTabsPerNick").value = config.marketplaceCheckTabsPerNick || 5;
  if ($("marketplaceCheckTimeoutMs")) $("marketplaceCheckTimeoutMs").value = config.marketplaceCheckTimeoutMs || 90000;
  if ($("fullConcurrency")) $("fullConcurrency").value = config.fullConcurrency || 4;
  if ($("postConcurrency")) $("postConcurrency").value = config.postConcurrency || 4;
  if ($("interactionConcurrency")) $("interactionConcurrency").value = config.interactionConcurrency || 4;
  if ($("pageConcurrency")) $("pageConcurrency").value = config.pageConcurrency || 4;
  if ($("avatarConcurrency")) $("avatarConcurrency").value = Math.max(1, Math.min(2, Number(config.avatarConcurrency || 2)));
  if ($("avatarImagePath")) $("avatarImagePath").value = config.avatarImagePath || "";
  if ($("avatarReplaceExisting")) $("avatarReplaceExisting").checked = Boolean(config.avatarReplaceExisting);
  if ($("nineProxyBaseUrl")) $("nineProxyBaseUrl").value = config.nineProxyBaseUrl || "http://127.0.0.1:22999";
  if ($("nineProxyToken")) $("nineProxyToken").value = config.nineProxyToken || "";
  if ($("nineProxyHost")) $("nineProxyHost").value = config.nineProxyHost || "127.0.0.1";
  if ($("nineProxyPortStart")) $("nineProxyPortStart").value = config.nineProxyPortStart || 7000;
  if ($("nineProxyPortCount")) $("nineProxyPortCount").value = Math.max(1, Math.min(10, Number(config.nineProxyPortCount || 10)));
  if ($("nineProxyState")) $("nineProxyState").value = config.nineProxyState || "CA";
  if ($("nineProxyIsp")) $("nineProxyIsp").value = config.nineProxyIsp || "T-Mobile";
  if ($("nineProxyPingLimitMs")) $("nineProxyPingLimitMs").value = config.nineProxyPingLimitMs || 50;
  if ($("nineProxyMinGoodPorts")) $("nineProxyMinGoodPorts").value = config.nineProxyMinGoodPorts || 5;
  if ($("nineProxyMaxIpAgeMinutes")) $("nineProxyMaxIpAgeMinutes").value = config.nineProxyMaxIpAgeMinutes || 60;
  if ($("nineProxyPingUrl")) $("nineProxyPingUrl").value = config.nineProxyPingUrl || "http://api.ipify.org?format=json";
  if ($("stateProxyEnabled")) $("stateProxyEnabled").checked = Boolean(config.stateProxyEnabled);
  if ($("stateProxyProvider")) $("stateProxyProvider").value = config.stateProxyProvider === "proxypanel" ? "proxypanel" : "clipproxy";
  if ($("proxyPanelBaseUrl")) $("proxyPanelBaseUrl").value = config.proxyPanelBaseUrl || "https://proxypanel.io/api/v1";
  if ($("proxyPanelApiKey")) $("proxyPanelApiKey").value = config.proxyPanelApiKey || "";
  if ($("proxyPanelProxyId")) $("proxyPanelProxyId").value = config.proxyPanelProxyId || "";
  if ($("proxyPanelCarrier")) $("proxyPanelCarrier").value = config.proxyPanelCarrier === "verizon" ? "verizon" : "tmobile";
  if ($("proxyPanelProtocol")) $("proxyPanelProtocol").value = config.proxyPanelProtocol === "http" ? "http" : "socks5";
  if ($("proxyPanelStateOverride")) $("proxyPanelStateOverride").value = config.proxyPanelStateOverride || "";
  if ($("proxyPanelUsername")) $("proxyPanelUsername").value = config.proxyPanelUsername || "";
  if ($("proxyPanelPassword")) $("proxyPanelPassword").value = config.proxyPanelPassword || "";
  if ($("proxyPanelRotateCooldownSeconds")) $("proxyPanelRotateCooldownSeconds").value = config.proxyPanelRotateCooldownSeconds ?? 60;
  if ($("clipProxyKey")) $("clipProxyKey").value = config.clipProxyKey || "";
  if ($("clipProxyPort")) $("clipProxyPort").value = config.clipProxyPort || 443;
  if ($("clipProxyCountry")) $("clipProxyCountry").value = config.clipProxyCountry || "US";
  if ($("clipProxyMaxUse")) $("clipProxyMaxUse").value = config.clipProxyMaxUse || 10;
  if ($("clipProxyPoolSize")) $("clipProxyPoolSize").value = config.clipProxyPoolSize || 5;
  if ($("clipProxyMaxAgeMinutes")) $("clipProxyMaxAgeMinutes").value = config.clipProxyMaxAgeMinutes || 60;
  if ($("clipProxyGoodPingMs")) $("clipProxyGoodPingMs").value = config.clipProxyGoodPingMs || 1500;
  if ($("clipProxyPingLimitMs")) $("clipProxyPingLimitMs").value = config.clipProxyPingLimitMs || 3000;
  if ($("clipProxySlowCooldownMinutes")) $("clipProxySlowCooldownMinutes").value = config.clipProxySlowCooldownMinutes || 10;
  if ($("clipProxyReserveSize")) $("clipProxyReserveSize").value = config.clipProxyReserveSize ?? 2;
  renderStateProxyConfig(config);
  if ($("interactionHomeTimeMin")) $("interactionHomeTimeMin").value = config.interactionHomeTimeMin || 30;
  if ($("interactionHomeTimeMax")) $("interactionHomeTimeMax").value = config.interactionHomeTimeMax || 60;
  if ($("interactionReelsTotalMin")) $("interactionReelsTotalMin").value = config.interactionReelsTotalMin || 30;
  if ($("interactionReelsTotalMax")) $("interactionReelsTotalMax").value = config.interactionReelsTotalMax || 60;
  if ($("interactionClipViewMin")) $("interactionClipViewMin").value = config.interactionClipViewMin || 5;
  if ($("interactionClipViewMax")) $("interactionClipViewMax").value = config.interactionClipViewMax || 10;
  if ($("interactionMarketPostsMin")) $("interactionMarketPostsMin").value = config.interactionMarketPostsMin || 3;
  if ($("interactionMarketPostsMax")) $("interactionMarketPostsMax").value = config.interactionMarketPostsMax || 5;
  if ($("interactionEnableRandomOrder")) $("interactionEnableRandomOrder").checked = config.interactionEnableRandomOrder !== false;
  if ($("interactionHumanDelayMode")) $("interactionHumanDelayMode").checked = Boolean(config.interactionHumanDelayMode);
  if ($("interactionSlowScrollMode")) $("interactionSlowScrollMode").checked = Boolean(config.interactionSlowScrollMode);
  if ($("interactionEnableRenewListings")) $("interactionEnableRenewListings").checked = Boolean(config.interactionEnableRenewListings);
  if ($("interactionEnableMarkAsSold")) $("interactionEnableMarkAsSold").checked = Boolean(config.interactionEnableMarkAsSold);
  renderSpreadsheetList();
  $("trashSheetName").value = config.trashSheetName || "rác";
}

async function saveConfig() {
  const { config } = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      browserApiProvider: $("browserApiProvider")?.value || "gpm",
      gpmBaseUrl: $("gpmBaseUrl").value,
      hideBaseUrl: $("hideBaseUrl")?.value || "http://127.0.0.1:2268",
      spreadsheetIds: state.config?.spreadsheetIds || [],
      accountSheets: state.config?.accountSheets || {},
      credentialsPath: $("credentialsPath").value,
      credentialSourceSpreadsheetId: $("credentialSourceSpreadsheetId")?.value || "",
      sellerSpreadsheetId: $("sellerSpreadsheetId").value,
      fullDataRoot: $("fullDataRoot").value,
      fullPriceMin: $("fullPriceMin").value,
      fullPriceMax: $("fullPriceMax").value,
      checkConcurrency: Number($("checkConcurrency")?.value || 4),
      checkOrderSpreadsheetId: $("checkOrderSpreadsheetId")?.value || "",
      checkOrderSheetName: $("checkOrderSheetName")?.value || "check order",
      checkOrderConcurrency: Math.max(1, Math.min(4, Number($("checkOrderConcurrency")?.value || 1))),
      marketplaceCheckSpreadsheetId: $("marketplaceCheckSpreadsheetId")?.value || "",
      marketplaceCheckSheetName: $("marketplaceCheckSheetName")?.value || "",
      marketplaceCheckNick1Id: $("marketplaceCheckNick1Id")?.value || "",
      marketplaceCheckNick2Id: $("marketplaceCheckNick2Id")?.value || "",
      marketplaceCheckTabsPerNick: Math.max(1, Math.min(20, Number($("marketplaceCheckTabsPerNick")?.value || 5))),
      marketplaceCheckTimeoutMs: Math.max(30000, Math.min(240000, Number($("marketplaceCheckTimeoutMs")?.value || 90000))),
      fullConcurrency: Number($("fullConcurrency")?.value || 4),
      postConcurrency: Number($("postConcurrency")?.value || 4),
      interactionConcurrency: Math.max(1, Math.min(4, Number($("interactionConcurrency")?.value || 4))),
      pageConcurrency: Number($("pageConcurrency")?.value || 4),
      avatarConcurrency: Math.max(1, Math.min(2, Number($("avatarConcurrency")?.value || 2))),
      avatarImagePath: $("avatarImagePath")?.value || "",
      avatarReplaceExisting: Boolean($("avatarReplaceExisting")?.checked),
      ...readProxyConfigForm(),
      interactionHomeTimeMin: Number($("interactionHomeTimeMin")?.value || 30),
      interactionHomeTimeMax: Number($("interactionHomeTimeMax")?.value || 60),
      interactionReelsTotalMin: Number($("interactionReelsTotalMin")?.value || 30),
      interactionReelsTotalMax: Number($("interactionReelsTotalMax")?.value || 60),
      interactionClipViewMin: Number($("interactionClipViewMin")?.value || 5),
      interactionClipViewMax: Number($("interactionClipViewMax")?.value || 10),
      interactionMarketPostsMin: Number($("interactionMarketPostsMin")?.value || 3),
      interactionMarketPostsMax: Number($("interactionMarketPostsMax")?.value || 5),
      interactionEnableRandomOrder: Boolean($("interactionEnableRandomOrder")?.checked),
      interactionHumanDelayMode: Boolean($("interactionHumanDelayMode")?.checked),
      interactionSlowScrollMode: Boolean($("interactionSlowScrollMode")?.checked),
      interactionEnableRenewListings: Boolean($("interactionEnableRenewListings")?.checked),
      interactionEnableMarkAsSold: Boolean($("interactionEnableMarkAsSold")?.checked),
      trashSheetName: $("trashSheetName").value
    })
  });
  state.config = config;
  updateEngineUi();
  renderSpreadsheetList();
  setStatus("Đã lưu cấu hình.");
  if ($("fullStatusText")) $("fullStatusText").textContent = "Đã lưu cấu hình làm full.";
  if ($("interactionStatusText")) $("interactionStatusText").textContent = "Đã lưu cấu hình tương tác.";
  if ($("pageStatusText")) $("pageStatusText").textContent = "Đã lưu cấu hình tạo page.";
  if ($("avatarStatusText")) $("avatarStatusText").textContent = "Đã lưu cấu hình đổi avatar.";
}

async function savePostConfig() {
  if ($("sellerSpreadsheetId") && $("postSellerSpreadsheetId")) $("sellerSpreadsheetId").value = $("postSellerSpreadsheetId").value;
  if ($("fullDataRoot") && $("postDataRoot")) $("fullDataRoot").value = $("postDataRoot").value;
  if ($("fullPriceMin") && $("postPriceMin")) $("fullPriceMin").value = $("postPriceMin").value;
  if ($("fullPriceMax") && $("postPriceMax")) $("fullPriceMax").value = $("postPriceMax").value;
  await saveConfig();
  if ($("postStatusText")) $("postStatusText").textContent = "Đã lưu cấu hình đăng bài.";
}

function readProxyConfigForm() {
  return {
    nineProxyBaseUrl: $("nineProxyBaseUrl")?.value || "",
    nineProxyToken: $("nineProxyToken")?.value || "",
    nineProxyHost: $("nineProxyHost")?.value || "127.0.0.1",
    nineProxyPortStart: Number($("nineProxyPortStart")?.value || 7000),
    nineProxyPortCount: Math.max(1, Math.min(10, Number($("nineProxyPortCount")?.value || 10))),
    nineProxyState: $("nineProxyState")?.value || "CA",
    nineProxyIsp: $("nineProxyIsp")?.value || "T-Mobile",
    nineProxyPingLimitMs: Math.max(1, Number($("nineProxyPingLimitMs")?.value || 50)),
    nineProxyMinGoodPorts: Math.max(1, Math.min(10, Number($("nineProxyMinGoodPorts")?.value || 5))),
    nineProxyMaxIpAgeMinutes: Math.max(1, Number($("nineProxyMaxIpAgeMinutes")?.value || 60)),
    nineProxyPingUrl: $("nineProxyPingUrl")?.value || "http://api.ipify.org?format=json",
    stateProxyEnabled: Boolean($("stateProxyEnabled")?.checked),
    stateProxyProvider: $("stateProxyProvider")?.value === "proxypanel" ? "proxypanel" : "clipproxy",
    proxyPanelBaseUrl: $("proxyPanelBaseUrl")?.value || "https://proxypanel.io/api/v1",
    proxyPanelApiKey: $("proxyPanelApiKey")?.value || "",
    proxyPanelProxyId: $("proxyPanelProxyId")?.value || "",
    proxyPanelCarrier: $("proxyPanelCarrier")?.value === "verizon" ? "verizon" : "tmobile",
    proxyPanelStateOverride: $("proxyPanelStateOverride")?.value || "",
    proxyPanelProtocol: $("proxyPanelProtocol")?.value === "http" ? "http" : "socks5",
    proxyPanelUsername: $("proxyPanelUsername")?.value || "",
    proxyPanelPassword: $("proxyPanelPassword")?.value || "",
    proxyPanelRotateCooldownSeconds: Math.max(0, Math.min(600, Number($("proxyPanelRotateCooldownSeconds")?.value || 60))),
    clipProxyKey: $("clipProxyKey")?.value || "",
    clipProxyPort: Number($("clipProxyPort")?.value || 443),
    clipProxyCountry: $("clipProxyCountry")?.value || "US",
    clipProxyType: 2,
    clipProxyAsn: "",
    clipProxyAsns: normalizeClipProxyAsns(state.config?.clipProxyAsns),
    clipProxyFormat: "",
    clipProxyMaxUse: Math.max(1, Number($("clipProxyMaxUse")?.value || 10)),
    clipProxyPoolSize: Math.max(1, Math.min(50, Number($("clipProxyPoolSize")?.value || 5))),
    clipProxyMaxAgeMinutes: Math.max(1, Number($("clipProxyMaxAgeMinutes")?.value || 60)),
    clipProxyGoodPingMs: Math.max(100, Number($("clipProxyGoodPingMs")?.value || 1500)),
    clipProxyPingLimitMs: Math.max(100, Number($("clipProxyPingLimitMs")?.value || 3000)),
    clipProxySlowCooldownMinutes: Math.max(1, Math.min(240, Number($("clipProxySlowCooldownMinutes")?.value || 10))),
    clipProxyReserveSize: Math.max(0, Math.min(20, Number($("clipProxyReserveSize")?.value || 2))),
    stateProxyStates: state.config?.stateProxyStates || []
  };
}

function renderSpreadsheetList() {
  const list = $("spreadsheetList");
  if (!list) return;
  const ids = state.config?.spreadsheetIds || [];
  const accountSheets = state.config?.accountSheets || {};
  const usedBySheet = new Map();
  for (const [accountId, sheetId] of Object.entries(accountSheets)) {
    if (!usedBySheet.has(sheetId)) usedBySheet.set(sheetId, []);
    usedBySheet.get(sheetId).push(accountId);
  }
  if ($("currentSheetInfo")) {
    const accountText = state.currentHideAccount?.email || state.currentHideAccount?.id || `chưa đọc tài khoản ${currentEngineLabel()}`;
    $("currentSheetInfo").textContent = state.currentSpreadsheetId
      ? `${accountText} -> ${state.currentSpreadsheetId}`
      : accountText;
  }
  if (!ids.length) {
    list.innerHTML = `<div class="empty compact">Chưa có Spreadsheet ID. Thêm sheet mới để tool gắn riêng cho từng tài khoản ${currentEngineLabel()}.</div>`;
    return;
  }
  list.innerHTML = "";
  ids.forEach((id, index) => {
    const row = document.createElement("div");
    row.className = "sheet-id-row";
    const owners = usedBySheet.get(id) || [];
    const ownerLabel = owners.length
      ? owners.map((owner) => owner.startsWith("hide:") ? "HideMyAcc" : owner.startsWith("gpm:") ? "GPM" : "account").join(", ")
      : "chưa gắn";
    row.innerHTML = `
      <input class="sheet-id-input" data-index="${index}" value="${escapeAttr(id)}" />
      <span class="sheet-owner">${ownerLabel}</span>
      <button type="button" class="small-btn danger-btn sheet-delete" data-index="${index}">Xóa</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".sheet-id-input").forEach((input) => {
    input.addEventListener("change", () => updateSpreadsheetIdAt(Number(input.dataset.index), input.value));
  });
  list.querySelectorAll(".sheet-delete").forEach((button) => {
    button.addEventListener("click", () => deleteSpreadsheetIdAt(Number(button.dataset.index)));
  });
}

function updateSpreadsheetIdAt(index, value) {
  const ids = [...(state.config?.spreadsheetIds || [])];
  ids[index] = String(value || "").trim();
  const compact = ids.filter(Boolean);
  const seen = new Set();
  for (const id of compact) {
    if (seen.has(id)) {
      setStatus(`Spreadsheet ID bị trùng: ${id}`, true);
      renderSpreadsheetList();
      return;
    }
    seen.add(id);
  }
  state.config.spreadsheetIds = compact;
  renderSpreadsheetList();
}

function deleteSpreadsheetIdAt(index) {
  const ids = [...(state.config?.spreadsheetIds || [])];
  const [removed] = ids.splice(index, 1);
  state.config.spreadsheetIds = ids;
  const accountSheets = { ...(state.config?.accountSheets || {}) };
  for (const [accountId, sheetId] of Object.entries(accountSheets)) {
    if (sheetId === removed) delete accountSheets[accountId];
  }
  state.config.accountSheets = accountSheets;
  renderSpreadsheetList();
}

function addSpreadsheetId() {
  const input = $("newSpreadsheetId");
  const id = String(input?.value || "").trim();
  if (!id) return;
  const ids = [...(state.config?.spreadsheetIds || [])];
  if (ids.includes(id)) {
    setStatus(`Spreadsheet ID bị trùng: ${id}`, true);
    return;
  }
  ids.push(id);
  state.config.spreadsheetIds = ids;
  input.value = "";
  renderSpreadsheetList();
}

function renderFolders() {
  $("folderCount").textContent = state.folders.length;
  const counts = new Map();
  for (const profile of state.profiles) {
    counts.set(profile.folderId, (counts.get(profile.folderId) || 0) + 1);
  }

  const list = $("folderList");
  list.innerHTML = "";
  list.appendChild(createFolderItem("all", "Tất cả", state.profiles.length));

  for (const folder of state.folders) {
    list.appendChild(createFolderItem(folder.id, folder.name, counts.get(folder.id) || 0));
  }
}

function createFolderItem(id, name, count) {
  const item = document.createElement("div");
  item.className = `folder-item ${state.selectedFolderId === id ? "active" : ""}`;
  item.innerHTML = `<span>${escapeHtml(name)}</span><span class="chip">${count}</span>`;
  item.onclick = () => {
    state.selectedFolderId = id;
    render();
  };
  return item;
}

function parseBulkTerms(text) {
  return String(text || "")
    .split(/\r?\n|,|;/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function profileHaystack(profile, extra = []) {
  return [
    profile.name,
    profile.id,
    profile.uid,
    profile.folderName,
    profile.sheetData?.Tool,
    sheetValue(profile, "trạng thái", "trang thai"),
    sheetValue(profile, "số vạch", "so vach"),
    sheetValue(profile, "chi tiết", "chi tiet"),
    ...extra
  ].join(" ").toLowerCase();
}

function matchesProfileFilters(profile, query, bulkQuery, extra = []) {
  const haystack = profileHaystack(profile, extra);
  const terms = parseBulkTerms([query, bulkQuery].filter(Boolean).join("\n"));
  if (!terms.length) return true;
  return terms.some((term) => haystack.includes(term));
}

function updateSelectionSummary(summaryId, buttonId, selectedCount) {
  const summary = $(summaryId);
  if (summary) {
    summary.textContent = `Đang chọn ${selectedCount} con.`;
  }
  const button = $(buttonId);
  if (button) {
    button.textContent = selectedCount > 0 ? `Bỏ chọn (${selectedCount})` : "Bỏ chọn";
  }
}

function primeToolProgress(profileIds, liveStatus, batchKey = "generic") {
  if (batchKey === "notifications") state.notificationBatchIds = [...(profileIds || [])];
  if (batchKey === "full") state.fullBatchIds = [...(profileIds || [])];
  if (batchKey === "post") state.postBatchIds = [...(profileIds || [])];
  if (batchKey === "interaction") state.interactionBatchIds = [...(profileIds || [])];
  if (batchKey === "pages") state.pageBatchIds = [...(profileIds || [])];
  if (batchKey === "avatar") state.avatarBatchIds = [...(profileIds || [])];
  if (batchKey === "passwords") state.passwordBatchIds = [...(profileIds || [])];
  const jobs = (profileIds || []).map((profileId, index) => ({
    profileId,
    status: index === 0 ? "running" : "queued",
    liveStatus: index === 0 ? liveStatus : "đã xếp hàng chờ chạy"
  }));
  renderToolProgress({
    running: jobs.length > 0,
    jobs,
    logs: state.logs || []
  });
}

function visibleProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);

  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.searchQuery, state.bulkSearchQuery));

  profiles.sort((a, b) => compareProfiles(a, b));
  return profiles;
}

function compareProfiles(a, b) {
  const dir = state.sortDir === "desc" ? -1 : 1;
  const av = sortValue(a, state.sortKey);
  const bv = sortValue(b, state.sortKey);
  return av.localeCompare(bv, "vi", { numeric: true, sensitivity: "base" }) * dir;
}

function sortValue(profile, key) {
  if (key === "uid") return profile.uid || "";
  if (key === "folderName") return profile.folderName || "";
  if (key === "tool") return profile.sheetData?.Tool || "";
  if (key === "sheetStatus") return sheetValue(profile, "trạng thái", "trang thai") || "";
  return profile.name || "";
}

function renderRows() {
  const rows = $("profileRows");
  const profiles = visibleProfiles();
  $("statVisible").textContent = profiles.length;
  $("statSelected").textContent = state.selectedIds.size;
  updateSelectionSummary("profileSelectionSummary", "clearSelectionBtn", state.selectedIds.size);

  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="10" class="empty">Không có profile phù hợp.</td></tr>`;
    updateSelectAllState();
    return;
  }

  rows.innerHTML = "";
  const duplicateIds = new Set(state.duplicates.duplicateProfileIds || []);
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    if (duplicateIds.has(profile.id)) tr.classList.add("duplicate-row");
    const action = profile.isRunning ? "Stop" : "Run";
    tr.innerHTML = `
      <td><input class="row-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedIds.has(profile.id) ? "checked" : ""} /></td>
      <td><button class="run-btn ${profile.isRunning ? "stop-btn" : ""}" data-id="${escapeAttr(profile.id)}" data-action="${action.toLowerCase()}">${action}</button></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(sheetValue(profile, "trạng thái", "trang thai"))}</td>
      <td>${escapeHtml(sheetValue(profile, "số vạch", "so vach"))}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }

  rows.querySelectorAll(".run-btn").forEach((button) => {
    button.addEventListener("click", () => toggleProfile(button.dataset.id, button.dataset.action, button));
  });
  rows.querySelectorAll(".row-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedIds.add(checkbox.dataset.id);
      else state.selectedIds.delete(checkbox.dataset.id);
      $("statSelected").textContent = state.selectedIds.size;
      updateSelectAllState();
    });
  });
  updateSelectAllState();
}

function renderActiveModule() {
  if (state.activeModule === "profiles") renderRows();
  if (state.activeModule === "notifications") renderNotificationRows();
  if (state.activeModule === "checkorder") renderCheckOrderRows();
  if (state.activeModule === "full") renderFullRows();
  if (state.activeModule === "post") renderPostRows();
  if (state.activeModule === "interaction") renderInteractionRows();
  if (state.activeModule === "pages") renderPageRows();
  if (state.activeModule === "avatar") renderAvatarRows();
  if (state.activeModule === "passwords") renderPasswordRows();
  if (state.activeModule === "proxy") renderProxyRows();
}

function render() {
  $("statFolders").textContent = state.folders.length;
  $("statProfiles").textContent = state.profiles.length;
  $("statDuplicate").textContent = state.duplicates.duplicateUids?.length || 0;
  renderFolders();
  renderDuplicateStats();
  renderActiveModule();
}

function passwordProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  profiles = profiles.filter((profile) =>
    matchesProfileFilters(profile, state.passwordSearchQuery, state.passwordBulkSearchQuery, [
      sheetValue(profile, "mật khẩu", "mat khau"),
      sheetValue(profile, "2fa"),
      sheetValue(profile, "cookie")
    ])
  );
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function passwordMissing(profile) {
  return !String(sheetValue(profile, "mật khẩu", "mat khau") || "").trim();
}

function proxyProfiles() {
  const profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}p`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}p`;
}

function renderProxyStatus() {
  const data = state.proxyStatus;
  if (!data) return;
  if ($("proxyGoodCount")) $("proxyGoodCount").textContent = data.goodCount || 0;
  if ($("proxyPortTotal")) $("proxyPortTotal").textContent = data.ports?.length || 0;
  if ($("proxyWarningText")) {
    $("proxyWarningText").textContent = data.warning || "Proxy pool đang đạt điều kiện.";
    $("proxyWarningText").className = data.warning ? "error" : "";
  }
  const rows = $("proxyPortRows");
  if (!rows) return;
  rows.innerHTML = "";
  for (const port of data.ports || []) {
    const tr = document.createElement("tr");
    tr.className = port.healthy ? "" : "warning-row";
    tr.innerHTML = `
      <td>${escapeHtml(String(port.port))}</td>
      <td>${escapeHtml(port.ip || "-")}</td>
      <td>${port.online === null ? "-" : port.online ? "online" : "offline"}</td>
      <td>${port.pingMs === null || port.pingMs === undefined ? "-" : `${port.pingMs}ms`}</td>
      <td>${formatAge(port.ageSeconds)}</td>
      <td>${escapeHtml(port.lastProfileId || "-")}</td>
      <td>${escapeHtml(port.lastError || "")}</td>
    `;
    rows.appendChild(tr);
  }
}

function updateStateProxyMetrics(config = state.config || {}) {
  const states = config.stateProxyStates || [];
  const proxies = state.stateProxyStatus?.proxies || [];
  const inUse = proxies.filter((proxy) => proxy.inUse).length;
  if ($("stateProxyStateCount")) $("stateProxyStateCount").textContent = states.length;
  if ($("stateProxyPoolCount")) $("stateProxyPoolCount").textContent = proxies.length;
  if ($("stateProxyInUseCount")) $("stateProxyInUseCount").textContent = inUse;
}

function normalizeClipProxyAsn(value) {
  const text = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!text) return "";
  const digits = text.replace(/^AS/, "");
  return /^\d+$/.test(digits) ? `AS${digits}` : "";
}

function normalizeClipProxyAsns(input) {
  const source = Array.isArray(input) ? input : String(input || "").split(/[\n,;]+/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const asn = normalizeClipProxyAsn(item);
    if (!asn || seen.has(asn)) continue;
    seen.add(asn);
    result.push(asn);
  }
  return result.length ? result : ["AS21928", "AS22773", "AS11351", "AS7922", "AS5650"];
}

function renderStateProxyConfig(config = state.config || {}) {
  const enabled = Boolean(config.stateProxyEnabled);
  const provider = config.stateProxyProvider === "proxypanel" ? "proxypanel" : "clipproxy";
  if ($("stateProxyPanel")) $("stateProxyPanel").classList.toggle("enabled", enabled);
  if ($("stateProxyProvider")) $("stateProxyProvider").value = provider;
  document.querySelectorAll(".proxypanel-field").forEach((el) => {
    el.style.display = provider === "proxypanel" ? "" : "none";
  });
  [
    "clipProxyKey",
    "clipProxyPort",
    "clipProxyCountry",
    "clipProxyAsnList",
    "newClipProxyAsn",
    "clipProxyMaxUse",
    "clipProxyPoolSize",
    "clipProxyGoodPingMs",
    "clipProxyPingLimitMs",
    "clipProxySlowCooldownMinutes",
    "clipProxyReserveSize"
  ].forEach((id) => {
    const label = $(id)?.closest("label");
    if (label) label.style.display = provider === "clipproxy" ? "" : "none";
  });
  if ($("stateProxySummary")) {
    const overrideState = String(config.proxyPanelStateOverride || "").trim();
    $("stateProxySummary").textContent = enabled
      ? provider === "proxypanel"
        ? overrideState
          ? `Bật ProxyPanel - ép tất cả profile chạy bang ${overrideState}, mỗi profile fresh IP`
          : "Bật ProxyPanel - lấy bang theo Sheet, đúng bang/nhà mạng rồi mới mở profile"
        : "Bật ClipProxy - mỗi profile lấy proxy theo cột bang trước khi mở browser"
      : "Tắt - tool chạy theo proxy hiện có của profile";
  }
  const asnList = $("clipProxyAsnList");
  if (asnList) {
    const asns = normalizeClipProxyAsns(config.clipProxyAsns || config.clipProxyAsn);
    asnList.innerHTML = asns.map((asn, index) => `
      <span class="state-chip editable-chip">
        <span>${escapeHtml(asn)}${asn === "AS21928" ? " ưu tiên" : ""}</span>
        <button type="button" data-action="edit-clip-asn" data-index="${index}">Sửa</button>
        <button type="button" data-action="delete-clip-asn" data-index="${index}">Xóa</button>
      </span>
    `).join("");
  }
  const list = $("stateProxyStateList");
  if (list) {
    const states = config.stateProxyStates || [];
    list.innerHTML = states.length
      ? states.map((item) => `<span class="state-chip">${escapeHtml(item)}</span>`).join("")
      : `<span class="muted">Chưa có bang.</span>`;
  }
  updateStateProxyMetrics(config);
  renderStateProxyStatus(config);
}

function renderStateProxyStatus(config = state.config || {}) {
  const data = state.stateProxyStatus;
  const pool = $("stateProxyPool");
  updateStateProxyMetrics(config);
  if (!pool) return;
  const proxies = data?.proxies || [];
  if (!proxies.length) {
    pool.innerHTML = `<div class="muted">Chưa có proxy trong pool. Tool sẽ lấy proxy khi chạy tới profile; Check ping chỉ kiểm tra proxy đã có.</div>`;
    return;
  }
  pool.innerHTML = proxies.map((proxy) => {
    const progress = proxy.progress || null;
    const isWorking = Boolean(progress && (progress.message || progress.secondsLeft));
    const hasProxyError = !isWorking && (proxy.alive === false || Boolean(proxy.lastError));
    const quality = hasProxyError ? "bad" : proxy.cooling ? "cold" : proxy.pingQuality || "good";
    const progressText = progress
      ? `${progress.message || "Đang áp dụng"}${progress.secondsLeft ? ` · còn ${progress.secondsLeft}s` : ""}`
      : "";
    const qualityText = isWorking ? "đang đổi" : hasProxyError ? "lỗi" : proxy.inUse ? "đang dùng" : quality === "cold" ? `nghỉ ${Math.ceil((proxy.coldSeconds || 0) / 60)}p` : quality === "warm" ? "ấm" : quality === "slow" ? "chậm" : "tốt";
    const useText = proxy.maxUse
      ? `lượt ${proxy.usageCount || 0}/${proxy.maxUse}`
      : `lượt ${proxy.usageCount || 0}`;
    return `
    <div class="proxy-mini-row ${quality === "bad" ? "bad" : isWorking || proxy.inUse ? "active" : quality === "cold" ? "cold" : quality === "warm" ? "warm" : ""}">
      <div class="proxy-mini-head">
        <strong>${escapeHtml(proxy.state)}</strong>
        <span>${qualityText} · ${proxy.ipinfoPingMs === null || proxy.ipinfoPingMs === undefined ? (proxy.pingMs === null || proxy.pingMs === undefined ? "-" : `tcp ${proxy.pingMs}ms`) : `${proxy.ipinfoPingMs}ms`}</span>
      </div>
      <code>${escapeHtml(proxy.raw || `${proxy.host}:${proxy.port}`)}</code>
      <div class="proxy-mini-meta">
        <span>IP: ${escapeHtml(proxy.exitIp || "-")}${proxy.ipinfoSource ? ` (${escapeHtml(proxy.ipinfoSource)})` : ""}</span>
        <span>TCP: ${proxy.pingMs === null || proxy.pingMs === undefined ? "-" : `${proxy.pingMs}ms`}</span>
        <span>Region: ${escapeHtml(proxy.region || "-")}</span>
        <span>Org: ${escapeHtml(proxy.org || "-")}</span>
      </div>
      ${(progressText || proxy.cooling || !proxy.exitIp || proxy.lastError) ? `<small class="proxy-mini-error">${escapeHtml(progressText || proxy.coldReason || proxy.lastError || "chưa có dữ liệu ipinfo, bấm Check ping sau khi reset backend")}</small>` : ""}
      <div class="proxy-mini-foot">
        <span>${proxy.inUse ? `đang dùng ${escapeHtml(proxy.assignedProfileId || "")}` : useText}</span>
        <span>${escapeHtml(proxy.lastError || formatAge(proxy.ageSeconds))}</span>
      </div>
    </div>
  `;
  }).join("");
}

function toggleStateProxyPanel() {
  const panel = $("stateProxyPanel");
  if (!panel) return;
  const collapsed = panel.classList.toggle("collapsed");
  if ($("toggleStateProxyPanelBtn")) {
    $("toggleStateProxyPanelBtn").textContent = collapsed ? "Mở rộng" : "Thu gọn";
  }
}

async function refreshStateProxyStatus() {
  try {
    const { data } = await api("/api/state-proxy/status");
    state.stateProxyStatus = data;
    renderStateProxyConfig(data.config || state.config || {});
  } catch (error) {
    if ($("stateProxySummary")) $("stateProxySummary").textContent = error.message;
  }
}

async function saveStateProxyConfig() {
  const { config, data } = await api("/api/state-proxy/save", {
    method: "POST",
    body: JSON.stringify(readProxyConfigForm())
  });
  state.config = config;
  state.stateProxyStatus = data;
  renderStateProxyConfig(config);
  setStatus("Đã lưu proxy theo bang.");
}

async function addStateProxyState() {
  const input = $("newStateProxyState");
  const value = String(input?.value || "").trim();
  if (!value) return;
  const { config, data } = await api("/api/state-proxy/add-state", {
    method: "POST",
    body: JSON.stringify({ ...readProxyConfigForm(), state: value })
  });
  if (input) input.value = "";
  state.config = config;
  state.stateProxyStatus = data;
  renderStateProxyConfig(config);
}

async function saveClipProxyAsns(asns) {
  state.config = { ...(state.config || {}), clipProxyAsns: normalizeClipProxyAsns(asns), clipProxyAsn: "" };
  await saveStateProxyConfig();
}

async function addClipProxyAsn() {
  const input = $("newClipProxyAsn");
  const asn = normalizeClipProxyAsn(input?.value);
  if (!asn) return;
  const asns = normalizeClipProxyAsns(state.config?.clipProxyAsns);
  if (!asns.includes(asn)) asns.push(asn);
  if (input) input.value = "";
  await saveClipProxyAsns(asns);
}

async function editClipProxyAsn(index) {
  const asns = normalizeClipProxyAsns(state.config?.clipProxyAsns);
  const current = asns[index] || "";
  const next = normalizeClipProxyAsn(prompt("Sửa ASN ClipProxy", current));
  if (!next) return;
  asns[index] = next;
  await saveClipProxyAsns(asns);
}

async function deleteClipProxyAsn(index) {
  const asns = normalizeClipProxyAsns(state.config?.clipProxyAsns);
  asns.splice(index, 1);
  await saveClipProxyAsns(asns);
}

async function checkStateProxyPool(options = {}) {
  if (state.stateProxyCheckRunning) return;
  state.stateProxyCheckRunning = true;
  try {
    if ($("stateProxySummary") && !options.silent) $("stateProxySummary").textContent = "Đang check ping các proxy đã có...";
    const { data } = await api("/api/state-proxy/check", {
      method: "POST",
      body: JSON.stringify(readProxyConfigForm())
    });
    state.stateProxyStatus = data.status;
    renderStateProxyConfig(data.status?.config || state.config || {});
    const proxyCount = Array.isArray(data.status?.proxies) ? data.status.proxies.length : 0;
    const checkedAttempts = Number(data.checkedAttempts || data.checked || 0);
    const removed = Number(data.removed || 0);
    const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
    if ($("stateProxySummary")) {
      $("stateProxySummary").textContent = removed
        ? `Đã check ${checkedAttempts} proxy, xóa ${removed} proxy chết, còn ${proxyCount}.`
        : errorCount
          ? `Đã check ${checkedAttempts} proxy, còn ${proxyCount}, ${errorCount} lỗi.`
          : `Đã check ${proxyCount} proxy đã có.`;
    }
  } finally {
    state.stateProxyCheckRunning = false;
  }
}

async function applyStateProxyNow() {
  if (state.stateProxyApplyRunning) return;
  state.stateProxyApplyRunning = true;
  const button = $("applyStateProxyBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Đang áp dụng...";
  }
  const applyRefreshTimer = setInterval(() => {
    refreshStateProxyStatus().catch(() => {});
  }, 2500);
  const currentProxy = state.stateProxyStatus?.proxies?.[0] || {};
  const wantedState = String($("proxyPanelStateOverride")?.value || currentProxy.state || $("newStateProxyState")?.value || state.config?.stateProxyStates?.[0] || "").trim();
  if ($("stateProxySummary")) $("stateProxySummary").textContent = "Đang áp dụng ProxyPanel theo bang/nhà mạng đã chọn...";
  try {
    const { config, data } = await api("/api/state-proxy/apply", {
      method: "POST",
      body: JSON.stringify({ ...readProxyConfigForm(), state: wantedState })
    });
    state.config = config;
    state.stateProxyStatus = data.status;
    renderStateProxyConfig(data.status?.config || config);
    await refreshStateProxyStatus();
    const proxy = state.stateProxyStatus?.proxies?.[0] || data.status?.proxies?.[0] || {};
    if ($("stateProxySummary")) {
      $("stateProxySummary").textContent = proxy.exitIp
        ? `Đã áp dụng ${proxy.region || wantedState}: ${proxy.exitIp} · ${proxy.org || ""}`
        : "Đã áp dụng ProxyPanel.";
    }
  } finally {
    clearInterval(applyRefreshTimer);
    state.stateProxyApplyRunning = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Áp dụng ngay";
    }
  }
}

function scheduleStateProxyRealtime() {
  if (state.stateProxyStatusTimer) clearInterval(state.stateProxyStatusTimer);
  if (state.stateProxyCheckTimer) clearInterval(state.stateProxyCheckTimer);
  state.stateProxyStatusTimer = setInterval(() => {
    refreshStateProxyStatus().catch((error) => {
      if ($("stateProxySummary")) $("stateProxySummary").textContent = error.message;
    });
  }, 3000);
  state.stateProxyCheckTimer = setInterval(() => {
    if (!$('stateProxyEnabled')?.checked) return;
    checkStateProxyPool({ silent: true }).catch((error) => {
      if ($("stateProxySummary")) $("stateProxySummary").textContent = error.message;
    });
  }, 10000);
}

function renderProxyRows() {
  if (!$("proxyRows")) return;
  const profiles = proxyProfiles();
  $("proxyTotal").textContent = profiles.length;
  $("proxySelected").textContent = state.selectedProxyIds.size;
  updateSelectionSummary("proxySelectionSummary", "clearProxySelectionBtn", state.selectedProxyIds.size);
  const rows = $("proxyRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="6" class="empty">Không có profile phù hợp.</td></tr>`;
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="proxy-row-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedProxyIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td>${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(sheetValue(profile, "bang") || sheetValue(profile, "proxy") || "")}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".proxy-row-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedProxyIds.add(checkbox.dataset.id);
      else state.selectedProxyIds.delete(checkbox.dataset.id);
      renderProxyRows();
    });
  });
  const selectAll = $("selectAllProxyRows");
  if (selectAll) {
    const selectedCount = profiles.filter((profile) => state.selectedProxyIds.has(profile.id)).length;
    selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
  }
  renderProxyStatus();
}

async function refreshProxyStatus() {
  try {
    const { data } = await api("/api/proxy-tool/status");
    state.proxyStatus = data;
    renderProxyStatus();
  } catch (error) {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = error.message;
  }
}

async function checkProxyPorts() {
  try {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = "Đang check online/ping các port...";
    const { data } = await api("/api/proxy-tool/check", {
      method: "POST",
      body: JSON.stringify(readProxyConfigForm())
    });
    state.proxyStatus = data;
    renderProxyStatus();
    if ($("proxyStatusText")) $("proxyStatusText").textContent = "Đã check xong proxy pool.";
  } catch (error) {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = error.message;
  }
}

async function prepareProxyPorts() {
  try {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = "Đang lấy IP mới cho proxy pool...";
    const { data } = await api("/api/proxy-tool/prepare", {
      method: "POST",
      body: JSON.stringify({
        ...readProxyConfigForm(),
        count: Number($("nineProxyPortCount")?.value || 10)
      })
    });
    state.proxyStatus = data.status;
    renderProxyStatus();
    if ($("proxyStatusText")) $("proxyStatusText").textContent = `Đã chuẩn bị ${data.slots?.length || 0} port.`;
  } catch (error) {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = error.message;
  }
}

async function assignProxyToSelected() {
  const profileIds = [...state.selectedProxyIds];
  if (!profileIds.length) {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = "Chưa chọn profile để gán proxy.";
    return;
  }
  try {
    $("assignProxyBtn").disabled = true;
    if ($("proxyStatusText")) $("proxyStatusText").textContent = `Đang gán proxy cho ${profileIds.length} profile...`;
    const { data } = await api("/api/proxy-tool/assign", {
      method: "POST",
      body: JSON.stringify({
        ...readProxyConfigForm(),
        profileIds
      })
    });
    state.proxyStatus = data.status;
    renderProxyStatus();
    if ($("proxyStatusText")) $("proxyStatusText").textContent = [
      `Đã gán proxy cho ${data.assigned} profile.`,
      ...(data.warnings || [])
    ].join(" ");
    await refreshHide({ silent: true });
  } catch (error) {
    if ($("proxyStatusText")) $("proxyStatusText").textContent = error.message;
  } finally {
    $("assignProxyBtn").disabled = false;
  }
}

function renderPasswordRows() {
  if (!$("passwordRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const profiles = passwordProfiles();
  $("passwordTotal").textContent = all.length;
  $("passwordBlank").textContent = all.filter((profile) => passwordMissing(profile)).length;
  $("passwordFilled").textContent = all.filter((profile) => !passwordMissing(profile)).length;
  $("passwordVisible").textContent = profiles.length;
  updateSelectionSummary("passwordSelectionSummary", "clearPasswordSelectionBtn", state.selectedPasswordIds.size);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder hiện tại";
  $("passwordStatusText").textContent = `Đang xem ${folderName}. Tool chỉ điền dòng đang trống mật khẩu.`;
  const rows = $("passwordRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">Không có profile phù hợp.</td></tr>`;
    updatePasswordSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="password-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedPasswordIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(sheetValue(profile, "mật khẩu", "mat khau"))}</td>
      <td>${escapeHtml(sheetValue(profile, "2fa"))}</td>
      <td>${escapeHtml(sheetValue(profile, "cookie"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".password-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPasswordIds.add(checkbox.dataset.id);
      else state.selectedPasswordIds.delete(checkbox.dataset.id);
      updatePasswordSelectAllState();
    });
  });
  updatePasswordSelectAllState();
}

function updatePasswordSelectAllState() {
  const selectAll = $("selectAllPasswordRows");
  if (!selectAll) return;
  const profiles = passwordProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedPasswordIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startFillPasswords(profileIds) {
  if (!profileIds.length) {
    $("passwordStatusText").textContent = "Bạn cần chọn ít nhất một profile để điền dữ liệu.";
    return;
  }
  try {
    $("runPasswordSelectedBtn").disabled = true;
    $("runPasswordFolderBtn").disabled = true;
    $("runPasswordTodoBtn").disabled = true;
    await saveConfig();
    const { data } = await api("/api/tools/dien-mat-khau", {
      method: "POST",
      body: JSON.stringify({
        profileIds,
        sourceSpreadsheetId: $("credentialSourceSpreadsheetId")?.value || ""
      })
    });
    primeToolProgress(profileIds, "bắt đầu: đối chiếu UID", "passwords");
    $("passwordStatusText").textContent = `Đã bắt đầu điền dữ liệu ${data.started} profile từ sheet nguồn ${data.sourceSheetTitle || ""}.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("passwordStatusText").textContent = error.message;
  } finally {
    $("runPasswordSelectedBtn").disabled = false;
    $("runPasswordFolderBtn").disabled = false;
    $("runPasswordTodoBtn").disabled = false;
  }
}

function setActiveModule(moduleName) {
  state.activeModule = moduleName;
  document.querySelectorAll(".module-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.module === moduleName);
  });
  $("profileModule").classList.toggle("hidden", moduleName !== "profiles");
  $("notificationModule").classList.toggle("hidden", moduleName !== "notifications");
  $("checkOrderModule").classList.toggle("hidden", moduleName !== "checkorder");
  $("linkOrderModule")?.classList.toggle("hidden", moduleName !== "linkorder");
  $("fullModule").classList.toggle("hidden", moduleName !== "full");
  $("postModule").classList.toggle("hidden", moduleName !== "post");
  $("interactionModule").classList.toggle("hidden", moduleName !== "interaction");
  $("pageModule").classList.toggle("hidden", moduleName !== "pages");
  $("avatarModule").classList.toggle("hidden", moduleName !== "avatar");
  $("passwordModule").classList.toggle("hidden", moduleName !== "passwords");
  $("proxyModule").classList.toggle("hidden", moduleName !== "proxy");
  $("logsModule").classList.toggle("hidden", moduleName !== "logs");
  $("profileModule").classList.toggle("active", moduleName === "profiles");
  $("notificationModule").classList.toggle("active", moduleName === "notifications");
  $("checkOrderModule").classList.toggle("active", moduleName === "checkorder");
  $("linkOrderModule")?.classList.toggle("active", moduleName === "linkorder");
  $("fullModule").classList.toggle("active", moduleName === "full");
  $("postModule").classList.toggle("active", moduleName === "post");
  $("interactionModule").classList.toggle("active", moduleName === "interaction");
  $("pageModule").classList.toggle("active", moduleName === "pages");
  $("avatarModule").classList.toggle("active", moduleName === "avatar");
  $("passwordModule").classList.toggle("active", moduleName === "passwords");
  $("proxyModule").classList.toggle("active", moduleName === "proxy");
  $("logsModule").classList.toggle("active", moduleName === "logs");
  render();
  if (moduleName === "proxy") refreshProxyStatus();
  if (moduleName === "logs") refreshToolStatus();
}

function updateSelectAllState() {
  const selectAll = $("selectAllRows");
  if (!selectAll) return;
  const profiles = visibleProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

function renderDuplicateStats() {
  const box = $("duplicateStats");
  const list = $("duplicateList");
  const details = state.duplicates.details || [];
  $("duplicateTotal").textContent = details.length;
  if (!details.length) {
    box.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  list.innerHTML = "";
  for (const item of details.slice(0, 80)) {
    const row = document.createElement("div");
    row.className = "duplicate-item";
    const folders = item.folders
      .map((folder) => `${folder.folderName}: ${folder.count}`)
      .join(", ");
    row.innerHTML = `
      <strong>${escapeHtml(item.uid)}</strong>
      <span>${item.count} profile</span>
      <span class="duplicate-folders">${escapeHtml(folders)}</span>
    `;
    list.appendChild(row);
  }
}

function makeSignature(data) {
  return JSON.stringify({
    folders: data.folders.map((folder) => [folder.id, folder.name]),
    profiles: data.profiles.map((profile) => [
      profile.id,
      profile.name,
      profile.uid,
      profile.folderId,
      profile.status,
      profile.sheetData?.Tool,
      sheetValue(profile, "trạng thái", "trang thai"),
      sheetValue(profile, "số vạch", "so vach"),
      sheetValue(profile, "chi tiết", "chi tiet"),
      sheetValue(profile, "mật khẩu", "mat khau"),
      sheetValue(profile, "2fa"),
      sheetValue(profile, "cookie")
    ]),
    duplicates: data.duplicates
  });
}

async function refreshHide({ silent = false, syncOnChange = false } = {}) {
  if (state.isLoading) return;
  state.isLoading = true;
  if (!silent) toggleBusy(true);
  try {
    updateEngineUi();
    if (!silent) setStatus(`Đang tải group/profile từ ${currentEngineLabel()}...`);
    const { data } = await api("/api/preview");
    const signature = makeSignature(data);
    const changed = signature !== state.lastSignature;
    state.currentHideAccount = data.hideAccount || null;
    state.currentSpreadsheetId = data.spreadsheetId || "";
    if (state.currentHideAccount?.id && state.currentSpreadsheetId && state.config) {
      state.config.accountSheets = {
        ...(state.config.accountSheets || {}),
        [state.currentHideAccount.id]: state.currentSpreadsheetId
      };
      if (!state.config.spreadsheetIds?.includes(state.currentSpreadsheetId)) {
        state.config.spreadsheetIds = [...(state.config.spreadsheetIds || []), state.currentSpreadsheetId];
      }
    }
    state.folders = data.folders;
    state.profiles = data.profiles;
    state.duplicates = data.duplicates || { duplicateUids: [], duplicateProfileIds: [], details: [] };
    state.lastSignature = signature;
    if (!silent || changed) render();
    renderSpreadsheetList();
    if (!silent || changed) {
      const duplicateText = state.duplicates.duplicateUids.length ? `, ${state.duplicates.duplicateUids.length} UID trùng` : "";
      setStatus(`Đã cập nhật ${data.totals.profiles} profile từ ${data.totals.folders} ${currentEngineKey() === "hide" ? "folder" : "group"}${duplicateText}.`);
    }
  } catch (error) {
    if (!silent) setStatus(error.message, true);
  } finally {
    state.isLoading = false;
    if (!silent) toggleBusy(false);
  }
}

function getHideRefreshIntervalMs() {
  const configuredSeconds = Math.max(Number(state.config?.autoRefreshSeconds || 2), 1);
  const profileCount = state.profiles.length;
  if (document.hidden) return Math.max(configuredSeconds, 10) * 1000;
  if (profileCount >= 1000) return Math.max(configuredSeconds, 8) * 1000;
  if (profileCount >= 500) return Math.max(configuredSeconds, 5) * 1000;
  if (state.activeModule !== "profiles") return Math.max(configuredSeconds, 4) * 1000;
  return configuredSeconds * 1000;
}

function scheduleHideRefresh() {
  if (state.hideRefreshTimer) window.clearTimeout(state.hideRefreshTimer);
  state.hideRefreshTimer = window.setTimeout(async () => {
    try {
      await refreshHide({ silent: true });
    } finally {
      scheduleHideRefresh();
    }
  }, getHideRefreshIntervalMs());
}

function canAutoSync() {
  const intervalMs = Math.max(Number(state.config?.autoSyncSeconds || 30), 10) * 1000;
  return Boolean(
    (state.config?.spreadsheetIds || []).length &&
      state.config?.credentialsPath &&
      !state.isSyncing &&
      Date.now() - state.lastAutoSyncAt >= intervalMs
  );
}

async function syncSheet({ silent = false } = {}) {
  if (state.isSyncing) return;
  state.isSyncing = true;
  if (!silent) toggleBusy(true);
  try {
    if (!silent) setStatus(`Đang cập nhật ${currentEngineLabel()} vào Google Sheet...`);
    const { data } = await api("/api/sync", { method: "POST", body: "{}" });
    state.lastAutoSyncAt = Date.now();
    setStatus(`Cập nhật ${currentEngineLabel()} -> Sheet xong: ${data.updated} profile, chuyển rác ${data.movedToTrash} dòng, UID trùng ${data.duplicateUids}.`);
    if (!silent) await refreshHide({ silent: true });
  } catch (error) {
    if (!silent) setStatus(error.message, true);
  } finally {
    state.isSyncing = false;
    if (!silent) toggleBusy(false);
  }
}

async function reloadSheetCache() {
  if (state.isSyncing) return;
  state.isSyncing = true;
  toggleBusy(true);
  try {
    setStatus("Đang nạp lại cache Sheet từ Google Sheets...");
    const { data } = await api("/api/sheet-cache/refresh", { method: "POST", body: "{}" });
    state.lastAutoSyncAt = Date.now();
    await refreshHide({ silent: true });
    const loadedAt = data.loadedAt ? new Date(data.loadedAt).toLocaleTimeString("vi-VN") : "";
    setStatus(`Đã nạp lại cache Sheet: ${data.rowCount} dòng / ${data.sheetCount} trang, thêm ${data.added}, bỏ ${data.removed}, cập nhật ${data.mergedQueuedRows || 0} dòng đang chờ${loadedAt ? ` lúc ${loadedAt}` : ""}.`);
  } catch (error) {
    setStatus(error.message || "Không nạp lại được cache Sheet.", true);
  } finally {
    state.isSyncing = false;
    toggleBusy(false);
  }
}

async function toggleProfile(profileId, action, button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "...";
  try {
    const endpoint = action === "stop" ? "stop" : "run";
    const { data } = await api(`/api/${endpoint}/${encodeURIComponent(profileId)}`, { method: "POST", body: "{}" });
    const port = data?.port || data?.data?.port || "";
    setStatus(
      endpoint === "run"
        ? port
          ? `Đã chạy profile ${profileId}, port ${port}.`
          : `Đã gửi lệnh chạy profile ${profileId}.`
        : `Đã dừng profile ${profileId}.`
    );
    updateProfileStatus(profileId, endpoint === "run");
    window.setTimeout(() => refreshHide({ silent: true }), 1500);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function updateProfileStatus(profileId, isRunning) {
  state.profiles = state.profiles.map((profile) => {
    if (profile.id !== profileId) return profile;
    return {
      ...profile,
      isRunning,
      status: isRunning ? "running" : "ready"
    };
  });
  render();
}

function sheetValue(profile, ...keys) {
  const data = profile?.sheetData || {};
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  return "";
}

function toggleBusy(isBusy) {
  $("refreshBtn").disabled = isBusy;
  $("syncBtn").disabled = isBusy;
  if ($("reloadSheetCacheBtn")) $("reloadSheetCacheBtn").disabled = isBusy;
  $("saveConfig").disabled = isBusy;
  if ($("saveFullConfig")) $("saveFullConfig").disabled = isBusy;
}

function isNotificationDone(profile) {
  const value = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  return Boolean(value);
}

function notificationResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase();
  const detail = String(sheetValue(profile, "chi tiết", "chi tiet") || "").trim().toLowerCase();
  if (status === "loi") return "loi";
  if (detail.includes("pause")) return "pause";
  if (detail.includes("order")) return "order";
  return isNotificationDone(profile) ? "ok" : "all";
}

function notificationProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.notificationProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isNotificationDone(profile));
  } else if (state.notificationProgressFilter === "done") {
    profiles = profiles.filter((profile) => isNotificationDone(profile));
  }
  if (state.notificationResultFilter !== "all") {
    profiles = profiles.filter((profile) => notificationResultKind(profile) === state.notificationResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.notificationSearchQuery, state.notificationBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderNotificationRows() {
  if (!$("notificationRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if (!toolRuntimeIsVisible()) {
    $("notificationStatusText").textContent = `Đang xem: ${folderName}.`;
  }
  $("ntfTotal").textContent = all.length;
  $("ntfTodo").textContent = all.filter((profile) => !isNotificationDone(profile)).length;
  $("ntfDone").textContent = all.filter((profile) => isNotificationDone(profile)).length;
  $("ntfError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase() === "loi").length;

  const profiles = notificationProfiles();
  $("ntfVisible").textContent = profiles.length;
  updateSelectionSummary("notificationSelectionSummary", "clearNotificationSelectionBtn", state.selectedNotificationIds.size);
  const rows = $("notificationRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">Không có profile phù hợp.</td></tr>`;
    updateNotificationSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="notification-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedNotificationIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".notification-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedNotificationIds.add(checkbox.dataset.id);
      else state.selectedNotificationIds.delete(checkbox.dataset.id);
      updateNotificationSelectAllState();
    });
  });
  updateNotificationSelectAllState();
}

function toolRuntimeIsVisible() {
  return !$("toolProgressPanel")?.classList.contains("hidden");
}

function updateNotificationSelectAllState() {
  const selectAll = $("selectAllNotificationRows");
  if (!selectAll) return;
  const profiles = notificationProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedNotificationIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startCheckNotifications(profileIds) {
  if (!profileIds.length) {
    $("notificationStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runNotificationSelectedBtn").disabled = true;
    $("runNotificationTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("checkConcurrency")?.value || 4)));
    const { data } = await api("/api/tools/check-notifications", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: kiểm tra thông báo", "notifications");
    $("notificationStatusText").textContent = `Đã bắt đầu xem thông báo ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("notificationStatusText").textContent = error.message;
  } finally {
    $("runNotificationSelectedBtn").disabled = false;
    $("runNotificationTodoBtn").disabled = false;
  }
}

function checkOrderProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.checkOrderSearchQuery, state.checkOrderBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderCheckOrderRows() {
  if (!$("checkOrderRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const profiles = checkOrderProfiles();
  $("checkOrderTotal").textContent = all.length;
  $("checkOrderSelected").textContent = state.selectedCheckOrderIds.size;
  $("checkOrderVisible").textContent = profiles.length;
  updateSelectionSummary("checkOrderSelectionSummary", "clearCheckOrderSelectionBtn", state.selectedCheckOrderIds.size);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder hiện tại";
  if ($("checkOrderStatusText") && !state.checkOrderBatchIds.length) $("checkOrderStatusText").textContent = `Đang xem ${folderName}.`;
  const rows = $("checkOrderRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="6" class="empty">Không có profile phù hợp.</td></tr>`;
    updateCheckOrderSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="check-order-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedCheckOrderIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.folderName)}</td>
      <td>${escapeHtml(sheetValue(profile, "trạng thái", "trang thai"))}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".check-order-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedCheckOrderIds.add(checkbox.dataset.id);
      else state.selectedCheckOrderIds.delete(checkbox.dataset.id);
      updateCheckOrderSelectAllState();
    });
  });
  updateCheckOrderSelectAllState();
}

function updateCheckOrderSelectAllState() {
  const selectAll = $("selectAllCheckOrderRows");
  if (!selectAll) return;
  const profiles = checkOrderProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedCheckOrderIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
  if ($("checkOrderSelected")) $("checkOrderSelected").textContent = state.selectedCheckOrderIds.size;
}

async function startCheckOrder(profileIds) {
  if (!profileIds.length) {
    $("checkOrderStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runCheckOrderSelectedBtn").disabled = true;
    $("runCheckOrderFolderBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("checkOrderConcurrency")?.value || 1)));
    const { data } = await api("/api/tools/check-order", {
      method: "POST",
      body: JSON.stringify({
        profileIds,
        concurrency,
        checkOrderSpreadsheetId: $("checkOrderSpreadsheetId")?.value || "",
        checkOrderSheetName: $("checkOrderSheetName")?.value || "check order"
      })
    });
    state.checkOrderBatchIds = [...profileIds];
    primeToolProgress(profileIds, "bắt đầu: check order", "checkorder");
    $("checkOrderStatusText").textContent = `Đã bắt đầu check order ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("checkOrderStatusText").textContent = error.message;
  } finally {
    $("runCheckOrderSelectedBtn").disabled = false;
    $("runCheckOrderFolderBtn").disabled = false;
  }
}

async function startLinkOrder() {
  const nick1 = $("marketplaceCheckNick1Id")?.value.trim() || "";
  const nick2 = $("marketplaceCheckNick2Id")?.value.trim() || "";
  if (!nick1 && !nick2) {
    $("linkOrderStatusText").textContent = "Bạn cần nhập ID Hide nick 1 hoặc nick 2.";
    return;
  }
  try {
    $("runLinkOrderBtn").disabled = true;
    await saveConfig();
    const body = {
      marketplaceCheckSpreadsheetId: $("marketplaceCheckSpreadsheetId")?.value || "",
      marketplaceCheckSheetName: $("marketplaceCheckSheetName")?.value || "",
      marketplaceCheckNick1Id: nick1,
      marketplaceCheckNick2Id: nick2,
      marketplaceCheckTabsPerNick: Math.max(1, Math.min(20, Number($("marketplaceCheckTabsPerNick")?.value || 5))),
      marketplaceCheckTimeoutMs: Math.max(30000, Math.min(240000, Number($("marketplaceCheckTimeoutMs")?.value || 90000)))
    };
    const { data, config } = await api("/api/tools/check-link-order", {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.config = config || state.config;
    state.linkOrderBatchIds = data.profileIds || [nick1, nick2].filter(Boolean);
    primeToolProgress(state.linkOrderBatchIds, "bắt đầu: check link order", "linkorder");
    $("linkOrderStatusText").textContent = `Đã bắt đầu ${data.started} nick, mỗi nick ${data.tabsPerNick || body.marketplaceCheckTabsPerNick} tab.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("linkOrderStatusText").textContent = error.message;
  } finally {
    $("runLinkOrderBtn").disabled = false;
  }
}
function isFullDone(profile) {
  return String(profile.sheetData?.Tool || "").trim().toLowerCase().includes("full");
}

function fullResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase();
  const bar = String(sheetValue(profile, "số vạch", "so vach")).trim().toLowerCase();
  const detail = String(sheetValue(profile, "chi tiết", "chi tiet")).trim().toLowerCase();
  if (status === "loi") return "loi";
  if (bar === "2v" || detail === "2v") return "2v";
  if (bar === "4v" || detail === "4v") return "4v";
  if (bar === "3v" || detail.includes("submit")) return "3v";
  return isFullDone(profile) ? "ok" : "all";
}

function fullProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.fullProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isFullDone(profile));
  } else if (state.fullProgressFilter === "done") {
    profiles = profiles.filter((profile) => isFullDone(profile));
  }
  if (state.fullResultFilter !== "all") {
    profiles = profiles.filter((profile) => fullResultKind(profile) === state.fullResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.fullSearchQuery, state.fullBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderFullRows() {
  if (!$("fullRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if (!toolRuntimeIsVisible()) $("fullStatusText").textContent = `Đang xem: ${folderName}.`;
  $("fullTotal").textContent = all.length;
  $("fullTodo").textContent = all.filter((profile) => !isFullDone(profile)).length;
  $("fullDone").textContent = all.filter((profile) => isFullDone(profile)).length;
  $("fullError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase() === "loi").length;

  const profiles = fullProfiles();
  $("fullVisible").textContent = profiles.length;
  updateSelectionSummary("fullSelectionSummary", "clearFullSelectionBtn", state.selectedFullIds.size);
  const rows = $("fullRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="9" class="empty">Không có profile phù hợp.</td></tr>`;
    updateFullSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai")).trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="full-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedFullIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "số vạch", "so vach"))}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".full-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedFullIds.add(checkbox.dataset.id);
      else state.selectedFullIds.delete(checkbox.dataset.id);
      updateFullSelectAllState();
    });
  });
  updateFullSelectAllState();
}

function updateFullSelectAllState() {
  const selectAll = $("selectAllFullRows");
  if (!selectAll) return;
  const profiles = fullProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedFullIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startLamFull(profileIds) {
  if (!profileIds.length) {
    $("fullStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runFullSelectedBtn").disabled = true;
    $("runFullTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("fullConcurrency")?.value || 4)));
    const { data } = await api("/api/tools/lam-full", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: lấy seller info", "full");
    $("fullStatusText").textContent = `Đã bắt đầu làm full ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("fullStatusText").textContent = error.message;
  } finally {
    $("runFullSelectedBtn").disabled = false;
    $("runFullTodoBtn").disabled = false;
  }
}

function isPostDone(profile) {
  const tool = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  return tool.includes("đã đăng bài") || tool.includes("da dang bai") || tool.includes("đã làm full") || tool.includes("da lam full");
}

function postResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase();
  const bar = String(sheetValue(profile, "số vạch", "so vach") || "").trim().toLowerCase();
  const tool = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  if (status === "loi") return "loi";
  if (tool.includes("đã đăng bài") || tool.includes("da dang bai")) return "2v";
  if (bar === "4v") return "4v";
  if (tool.includes("đã làm full") || tool.includes("da lam full") || bar === "3v") return "3v";
  if (bar === "2v") return "2v";
  return isPostDone(profile) ? "ok" : "all";
}

function postProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.postProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isPostDone(profile));
  } else if (state.postProgressFilter === "done") {
    profiles = profiles.filter((profile) => isPostDone(profile));
  }
  if (state.postResultFilter !== "all") {
    profiles = profiles.filter((profile) => postResultKind(profile) === state.postResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.postSearchQuery, state.postBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderPostRows() {
  if (!$("postRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if (!toolRuntimeIsVisible()) $("postStatusText").textContent = `Đang xem: ${folderName}.`;
  $("postTotal").textContent = all.length;
  $("postTodo").textContent = all.filter((profile) => !isPostDone(profile)).length;
  $("postDone").textContent = all.filter((profile) => isPostDone(profile)).length;
  $("postError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase() === "loi").length;
  const profiles = postProfiles();
  $("postVisible").textContent = profiles.length;
  updateSelectionSummary("postSelectionSummary", "clearPostSelectionBtn", state.selectedPostIds.size);
  const rows = $("postRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="9" class="empty">Không có profile phù hợp.</td></tr>`;
    updatePostSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="post-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedPostIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "số vạch", "so vach"))}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".post-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPostIds.add(checkbox.dataset.id);
      else state.selectedPostIds.delete(checkbox.dataset.id);
      updatePostSelectAllState();
    });
  });
  updatePostSelectAllState();
}

function updatePostSelectAllState() {
  const selectAll = $("selectAllPostRows");
  if (!selectAll) return;
  const profiles = postProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedPostIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startDangBai(profileIds) {
  if (!profileIds.length) {
    $("postStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runPostSelectedBtn").disabled = true;
    $("runPostTodoBtn").disabled = true;
    await savePostConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("postConcurrency")?.value || 4)));
    const { data } = await api("/api/tools/dang-bai", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: mở profile đăng bài", "post");
    $("postStatusText").textContent = `Đã bắt đầu đăng bài ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("postStatusText").textContent = error.message;
  } finally {
    $("runPostSelectedBtn").disabled = false;
    $("runPostTodoBtn").disabled = false;
  }
}

function isInteractionDone(profile) {
  const tool = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  return tool.includes("tuong tac") || tool.includes("tương tác");
}

function interactionResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase();
  if (status === "loi") return "loi";
  return isInteractionDone(profile) ? "ok" : "all";
}

function interactionProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.interactionProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isInteractionDone(profile));
  } else if (state.interactionProgressFilter === "done") {
    profiles = profiles.filter((profile) => isInteractionDone(profile));
  }
  if (state.interactionResultFilter !== "all") {
    profiles = profiles.filter((profile) => interactionResultKind(profile) === state.interactionResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.interactionSearchQuery, state.interactionBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderInteractionRows() {
  if (!$("interactionRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if ($("interactionStatusText")) $("interactionStatusText").textContent = `Đang xem: ${folderName}.`;
  $("interactionTotal").textContent = all.length;
  $("interactionTodo").textContent = all.filter((profile) => !isInteractionDone(profile)).length;
  $("interactionDone").textContent = all.filter((profile) => isInteractionDone(profile)).length;
  $("interactionError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase() === "loi").length;

  const profiles = interactionProfiles();
  $("interactionVisible").textContent = profiles.length;
  updateSelectionSummary("interactionSelectionSummary", "clearInteractionSelectionBtn", state.selectedInteractionIds.size);
  const rows = $("interactionRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">Không có profile phù hợp.</td></tr>`;
    updateInteractionSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="interaction-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedInteractionIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".interaction-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedInteractionIds.add(checkbox.dataset.id);
      else state.selectedInteractionIds.delete(checkbox.dataset.id);
      updateInteractionSelectAllState();
    });
  });
  updateInteractionSelectAllState();
}

function updateInteractionSelectAllState() {
  const selectAll = $("selectAllInteractionRows");
  if (!selectAll) return;
  const profiles = interactionProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedInteractionIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startInteraction(profileIds) {
  if (!profileIds.length) {
    $("interactionStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runInteractionSelectedBtn").disabled = true;
    $("runInteractionTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("interactionConcurrency")?.value || 4)));
    const { data } = await api("/api/tools/tuong-tac", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: tương tác", "interaction");
    $("interactionStatusText").textContent = `Đã bắt đầu tương tác ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("interactionStatusText").textContent = error.message;
  } finally {
    $("runInteractionSelectedBtn").disabled = false;
    $("runInteractionTodoBtn").disabled = false;
  }
}
async function startRenewStandalone(profileIds) {
  if (!profileIds.length) {
    $("interactionStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy Renew độc lập.";
    return;
  }
  try {
    if ($("runRenewStandaloneBtn")) $("runRenewStandaloneBtn").disabled = true;
    $("runInteractionSelectedBtn").disabled = true;
    $("runInteractionTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("interactionConcurrency")?.value || 1)));
    const { data } = await api("/api/tools/renew-doc-lap", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: Renew độc lập", "interaction");
    $("interactionStatusText").textContent = `Đã bắt đầu Renew độc lập ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("interactionStatusText").textContent = error.message;
  } finally {
    if ($("runRenewStandaloneBtn")) $("runRenewStandaloneBtn").disabled = false;
    $("runInteractionSelectedBtn").disabled = false;
    $("runInteractionTodoBtn").disabled = false;
  }
}

function pageCount(profile) {
  const raw = String(sheetValue(profile, "số lượng page", "so luong page", "page count", "so page") || "").trim();
  const parsed = Math.floor(Number(raw.replace(/[^\d.-]/g, "")));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isPageDone(profile) {
  const tool = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  return tool.includes("tạo page") || tool.includes("tao page") || pageCount(profile) > 0;
}

function pageResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase();
  if (status === "loi") return "loi";
  return isPageDone(profile) ? "ok" : "all";
}

function pageProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.pageProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isPageDone(profile));
  } else if (state.pageProgressFilter === "done") {
    profiles = profiles.filter((profile) => isPageDone(profile));
  }
  if (state.pageResultFilter !== "all") {
    profiles = profiles.filter((profile) => pageResultKind(profile) === state.pageResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.pageSearchQuery, state.pageBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderPageRows() {
  if (!$("pageRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if ($("pageStatusText")) $("pageStatusText").textContent = `Đang xem: ${folderName}.`;
  $("pageTotal").textContent = all.length;
  $("pageTodo").textContent = all.filter((profile) => !isPageDone(profile)).length;
  $("pageDone").textContent = all.filter((profile) => isPageDone(profile)).length;
  $("pageError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase() === "loi").length;

  const profiles = pageProfiles();
  $("pageVisible").textContent = profiles.length;
  updateSelectionSummary("pageSelectionSummary", "clearPageSelectionBtn", state.selectedPageIds.size);
  const rows = $("pageRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="9" class="empty">Không có profile phù hợp.</td></tr>`;
    updatePageSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="page-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedPageIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "số lượng page", "so luong page"))}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".page-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPageIds.add(checkbox.dataset.id);
      else state.selectedPageIds.delete(checkbox.dataset.id);
      updatePageSelectAllState();
    });
  });
  updatePageSelectAllState();
}

function updatePageSelectAllState() {
  const selectAll = $("selectAllPageRows");
  if (!selectAll) return;
  const profiles = pageProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedPageIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startCreatePage(profileIds) {
  if (!profileIds.length) {
    $("pageStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runPageSelectedBtn").disabled = true;
    $("runPageTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(4, Number($("pageConcurrency")?.value || 4)));
    const { data } = await api("/api/tools/tao-page", {
      method: "POST",
      body: JSON.stringify({ profileIds, concurrency })
    });
    primeToolProgress(profileIds, "bắt đầu: tạo page", "pages");
    $("pageStatusText").textContent = `Đã bắt đầu tạo page ${data.started} profile với ${data.concurrency || 1} luồng.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("pageStatusText").textContent = error.message;
  } finally {
    $("runPageSelectedBtn").disabled = false;
    $("runPageTodoBtn").disabled = false;
  }
}

function isAvatarDone(profile) {
  const tool = String(profile.sheetData?.Tool || "").trim().toLowerCase();
  const detail = String(sheetValue(profile, "chi tiết", "chi tiet") || "").trim().toLowerCase();
  return tool.includes("avatar") || tool.includes("ảnh đại diện") || tool.includes("anh dai dien")
    || detail.includes("ảnh đại diện") || detail.includes("anh dai dien");
}

function avatarResultKind(profile) {
  const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim().toLowerCase();
  if (status === "loi") return "loi";
  return isAvatarDone(profile) ? "ok" : "all";
}

function avatarProfiles() {
  let profiles = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  if (state.avatarProgressFilter === "todo") {
    profiles = profiles.filter((profile) => !isAvatarDone(profile));
  } else if (state.avatarProgressFilter === "done") {
    profiles = profiles.filter((profile) => isAvatarDone(profile));
  }
  if (state.avatarResultFilter !== "all") {
    profiles = profiles.filter((profile) => avatarResultKind(profile) === state.avatarResultFilter);
  }
  profiles = profiles.filter((profile) => matchesProfileFilters(profile, state.avatarSearchQuery, state.avatarBulkSearchQuery));
  profiles.sort((a, b) => (a.folderName || "").localeCompare(b.folderName || "", "vi", { sensitivity: "base" })
    || (a.name || "").localeCompare(b.name || "", "vi", { numeric: true, sensitivity: "base" }));
  return profiles;
}

function renderAvatarRows() {
  if (!$("avatarRows")) return;
  const all = state.selectedFolderId === "all"
    ? [...state.profiles]
    : state.profiles.filter((profile) => profile.folderId === state.selectedFolderId);
  const folderName = state.selectedFolderId === "all"
    ? "Tất cả folder"
    : state.folders.find((folder) => folder.id === state.selectedFolderId)?.name || "Folder đang chọn";
  if ($("avatarStatusText")) $("avatarStatusText").textContent = `Đang xem: ${folderName}.`;
  $("avatarTotal").textContent = all.length;
  $("avatarTodo").textContent = all.filter((profile) => !isAvatarDone(profile)).length;
  $("avatarDone").textContent = all.filter((profile) => isAvatarDone(profile)).length;
  $("avatarError").textContent = all.filter((profile) => String(sheetValue(profile, "trạng thái", "trang thai")).trim().toLowerCase() === "loi").length;

  const profiles = avatarProfiles();
  $("avatarVisible").textContent = profiles.length;
  updateSelectionSummary("avatarSelectionSummary", "clearAvatarSelectionBtn", state.selectedAvatarIds.size);
  const rows = $("avatarRows");
  if (!profiles.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">Không có profile phù hợp.</td></tr>`;
    updateAvatarSelectAllState();
    return;
  }
  rows.innerHTML = "";
  for (const profile of profiles) {
    const tr = document.createElement("tr");
    const status = String(sheetValue(profile, "trạng thái", "trang thai") || "").trim();
    if (status.toLowerCase() === "loi") tr.classList.add("duplicate-row");
    tr.innerHTML = `
      <td><input class="avatar-check" type="checkbox" data-id="${escapeAttr(profile.id)}" ${state.selectedAvatarIds.has(profile.id) ? "checked" : ""} /></td>
      <td>${escapeHtml(profile.name)}</td>
      <td>${escapeHtml(profile.id)}</td>
      <td class="uid">${escapeHtml(profile.uid || "")}</td>
      <td>${escapeHtml(profile.sheetData?.Tool || "")}</td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(sheetValue(profile, "chi tiết", "chi tiet"))}</td>
      <td>${escapeHtml(profile.folderName)}</td>
    `;
    rows.appendChild(tr);
  }
  rows.querySelectorAll(".avatar-check").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedAvatarIds.add(checkbox.dataset.id);
      else state.selectedAvatarIds.delete(checkbox.dataset.id);
      updateAvatarSelectAllState();
    });
  });
  updateAvatarSelectAllState();
}

function updateAvatarSelectAllState() {
  const selectAll = $("selectAllAvatarRows");
  if (!selectAll) return;
  const profiles = avatarProfiles();
  const selectedCount = profiles.filter((profile) => state.selectedAvatarIds.has(profile.id)).length;
  selectAll.checked = profiles.length > 0 && selectedCount === profiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < profiles.length;
}

async function startAvatar(profileIds) {
  if (!profileIds.length) {
    $("avatarStatusText").textContent = "Bạn cần chọn ít nhất một profile để chạy.";
    return;
  }
  try {
    $("runAvatarSelectedBtn").disabled = true;
    $("runAvatarTodoBtn").disabled = true;
    await saveConfig();
    const concurrency = Math.max(1, Math.min(2, Number($("avatarConcurrency")?.value || 2)));
    const { data } = await api("/api/tools/avatar", {
      method: "POST",
      body: JSON.stringify({
        profileIds,
        concurrency,
        avatarImagePath: $("avatarImagePath")?.value || "",
        avatarReplaceExisting: Boolean($("avatarReplaceExisting")?.checked)
      })
    });
    primeToolProgress(profileIds, "bắt đầu: đổi avatar", "avatar");
    $("avatarStatusText").textContent = `Đã bắt đầu đổi avatar ${data.started} profile với ${data.concurrency || 1} luồng, kho ảnh ${data.imageCount || 0} ảnh.`;
    await refreshToolStatus();
    startToolStatusPolling();
  } catch (error) {
    $("avatarStatusText").textContent = error.message;
  } finally {
    $("runAvatarSelectedBtn").disabled = false;
    $("runAvatarTodoBtn").disabled = false;
  }
}

function startToolStatusPolling() {
  if (state.toolStatusTimer) return;
  state.toolStatusTimer = window.setInterval(refreshToolStatus, 1500);
}

function stopToolStatusPolling() {
  if (!state.toolStatusTimer) return;
  window.clearInterval(state.toolStatusTimer);
  state.toolStatusTimer = null;
}

async function refreshToolStatus() {
  try {
    const { data } = await api("/api/tools/status");
    renderToolProgress(data);
    if (!data.running) {
      stopToolStatusPolling();
      await refreshHide({ silent: true });
      if ($("fullStatusText")) $("fullStatusText").textContent = "Tool làm full đã chạy xong.";
      if ($("postStatusText")) $("postStatusText").textContent = "Tool đăng bài đã chạy xong.";
      if ($("interactionStatusText")) $("interactionStatusText").textContent = "Tool tương tác đã chạy xong.";
      if ($("pageStatusText")) $("pageStatusText").textContent = "Tool tạo page đã chạy xong.";
      if ($("avatarStatusText")) $("avatarStatusText").textContent = "Tool đổi avatar đã chạy xong.";
      if ($("notificationStatusText")) $("notificationStatusText").textContent = "Tool xem thông báo đã chạy xong.";
      if ($("checkOrderStatusText")) $("checkOrderStatusText").textContent = "Tool check order đã chạy xong.";
      if ($("passwordStatusText")) $("passwordStatusText").textContent = "Tool điền mật khẩu đã chạy xong.";
    }
  } catch {
    stopToolStatusPolling();
  }
}

function renderToolProgress(data) {
  state.logs = data.logs || [];
  renderLogs();
  const allJobs = data.jobs || [];
  const doneStatuses = new Set(["done", "success", "completed", "error", "stopped", "cancelled", "skipped"]);
  const buildProgress = (batchIds) => {
    const wanted = new Set((batchIds || []).filter(Boolean));
    const jobs = wanted.size ? allJobs.filter((job) => wanted.has(job.profileId)) : [];
    const total = jobs.length || wanted.size;
    const completed = jobs.filter((job) => doneStatuses.has(String(job.status || "").toLowerCase())).length;
    const active = jobs.filter((job) => !doneStatuses.has(String(job.status || "").toLowerCase())).length;
    const percent = total ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
    const summaryText = total
      ? `Đã xong ${completed}/${total} profile, đang chạy ${active} profile.`
      : "Chưa có batch đang chạy.";
    return { jobs, total, completed, active, percent, summaryText };
  };
  const notificationProgress = buildProgress(state.notificationBatchIds);
  const checkOrderProgress = buildProgress(state.checkOrderBatchIds);
  const linkOrderProgress = buildProgress(state.linkOrderBatchIds);
  renderToolProgressPanel({
    panelId: "checkOrderToolProgressPanel",
    stateId: "checkOrderToolProgressState",
    countId: "checkOrderToolProgressCount",
    textId: "checkOrderToolProgressText",
    barId: "checkOrderToolProgressBar",
    listId: "checkOrderToolProgressList",
    stateLabel: checkOrderProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${checkOrderProgress.completed} / ${checkOrderProgress.total}`,
    textLabel: checkOrderProgress.summaryText,
    percent: checkOrderProgress.percent,
    jobs: checkOrderProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "linkOrderToolProgressPanel",
    stateId: "linkOrderToolProgressState",
    countId: "linkOrderToolProgressCount",
    textId: "linkOrderToolProgressText",
    barId: "linkOrderToolProgressBar",
    listId: "linkOrderToolProgressList",
    stateLabel: linkOrderProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${linkOrderProgress.completed} / ${linkOrderProgress.total}`,
    textLabel: linkOrderProgress.summaryText,
    percent: linkOrderProgress.percent,
    jobs: linkOrderProgress.jobs
  });
  const fullProgress = buildProgress(state.fullBatchIds);
  const postProgress = buildProgress(state.postBatchIds);
  const interactionProgress = buildProgress(state.interactionBatchIds);
  const pageProgress = buildProgress(state.pageBatchIds);
  const avatarProgress = buildProgress(state.avatarBatchIds);
  const passwordProgress = buildProgress(state.passwordBatchIds);
  renderToolProgressPanel({
    panelId: "toolProgressPanel",
    stateId: "toolProgressState",
    countId: "toolProgressCount",
    textId: "toolProgressText",
    barId: "toolProgressBar",
    listId: "toolProgressList",
    stateLabel: notificationProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${notificationProgress.completed} / ${notificationProgress.total}`,
    textLabel: notificationProgress.summaryText,
    percent: notificationProgress.percent,
    jobs: notificationProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "fullToolProgressPanel",
    stateId: "fullToolProgressState",
    countId: "fullToolProgressCount",
    textId: "fullToolProgressText",
    barId: "fullToolProgressBar",
    listId: "fullToolProgressList",
    stateLabel: fullProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${fullProgress.completed} / ${fullProgress.total}`,
    textLabel: fullProgress.summaryText,
    percent: fullProgress.percent,
    jobs: fullProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "postToolProgressPanel",
    stateId: "postToolProgressState",
    countId: "postToolProgressCount",
    textId: "postToolProgressText",
    barId: "postToolProgressBar",
    listId: "postToolProgressList",
    stateLabel: postProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${postProgress.completed} / ${postProgress.total}`,
    textLabel: postProgress.summaryText,
    percent: postProgress.percent,
    jobs: postProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "interactionToolProgressPanel",
    stateId: "interactionToolProgressState",
    countId: "interactionToolProgressCount",
    textId: "interactionToolProgressText",
    barId: "interactionToolProgressBar",
    listId: "interactionToolProgressList",
    stateLabel: interactionProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${interactionProgress.completed} / ${interactionProgress.total}`,
    textLabel: interactionProgress.summaryText,
    percent: interactionProgress.percent,
    jobs: interactionProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "pageToolProgressPanel",
    stateId: "pageToolProgressState",
    countId: "pageToolProgressCount",
    textId: "pageToolProgressText",
    barId: "pageToolProgressBar",
    listId: "pageToolProgressList",
    stateLabel: pageProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${pageProgress.completed} / ${pageProgress.total}`,
    textLabel: pageProgress.summaryText,
    percent: pageProgress.percent,
    jobs: pageProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "avatarToolProgressPanel",
    stateId: "avatarToolProgressState",
    countId: "avatarToolProgressCount",
    textId: "avatarToolProgressText",
    barId: "avatarToolProgressBar",
    listId: "avatarToolProgressList",
    stateLabel: avatarProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${avatarProgress.completed} / ${avatarProgress.total}`,
    textLabel: avatarProgress.summaryText,
    percent: avatarProgress.percent,
    jobs: avatarProgress.jobs
  });
  renderToolProgressPanel({
    panelId: "passwordToolProgressPanel",
    stateId: "passwordToolProgressState",
    countId: "passwordToolProgressCount",
    textId: "passwordToolProgressText",
    barId: "passwordToolProgressBar",
    listId: "passwordToolProgressList",
    stateLabel: passwordProgress.total ? (data.running ? "đang chạy" : "xong") : "idle",
    countLabel: `${passwordProgress.completed} / ${passwordProgress.total}`,
    textLabel: passwordProgress.summaryText,
    percent: passwordProgress.percent,
    jobs: passwordProgress.jobs
  });
}

function renderToolProgressPanel({
  panelId,
  stateId,
  countId,
  textId,
  barId,
  listId,
  stateLabel,
  countLabel,
  textLabel,
  percent,
  jobs
}) {
  const panel = $(panelId);
  const list = $(listId);
  const stateNode = $(stateId);
  const countNode = $(countId);
  const textNode = $(textId);
  const barNode = $(barId);
  if (!panel || !list || !stateNode || !countNode || !textNode || !barNode) return;
  if (!jobs.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    barNode.style.width = "0%";
    countNode.textContent = "0 / 0";
    textNode.textContent = "Chưa có batch đang chạy.";
    stateNode.textContent = "idle";
    return;
  }
  panel.classList.remove("hidden");
  stateNode.textContent = stateLabel;
  countNode.textContent = countLabel;
  textNode.textContent = textLabel;
  barNode.style.width = `${percent}%`;
  list.innerHTML = jobs.slice(-80).map((job) => `
    <div class="tool-progress-item">
      <span>${escapeHtml(job.profileId || "")}</span>
      <span class="job-status ${escapeAttr(job.status || "queued")}">${escapeHtml(job.status || "queued")}</span>
      <span>${escapeHtml(job.liveStatus || "")}</span>
    </div>
  `).join("");
}

function visibleLogs() {
  const query = state.logSearchQuery.trim().toLowerCase();
  return [...state.logs].reverse().filter((log) => {
    if (state.logTypeFilter !== "all" && String(log.type || "") !== state.logTypeFilter) return false;
    if (state.logToolFilter !== "all" && String(log.tool || "") !== state.logToolFilter) return false;
    if (!query) return true;
    const haystack = [
      log.createdAt,
      log.type,
      log.tool,
      log.step,
      log.profileId,
      log.message
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderLogs() {
  if (!$("logRows")) return;
  const logs = visibleLogs();
  $("logCount").textContent = `${logs.length} dòng`;
  const rows = $("logRows");
  if (!logs.length) {
    rows.innerHTML = `<div class="empty">Chưa có nhật ký phù hợp.</div>`;
    return;
  }
  rows.innerHTML = `<div class="activity-list">${logs.map((log) => renderLogEntry(log)).join("")}</div>`;
  renderActivityLogs();
}

function renderActivityLogs() {
  const logs = [...state.logs].reverse().slice(0, 200);
  renderActivityLogBox("profileActivityLog", logs);
  renderActivityLogBox("notificationActivityLog", logs);
  renderActivityLogBox("checkOrderActivityLog", logs);
  renderActivityLogBox("linkOrderActivityLog", logs);
  renderActivityLogBox("fullActivityLog", logs);
  renderActivityLogBox("postActivityLog", logs);
  renderActivityLogBox("interactionActivityLog", logs);
  renderActivityLogBox("pageActivityLog", logs);
  renderActivityLogBox("avatarActivityLog", logs);
  renderActivityLogBox("passwordActivityLog", logs);
}

function renderActivityLogBox(id, logs) {
  const box = $(id);
  if (!box) return;
  if (!logs.length) {
    box.innerHTML = `<div class="empty">Chưa có nhật ký.</div>`;
    return;
  }
  box.innerHTML = `<div class="activity-list">${logs.map((log) => renderLogEntry(log, true)).join("")}</div>`;
}

function renderLogEntry(log, compact = false) {
  const time = escapeHtml(formatLogTime(log.createdAt));
  const type = escapeHtml(log.type || "info");
  const typeClass = escapeAttr(log.type || "info");
  const step = escapeHtml(log.step || "Đang xử lý");
  const tool = escapeHtml(log.tool || "");
  const profileId = escapeHtml(log.profileId || "");
  const detail = escapeHtml(log.detail || "");
  const message = escapeHtml(log.message || "");
  return `
    <article class="activity-entry ${compact ? "compact" : ""}">
      <div class="activity-entry-header">
        <div class="activity-entry-title">
          <span class="activity-entry-time">${time}</span>
          <span class="activity-entry-step">${step}</span>
        </div>
        <div class="activity-entry-tags">
          <span class="activity-tag log-type-${typeClass}">${type}</span>
          ${tool ? `<span class="activity-tag">${tool}</span>` : ""}
          ${profileId ? `<span class="activity-tag">${profileId}</span>` : ""}
        </div>
      </div>
      <div class="activity-entry-body">
        ${message || "Không có nội dung."}
        ${detail && detail !== message ? `<small>${detail}</small>` : ""}
      </div>
    </article>
  `;
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString("vi-VN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function ensureReloadUiButton() {
  const refreshBtn = $("refreshBtn");
  if (!refreshBtn || $("reloadUiBtn")) return;
  const button = document.createElement("button");
  button.id = "reloadUiBtn";
  button.className = "ghost-btn";
  button.innerHTML = '<span class="btn-icon">⟳</span><span>Tải lại giao diện</span>';
  refreshBtn.parentElement?.insertBefore(button, refreshBtn);
}

async function restartBackend() {
  const button = $("manualRestartBtn");
  if (button) button.disabled = true;
  try {
    if (!window.confirm("Reset backend ngay bây giờ? Nếu đang có job chạy thì job đó sẽ bị dừng ngay.")) {
      return;
    }
    setStatus("Đang khởi động lại backend...");
    const restartResult = await api("/api/restart-manual", { method: "POST", body: "{}" });
    const previousStartedAt = restartResult?.data?.startedAt || "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const response = await fetch(`/api/runtime?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) continue;
        const payload = await response.json();
        const runtime = payload?.data || {};
        if (runtime.startedAt && runtime.startedAt !== previousStartedAt && !runtime.restarting) {
          window.location.reload();
          return;
        }
      } catch {}
    }
    setStatus("Backend chưa lên lại. Hãy bấm Tải lại giao diện sau vài giây.", true);
  } catch (error) {
    setStatus(error.message || "Không khởi động lại được backend.", true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function updateOnline() {
  const button = $("onlineUpdateBtn");
  const statusNode = $("onlineUpdateStatus");
  if (button) button.disabled = true;
  if (statusNode) {
    statusNode.textContent = "Đang tải bản cập nhật...";
    statusNode.className = "config-note";
  }
  try {
    const { data } = await api("/api/update/online", { method: "POST", body: "{}" });
    const updated = Number(data?.updated || 0);
    const skipped = Number(data?.skipped || 0);
    const version = data?.version || "";
    const message = updated
      ? `Đã cập nhật ${updated} file lên bản ${version}, bỏ qua ${skipped}. Hãy reset backend hoặc tắt mở lại tool.`
      : `Tool đã ở bản mới nhất ${version}. Không có file cần đổi.`;
    if (statusNode) statusNode.textContent = message;
    setStatus(message, false);
  } catch (error) {
    const message = error.message || "Không cập nhật online được.";
    if (statusNode) {
      statusNode.textContent = message;
      statusNode.className = "config-note error";
    }
    setStatus(message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function stopCurrentTool() {
  try {
    const { data } = await api("/api/tools/stop", { method: "POST", body: "{}" });
    const toolName = data?.tool || "tool hien tai";
    setStatus(`Đã gửi lệnh dừng hẳn cho ${toolName}.`);
    if ($("fullStatusText") && state.activeModule === "full") $("fullStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
    if ($("postStatusText") && state.activeModule === "post") $("postStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
    if ($("passwordStatusText") && state.activeModule === "passwords") $("passwordStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
    if ($("notificationStatusText") && state.activeModule === "notifications") $("notificationStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
    if ($("checkOrderStatusText") && state.activeModule === "checkorder") $("checkOrderStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
    if ($("linkOrderStatusText") && state.activeModule === "linkorder") $("linkOrderStatusText").textContent = "Đã gửi lệnh dừng hẳn.";
  } catch (error) {
    setStatus(error.message || "Không gửi được lệnh dừng hẳn.", true);
  }
}

ensureReloadUiButton();
if ($("browserApiProvider")) {
  $("browserApiProvider").addEventListener("change", () => switchEngine($("browserApiProvider").value).catch((error) => setStatus(error.message, true)));
}
if ($("engineSwitchGpm")) $("engineSwitchGpm").addEventListener("click", () => switchEngine("gpm").catch((error) => setStatus(error.message, true)));
if ($("engineSwitchHide")) $("engineSwitchHide").addEventListener("click", () => switchEngine("hide").catch((error) => setStatus(error.message, true)));
$("saveConfig").addEventListener("click", saveConfig);
if ($("saveFullConfig")) $("saveFullConfig").addEventListener("click", saveConfig);
if ($("saveCheckOrderConfig")) $("saveCheckOrderConfig").addEventListener("click", saveConfig);
if ($("saveLinkOrderConfig")) $("saveLinkOrderConfig").addEventListener("click", saveConfig);
if ($("savePostConfig")) $("savePostConfig").addEventListener("click", savePostConfig);
if ($("saveInteractionConfig")) $("saveInteractionConfig").addEventListener("click", saveConfig);
if ($("savePageConfig")) $("savePageConfig").addEventListener("click", saveConfig);
if ($("saveAvatarConfig")) $("saveAvatarConfig").addEventListener("click", saveConfig);
if ($("saveProxyConfig")) $("saveProxyConfig").addEventListener("click", saveConfig);
if ($("stateProxyEnabled")) $("stateProxyEnabled").addEventListener("change", () => saveStateProxyConfig().catch((error) => setStatus(error.message, true)));
if ($("stateProxyProvider")) $("stateProxyProvider").addEventListener("change", () => {
  const nextConfig = { ...(state.config || {}), ...readProxyConfigForm() };
  renderStateProxyConfig(nextConfig);
  saveStateProxyConfig().catch((error) => setStatus(error.message, true));
});
if ($("saveStateProxyBtn")) $("saveStateProxyBtn").addEventListener("click", () => saveStateProxyConfig().catch((error) => setStatus(error.message, true)));
if ($("applyStateProxyBtn")) $("applyStateProxyBtn").addEventListener("click", () => applyStateProxyNow().catch((error) => {
  if ($("stateProxySummary")) $("stateProxySummary").textContent = error.message;
  setStatus(error.message, true);
  refreshStateProxyStatus().catch(() => {});
}));
if ($("checkStateProxyBtn")) $("checkStateProxyBtn").addEventListener("click", () => checkStateProxyPool().catch((error) => setStatus(error.message, true)));
if ($("toggleStateProxyPanelBtn")) $("toggleStateProxyPanelBtn").addEventListener("click", toggleStateProxyPanel);
if ($("addStateProxyBtn")) $("addStateProxyBtn").addEventListener("click", () => addStateProxyState().catch((error) => setStatus(error.message, true)));
if ($("addClipProxyAsnBtn")) $("addClipProxyAsnBtn").addEventListener("click", () => addClipProxyAsn().catch((error) => setStatus(error.message, true)));
if ($("clipProxyAsnList")) $("clipProxyAsnList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index || -1);
  const action = button.dataset.action;
  const task = action === "edit-clip-asn" ? editClipProxyAsn(index) : deleteClipProxyAsn(index);
  task.catch((error) => setStatus(error.message, true));
});
if ($("newClipProxyAsn")) $("newClipProxyAsn").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addClipProxyAsn().catch((error) => setStatus(error.message, true));
  }
});
if ($("newStateProxyState")) $("newStateProxyState").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addStateProxyState().catch((error) => setStatus(error.message, true));
  }
});
if ($("manualRestartBtn")) $("manualRestartBtn").addEventListener("click", restartBackend);
if ($("onlineUpdateBtn")) $("onlineUpdateBtn").addEventListener("click", updateOnline);
$("addSpreadsheetIdBtn").addEventListener("click", addSpreadsheetId);
$("newSpreadsheetId").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSpreadsheetId();
  }
});
if ($("reloadUiBtn")) $("reloadUiBtn").addEventListener("click", () => window.location.reload());
$("refreshBtn").addEventListener("click", refreshHide);
$("syncBtn").addEventListener("click", syncSheet);
if ($("reloadSheetCacheBtn")) $("reloadSheetCacheBtn").addEventListener("click", reloadSheetCache);
document.querySelectorAll(".module-item").forEach((button) => {
  button.addEventListener("click", () => setActiveModule(button.dataset.module || "profiles"));
});
if ($("runCheckOrderSelectedBtn")) $("runCheckOrderSelectedBtn").addEventListener("click", () => {
  startCheckOrder([...state.selectedCheckOrderIds]);
});
if ($("runCheckOrderFolderBtn")) $("runCheckOrderFolderBtn").addEventListener("click", () => {
  startCheckOrder(checkOrderProfiles().map((profile) => profile.id));
});
if ($("stopCheckOrderBtn")) $("stopCheckOrderBtn").addEventListener("click", stopCurrentTool);
if ($("runLinkOrderBtn")) $("runLinkOrderBtn").addEventListener("click", startLinkOrder);
if ($("stopLinkOrderBtn")) $("stopLinkOrderBtn").addEventListener("click", stopCurrentTool);
if ($("checkOrderSearchInput")) $("checkOrderSearchInput").addEventListener("input", (event) => {
  state.checkOrderSearchQuery = event.target.value;
  state.checkOrderBulkSearchQuery = event.target.value;
  renderCheckOrderRows();
});
if ($("clearCheckOrderSelectionBtn")) $("clearCheckOrderSelectionBtn").addEventListener("click", () => {
  state.selectedCheckOrderIds.clear();
  renderCheckOrderRows();
});
if ($("selectAllCheckOrderRows")) $("selectAllCheckOrderRows").addEventListener("change", (event) => {
  for (const profile of checkOrderProfiles()) {
    if (event.target.checked) state.selectedCheckOrderIds.add(profile.id);
    else state.selectedCheckOrderIds.delete(profile.id);
  }
  renderCheckOrderRows();
});
if ($("openLogsFromCheckOrderBtn")) $("openLogsFromCheckOrderBtn").addEventListener("click", () => setActiveModule("logs"));
if ($("openLogsFromLinkOrderBtn")) $("openLogsFromLinkOrderBtn").addEventListener("click", () => setActiveModule("logs"));
$("runNotificationSelectedBtn").addEventListener("click", () => {
  startCheckNotifications([...state.selectedNotificationIds]);
});
if ($("stopNotificationBtn")) $("stopNotificationBtn").addEventListener("click", stopCurrentTool);
$("runNotificationTodoBtn").addEventListener("click", () => {
  const ids = notificationProfiles().filter((profile) => !isNotificationDone(profile)).map((profile) => profile.id);
  startCheckNotifications(ids);
});
$("notificationSearchInput").addEventListener("input", (event) => {
  state.notificationSearchQuery = event.target.value;
  state.notificationBulkSearchQuery = event.target.value;
  renderNotificationRows();
});
$("notificationProgressFilter").addEventListener("change", (event) => {
  state.notificationProgressFilter = event.target.value;
  renderNotificationRows();
});
$("notificationResultFilter").addEventListener("change", (event) => {
  state.notificationResultFilter = event.target.value;
  renderNotificationRows();
});
$("refreshLogsBtn").addEventListener("click", refreshToolStatus);
$("openLogsModuleBtn").addEventListener("click", () => setActiveModule("logs"));
$("openLogsFromNotificationBtn").addEventListener("click", () => setActiveModule("logs"));
$("logSearchInput").addEventListener("input", (event) => {
  state.logSearchQuery = event.target.value;
  renderLogs();
});
$("logTypeFilter").addEventListener("change", (event) => {
  state.logTypeFilter = event.target.value;
  renderLogs();
});
$("logToolFilter").addEventListener("change", (event) => {
  state.logToolFilter = event.target.value;
  renderLogs();
});
$("clearLogFilterBtn").addEventListener("click", () => {
  state.logSearchQuery = "";
  state.logTypeFilter = "all";
  state.logToolFilter = "all";
  $("logSearchInput").value = "";
  $("logTypeFilter").value = "all";
  $("logToolFilter").value = "all";
  renderLogs();
});
$("clearNotificationSelectionBtn").addEventListener("click", () => {
  state.selectedNotificationIds.clear();
  renderNotificationRows();
});
$("selectAllNotificationRows").addEventListener("change", (event) => {
  for (const profile of notificationProfiles()) {
    if (event.target.checked) state.selectedNotificationIds.add(profile.id);
    else state.selectedNotificationIds.delete(profile.id);
  }
  renderNotificationRows();
});
$("runFullSelectedBtn").addEventListener("click", () => {
  startLamFull([...state.selectedFullIds]);
});
if ($("stopFullBtn")) $("stopFullBtn").addEventListener("click", stopCurrentTool);
$("runFullTodoBtn").addEventListener("click", () => {
  const ids = fullProfiles().filter((profile) => !isFullDone(profile)).map((profile) => profile.id);
  startLamFull(ids);
});
if ($("runPostSelectedBtn")) $("runPostSelectedBtn").addEventListener("click", () => {
  startDangBai([...state.selectedPostIds]);
});
if ($("stopPostBtn")) $("stopPostBtn").addEventListener("click", stopCurrentTool);
if ($("runPostTodoBtn")) $("runPostTodoBtn").addEventListener("click", () => {
  const ids = postProfiles().filter((profile) => !isPostDone(profile)).map((profile) => profile.id);
  startDangBai(ids);
});
if ($("runRenewStandaloneBtn")) $("runRenewStandaloneBtn").addEventListener("click", () => {
  startRenewStandalone([...state.selectedInteractionIds]);
});
if ($("runInteractionSelectedBtn")) $("runInteractionSelectedBtn").addEventListener("click", () => {
  startInteraction([...state.selectedInteractionIds]);
});
if ($("stopInteractionBtn")) $("stopInteractionBtn").addEventListener("click", stopCurrentTool);
if ($("runInteractionTodoBtn")) $("runInteractionTodoBtn").addEventListener("click", () => {
  const ids = interactionProfiles().filter((profile) => !isInteractionDone(profile)).map((profile) => profile.id);
  startInteraction(ids);
});
if ($("runPageSelectedBtn")) $("runPageSelectedBtn").addEventListener("click", () => {
  startCreatePage([...state.selectedPageIds]);
});
if ($("stopPageBtn")) $("stopPageBtn").addEventListener("click", stopCurrentTool);
if ($("runPageTodoBtn")) $("runPageTodoBtn").addEventListener("click", () => {
  const ids = pageProfiles().filter((profile) => !isPageDone(profile)).map((profile) => profile.id);
  startCreatePage(ids);
});
if ($("runAvatarSelectedBtn")) $("runAvatarSelectedBtn").addEventListener("click", () => {
  startAvatar([...state.selectedAvatarIds]);
});
if ($("stopAvatarBtn")) $("stopAvatarBtn").addEventListener("click", stopCurrentTool);
if ($("runAvatarTodoBtn")) $("runAvatarTodoBtn").addEventListener("click", () => {
  const ids = avatarProfiles().filter((profile) => !isAvatarDone(profile)).map((profile) => profile.id);
  startAvatar(ids);
});
if ($("runPasswordSelectedBtn")) $("runPasswordSelectedBtn").addEventListener("click", () => {
  startFillPasswords([...state.selectedPasswordIds]);
});
if ($("stopPasswordBtn")) $("stopPasswordBtn").addEventListener("click", stopCurrentTool);
if ($("runPasswordFolderBtn")) $("runPasswordFolderBtn").addEventListener("click", () => {
  startFillPasswords(passwordProfiles().map((profile) => profile.id));
});
if ($("runPasswordTodoBtn")) $("runPasswordTodoBtn").addEventListener("click", () => {
  startFillPasswords(passwordProfiles().filter((profile) => passwordMissing(profile)).map((profile) => profile.id));
});
if ($("prepareProxyBtn")) $("prepareProxyBtn").addEventListener("click", prepareProxyPorts);
if ($("checkProxyBtn")) $("checkProxyBtn").addEventListener("click", checkProxyPorts);
if ($("assignProxyBtn")) $("assignProxyBtn").addEventListener("click", assignProxyToSelected);
if ($("clearProxySelectionBtn")) $("clearProxySelectionBtn").addEventListener("click", () => {
  state.selectedProxyIds.clear();
  renderProxyRows();
});
if ($("selectAllProxyRows")) $("selectAllProxyRows").addEventListener("change", (event) => {
  for (const profile of proxyProfiles()) {
    if (event.target.checked) state.selectedProxyIds.add(profile.id);
    else state.selectedProxyIds.delete(profile.id);
  }
  renderProxyRows();
});
if ($("passwordSearchInput")) $("passwordSearchInput").addEventListener("input", (event) => {
  state.passwordSearchQuery = event.target.value;
  state.passwordBulkSearchQuery = event.target.value;
  renderPasswordRows();
});
if ($("clearPasswordSelectionBtn")) $("clearPasswordSelectionBtn").addEventListener("click", () => {
  state.selectedPasswordIds.clear();
  renderPasswordRows();
});
if ($("selectAllPasswordRows")) $("selectAllPasswordRows").addEventListener("change", (event) => {
  for (const profile of passwordProfiles()) {
    if (event.target.checked) state.selectedPasswordIds.add(profile.id);
    else state.selectedPasswordIds.delete(profile.id);
  }
  renderPasswordRows();
});
$("pauseFullBtn").addEventListener("click", async () => {
  try {
    await api("/api/tools/lam-full/pause", { method: "POST", body: "{}" });
    $("fullStatusText").textContent = "Đã gửi lệnh dừng tạm.";
  } catch (error) {
    $("fullStatusText").textContent = error.message;
  }
});
$("resumeFullBtn").addEventListener("click", async () => {
  try {
    await api("/api/tools/lam-full/resume", { method: "POST", body: "{}" });
    $("fullStatusText").textContent = "Đã gửi lệnh tiếp tục.";
  } catch (error) {
    $("fullStatusText").textContent = error.message;
  }
});
$("fullSearchInput").addEventListener("input", (event) => {
  state.fullSearchQuery = event.target.value;
  state.fullBulkSearchQuery = event.target.value;
  renderFullRows();
});
$("fullProgressFilter").addEventListener("change", (event) => {
  state.fullProgressFilter = event.target.value;
  renderFullRows();
});
$("fullResultFilter").addEventListener("change", (event) => {
  state.fullResultFilter = event.target.value;
  renderFullRows();
});
$("clearFullSelectionBtn").addEventListener("click", () => {
  state.selectedFullIds.clear();
  renderFullRows();
});
$("selectAllFullRows").addEventListener("change", (event) => {
  for (const profile of fullProfiles()) {
    if (event.target.checked) state.selectedFullIds.add(profile.id);
    else state.selectedFullIds.delete(profile.id);
  }
  renderFullRows();
});
if ($("postSearchInput")) $("postSearchInput").addEventListener("input", (event) => {
  state.postSearchQuery = event.target.value;
  state.postBulkSearchQuery = event.target.value;
  renderPostRows();
});
if ($("postProgressFilter")) $("postProgressFilter").addEventListener("change", (event) => {
  state.postProgressFilter = event.target.value;
  renderPostRows();
});
if ($("postResultFilter")) $("postResultFilter").addEventListener("change", (event) => {
  state.postResultFilter = event.target.value;
  renderPostRows();
});
if ($("clearPostSelectionBtn")) $("clearPostSelectionBtn").addEventListener("click", () => {
  state.selectedPostIds.clear();
  renderPostRows();
});
if ($("selectAllPostRows")) $("selectAllPostRows").addEventListener("change", (event) => {
  for (const profile of postProfiles()) {
    if (event.target.checked) state.selectedPostIds.add(profile.id);
    else state.selectedPostIds.delete(profile.id);
  }
  renderPostRows();
});
if ($("interactionSearchInput")) $("interactionSearchInput").addEventListener("input", (event) => {
  state.interactionSearchQuery = event.target.value;
  state.interactionBulkSearchQuery = event.target.value;
  renderInteractionRows();
});
if ($("interactionProgressFilter")) $("interactionProgressFilter").addEventListener("change", (event) => {
  state.interactionProgressFilter = event.target.value;
  renderInteractionRows();
});
if ($("interactionResultFilter")) $("interactionResultFilter").addEventListener("change", (event) => {
  state.interactionResultFilter = event.target.value;
  renderInteractionRows();
});
if ($("clearInteractionSelectionBtn")) $("clearInteractionSelectionBtn").addEventListener("click", () => {
  state.selectedInteractionIds.clear();
  renderInteractionRows();
});
if ($("selectAllInteractionRows")) $("selectAllInteractionRows").addEventListener("change", (event) => {
  for (const profile of interactionProfiles()) {
    if (event.target.checked) state.selectedInteractionIds.add(profile.id);
    else state.selectedInteractionIds.delete(profile.id);
  }
  renderInteractionRows();
});
if ($("pageSearchInput")) $("pageSearchInput").addEventListener("input", (event) => {
  state.pageSearchQuery = event.target.value;
  state.pageBulkSearchQuery = event.target.value;
  renderPageRows();
});
if ($("pageProgressFilter")) $("pageProgressFilter").addEventListener("change", (event) => {
  state.pageProgressFilter = event.target.value;
  renderPageRows();
});
if ($("pageResultFilter")) $("pageResultFilter").addEventListener("change", (event) => {
  state.pageResultFilter = event.target.value;
  renderPageRows();
});
if ($("clearPageSelectionBtn")) $("clearPageSelectionBtn").addEventListener("click", () => {
  state.selectedPageIds.clear();
  renderPageRows();
});
if ($("selectAllPageRows")) $("selectAllPageRows").addEventListener("change", (event) => {
  for (const profile of pageProfiles()) {
    if (event.target.checked) state.selectedPageIds.add(profile.id);
    else state.selectedPageIds.delete(profile.id);
  }
  renderPageRows();
});
if ($("avatarSearchInput")) $("avatarSearchInput").addEventListener("input", (event) => {
  state.avatarSearchQuery = event.target.value;
  state.avatarBulkSearchQuery = event.target.value;
  renderAvatarRows();
});
if ($("avatarProgressFilter")) $("avatarProgressFilter").addEventListener("change", (event) => {
  state.avatarProgressFilter = event.target.value;
  renderAvatarRows();
});
if ($("avatarResultFilter")) $("avatarResultFilter").addEventListener("change", (event) => {
  state.avatarResultFilter = event.target.value;
  renderAvatarRows();
});
if ($("clearAvatarSelectionBtn")) $("clearAvatarSelectionBtn").addEventListener("click", () => {
  state.selectedAvatarIds.clear();
  renderAvatarRows();
});
if ($("selectAllAvatarRows")) $("selectAllAvatarRows").addEventListener("change", (event) => {
  for (const profile of avatarProfiles()) {
    if (event.target.checked) state.selectedAvatarIds.add(profile.id);
    else state.selectedAvatarIds.delete(profile.id);
  }
  renderAvatarRows();
});
if ($("openLogsFromPasswordBtn")) $("openLogsFromPasswordBtn").addEventListener("click", () => setActiveModule("logs"));
$("openLogsFromFullBtn").addEventListener("click", () => setActiveModule("logs"));
if ($("openLogsFromPostBtn")) $("openLogsFromPostBtn").addEventListener("click", () => setActiveModule("logs"));
if ($("openLogsFromInteractionBtn")) $("openLogsFromInteractionBtn").addEventListener("click", () => setActiveModule("logs"));
if ($("openLogsFromPageBtn")) $("openLogsFromPageBtn").addEventListener("click", () => setActiveModule("logs"));
if ($("openLogsFromAvatarBtn")) $("openLogsFromAvatarBtn").addEventListener("click", () => setActiveModule("logs"));
$("searchInput").addEventListener("input", (event) => {
  state.searchQuery = event.target.value;
  state.bulkSearchQuery = event.target.value;
  renderRows();
});
$("sortKey").addEventListener("change", (event) => {
  state.sortKey = event.target.value;
  renderRows();
});
$("sortDir").addEventListener("change", (event) => {
  state.sortDir = event.target.value;
  renderRows();
});
$("clearSelectionBtn").addEventListener("click", () => {
  state.selectedIds.clear();
  renderRows();
});
$("selectAllRows").addEventListener("change", (event) => {
  for (const profile of visibleProfiles()) {
    if (event.target.checked) state.selectedIds.add(profile.id);
    else state.selectedIds.delete(profile.id);
  }
  renderRows();
});
document.querySelectorAll(".collapse-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    button.closest(".collapsible")?.classList.toggle("open");
  });
});

loadConfig()
  .then(() => refreshStateProxyStatus())
  .then(() => refreshHide({ silent: false }))
  .then(() => {
    scheduleHideRefresh();
    scheduleStateProxyRealtime();
  })
  .catch((error) => setStatus(error.message, true));
































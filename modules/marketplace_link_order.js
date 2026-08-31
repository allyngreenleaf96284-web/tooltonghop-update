const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clampNumber(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseSpreadsheetInput(value) {
  const text = String(value || "").trim();
  if (!text) return { spreadsheetId: "", gid: "" };
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const spreadsheetId = match?.[1] || text;
  let gid = "";
  try {
    const url = new URL(text);
    gid = url.searchParams.get("gid") || "";
    const hashGid = String(url.hash || "").match(/gid=([0-9]+)/);
    if (hashGid?.[1]) gid = hashGid[1];
  } catch {
    const gidMatch = text.match(/[?#&]gid=([0-9]+)/);
    if (gidMatch?.[1]) gid = gidMatch[1];
  }
  return { spreadsheetId, gid };
}

function normalizeProfileIdText(value) {
  return String(value || "").replace(/[\s\u200b-\u200d\ufeff]+/g, "").trim();
}

function columnName(index) {
  let n = Number(index) + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function sheetRange(title, colIndex, rowNumber) {
  const escaped = String(title || "").replace(/'/g, "''");
  const col = columnName(colIndex);
  return `'${escaped}'!${col}${rowNumber}`;
}

function findHeaderIndex(headers, names) {
  const wanted = new Set(names.map(normalizeHeader));
  return headers.findIndex((header) => wanted.has(normalizeHeader(header)));
}

async function ensureHeaders(client, title, values) {
  const headers = [...(values[0] || [])];
  const ensure = (name) => {
    let index = findHeaderIndex(headers, [name]);
    if (index >= 0) return index;
    headers.push(name);
    return headers.length - 1;
  };
  const uidIndex = findHeaderIndex(headers, ["uid"]);
  const linkIndex = findHeaderIndex(headers, ["link sp", "link", "link sản phẩm", "link san pham"]);
  if (linkIndex < 0) throw new Error("Sheet chua co cot LINK SP.");
  const nick1Index = ensure("tình trạng nick 1");
  const nick2Index = ensure("tình trạng nick 2");
  if ((values[0] || []).length !== headers.length || headers.some((value, index) => value !== values[0]?.[index])) {
    await client.updateRowValues(title, 1, headers);
    values[0] = headers;
  }
  return { headers, uidIndex, linkIndex, nick1Index, nick2Index };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeStatusLabel(value) {
  return normalizeText(value).toLowerCase();
}

function classifyUnavailableText(text) {
  const lower = normalizeStatusLabel(text)
    .replace(/[’`]/g, "'")
    .replace(/\u00a0/g, " ");
  const hasUnavailableTitle = /this listing is(?:n't| not) available any\s*more/.test(lower);
  const hasUnavailableReason =
    /it may have (?:expired or been sold|been sold or expired)/.test(lower) ||
    lower.includes("take a look at these other items below");
  return hasUnavailableTitle || hasUnavailableReason ? "hết hạn" : "";
}

function classifyText(text) {
  const unavailable = classifyUnavailableText(text);
  if (unavailable) return unavailable;
  const lower = normalizeStatusLabel(text);
  if (lower.includes("out of stock")) return "out of stock";
  if (lower.includes("buy now")) return "buy now";
  if (lower.includes("send seller a message")) return "send seller a message";
  return "không rõ";
}

async function waitForMarketplaceSignal(page, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 90000);
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      if (/this listing is(?:n't| not) available any\s*more/i.test(text)) return true;
      if (/buy now|out of stock|make an offer|send seller a message/i.test(text)) return true;
      if (/marketplace access|log in|login|checkpoint|confirm your identity/i.test(text)) return true;
      return false;
    }).catch(() => false);
    if (found) return;
    await sleep(750);
  }
}

async function classifyCurrentPage(page, timeoutMs) {
  await page.waitForSelector("body", { timeout: Math.min(timeoutMs, 30000) }).catch(() => {});
  await waitForMarketplaceSignal(page, timeoutMs);
  await sleep(3000);
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const lower = (value) => clean(value).toLowerCase().replace(/[’`]/g, "'");
    const bodyText = document.body?.innerText || "";
    const bodyLower = lower(bodyText);
    if (
      /this listing is(?:n't| not) available any\s*more/.test(bodyLower) ||
      /it may have (?:expired or been sold|been sold or expired)/.test(bodyLower) ||
      bodyLower.includes("take a look at these other items below")
    ) {
      return "hết hạn";
    }

    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const titleEl = Array.from(document.querySelectorAll("h1, h2"))
      .filter(visible)
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || ""), rect: el.getBoundingClientRect() }))
      .filter((item) => item.text && !/^marketplace$/i.test(item.text))
      .sort((a, b) => (b.rect.left - a.rect.left) || (a.rect.top - b.rect.top))[0];
    const titleText = titleEl?.text || "";
    const titleRect = titleEl?.rect || { left: Math.max(0, window.innerWidth * 0.55), top: 0, bottom: 0 };
    const actionWords = /^(buy now|make an offer|out of stock|send seller a message)$/i;
    const rawButtons = Array.from(document.querySelectorAll("[role='button'], button, a[role='button']"))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.getAttribute("aria-label") || el.textContent || "");
        const style = window.getComputedStyle(el);
        const disabled =
          el.disabled === true ||
          el.getAttribute("aria-disabled") === "true" ||
          el.getAttribute("disabled") !== null ||
          style.pointerEvents === "none";
        return {
          text,
          label: lower(text),
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          disabled,
          background: style.backgroundColor,
          color: style.color,
          opacity: Number(style.opacity || 1)
        };
      })
      .filter((item) => actionWords.test(item.text));

    const panelButtons = rawButtons
      .filter((item) => item.left >= Math.max(0, titleRect.left - 80))
      .filter((item) => item.top >= Math.max(0, titleRect.bottom - 20))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const buttons = panelButtons.length ? panelButtons : rawButtons.sort((a, b) => a.top - b.top || a.left - b.left);
    if (!buttons.length) return "";

    const outOfStock = buttons.find((item) => item.label === "out of stock");
    if (outOfStock) {
      const prefixMatch = titleText.match(/^\s*(pending|stock)\b/i);
      return prefixMatch ? `out of stock - ${prefixMatch[1].toLowerCase()}` : "out of stock";
    }

    const labels = [];
    for (const item of buttons) {
      if (item.label === "buy now") {
        const isGray =
          item.disabled ||
          item.opacity < 0.75 ||
          /rgba?\(\s*(?:229|228|218|216|206|204|198|196|190|189|180|176|170|166|160|150|140|130|120)/i.test(item.background);
        labels.push(isGray ? "thâm buy now" : "buy now");
      } else {
        labels.push(item.label);
      }
    }
    return Array.from(new Set(labels)).join("- ");
  }).catch(() => "");
  return result || classifyText(await page.evaluate(() => document.body?.innerText || "").catch(() => ""));
}

async function classifyPage(page, url, timeoutMs) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  return classifyCurrentPage(page, timeoutMs);
}

export function createMarketplaceLinkOrderTool({
  getHideManager,
  dangNhap,
  buildToolRow,
  getRowsByProfileIds,
  getGoogleAccessToken,
  SheetsClient,
  addRuntimeLog,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "check link order",
      step,
      detail
    });
  }

  function stoppedError() {
    const error = new Error("Da nhan lenh dung, dung check link order.");
    error.status = "stopped";
    return error;
  }

  async function readPlan(config) {
    const sheetInput = parseSpreadsheetInput(config.marketplaceCheckSpreadsheetId || config.checkOrderSpreadsheetId || "");
    const spreadsheetId = sheetInput.spreadsheetId;
    if (!spreadsheetId) throw new Error("Chua nhap link/ID Sheet check link order.");
    if (!String(config.credentialsPath || "").trim()) throw new Error("Chua cau hinh Service Account JSON.");
    const token = await getGoogleAccessToken(config.credentialsPath);
    const client = new SheetsClient({ ...config, spreadsheetId }, token);
    const meta = await client.metadata();
    const sheets = meta.sheets || [];
    const titles = sheets.map((sheet) => sheet.properties?.title).filter(Boolean);
    const gidTitle = sheetInput.gid
      ? sheets.find((sheet) => String(sheet.properties?.sheetId ?? "") === String(sheetInput.gid))?.properties?.title || ""
      : "";
    const title = gidTitle || String(config.marketplaceCheckSheetName || "").trim() || titles[0];
    if (!title) throw new Error("Khong tim thay tab Sheet de check.");
    const values = await client.getValues(title);
    if (!values.length) throw new Error("Sheet dang trong.");
    const indexes = await ensureHeaders(client, title, values);
    return { client, title, gid: sheetInput.gid, values, ...indexes };
  }

  function buildTasks(values, linkIndex, statusIndex) {
    const tasks = [];
    for (let index = 1; index < values.length; index += 1) {
      const row = values[index] || [];
      const link = String(row[linkIndex] || "").trim();
      const status = String(row[statusIndex] || "").trim();
      if (!link || (status && !shouldRetryStatus(status))) continue;
      tasks.push({ rowNumber: index + 1, link });
    }
    return tasks;
  }

  async function writeStatus(client, title, statusIndex, task, status) {
    await client.batchUpdateValues([{
      range: sheetRange(title, statusIndex, task.rowNumber),
      values: [[status]]
    }]);
  }

  function shouldRetryStatus(status) {
    const text = normalizeStatusLabel(status);
    return text === "không rõ" || text === "khong ro" || text === "lỗi check" || text === "loi check";
  }

  async function checkTaskWithRetry(browser, currentPage, task, timeoutMs, profileId, nickLabel, label, workerSlot, workerTotal) {
    let page = currentPage;
    let lastStatus = "";
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (attempt === 1) {
          log(profileId, "check link", `${label} mo link lan 1`);
          lastStatus = await classifyPage(page, task.link, timeoutMs);
        } else if (attempt === 2) {
          log(profileId, "check link", `${label} ra ${lastStatus || lastError || "khong ro"}, F5 lai lan 2`, "warn");
          await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
          lastStatus = await classifyCurrentPage(page, timeoutMs);
        } else {
          log(profileId, "check link", `${label} van ${lastStatus || lastError || "khong ro"}, dong tab mo tab moi lan 3`, "warn");
          await page.close({ runBeforeUnload: false }).catch(() => {});
          page = await browser.newPage();
          await applyWindowTiling(browser, page, workerSlot, workerTotal);
          lastStatus = await classifyPage(page, task.link, timeoutMs);
        }
        lastError = "";
      } catch (error) {
        lastError = error.message || String(error);
        lastStatus = "lỗi check";
        log(profileId, "check link", `${label} lan ${attempt} loi: ${lastError}`, "warn");
      }
      if (!shouldRetryStatus(lastStatus)) return { status: lastStatus, page };
    }
    return { status: lastStatus || "lỗi check", page };
  }

  function tileBounds(workerSlot = 0, workerTotal = 2) {
    const total = Math.max(1, Math.min(2, Number(workerTotal || 2)));
    const slot = Math.max(0, Math.min(total - 1, Number(workerSlot || 0)));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    return { left: slot === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
  }

  async function applyWindowTiling(browser, page, workerSlot, workerTotal) {
    const bounds = tileBounds(workerSlot, workerTotal);
    await page.setViewport?.({
      width: Math.max(760, bounds.width - 24),
      height: Math.max(640, bounds.height - 120),
      deviceScaleFactor: 1
    }).catch(() => {});
    try {
      const session = await page.target().createCDPSession();
      const info = await session.send("Browser.getWindowForTarget").catch(() => null);
      if (info?.windowId !== undefined) {
        await session.send("Browser.setWindowBounds", {
          windowId: info.windowId,
          bounds: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            windowState: "normal"
          }
        }).catch(() => {});
      }
      await session.detach().catch(() => {});
    } catch {}
    return bounds;
  }

  async function ensureLoggedIn(manager, browser, profileId, nickLabel, row, workerSlot, workerTotal, job) {
    const page = await browser.newPage();
    const bounds = await applyWindowTiling(browser, page, workerSlot, workerTotal);
    try {
      if (job) job.liveStatus = `${nickLabel}: dang kiem tra dang nhap`;
      log(profileId, "dang nhap Facebook", `${nickLabel} dang kiem tra dang nhap truoc khi check link, uid=${row.uid || profileId}`);
      await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
        if (job) job.liveStatus = `${nickLabel}: ${status}`;
        log(profileId, "dang nhap Facebook", status);
      });
      log(profileId, "dang nhap Facebook", `${nickLabel} da dang nhap Facebook, bounds=${bounds.width}x${bounds.height}`, "success");
      return page;
    } catch (error) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      throw error;
    }
  }

  async function runNick({ profileId, nickLabel, statusIndex, sheetRow, config, plan, tabCount, workerSlot = 0, workerTotal = 2 }) {
    const manager = getHideManager();
    if (manager) {
      manager.__profileConfig = async () => ({ ...config, browserApiProvider: "hide" });
    }
    const row = typeof buildToolRow === "function"
      ? buildToolRow(profileId, sheetRow || {})
      : { uid: String(sheetRow?.uid || profileId).trim(), profile_id: profileId, raw: { ...(sheetRow || {}) } };
    row.profile_id = profileId;
    const tasks = buildTasks(plan.values, plan.linkIndex, statusIndex);
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let loginPage = null;
    let checked = 0;
    let cursor = 0;
    try {
      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid: row.uid || profileId, shouldFinish: () => false });
      browser = await manager.connectBrowser(profileId);
      loginPage = await ensureLoggedIn(manager, browser, profileId, nickLabel, row, workerSlot, workerTotal, job);
      if (job) {
        job.status = "running";
        job.liveStatus = `${nickLabel}: con ${tasks.length} link`;
      }
      const timeoutMs = clampNumber(config.marketplaceCheckTimeoutMs, 90000, 30000, 240000);
      const workers = Array.from({ length: Math.min(tabCount, Math.max(1, tasks.length)) }, async (_, workerIndex) => {
        let page = await browser.newPage();
        await applyWindowTiling(browser, page, workerSlot, workerTotal);
        try {
          while (cursor < tasks.length) {
            if (runtime.stopRequested) throw stoppedError();
            const task = tasks[cursor++];
            const label = `${nickLabel} row ${task.rowNumber}`;
            if (job) job.liveStatus = `${label} (${checked}/${tasks.length})`;
            log(profileId, "check link", `bat dau ${label}: ${task.link}`);
            let status = "";
            const checkedTask = await checkTaskWithRetry(browser, page, task, timeoutMs, profileId, nickLabel, label, workerSlot, workerTotal);
            status = checkedTask.status;
            page = checkedTask.page;
            await writeStatus(plan.client, plan.title, statusIndex, task, status);
            checked += 1;
            log(profileId, "ghi Sheet", `${label} => ${status}`, status === "lỗi check" ? "warn" : "success");
          }
        } finally {
          await page.close({ runBeforeUnload: false }).catch(() => {});
        }
      });
      await Promise.all(workers);
      if (job) {
        job.status = "success";
        job.liveStatus = `${nickLabel}: xong ${checked}/${tasks.length}`;
        job.result = { checked, total: tasks.length };
      }
      return { profileId, checked, total: tasks.length };
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = `${nickLabel}: da dung, da ghi den dong gan nhat`;
        }
        return { profileId, stopped: true, checked, total: tasks.length };
      }
      if (job) {
        job.status = "error";
        job.liveStatus = error.message || "loi check link order";
      }
      log(profileId, "loi tong", `${nickLabel} loi: ${error.message || error}`, "error");
      return { profileId, error: error.message || String(error), checked, total: tasks.length };
    } finally {
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (loginPage && !loginPage.isClosed()) await loginPage.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function run(config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const nick1 = String(config.marketplaceCheckNick1Id || "").trim();
    const nick2 = String(config.marketplaceCheckNick2Id || "").trim();
    if (!nick1 && !nick2) throw new Error("Chua nhap ID Hide nick 1 hoac nick 2.");
    const tabCount = clampNumber(config.marketplaceCheckTabsPerNick, 5, 1, 20);
    const plan = await readPlan(config);
    const profiles = [
      nick1 ? { profileId: nick1, nickLabel: "nick 1", statusIndex: plan.nick1Index } : null,
      nick2 ? { profileId: nick2, nickLabel: "nick 2", statusIndex: plan.nick2Index } : null
    ].filter(Boolean);
    let sheetRows = typeof getRowsByProfileIds === "function"
      ? await getRowsByProfileIds(config, profiles.map((item) => item.profileId))
      : new Map();
    const missingBeforeRefresh = profiles.filter((item) => !sheetRows.has(normalizeProfileIdText(item.profileId)));
    if (missingBeforeRefresh.length && typeof getRowsByProfileIds === "function") {
      log("", "doc Sheet profile", `khong thay ${missingBeforeRefresh.length} ID Hide trong cache, dang tai lai Sheet quan ly profile...`, "warn");
      sheetRows = await getRowsByProfileIds(config, profiles.map((item) => item.profileId), {
        forceRefresh: true,
        source: "link-order-profile-miss"
      });
    }

    for (const item of profiles) {
      const sheetRow = sheetRows.get(normalizeProfileIdText(item.profileId));
      if (!sheetRow) {
        throw new Error(`Khong tim thay ID Hide ${item.profileId} trong Sheet quan ly profile. Hay bam Cap nhat HideMyAcc -- Sheet hoac Tai lai cache Sheet truoc khi chay.`);
      }
      item.sheetRow = sheetRow;
    }

    for (const item of profiles) {
      runtime.jobs.set(item.profileId, {
        profileId: item.profileId,
        tool: "check link order",
        status: "queued",
        liveStatus: `${item.nickLabel}: dang cho chay ${tabCount} tab`,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: "",
        result: null
      });
      log(item.profileId, "xep hang", `${item.nickLabel} da xep hang ${tabCount} tab`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "check link order";
    setImmediate(async () => {
      try {
        await Promise.all(profiles.map((item, index) => runNick({
          ...item,
          config,
          plan,
          tabCount,
          workerSlot: index,
          workerTotal: profiles.length
        })));
      } finally {
        runtime.running = false;
        runtime.currentTool = "";
      }
    });
    return { started: profiles.length, profileIds: profiles.map((item) => item.profileId), sheetTitle: plan.title, tabsPerNick: tabCount };
  }

  return { run };
}

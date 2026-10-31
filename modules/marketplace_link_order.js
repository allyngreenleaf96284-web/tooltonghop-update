import { withFacebookLocale, isMarketplaceIneligibleError, assertMarketplaceAccess } from "./facebook_locale.js";
import { installLightLinkCheck, createLinkCheckProgress } from "./link_check_light.js";
import { runHttpLinkChecks } from "./link_http_runner.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LINK_ORDER_RESTART_DELAY_MS = 60 * 1000;

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
  if ((values[0] || []).length !== headers.length || headers.some((value, index) => value !== values[0]?.[index])) {
    await client.updateRowValues(title, 1, headers);
    values[0] = headers;
  }
  return { headers, uidIndex, linkIndex, nick1Index };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeStatusLabel(value) {
  return normalizeText(value).toLowerCase();
}

export async function classifyCurrentPage(page, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (page.isClosed()) throw new Error("Tab check link da dong.");
    await assertMarketplaceAccess(page);
    const result = await readCurrentMarketplaceStatus(page);
    await assertMarketplaceAccess(page);
    if (result && result !== "không rõ") return result;
    if (Date.now() >= deadline) return "không rõ";
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function readCurrentMarketplaceStatus(page) {
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
    const titleEl = Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
      .filter(visible)
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || ""), rect: el.getBoundingClientRect() }))
      .filter((item) => item.text && !/^marketplace$/i.test(item.text))
      .sort((a, b) => (b.rect.left - a.rect.left) || (a.rect.top - b.rect.top))[0];
    const titleText = titleEl?.text || "";
    // New Marketplace layout places the status before the listing title,
    // without an Out of stock button. Require the UI separator, not a word
    // appearing somewhere in a product description or product name.
    const titleStatus = titleText.match(/^(pending|sold)\s*[·•]\s*\S/i);
    if (titleStatus) return titleStatus[1].toLowerCase();
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
  return result;
}

async function classifyPage(page, url, timeoutMs) {
  await page.goto(withFacebookLocale(url), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  return classifyCurrentPage(page, timeoutMs);
}

export function partitionLinkTasks(tasks, count) {
  const buckets = Array.from({ length: Math.max(1, count) }, () => []);
  tasks.forEach((task, index) => buckets[index % buckets.length].push(task));
  return buckets;
}

export function linkCheckProfileIds(config) {
  return [...new Set([config.marketplaceCheckNick1Id, config.marketplaceCheckNick2Id,
    ...(Array.isArray(config.marketplaceCheckExtraNickIds) ? config.marketplaceCheckExtraNickIds : [])]
    .map(normalizeProfileIdText).filter(Boolean))];
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

  async function readPlan(config, spreadsheetValue = "") {
    const sheetInput = parseSpreadsheetInput(spreadsheetValue || config.marketplaceCheckSpreadsheetId || config.checkOrderSpreadsheetId || "");
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
    const sheetId = sheets.find((sheet) => sheet.properties?.title === title)?.properties?.sheetId;
    return { client, title, gid: sheetInput.gid, spreadsheetId, sheetId, values, ...indexes };
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

  function createSharedQueue(plan, participantCount) {
    const tasks = buildTasks(plan.values, plan.linkIndex, plan.nick1Index);
    return {
      tasks,
      partitions: partitionLinkTasks(tasks, participantCount),
      first: 0,
      last: tasks.length - 1,
      total: tasks.length,
      participantCount: Math.max(1, participantCount),
      completedParticipants: 0,
      waiters: [],
      aborted: false,
      abortReason: ""
    };
  }

  function claimSharedTask(queue, workerSlot) {
    if (queue.aborted) return null;
    return queue.partitions[workerSlot]?.shift() || null;
  }

  function releaseQueueWaiters(queue) {
    const waiters = queue.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function abortSharedQueues(plans, reason) {
    for (const plan of plans) {
      const queue = plan.sharedQueue;
      if (!queue || queue.aborted) continue;
      queue.aborted = true;
      queue.abortReason = reason || "Da dung check link order.";
      releaseQueueWaiters(queue);
    }
  }

  async function waitForSheetPeers(queue) {
    if (queue.aborted) throw new Error(queue.abortReason);
    queue.completedParticipants += 1;
    if (queue.completedParticipants >= queue.participantCount) {
      releaseQueueWaiters(queue);
      return;
    }
    await new Promise((resolve) => queue.waiters.push(resolve));
    if (queue.aborted) throw new Error(queue.abortReason);
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
          await installLightLinkCheck(page);
          await applyWindowTiling(browser, page, workerSlot, workerTotal);
          lastStatus = await classifyPage(page, task.link, timeoutMs);
        }
        await assertMarketplaceAccess(page);
        lastError = "";
      } catch (error) {
        if (isMarketplaceIneligibleError(error)) {
          if (page !== currentPage) await page.close({ runBeforeUnload: false }).catch(() => {});
          throw error;
        }
        lastError = error.message || String(error);
        lastStatus = "lỗi check";
        log(profileId, "check link", `${label} lan ${attempt} loi: ${lastError}`, "warn");
      }
      if (!shouldRetryStatus(lastStatus)) return { status: lastStatus, page };
    }
    return { status: lastStatus || "lỗi check", page };
  }

  function tileBounds(workerSlot = 0, workerTotal = 2) {
    const total = Math.max(1, Number(workerTotal || 1));
    const slot = Math.max(0, Math.min(total - 1, Number(workerSlot || 0)));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    const columns = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / columns);
    const width = Math.floor(1920 / columns), height = Math.floor(980 / rows);
    return { left: (slot % columns) * width, top: Math.floor(slot / columns) * height, width, height };
  }

  async function applyWindowTiling(browser, page, workerSlot, workerTotal) {
    const bounds = tileBounds(workerSlot, workerTotal);
    await page.setViewport?.({
      width: Math.max(320, bounds.width - 24),
      height: Math.max(240, bounds.height - 120),
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

  async function runNick({ profileId, nickLabel, direction, sheetRow, config, plans, tabCount, progress, workerSlot = 0, workerTotal = 2 }) {
    const manager = getHideManager();
    if (manager) {
      manager.__profileConfig = async () => ({ ...config, browserApiProvider: "hide" });
    }
    const row = typeof buildToolRow === "function"
      ? buildToolRow(profileId, sheetRow || {})
      : { uid: String(sheetRow?.uid || profileId).trim(), profile_id: profileId, raw: { ...(sheetRow || {}) } };
    row.profile_id = profileId;
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let loginPage = null;
    let checked = 0;
    let retryable = 0;
    let totalTasks = 0;
    try {
      progress.summary.activeProfiles += 1;
      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid: row.uid || profileId, shouldFinish: () => false });
      browser = await manager.connectBrowser(profileId);
      loginPage = await ensureLoggedIn(manager, browser, profileId, nickLabel, row, workerSlot, workerTotal, job);
      // Cookies remain in the profile; the idle login tab need not retain a
      // Facebook feed and its images while the check tabs do the work.
      await loginPage.goto("about:blank");
      if (job) {
        job.status = "running";
        job.liveStatus = `${nickLabel}: dang chay ${plans.length} Sheet`;
      }
      const timeoutMs = clampNumber(config.marketplaceCheckTimeoutMs, 90000, 30000, 240000);
      for (let sheetIndex = 0; sheetIndex < plans.length; sheetIndex += 1) {
        const plan = plans[sheetIndex];
        const queue = plan.sharedQueue;
        if (!queue) throw new Error("Khong tim thay hang doi chung cua Sheet.");
        if (queue.aborted) throw new Error(queue.abortReason || "Hang doi Sheet da dung.");
        totalTasks += queue.partitions[workerSlot]?.length || 0;
        const sheetLabel = `Sheet ${sheetIndex + 1}/${plans.length} ${plan.title}`;
        if (job) job.liveStatus = `${nickLabel}: ${sheetLabel}, duoc chia ${queue.partitions[workerSlot]?.length || 0}/${queue.total} link`;
        log(profileId, "xep hang", `${nickLabel} bat dau ${sheetLabel}, xu ly phan link duoc chia rieng`);
        const workers = Array.from({ length: Math.min(tabCount, queue.partitions[workerSlot]?.length || 0) }, async (_, workerIndex) => {
          let page = await browser.newPage();
          try {
            await installLightLinkCheck(page);
            await applyWindowTiling(browser, page, workerSlot, workerTotal);
            while (true) {
              if (runtime.stopRequested) throw stoppedError();
              if (queue.aborted) throw new Error(queue.abortReason || "Hang doi Sheet da dung.");
              const task = claimSharedTask(queue, workerSlot);
              if (!task) break;
              const label = `${nickLabel} ${sheetLabel} row ${task.rowNumber}`;
              if (job) job.liveStatus = `${label} (${checked}/${totalTasks})`;
              log(profileId, "check link", `bat dau ${label}: ${task.link}`);
              progress.summary.inFlight += 1;
              progress.summary.attempts += 1;
              try {
                let status = "";
                const checkedTask = await checkTaskWithRetry(browser, page, task, timeoutMs, profileId, nickLabel, label, workerSlot, workerTotal);
                status = checkedTask.status;
                page = checkedTask.page;
                await page.goto("about:blank").catch(() => {});
                await writeStatus(plan.client, plan.title, plan.nick1Index, task, status);
                progress.wrote(plan, task, status);
                checked += 1;
                if (shouldRetryStatus(status)) retryable += 1;
                if (job) job.liveStatus = `${nickLabel}: da check ${checked}/${totalTasks}; ${status}`;
                log(profileId, "ghi Sheet", `${label} => ${status}`, status === "lỗi check" ? "warn" : "success");
              } finally {
                progress.summary.inFlight -= 1;
                // Unload scripts/DOM between links (including during slow
                // Sheet writes or peer barriers), retaining this reusable tab.
                if (!page.isClosed() && page.url() !== "about:blank") await page.goto("about:blank").catch(() => {});
              }
            }
          } finally {
            await page.close({ runBeforeUnload: false }).catch(() => {});
          }
        });
        // Drain every tab before a retry pass can reload and redistribute rows.
        const results = await Promise.allSettled(workers.map((work) => work.catch((error) => {
          abortSharedQueues(plans, error.message || String(error));
          throw error;
        })));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        await assertMarketplaceAccess(loginPage);
        await waitForSheetPeers(queue);
      }
      if (job) {
        job.status = "success";
        job.liveStatus = `${nickLabel}: xong ${checked}/${totalTasks}`;
        job.result = { checked, total: totalTasks, retryable, sheets: plans.length };
      }
      return { profileId, checked, total: totalTasks, retryable, sheets: plans.length };
    } catch (error) {
      abortSharedQueues(plans, error.message || String(error));
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = `${nickLabel}: da dung, da ghi den dong gan nhat`;
        }
        return { profileId, stopped: true, checked, total: totalTasks };
      }
      if (job) {
        job.status = "error";
        job.liveStatus = error.message || "loi check link order";
        if (browser?.__marketplaceAccess?.error) job.result = { trangThai: "die cho", chiTiet: error.message };
        else if (browser?.__loginCaptcha?.error) job.result = { trangThai: "capcha", chiTiet: error.message };
      }
      log(profileId, "loi tong", `${nickLabel} loi: ${error.message || error}`, "error");
      return { profileId, error: error.message || String(error), checked, total: totalTasks, permanent: Boolean(browser?.__marketplaceAccess?.error) };
    } finally {
      progress.summary.activeProfiles -= 1;
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (loginPage && !loginPage.isClosed()) await loginPage.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function run(config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    if (config.marketplaceCheckMode === "http") return runHttpLinkChecks({config,readPlan,runtime,log});
    const ids = linkCheckProfileIds(config);
    if (!ids.length) throw new Error("Chua nhap ID profile nick check.");
    const tabCount = clampNumber(config.marketplaceCheckTabsPerNick, 5, 1, 20);
    const profiles = ids.map((profileId, index) => ({ profileId, nickLabel: `nick ${index + 1}`, direction: "asc" }));

    const loadPlans = async (participantCount = profiles.length) => {
      const sheetInputs = Array.isArray(config.marketplaceCheckSpreadsheetIds) && config.marketplaceCheckSpreadsheetIds.length
        ? config.marketplaceCheckSpreadsheetIds
        : [config.marketplaceCheckSpreadsheetId || config.checkOrderSpreadsheetId || ""];
      const plans = [];
      const seenSheets = new Set();
      for (const sheetInput of sheetInputs) {
        const plan = await readPlan(config, sheetInput);
        const key = `${plan.spreadsheetId || sheetInput}|${plan.title}`;
        if (!seenSheets.has(key)) {
          seenSheets.add(key);
          plans.push(plan);
        }
      }
      if (!plans.length) throw new Error("Chua nhap link/ID Sheet check link order.");
      for (const plan of plans) plan.sharedQueue = createSharedQueue(plan, participantCount);
      return plans;
    };

    const plans = await loadPlans();
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

    const progress = createLinkCheckProgress(runtime, profiles.length, shouldRetryStatus);
    progress.register(plans);
    for (const item of profiles) {
      runtime.jobs.set(item.profileId, {
        profileId: item.profileId,
        tool: "check link order",
        status: "queued",
        liveStatus: `${item.nickLabel}: phan link duoc chia rieng, dang cho chay ${tabCount} tab`,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: "",
        result: null
      });
      log(item.profileId, "xep hang", `${item.nickLabel} da xep hang ${tabCount} tab, lay link phan link duoc chia rieng.`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "check link order";
    setImmediate(async () => {
      let pass = 0;
      let activeProfiles = [...profiles];
      try {
        while (!runtime.stopRequested) {
          pass += 1;
          progress.summary.pass = pass;
          let currentPlans = plans;
          try {
            if (pass > 1) currentPlans = await loadPlans(activeProfiles.length);
            progress.register(currentPlans);
            const pendingLinks = currentPlans.reduce((total, plan) => total + Number(plan.sharedQueue?.total || 0), 0);
            if (!pendingLinks) break;
            if (pass > 1) {
              for (const item of activeProfiles) {
                const job = runtime.jobs.get(item.profileId);
                if (!job) continue;
                job.status = "running";
                job.liveStatus = `${item.nickLabel}: tu dong mo lai luot ${pass}, con ${pendingLinks} link can check`;
              }
              log("", "tu dong chay lai", `bat dau luot ${pass}, con ${pendingLinks} link loi check/khong ro can xu ly`, "warn");
            }
            const results = await Promise.all(activeProfiles.map((item, index) => runNick({
              ...item,
              config,
              plans: currentPlans,
              tabCount,
              progress,
              direction: item.direction,
              workerSlot: index,
              workerTotal: activeProfiles.length
            })));
            if (runtime.stopRequested) break;
            const blockedIds = new Set(results.filter((result) => result.permanent).map((result) => result.profileId));
            activeProfiles = activeProfiles.filter((item) => !blockedIds.has(item.profileId));
            if (!activeProfiles.length) break;
            const retryable = results.reduce((total, result) => total + Number(result?.retryable || 0), 0);
            const errors = results.filter((result) => result?.error && !result.permanent);
            if (!retryable && !errors.length) break;
            const reason = errors.length
              ? `${errors.length} nick/browser loi`
              : `${retryable} link van la khong ro/loi check sau 3 lan`;
            for (const item of activeProfiles) {
              const job = runtime.jobs.get(item.profileId);
              if (!job) continue;
              job.status = "running";
              job.liveStatus = `${item.nickLabel}: ${reason}, cho 60 giay de tu mo lai`;
            }
            log("", "tu dong chay lai", `${reason}; cho 60 giay roi tu dong mo lai luot ${pass + 1}.`, "warn");
          } catch (error) {
            if (runtime.stopRequested) break;
            const reason = error?.message || String(error);
            for (const item of activeProfiles) {
              const job = runtime.jobs.get(item.profileId);
              if (!job) continue;
              job.status = "running";
              job.liveStatus = `${item.nickLabel}: loi ${reason}, cho 60 giay de tu mo lai`;
            }
            log("", "tu dong chay lai", `luot ${pass} loi: ${reason}; cho 60 giay roi tu dong mo lai.`, "warn");
          }

          const restartAt = Date.now() + LINK_ORDER_RESTART_DELAY_MS;
          while (!runtime.stopRequested && Date.now() < restartAt) {
            const seconds = Math.max(1, Math.ceil((restartAt - Date.now()) / 1000));
            for (const item of activeProfiles) {
              const job = runtime.jobs.get(item.profileId);
              if (job) job.liveStatus = `${item.nickLabel}: cho ${seconds}s de tu mo lai check link`;
            }
            await sleep(Math.min(1000, restartAt - Date.now()));
          }
        }
        if (runtime.stopRequested) {
          for (const item of activeProfiles) {
            const job = runtime.jobs.get(item.profileId);
            if (!job) continue;
            job.status = "stopped";
            job.liveStatus = `${item.nickLabel}: da dung han theo yeu cau`;
          }
        }
      } finally {
        progress.finish();
        runtime.running = false;
        runtime.currentTool = "";
      }
    });
    return { started: profiles.length, profileIds: profiles.map((item) => item.profileId), sheetTitles: plans.map((plan) => plan.title), sheets: plans.length, tabsPerNick: tabCount };
  }

  return { run };
}

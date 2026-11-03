import { withFacebookLocale, isMarketplaceIneligibleError, assertMarketplaceAccess } from "./facebook_locale.js";
import { installLightLinkCheck, createLinkCheckProgress } from "./link_check_light.js";
import { prepareLinkCheckScrolling, recoverLinkCheckScroll } from "./link_check_scroll.js";
import { createLinkSheetWriter } from "./link_check_writer.js";
import { createLinkCheckDisplay, openCheckWindow } from "./link_check_display.js";

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
  let previous = "", stableSince = Date.now();
  let scrollPhase = 0, nextScrollAt = Date.now() + 750;
  for (;;) {
    if (page.isClosed()) throw new Error("Tab check link da dong.");
    await assertMarketplaceAccess(page);
    const reading = await readCurrentMarketplaceStatus(page);
    const result = typeof reading === "string" ? reading : reading.status;
    const messageWaitMs = reading?.confirmedComposer ? 750 : 8000;
    await assertMarketplaceAccess(page);
    if (result !== previous) { previous = result; stableSince = Date.now(); }
    if (result && result !== "không rõ" && (!/thâm buy now/i.test(result) || Date.now() - stableSince >= 2000) && (result !== "send seller a message" || Date.now() - stableSince >= messageWaitMs)) return result;
    if (Date.now() >= deadline) return "không rõ";
    if (!result && scrollPhase < 5 && Date.now() >= nextScrollAt) {
      await recoverLinkCheckScroll(page, scrollPhase++);
      nextScrollAt = Date.now() + 750;
    }
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function readCurrentMarketplaceStatus(page) {
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const lower = (value) => clean(value).toLowerCase().replace(/[’`]/g, "'");
    const currentUrl=new URL(location.href);
    if(/(^|\.)facebook\.com$/i.test(currentUrl.hostname) && currentUrl.pathname.startsWith("/marketplace/") && currentUrl.searchParams.get("unavailable_product")==="1") return "hết hạn";
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
      if (!el || el.closest('[aria-hidden="true"], [inert]')) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const titleEl = Array.from(document.querySelectorAll("h1, h2, [role='heading']"))
      .filter(visible)
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || ""), rect: el.getBoundingClientRect() }))
      .filter((item) => item.text && !item.el.closest('aside,nav,[role="navigation"],[role="feed"]')
        && !/^(marketplace|details|seller information|today.s picks|related items|recommended(?: for you)?|shipping (?:and|&) returns)$/i.test(item.text))
      .sort((a, b) => Number(b.el.matches('h1,[aria-level="1"]')) - Number(a.el.matches('h1,[aria-level="1"]'))
        || (b.rect.left - a.rect.left) || (a.rect.top - b.rect.top))[0];
    const titleText = titleEl?.text || "";
    // New Marketplace layout places the status before the listing title,
    // without an Out of stock button. Require the UI separator, not a word
    // appearing somewhere in a product description or product name.
    const titleStatus = titleText.match(/^(pending|sold)\s*[·•]\s*\S/i);
    if (titleStatus) return titleStatus[1].toLowerCase();
    const titleRect = titleEl?.rect || { left: Math.max(0, window.innerWidth * 0.55), top: 0, bottom: 0 };
    const actionWords = /^(buy now|make an offer|out of stock|send seller a message|message)$/i;
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
          el,
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

    // Restrict actions to the closest product section when its DOM provides
    // one. Relative geometry remains valid even above/below the viewport.
    // Message may live in a small header wrapper while checkout actions are
    // siblings farther down the product panel. Do not scope to the first button.
    const panelButtons = rawButtons
      .filter(item => !item.el.closest('nav,[role="navigation"],[role="feed"]'))
      .filter((item) => item.left >= titleRect.left - 80)
      .filter((item) => item.top >= titleRect.bottom - 20)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const buttons = panelButtons;
    // Facebook also renders this as a composer label, not a button. Require
    // the actual input + Send control below the product title, rather than
    // matching words inside a description, sidebar or recommendation.
    const messageButton = panelButtons.some(item => /^(message|send seller a message)$/.test(item.label));
    const hasPurchaseAction = buttons.some(item => !/^(message|send seller a message)$/.test(item.label));
    const composerLabel = !hasPurchaseAction && titleEl && [...document.querySelectorAll("label, span, p, div")].some(el => {
      if (!visible(el) || lower(el.innerText || el.textContent) !== "send seller a message") return false;
      const rect = el.getBoundingClientRect();
      if (rect.left < titleRect.left - 80 || rect.top < titleRect.bottom - 20) return false;
      let parent = el.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 4; depth++, parent = parent.parentElement) {
        const input = [...parent.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"], [role="textbox"]')].some(visible);
        const send = [...parent.querySelectorAll('button, [role="button"]')].some(button => visible(button) && (/^send$/i.test(clean(button.innerText || button.textContent)) || /^send message to\s+\S/i.test(clean(button.getAttribute("aria-label")))));
        if (input && send) return true;
      }
      return false;
    });
    if (!buttons.length && !composerLabel) return "";

    const outOfStock = buttons.find((item) => item.label === "out of stock");
    if (outOfStock) {
      const prefixMatch = titleText.match(/^\s*(pending|stock)\b/i);
      return prefixMatch ? `out of stock - ${prefixMatch[1].toLowerCase()}` : "out of stock";
    }

    const labels = [];
    for (const item of buttons) {
      if (item.label === "buy now") {
        // Appearance is not evidence of disabled checkout: active secondary
        // buttons may be gray or translucent in Facebook's layouts/themes.
        const isGray = item.disabled;
        labels.push(isGray ? "thâm buy now" : "buy now");
      } else if (!/^(message|send seller a message)$/.test(item.label)) {
        labels.push(item.label);
      }
    }
    if (!labels.length && (messageButton || composerLabel)) labels.push("send seller a message");
    const status=Array.from(new Set(labels)).join("- ");
    return status === "send seller a message" && messageButton && composerLabel ? {status,confirmedComposer:true} : status;
  }).catch(() => "");
  return result;
}

export async function classifyPage(page, url, timeoutMs) {
  const started = Date.now();
  await prepareLinkCheckScrolling(page);
  const session=await page.target().createCDPSession();
  try {
    // Navigate to the new document without waiting for DOMContentLoaded or load.
    const navigation=await session.send("Page.navigate", {url:withFacebookLocale(url)});
    if(navigation.errorText)throw new Error(navigation.errorText);
    await page.waitForFunction(expected => location.pathname === new URL(expected).pathname || (location.pathname.startsWith("/marketplace/") && new URL(location.href).searchParams.get("unavailable_product")==="1") || /\/(login|checkpoint|two_step_verification|marketplace\/ineligible)\//.test(location.pathname), {timeout:Math.max(1,timeoutMs-(Date.now()-started))}, withFacebookLocale(url));
    const status=await classifyCurrentPage(page, Math.max(0,timeoutMs-(Date.now()-started)));
    // Discard remaining downloads/work for a result already identified.
    await session.send("Page.stopLoading").catch(()=>{});
    return status;
  } finally { await session.detach().catch(()=>{}); }
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
  runtime,
  journalPath,
  createWindowPage = openCheckWindow
}) {
  const checkDisplay = createLinkCheckDisplay();

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

  function buildTasks(values, linkIndex, statusIndex, includeUnknown = true) {
    const tasks = [];
    for (let index = 1; index < values.length; index += 1) {
      const row = values[index] || [];
      const link = String(row[linkIndex] || "").trim();
      const status = String(row[statusIndex] || "").trim();
      if (!link || (status && (!shouldRetryStatus(status) || (!includeUnknown && isUnknownStatus(status))))) continue;
      tasks.push({ rowNumber: index + 1, link });
    }
    return tasks;
  }

  function createSharedQueue(plan, participantCount, includeUnknown = true) {
    const tasks = buildTasks(plan.values, plan.linkIndex, plan.nick1Index, includeUnknown);
    return {
      tasks,
      cursor: 0,
      total: tasks.length,
      participantCount: Math.max(1, participantCount),
      completedParticipants: 0,
      waiters: [],
      aborted: false,
      abortReason: ""
    };
  }

  function claimSharedTask(queue) {
    if (queue.aborted) return null;
    return queue.tasks[queue.cursor++] || null;
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

  function isUnknownStatus(status) { return /^(không rõ|khong ro)$/i.test(String(status || "").trim()); }

  function shouldRetryStatus(status) {
    const text = normalizeStatusLabel(status);
    return text === "không rõ" || text === "khong ro" || text === "lỗi check" || text === "loi check";
  }

  async function checkTask(page, task, timeoutMs, profileId, label) {
    try {
      const status = await classifyPage(page, task.link, timeoutMs);
      await assertMarketplaceAccess(page);
      return status;
    } catch (error) {
      if (isMarketplaceIneligibleError(error)) throw error;
      log(profileId, "check link", `${label}: ${error.message || error}; de lai luot check lai`, "warn");
      return "lỗi check";
    }
  }

  async function applyWindowTiling(browser, page, workerSlot, workerTotal) {
    return checkDisplay.apply(page, workerSlot, workerTotal);
  }

  async function ensureLoggedIn(manager, browser, profileId, nickLabel, row, workerSlot, workerTotal, job) {
    const page = await browser.newPage();
    try {
      const bounds = await applyWindowTiling(browser, page, workerSlot, workerTotal);
      if (job) { job.status = "running"; job.liveStatus = `${nickLabel}: dang kiem tra dang nhap`; }
      log(profileId, "dang nhap Facebook", `${nickLabel} dang kiem tra dang nhap truoc khi check link, uid=${row.uid || profileId}`);
      await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
        if (job) job.liveStatus = `${nickLabel}: ${status}`;
        log(profileId, "dang nhap Facebook", status);
      }, { robustLanguage: true, shouldStop: () => runtime.stopRequested });
      await applyWindowTiling(browser, page, workerSlot, workerTotal);
      log(profileId, "dang nhap Facebook", `${nickLabel} da dang nhap Facebook, bounds=${bounds.width}x${bounds.height}`, "success");
      return page;
    } catch (error) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      throw error;
    }
  }

  async function runNick({ profileId, nickLabel, direction, sheetRow, config, plans, writer, progress, tabCount, workerSlot = 0, workerTotal = 2 }) {
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
    const checkPages = [];
    let checked = 0;
    let retryable = 0;
    let totalTasks = 0;
    try {
      progress.summary.activeProfiles += 1;
      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid: row.uid || profileId, shouldFinish: () => false });
      browser = await manager.connectBrowser(profileId);
      loginPage = await ensureLoggedIn(manager, browser, profileId, nickLabel, row, workerSlot * tabCount, workerTotal * tabCount, job);
      checkPages.push(loginPage);
      await installLightLinkCheck(loginPage);
      for (let index = 1; index < tabCount; index++) {
        if (runtime.stopRequested) throw stoppedError();
        const page = await createWindowPage(browser);
        checkPages.push(page);
        await installLightLinkCheck(page);
        await applyWindowTiling(browser, page, workerSlot * tabCount + index, workerTotal * tabCount);
      }
      if (job) {
        job.status = "running";
        job.liveStatus = `${nickLabel}: dang chay ${plans.length} Sheet`;
      }
      const timeoutMs = clampNumber(config.marketplaceCheckTimeoutMs, 30000, 10000, 240000);
      for (let sheetIndex = 0; sheetIndex < plans.length; sheetIndex += 1) {
        const plan = plans[sheetIndex];
        const queue = plan.sharedQueue;
        if (!queue) throw new Error("Khong tim thay hang doi chung cua Sheet.");
        if (queue.aborted) throw new Error(queue.abortReason || "Hang doi Sheet da dung.");
        totalTasks += queue.total;
        const sheetLabel = `Sheet ${sheetIndex + 1}/${plans.length} ${plan.title}`;
        if (job) job.liveStatus = `${nickLabel}: ${sheetLabel}, hang doi chung ${queue.total} link`;
        log(profileId, "xep hang", `${nickLabel} bat dau ${sheetLabel}, lay link tu hang doi chung`);
        const workers = checkPages.map(async (initialPage, pageIndex) => {
          let page=initialPage;
          let count=page.__linkCheckCount || 0;
          while (true) {
            if (runtime.stopRequested) throw stoppedError();
            if (queue.aborted) throw new Error(queue.abortReason || "Hang doi Sheet da dung.");
            const task = claimSharedTask(queue);
            if (!task) break;
            if(count>=100){
              const replacement=await createWindowPage(browser);
              try {
                await installLightLinkCheck(replacement);
                await applyWindowTiling(browser,replacement,workerSlot*tabCount+pageIndex,workerTotal*tabCount);
              }catch(error){await replacement.close({runBeforeUnload:false}).catch(()=>{});throw error;}
              checkPages[pageIndex]=replacement;
              if(loginPage===page)loginPage=replacement;
              await page.close({runBeforeUnload:false}).catch(()=>{});
              page=replacement;count=0;
              log(profileId,"doi tab",`${nickLabel}: thay cua so sau 100 link, giu nguyen phien dang nhap`,"info");
            }
            const label = `${nickLabel} ${sheetLabel} row ${task.rowNumber}`;
            if (job) job.liveStatus = `${label}; da check ${checked} link`;
            progress.startTask();
            progress.summary.inFlight += 1;
            progress.summary.attempts += 1;
            try {
              const checkStarted=Date.now();
              const status = await checkTask(page, task, timeoutMs, profileId, label);
              const checkFinished=Date.now();
              await writer.write(plan, task, status, "browser");
              progress.summary.sheetPending = writer.pendingCount; progress.summary.sheetReview = writer.reviewCount; progress.summary.sheetConfirmed = writer.confirmedCount; progress.summary.sheetLastWrite = writer.lastWrite;
              progress.wrote(plan, task, status, {checkMs:checkFinished-checkStarted,saveMs:Date.now()-checkFinished});
              checked += 1;
              page.__linkCheckCount=++count;
              if (shouldRetryStatus(status) && !isUnknownStatus(status)) retryable += 1;
              if (job) job.liveStatus = `${nickLabel}: da check ${checked} link; ${status}`;
              log(profileId, "check link", `${label} => ${status}; da luu cho ghi Sheet`, shouldRetryStatus(status) ? "warn" : "success");
            } finally {
              progress.summary.inFlight -= 1;
            }
          }
        });
        const results = await Promise.allSettled(workers.map(work => work.catch(error => {
          abortSharedQueues(plans, error.message || String(error));
          throw error;
        })));
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
        await assertMarketplaceAccess(loginPage);
        await waitForSheetPeers(queue);
      }
      if (job) {
        job.status = "success";
        job.liveStatus = `${nickLabel}: xong ${checked} link`;
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
      await Promise.allSettled(checkPages.map(page => page.close({ runBeforeUnload: false })));
      try { if (loginPage && !loginPage.isClosed()) await loginPage.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function run(config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "check link order";
    try { return await start(config); }
    catch (error) { runtime.running = false; runtime.currentTool = ""; throw error; }
  }

  async function start(config) {
    const ids = linkCheckProfileIds(config);
    if (!ids.length) throw new Error("Chua nhap ID profile nick check.");
    const tabCount = clampNumber(config.marketplaceCheckTabsPerNick, 1, 1, 20);
    checkDisplay.reset(config.marketplaceCheckZoomPercent);
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
        liveStatus: `${item.nickLabel}: dang cho mo ${tabCount} cua so Hide`,
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: "",
        result: null
      });
      log(item.profileId, "xep hang", `${item.nickLabel} da xep hang ${tabCount} cua so, lay link tu hang doi chung.`);
    }

    setImmediate(async () => {
      let pass = 0;
      let activeProfiles = [...profiles];
      try {
        while (!runtime.stopRequested) {
          pass += 1;
          progress.summary.pass = pass;
          let currentPlans = plans;
          let writer, flushTimer;
          try {
            if (pass > 1) currentPlans = await loadPlans(activeProfiles.length);
            writer = await createLinkSheetWriter(currentPlans, journalPath);
            await writer.flush();
            for (const plan of currentPlans) plan.sharedQueue = createSharedQueue(plan, activeProfiles.length, pass === 1);
            progress.register(currentPlans);
            progress.summary.sheetPending = writer.pendingCount; progress.summary.sheetReview = writer.reviewCount; progress.summary.sheetConfirmed = writer.confirmedCount; progress.summary.sheetLastWrite = writer.lastWrite;
            let flushing = false;
            flushTimer = setInterval(async () => {
              if (flushing || writer.pendingCount < 100) return;
              flushing = true;
              try { await writer.flush(); progress.summary.sheetWriteError = ""; }
              catch (error) { progress.summary.sheetWriteError = `Ghi Sheet loi: ${error.status || ""} ${error.message}. Ket qua da luu tren may de ghi lai.`; }
              finally { progress.summary.sheetPending = writer.pendingCount; progress.summary.sheetReview = writer.reviewCount; progress.summary.sheetConfirmed = writer.confirmedCount; progress.summary.sheetLastWrite = writer.lastWrite; flushing = false; }
            }, 1000);
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
              writer,
              progress,
              tabCount,
              direction: item.direction,
              workerSlot: index,
              workerTotal: activeProfiles.length
            })));
            await writer.flush();
            progress.summary.sheetPending = writer.pendingCount; progress.summary.sheetReview = writer.reviewCount; progress.summary.sheetConfirmed = writer.confirmedCount; progress.summary.sheetLastWrite = writer.lastWrite;
            if (runtime.stopRequested) break;
            const blockedIds = new Set(results.filter((result) => result.permanent).map((result) => result.profileId));
            activeProfiles = activeProfiles.filter((item) => !blockedIds.has(item.profileId));
            if (!activeProfiles.length) break;
            const retryable = results.reduce((total, result) => total + Number(result?.retryable || 0), 0);
            const errors = results.filter((result) => result?.error && !result.permanent);
            if (!retryable && !errors.length) break;
            const reason = errors.length
              ? `${errors.length} nick/browser loi`
              : `${retryable} link van la khong ro/loi check trong luot nay`;
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
          } finally {
            clearInterval(flushTimer);
            if (writer) {
              try { await writer.flush(); progress.summary.sheetWriteError = ""; }
              catch (error) { progress.summary.sheetWriteError = `Ghi Sheet loi: ${error.status || ""} ${error.message}. Con ket qua tren may; bam Chay tiep de ghi lai Sheet.`; }
              progress.summary.sheetPending = writer.pendingCount; progress.summary.sheetReview = writer.reviewCount; progress.summary.sheetConfirmed = writer.confirmedCount; progress.summary.sheetLastWrite = writer.lastWrite;
            }
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
    return { started: profiles.length, profileIds: profiles.map((item) => item.profileId), sheetTitles: plans.map((plan) => plan.title), sheets: plans.length, tabsPerNick: tabCount, windows: profiles.length * tabCount };
  }

  return { run };
}

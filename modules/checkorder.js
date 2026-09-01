const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DASHBOARD_URL = "https://www.facebook.com/marketplace/you/dashboard";
const LISTINGS_URL = "https://www.facebook.com/marketplace/you/selling";
const SHIPPING_ORDERS_URL = "https://www.facebook.com/marketplace/you/shipping_orders/";

const CHECK_ORDER_HEADERS = [
  "uid",
  "ng\u00e0y l\u00e0m",
  "tr\u1ea1ng th\u00e1i",
  "chi ti\u1ebft",
  "order",
  "Orders to fill",
  "click on listings",
  "Active & pending",
  "Last payout",
  "To renew",
  "Sold & out of stock"
];

export { CHECK_ORDER_HEADERS };

export function createCheckOrderTool({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  mapErrorForSheet,
  writeCheckOrderRow,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "check order",
      step,
      detail
    });
  }

  function clampToolConcurrency(value, fallback = 1) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
    return Math.max(1, Math.min(4, parsed));
  }

  function buildStoppedError() {
    const error = new Error("Da nhan lenh dung han, tool dung batch hien tai.");
    error.status = "stopped";
    error.step = "dung han";
    return error;
  }
  function stripRuntimePrefixes(name) {
    let next = String(name || "").trim();
    const prefixes = [
      /^loilogin-/i,
      /^loi login-/i,
      /^loi\s+2v-/i,
      /^loi\s+3v-/i,
      /^loi\s+4v-/i,
      /^loi\s+seller info-/i,
      /^loi\s+ssn-/i,
      /^loi\s+bank-/i,
      /^loi-/i,
      /^loicapcha-/i,
      /^cp282-/i,
      /^cp956-/i,
      /^cp049-/i,
      /^loipb-/i,
      /^hetproxy-/i,
      /^thieubang-/i,
      /^biout-/i,
      /^die cho-/i
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const prefix of prefixes) {
        const updated = next.replace(prefix, "").trim();
        if (updated !== next) {
          next = updated;
          changed = true;
        }
      }
    }
    return next.replace(/^-+/, "").replace(/-+$/, "").trim() || String(name || "profile").trim();
  }

  function rowValue(row, ...keys) {
    const wanted = keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean);
    for (const [key, value] of Object.entries(row || {})) {
      if (!wanted.includes(String(key || "").trim().toLowerCase())) continue;
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  async function renameProfileOnError(manager, profileId, row, mapped) {
    const status = String(mapped?.renameStatus || "loi").trim().toLowerCase() || "loi";
    if (status === "stopped") return;
    const currentName = await manager.getProfileNameById(profileId).catch(() => "");
    const baseSource = rowValue(row.raw || {}, "tên chuẩn", "ten chuan", "tenChuan") || currentName || profileId;
    let base = stripRuntimePrefixes(baseSource);
    if (!base || /^tool$/i.test(base)) base = String(row.uid || profileId || "profile").trim();
    if (!/-tool$/i.test(base)) base = `${base}-tool`;
    const nextName = status === "loi" ? `loi-${base}` : `${status}-${base}`;
    await manager.updateProfileName(profileId, nextName);
    return nextName;
  }

  async function step(profileId, job, name, action, options = {}) {
    if (runtime.stopRequested) throw buildStoppedError();
    const timeoutMs = Number(options.timeoutMs || 0);
    if (job) job.liveStatus = name;
    log(profileId, name, `bat dau: ${name}`);
    const startedAt = Date.now();
    try {
      const work = Promise.resolve().then(action);
      const result = timeoutMs > 0
        ? await Promise.race([
            work,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout o buoc "${name}" sau ${timeoutMs}ms.`)), timeoutMs))
          ])
        : await work;
      if (runtime.stopRequested) throw buildStoppedError();
      log(profileId, name, `xong: ${name} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") throw error;
      error.step = error.step || name;
      log(profileId, name, `loi o buoc "${name}": ${error.message || error}`, "error");
      throw error;
    }
  }

  function tileBounds(workerSlot = 0, workerTotal = 1) {
    const total = Math.max(1, Math.min(4, Number(workerTotal || 1)));
    const slot = Math.max(0, Math.min(total - 1, Number(workerSlot || 0)));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    if (total === 2) return { left: slot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
    if (total === 3) return { left: slot * 640, top: 0, width: 640, height: 980 };
    return {
      left: (slot % 2) * 960,
      top: Math.floor(slot / 2) * 520,
      width: 960,
      height: 520
    };
  }

  async function readViewportMetrics(page) {
    return page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      hidden: document.hidden,
      visibilityState: document.visibilityState
    })).catch(() => null);
  }

  async function applyStableViewport(page, workerSlot = 0, workerTotal = 1) {
    if (!page || page.isClosed?.()) return null;
    const bounds = tileBounds(workerSlot, workerTotal);
    const compact = Math.max(1, Math.min(4, Number(workerTotal || 1))) >= 4;
    const viewport = {
      width: Math.max(compact ? 760 : 900, bounds.width - 24),
      height: Math.max(compact ? 430 : 640, bounds.height - 110),
      deviceScaleFactor: 1
    };
    await page.setViewport?.(viewport).catch(() => {});
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      if (document.body) document.body.style.zoom = "";
    }).catch(() => {});
    return { ...viewport, zoom: 1, bounds, actual: await readViewportMetrics(page) };
  }

  function patchStableWindowTiling(manager, workerSlot = 0, workerTotal = 1) {
    if (!manager || manager.__checkOrderWindowTilingPatched) return;
    const original = manager.maximizeBrowserWindow;
    manager.__checkOrderWindowTilingPatched = true;
    manager.__toolWorkerSlot = workerSlot;
    manager.__toolWorkerTotal = workerTotal;
    manager.maximizeBrowserWindow = async (browser, page = null) => {
      const targetPage = page || (await browser.pages().catch(() => []))[0];
      if (!targetPage) return original?.call(manager, browser, page);
      const bounds = tileBounds(workerSlot, workerTotal);
      try {
        const session = await targetPage.createCDPSession();
        const windowInfo = await session.send("Browser.getWindowForTarget").catch(() => null);
        if (windowInfo?.windowId !== undefined) {
          await session.send("Browser.setWindowBounds", {
            windowId: windowInfo.windowId,
            bounds: {
              windowState: "normal",
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height
            }
          });
        }
        await session.detach().catch(() => {});
        await applyStableViewport(targetPage, workerSlot, workerTotal);
      } catch {
        await original?.call(manager, browser, page).catch(() => {});
      }
    };
  }
  async function gotoWithRetry(manager, page, url, row, attempts = 3) {
    if (typeof manager.gotoWithRetry === "function") {
      await manager.gotoWithRetry(page, url, row, attempts);
      return;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        await sleep(1200 * attempt);
      }
    }
    throw lastError || new Error(`Khong mo duoc ${url}`);
  }

  async function preparePage(manager, browser, uid, workerSlot, workerTotal) {
    const pages = await browser.pages().catch(() => []);
    const page = pages.find((item) => !item.isClosed?.()) || await browser.newPage();
    page.__toolUid = String(uid || "").trim();
    if (typeof manager.maximizeBrowserWindow === "function") {
      await manager.maximizeBrowserWindow(browser, page).catch(() => {});
    }
    await applyStableViewport(page, workerSlot, workerTotal).catch(() => {});
    await page.bringToFront().catch(() => {});
    return page;
  }

  async function hasShippingOrders(page) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const found = await page.evaluate(() => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        return Array.from(document.querySelectorAll("a, button, span, div, [role='link'], [role='button']"))
          .filter(visible)
          .some((element) => normalize(element.innerText || element.textContent || element.getAttribute("aria-label")).includes("shipping orders"));
      }).catch(() => false);
      if (found) return true;
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.7))).catch(() => {});
      await sleep(2200);
    }
    return false;
  }

  async function readDashboardMetrics(page) {
    const samples = [];
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(2200);
    for (let i = 0; i < 7; i += 1) {
      const pageSamples = await page.evaluate(() => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 40 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
        };
        return Array.from(document.querySelectorAll("div, section, article"))
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const lines = normalize(element.innerText || element.textContent || "")
              .split(/\n+/)
              .map((line) => normalize(line))
              .filter(Boolean)
              .slice(0, 12);
            return {
              top: Math.round(rect.top + window.scrollY),
              left: Math.round(rect.left),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              text: lines.join("\n")
            };
          })
          .filter((item) => item.text && item.text.length <= 500);
      }).catch(() => []);
      samples.push(...pageSamples);
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65))).catch(() => {});
      await sleep(450);
    }

    const unique = [];
    const seen = new Set();
    for (const item of samples) {
      const key = `${item.top}|${item.left}|${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    const normalize = (value) => String(value || "").replace(/&/g, "and").replace(/\s+/g, " ").trim().toLowerCase();
    const valueFromText = (text, labelMatchers, options = {}) => {
      const candidates = unique
        .filter((item) => labelMatchers.some((matcher) => normalize(item.text).includes(normalize(matcher))))
        .sort((a, b) => (a.text.length - b.text.length) || (a.width * a.height - b.width * b.height));
      for (const candidate of candidates) {
        const lines = String(candidate.text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const valueLine = lines.find((line) => {
          const lower = normalize(line);
          if (labelMatchers.some((matcher) => lower === normalize(matcher) || lower.includes(normalize(matcher)))) return false;
          if (options.currency) return /\$[\d,.]+/.test(line);
          return /\$[\d,.]+|-?\d+(?:[,.]\d+)?/.test(line);
        });
        if (valueLine) {
          const currency = valueLine.match(/\$[\d,.]+/)?.[0] || "";
          if (options.currency && currency) return currency;
          const number = valueLine.match(/-?\d+(?:[,.]\d+)?/)?.[0] || "";
          return currency || number || valueLine;
        }
        const currency = candidate.text.match(/\$[\d,.]+/)?.[0] || "";
        if (options.currency && currency) return currency;
        const numbers = candidate.text.match(/-?\d+(?:[,.]\d+)?/g) || [];
        if (numbers.length) return numbers[0];
      }
      return "";
    };

    return {
      "Orders to fill": valueFromText("Orders to fill", ["Orders to fill"]),
      "click on listings": valueFromText("Clicks on listings", ["Clicks on listings", "clicks on listing", "click on listings"]),
      "Active & pending": valueFromText("Active & pending", ["Active & pending", "Active and pending"]),
      "Last payout": valueFromText("Last payout", ["Last payout", "No payout history", "Next payout", "payout"], { currency: true }),
      "To renew": valueFromText("To renew", ["To renew"]),
      "Sold & out of stock": valueFromText("Sold & out of stock", ["Sold & out of stock", "Sold and out of stock"])
    };
  }

  async function clickByText(page, text, options = {}) {
    const point = await findButtonPoint(page, text, { exact: Boolean(options.exact), orderScope: false });
    if (!point) return false;
    await page.mouse.click(point.x, point.y, { delay: 80 }).catch(() => {});
    await sleep(options.waitMs || 1200);
    return true;
  }

  async function findButtonPoint(page, text, options = {}) {
    return page.evaluate(({ wanted, exact, orderScope }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
      const orderDialog = dialogs.find((dialog) => /order from|order details|order request|order status/i.test(dialog.innerText || dialog.textContent || ""));
      const scope = orderScope ? (orderDialog || document) : document;
      const targetText = normalize(wanted);
      const candidates = Array.from(scope.querySelectorAll("div[role='button'], button, a[role='button'], [role='button'], a[role='link']"))
        .filter(visible)
        .filter((element) => !/true/i.test(String(element.getAttribute("aria-disabled") || element.disabled || "")))
        .map((element) => {
          const label = normalize(element.getAttribute("aria-label") || element.innerText || element.textContent);
          const rect = element.getBoundingClientRect();
          return {
            label,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            top: rect.top,
            area: rect.width * rect.height,
            role: element.getAttribute("role") || element.tagName.toLowerCase()
          };
        })
        .filter((item) => exact ? item.label === targetText : item.label.includes(targetText))
        .sort((a, b) => (a.label.length - b.label.length) || (a.top - b.top) || (a.area - b.area));
      return candidates[0] || null;
    }, { wanted: text, exact: Boolean(options.exact), orderScope: Boolean(options.orderScope) }).catch(() => null);
  }

  async function hasExactOrderButton(page, label) {
    return Boolean(await findButtonPoint(page, label, { exact: true, orderScope: true }));
  }

  async function closeOrderDialog(page) {
    const closed = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
      const orderDialog = dialogs.find((dialog) => /order from|order details|order request|order status/i.test(dialog.innerText || dialog.textContent || ""));
      const scope = orderDialog || dialogs[0] || document;
      const buttons = Array.from(scope.querySelectorAll("div[aria-label], button, [role='button']"))
        .filter(visible)
        .map((element) => ({ element, label: normalize(element.getAttribute("aria-label") || element.innerText || element.textContent) }));
      const target = buttons.find((item) => /^(close|x|dong|đóng)$/i.test(item.label)) || buttons.find((item) => item.label.includes("close"));
      if (!target) return false;
      target.element.click();
      return true;
    }).catch(() => false);
    if (!closed) await page.keyboard.press("Escape").catch(() => {});
    await sleep(1000);
  }

  async function orderDialogState(page) {
    return page.evaluate(() => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
      const orderDialog = dialogs.find((dialog) => /order from|order details|order request|order status/i.test(dialog.innerText || dialog.textContent || ""));
      const text = String((orderDialog || document.body)?.innerText || "");
      return {
        opened: Boolean(orderDialog) || /\/marketplace\/you\/shipping_orders\//.test(location.pathname),
        hasAccept: /accept order/i.test(text),
        pending: /order request pending/i.test(text),
        text: text.slice(0, 1200)
      };
    }).catch(() => ({ opened: false, hasAccept: false, pending: false, text: "" }));
  }

  async function acceptCurrentOrder(page) {
    const before = await orderDialogState(page);
    if (!before.hasAccept) return { accepted: false, hadAccept: false };

    let clickedAny = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const point = await findButtonPoint(page, "Accept order", { exact: true, orderScope: true });
      if (point) {
        clickedAny = true;
        await page.mouse.click(point.x, point.y, { delay: 100 }).catch(() => {});
        await sleep(2500);
      }

      for (const label of ["Accept", "Confirm", "Continue", "Done"]) {
        const confirmPoint = await findButtonPoint(page, label, { exact: true, orderScope: false });
        if (!confirmPoint) continue;
        clickedAny = true;
        await page.mouse.click(confirmPoint.x, confirmPoint.y, { delay: 100 }).catch(() => {});
        await sleep(2200);
      }

      const after = await orderDialogState(page);
      const stillHasAccept = await hasExactOrderButton(page, "Accept order");
      if (!after.pending && !stillHasAccept) return { accepted: true, hadAccept: true, clickedAny };
      if (!point && !stillHasAccept) return { accepted: true, hadAccept: true, clickedAny };
      await sleep(1500);
    }

    return { accepted: false, hadAccept: true, clickedAny };
  }

  async function handleOrderDialog(page) {
    await page.waitForFunction(
      () => /\/marketplace\/you\/shipping_orders\//.test(location.pathname) || /Order from|Order details|Order request|Order status/i.test(document.body?.innerText || ""),
      { timeout: 30000 }
    ).catch(() => {});
    await sleep(2500);
    const state = await orderDialogState(page);
    const result = state.hasAccept ? await acceptCurrentOrder(page) : { accepted: false, hadAccept: false };
    await closeOrderDialog(page);
    return { ...result, opened: state.opened };
  }
  async function ensureListingsPage(manager, page, row) {
    await gotoWithRetry(manager, page, LISTINGS_URL, row, 3);
    await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () => location.href.includes("/marketplace/you/selling") || /Your listings/i.test(document.body?.innerText || ""),
      { timeout: 45000 }
    ).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(3500);
  }

  async function findNextViewOrderTarget(page, seenKeys) {
    return page.evaluate((seen) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const seenSet = new Set(seen || []);
      const links = Array.from(document.querySelectorAll("a[href*='/marketplace/you/shipping_orders/'], a[href*='/marketplace/you/shipping_orders'], a[aria-label]"))
        .filter(visible)
        .filter((element) => {
          const label = normalize(element.getAttribute("aria-label") || element.innerText || element.textContent);
          const href = element.href || element.getAttribute("href") || "";
          return /view\s+order/i.test(label) && /\/marketplace\/you\/shipping_orders\//.test(href);
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const href = element.href || element.getAttribute("href") || "";
          return {
            key: href,
            href,
            text: normalize(element.getAttribute("aria-label") || element.innerText || element.textContent),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((item) => !seenSet.has(item.key))
        .sort((a, b) => (a.top - b.top) || (a.left - b.left));
      const target = links[0];
      if (!target) return null;
      const link = Array.from(document.querySelectorAll("a[href]")).find((element) => (element.href || element.getAttribute("href") || "") === target.href);
      if (link) link.scrollIntoView({ block: "center", inline: "center" });
      return target;
    }, [...seenKeys]).catch(() => null);
  }
  async function scanListingsAndAccept(manager, page, row, profileId, job) {
    const seen = new Set();
    let checked = 0;
    let accepted = 0;
    let idleScrolls = 0;
    let lastHeight = 0;

    await ensureListingsPage(manager, page, row);

    for (let loop = 0; loop < 260; loop += 1) {
      if (runtime.stopRequested) throw buildStoppedError();
      const candidate = await findNextViewOrderTarget(page, seen);
      if (candidate?.key) {
        seen.add(candidate.key);
        await sleep(800);
        await gotoWithRetry(manager, page, candidate.href, row, 2);
        await sleep(3500);
        const opened = await orderDialogState(page);
        if (!opened.opened) {
          log(profileId, "view order", `mo link View Order khong thay order: ${candidate.href || candidate.key}`, "warn");
          continue;
        }
        checked += 1;
        if (job) job.liveStatus = `da mo ${checked} view order, accept ${accepted}`;
        log(profileId, "view order", `mo view order thu ${checked}`);
        const result = await handleOrderDialog(page);
        if (result.accepted) {
          accepted += 1;
          log(profileId, "accept order", `da accept order thanh cong (${accepted}), quay lai Your listings de quet tiep`, "success");
        } else if (result.hadAccept) {
          log(profileId, "accept order", "co Accept order nhung chua xac nhan accept xong, dong popup va quet tiep", "warn");
        } else {
          log(profileId, "accept order", "khong co Accept order, dong popup va quet tiep", "warn");
        }
        await ensureListingsPage(manager, page, row);
        idleScrolls = 0;
        lastHeight = 0;
        continue;
      }

      const info = await page.evaluate(() => {
        const before = window.scrollY;
        const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        window.scrollBy(0, Math.round(window.innerHeight * 0.72));
        return { before, after: window.scrollY, height };
      }).catch(() => ({ before: 0, after: 0, height: 0 }));
      await sleep(2500);
      if (info.height === lastHeight && Math.abs(info.after - info.before) < 20) idleScrolls += 1;
      else idleScrolls = 0;
      lastHeight = info.height;
      if (idleScrolls >= 12) break;
    }

    return { checked, accepted };
  }

  async function readShippingOrderCount(manager, page, row) {
    await gotoWithRetry(manager, page, SHIPPING_ORDERS_URL, row, 3);
    await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () => /Your orders|No shipping orders yet|Orders\s*[·:]/i.test(document.body?.innerText || ""),
      { timeout: 60000 }
    ).catch(() => {});
    await sleep(2500);

    return page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      const bodyText = normalize(document.body?.innerText || "");
      if (/No shipping orders yet/i.test(bodyText)) return 0;

      const orderMatch = bodyText.match(/\bOrders\s*[·:]\s*(\d+)\b/i);
      if (orderMatch) return Number(orderMatch[1]) || 0;

      const containers = Array.from(document.querySelectorAll("div, section, article"))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: normalize(element.innerText || element.textContent || ""),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          };
        });

      const cards = containers.filter((item) => {
        if (item.width < 250 || item.height < 45) return false;
        if (!/\bTotal:\s*\$|\bShip by\b|\bOrder\b/i.test(item.text)) return false;
        if (/Your orders|Search your orders|Order status|Filters/i.test(item.text)) return false;
        return true;
      });

      const seen = new Set();
      let count = 0;
      for (const card of cards) {
        const key = `${Math.round(card.top / 20)}|${Math.round(card.left / 20)}|${card.text.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
      }
      return count;
    }).catch(() => 0);
  }

  async function runOne(profileId, sheetRow, config, workerSlot = 0, workerTotal = 1) {
    const manager = getManager({ fresh: true });
    const row = buildToolRow(profileId, sheetRow || {});
    const uid = String(row.uid || profileId || "").trim();
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    const resultRow = {
      uid,
      "ng\u00e0y l\u00e0m": new Date().toLocaleString("vi-VN", { hour12: false }),
      "tr\u1ea1ng th\u00e1i": "false",
      "chi ti\u1ebft": "",
      order: "",
      "Orders to fill": "",
      "click on listings": "",
      "Active & pending": "",
      "Last payout": "",
      "To renew": "",
      "Sold & out of stock": ""
    };

    try {
      patchStableWindowTiling(manager, workerSlot, workerTotal);
      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid, shouldFinish: () => false });

      proxyLease = await step(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      );

      browser = await step(profileId, job, "mo profile GPM", async () => manager.connectBrowser(profileId), { timeoutMs: 120000 });
      page = await step(profileId, job, "mo tab Facebook", async () => {
        const target = await preparePage(manager, browser, uid, workerSlot, workerTotal);
        const viewport = await applyStableViewport(target, workerSlot, workerTotal);
        log(profileId, "viewport", `worker ${workerSlot + 1}/${workerTotal} bounds=${viewport?.bounds?.width || ""}x${viewport?.bounds?.height || ""} viewport=${viewport?.width || ""}x${viewport?.height || ""}, actual=${JSON.stringify(viewport?.actual || {})}`);
        return target;
      }, { timeoutMs: 60000 });

      await step(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      }, { timeoutMs: 300000 });

      await step(profileId, job, "vao seller dashboard", async () => {
        await gotoWithRetry(manager, page, DASHBOARD_URL, row, 3);
        await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
        await sleep(2500);
      }, { timeoutMs: 180000 });

      const shippingOrders = await step(profileId, job, "kiem tra Shipping orders", async () => hasShippingOrders(page), { timeoutMs: 120000 });
      if (!shippingOrders) {
        resultRow["tr\u1ea1ng th\u00e1i"] = "false";
        resultRow["chi ti\u1ebft"] = "k co shipping order";
        await writeCheckOrderRow(config, resultRow);
        if (job) {
          job.status = "success";
          job.liveStatus = resultRow["chi ti\u1ebft"];
          job.result = resultRow;
        }
        log(profileId, "ket thuc", resultRow["chi ti\u1ebft"], "warn");
        return resultRow;
      }

      const metrics = await step(profileId, job, "doc seller dashboard", async () => readDashboardMetrics(page), { timeoutMs: 180000 });
      Object.assign(resultRow, metrics);
      resultRow["chi ti\u1ebft"] = "da doc seller dashboard";

      await step(profileId, job, "vao Your listings", async () => {
        await ensureListingsPage(manager, page, row);
      }, { timeoutMs: 180000 });

      const orderResult = await step(profileId, job, "quet View order", async () => scanListingsAndAccept(manager, page, row, profileId, job), { timeoutMs: 1200000 });
      const shippingOrderCount = await step(profileId, job, "doc Shipping orders", async () => readShippingOrderCount(manager, page, row), { timeoutMs: 180000 });
      resultRow.order = String(shippingOrderCount);
      resultRow["tr\u1ea1ng th\u00e1i"] = "true";
      resultRow["chi ti\u1ebft"] = `da check ${orderResult.checked} view order, accept ${orderResult.accepted}, con ${shippingOrderCount} order`;
      await writeCheckOrderRow(config, resultRow);

      if (job) {
        job.status = "success";
        job.liveStatus = resultRow["chi ti\u1ebft"];
        job.result = resultRow;
      }
      log(profileId, "ket thuc", resultRow["chi ti\u1ebft"], "success");
      return resultRow;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = "da dung han, giu nguyen Sheet";
          job.result = null;
        }
        return { stopped: true };
      }
      const mapped = mapErrorForSheet(error);
      resultRow["tr\u1ea1ng th\u00e1i"] = "false";
      resultRow["chi ti\u1ebft"] = mapped.detail || String(error?.message || error || "loi check order");
      await renameProfileOnError(manager, profileId, row, mapped).catch((renameError) => {
        log(profileId, "doi ten profile khi loi", `khong doi duoc ten profile: ${renameError.message}`, "error");
      });
      await writeCheckOrderRow(config, resultRow).catch((sheetError) => {
        log(profileId, "ghi Sheet", `ghi Sheet check order loi: ${sheetError.message}`, "error");
      });
      if (job) {
        job.status = "error";
        job.liveStatus = resultRow["chi ti\u1ebft"];
        job.result = resultRow;
      }
      log(profileId, error.step || "loi tong", `loi check order: ${resultRow["chi ti\u1ebft"]}`, "error");
      return resultRow;
    } finally {
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      try { stateProxy?.release?.(proxyLease); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runQueue(profileIds, config, options = {}) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set((profileIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");
    if (!String(config.checkOrderSpreadsheetId || "").trim()) throw new Error("Chua cau hinh Check order Spreadsheet ID.");
    if (!String(config.credentialsPath || "").trim()) throw new Error("Chua cau hinh Service Account JSON.");

    const concurrency = Math.min(clampToolConcurrency(options.concurrency || config.checkOrderConcurrency, 1), ids.length);
    const rowsById = options.rowsById instanceof Map ? options.rowsById : new Map();

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "check order",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang check order ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "check order";
    setImmediate(async () => {
      try {
        let cursor = 0;
        const nextId = () => {
          if (runtime.stopRequested) return "";
          if (cursor >= ids.length) return "";
          const id = ids[cursor];
          cursor += 1;
          return id;
        };
        const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
          while (true) {
            const id = nextId();
            if (!id) break;
            const job = runtime.jobs.get(id);
            if (job) {
              job.status = "running";
              job.startedAt = new Date().toISOString();
              job.liveStatus = `worker ${workerIndex + 1} dang chay`;
            }
            await runOne(id, rowsById.get(id) || {}, config, workerIndex, concurrency);
          }
        });
        await Promise.all(workers);
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });

    return { started: ids.length, concurrency };
  }

  return { runQueue };
}
















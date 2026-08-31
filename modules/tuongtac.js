import fs from "node:fs";
import { fileURLToPath } from "node:url";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INTERACTION_MAX_CONCURRENCY = 4;
const FACEBOOK_LOCALE = "en_US";

function withFacebookLocale(rawUrl) {
  if (typeof rawUrl !== "string") return rawUrl;
  const text = rawUrl.trim();
  if (!/^https?:\/\//i.test(text)) return rawUrl;
  try {
    const url = new URL(text);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return rawUrl;
    url.searchParams.set("locale", FACEBOOK_LOCALE);
    return url.toString();
  } catch {
    if (!/facebook\.com/i.test(text) || /[?&]locale=/i.test(text)) return rawUrl;
    return text + (text.includes("?") ? "&" : "?") + "locale=" + FACEBOOK_LOCALE;
  }
}

function patchPageGotoFacebookLocale(page) {
  if (!page || typeof page.goto !== "function" || page.__toolFacebookLocalePatched) return () => {};
  const originalGoto = page.goto.bind(page);
  page.goto = async (url, ...args) => originalGoto(withFacebookLocale(url), ...args);
  page.__toolFacebookLocalePatched = true;
  return () => {
    try {
      page.goto = originalGoto;
      delete page.__toolFacebookLocalePatched;
    } catch {}
  };
}

function clampToolConcurrency(value, fallback = 4) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(INTERACTION_MAX_CONCURRENCY, fallback));
  return Math.max(1, Math.min(INTERACTION_MAX_CONCURRENCY, parsed));
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "bat", "bật"].includes(text)) return true;
  if (["0", "false", "no", "off", "tat", "tắt"].includes(text)) return false;
  return fallback;
}

function normalizeRange(config, minKey, maxKey, fallbackMin, fallbackMax) {
  const min = Math.max(1, Math.floor(Number(config[minKey])) || fallbackMin);
  const max = Math.max(1, Math.floor(Number(config[maxKey])) || fallbackMax);
  return min <= max ? { min, max } : { min: max, max: min };
}

function buildInteractionConfig(config = {}) {
  const home = normalizeRange(config, "interactionHomeTimeMin", "interactionHomeTimeMax", 30, 60);
  const reels = normalizeRange(config, "interactionReelsTotalMin", "interactionReelsTotalMax", 30, 60);
  const clip = normalizeRange(config, "interactionClipViewMin", "interactionClipViewMax", 5, 10);
  const market = normalizeRange(config, "interactionMarketPostsMin", "interactionMarketPostsMax", 3, 5);
  return {
    homeTimeMin: home.min,
    homeTimeMax: home.max,
    reelsTotalMin: reels.min,
    reelsTotalMax: reels.max,
    clipViewMin: clip.min,
    clipViewMax: clip.max,
    marketPostsMin: market.min,
    marketPostsMax: market.max,
    maxConcurrency: clampToolConcurrency(config.interactionConcurrency, 4),
    backgroundLogin: false,
    enableRandomOrder: normalizeBool(config.interactionEnableRandomOrder, true),
    humanDelayMode: normalizeBool(config.interactionHumanDelayMode, false),
    slowScrollMode: normalizeBool(config.interactionSlowScrollMode, false)
  };
}

function tileBounds(workerSlot = 0, workerTotal = 1) {
  const total = Math.max(1, Math.min(INTERACTION_MAX_CONCURRENCY, Number(workerTotal || 1)));
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

async function clearInteractionVisualScale(page) {
  if (!page || page.isClosed?.()) return;
  await page.evaluateOnNewDocument(() => {
    const clearScale = () => {
      const style = document.getElementById("__tool-window-scale");
      if (style) style.remove();
      document.documentElement.style.zoom = "";
      document.documentElement.style.width = "";
      document.documentElement.style.minHeight = "";
      document.documentElement.style.overflowX = "";
      if (document.body) {
        document.body.style.zoom = "";
        document.body.style.width = "";
        document.body.style.minHeight = "";
        document.body.style.overflowX = "";
      }
      window.__toolWindowScale = 1;
      window.__toolApplyWindowScale = clearScale;
    };
    document.addEventListener("DOMContentLoaded", clearScale);
    clearScale();
  }).catch(() => {});
  await page.evaluate(() => {
    const style = document.getElementById("__tool-window-scale");
    if (style) style.remove();
    document.documentElement.style.zoom = "";
    document.documentElement.style.width = "";
    document.documentElement.style.minHeight = "";
    document.documentElement.style.overflowX = "";
    if (document.body) {
      document.body.style.zoom = "";
      document.body.style.width = "";
      document.body.style.minHeight = "";
      document.body.style.overflowX = "";
    }
    window.__toolWindowScale = 1;
  }).catch(() => {});
}

async function applyStableViewport(page, workerSlot = 0, workerTotal = 1) {
  if (!page || page.isClosed?.()) return null;
  const bounds = tileBounds(workerSlot, workerTotal);
  const compact = Math.max(1, Math.min(INTERACTION_MAX_CONCURRENCY, Number(workerTotal || 1))) >= 4;
  const viewport = {
    width: Math.max(compact ? 760 : 900, bounds.width - 24),
    height: Math.max(compact ? 430 : 640, bounds.height - 110),
    deviceScaleFactor: 1
  };
  await page.setViewport?.(viewport).catch(() => {});
  await clearInteractionVisualScale(page);
  return { ...viewport, zoom: 1, bounds, actual: await readViewportMetrics(page) };
}

async function tileBrowserWindow(page, workerSlot = 0, workerTotal = 1) {
  if (!page || page.isClosed?.()) return false;
  const bounds = tileBounds(workerSlot, workerTotal);
  try {
    const session = await page.createCDPSession();
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
    await applyStableViewport(page, workerSlot, workerTotal);
    return true;
  } catch {
    return false;
  }
}

async function applyLegacyInteractionLayout(interactionManager, browser, page, workerSlot = 0, workerTotal = 1) {
  if (!interactionManager || !browser || !page || page.isClosed?.()) return null;
  interactionManager.config = {
    ...(interactionManager.config || {}),
    maxConcurrency: clampToolConcurrency(workerTotal, 4),
    backgroundLogin: false
  };
  const tiled = await tileBrowserWindow(page, workerSlot, workerTotal);
  if (!tiled) {
    await interactionManager.maximizeBrowserWindow(browser, page, {
      slotIndex: Math.max(0, Number(workerSlot || 0)),
      forceMaximized: workerTotal <= 1
    }).catch(() => {});
    await applyStableViewport(page, workerSlot, workerTotal).catch(() => {});
  }
  await page.bringToFront?.().catch(() => {});
  return readViewportMetrics(page);
}

function patchStableWindowTiling(manager, interactionManager, workerSlot = 0, workerTotal = 1) {
  const original = manager.maximizeBrowserWindow;
  manager.__toolWorkerSlot = workerSlot;
  manager.__toolWorkerTotal = workerTotal;
  manager.maximizeBrowserWindow = async (browser, page = null) => {
    const targetPage = page || (await browser.pages().catch(() => []))[0];
    if (!targetPage) return original?.call(manager, browser, page);
    try {
      await applyLegacyInteractionLayout(interactionManager, browser, targetPage, workerSlot, workerTotal);
    } catch {
      await original?.call(manager, browser, page).catch(() => {});
    }
  };
}
function buildStoppedError() {
  const error = new Error("Da nhan lenh dung han, tool tuong tac dung batch hien tai.");
  error.status = "stopped";
  error.step = "dung han";
  return error;
}

function normalizeRenewKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

async function getSellingScrollState(page) {
  return page.evaluate(() => {
    const scroller = document.scrollingElement || document.documentElement || document.body;
    if (!scroller) return { top: 0, bottom: 0, height: 0, clientHeight: 0 };
    return {
      top: scroller.scrollTop,
      bottom: scroller.scrollTop + scroller.clientHeight,
      height: scroller.scrollHeight,
      clientHeight: scroller.clientHeight
    };
  }).catch(() => ({ top: 0, bottom: 0, height: 0, clientHeight: 0 }));
}


function getSheetBang(row) {
  const raw = row?.raw || {};
  return String(raw.bang || raw.Bang || raw["bang"] || raw["Bang"] || raw.state || raw.State || "").replace(/\s+/g, " ").trim();
}

function normalizeLocationCompare(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function marketplaceLocationMatchesBang(locationText, bang) {
  const target = normalizeLocationCompare(bang);
  if (!target) return false;
  const base = String(locationText || "").split(/[\u00b7?]/)[0] || locationText;
  const current = normalizeLocationCompare(base);
  return current === target || current.endsWith(" " + target) || current.includes(" " + target + " ");
}

async function readMarketplaceSidebarLocation(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const directButton = Array.from(document.querySelectorAll("[role='button'][aria-label^='Location:']"))
      .find((element) => visible(element) && element.getBoundingClientRect().left < 520);
    if (directButton instanceof HTMLElement) {
      const label = normalize(directButton.getAttribute("aria-label") || "");
      return normalize(label.replace(/^Location:\s*/i, ""));
    }
    const headings = Array.from(document.querySelectorAll("span, div, h1, h2, h3, h4"))
      .filter((element) => visible(element))
      .map((element) => ({ element, text: normalize(element.innerText || element.textContent || "") }))
      .filter((item) => /^location$/i.test(item.text));
    const heading = headings[0]?.element;
    if (!heading) return "";
    const lines = Array.from(document.querySelectorAll("a, [role='link'], [role='button'], span, div"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || element.getAttribute?.("aria-label") || "");
        const rect = element.getBoundingClientRect();
        return { text, rect };
      })
      .filter((item) => item.rect.left < 520 && item.rect.top > heading.getBoundingClientRect().bottom - 8 && item.text.includes(",") && /within\s+\d+/i.test(item.text))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = lines[0];
    if (!chosen) return "";
    return normalize((chosen.text.split(/[\u00b7?]/)[0] || chosen.text).replace(/^Location:\s*/i, ""));
  }).catch(() => "");
}

async function clickMarketplaceSidebarLocation(page) {
  const target = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const direct = Array.from(document.querySelectorAll("[role='button'][aria-label^='Location:']"))
      .find((element) => visible(element) && element.getBoundingClientRect().left < 520);
    if (direct instanceof HTMLElement) {
      const rect = direct.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width * 0.5, rect.width - 8), y: rect.top + rect.height / 2 };
    }
    const headings = Array.from(document.querySelectorAll("span, div, h1, h2, h3, h4"))
      .filter((element) => visible(element))
      .map((element) => ({ element, text: normalize(element.innerText || element.textContent || "") }))
      .filter((item) => /^location$/i.test(item.text));
    const heading = headings[0]?.element;
    if (!heading) return null;
    const lines = Array.from(document.querySelectorAll("a, [role='link'], [role='button'], span, div"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || element.getAttribute?.("aria-label") || "");
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter((item) => item.rect.left < 520 && item.rect.top > heading.getBoundingClientRect().bottom - 8 && item.text.includes(",") && /within\s+\d+/i.test(item.text))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = lines[0];
    if (!chosen) return null;
    const clickable = chosen.element.closest("a, button, [role='button'], [role='link']") || chosen.element.parentElement || chosen.element;
    const rect = (clickable instanceof HTMLElement ? clickable : chosen.element).getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width * 0.6, rect.width - 8), y: rect.top + rect.height / 2 };
  }).catch(() => null);
  if (!target) return false;
  await page.mouse?.move?.(target.x, target.y, { steps: 3 }).catch(() => {});
  await sleep(120);
  await page.mouse?.click?.(target.x, target.y, { delay: 60 }).catch(() => {});
  return true;
}

async function waitForChangeLocationDialog(page, timeoutMs = 15000) {
  return page.waitForFunction(() => {
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"));
    return dialogs.some((dialog) => /change location/i.test(dialog.innerText || dialog.textContent || ""));
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function readLocationFromDialog(page) {
  const selectors = [
    "[role='dialog'] input[aria-label='Location']",
    "[role='dialog'] input[aria-label*='City']",
    "[role='dialog'] input[placeholder*='City']",
    "[role='dialog'] input[placeholder*='city']",
    "[role='dialog'] input[aria-label*='Location']",
    "[role='dialog'] input[type='text']"
  ];
  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;
    const value = await handle.evaluate((element) => String(element.value || "").trim()).catch(() => "");
    if (value) return value;
  }
  return "";
}

async function isLocationApplyReady(page) {
  return page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find((item) => /change location/i.test(item.innerText || item.textContent || ""));
    if (!(dialog instanceof HTMLElement)) return false;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) => visible(element) && /apply/i.test(String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")));
    if (!(applyButton instanceof HTMLElement)) return false;
    return !(String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true" || applyButton.matches?.(":disabled") || applyButton.closest("[aria-disabled='true']"));
  }).catch(() => false);
}

async function clickLocationDialogApply(page) {
  const target = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find((item) => /change location/i.test(item.innerText || item.textContent || ""));
    if (!(dialog instanceof HTMLElement)) return null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) => visible(element) && /apply/i.test(String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")));
    if (!(applyButton instanceof HTMLElement)) return null;
    const disabled = String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true" || applyButton.matches?.(":disabled") || applyButton.closest("[aria-disabled='true']");
    if (disabled) return null;
    applyButton.scrollIntoView({ block: "center", inline: "center" });
    const rect = applyButton.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }).catch(() => null);
  if (!target) return false;
  await page.mouse?.move?.(target.x, target.y, { steps: 3 }).catch(() => {});
  await sleep(100);
  await page.mouse?.click?.(target.x, target.y, { delay: 80 }).catch(() => {});
  return true;
}

async function clickFirstLocationSuggestionFallback(page) {
  const firstSuggestion = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find((item) => /change location/i.test(item.innerText || item.textContent || ""));
    if (!(dialog instanceof HTMLElement)) return null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const input = dialog.querySelector("input[type='text'], input[type='search'], input[aria-label], input");
    const inputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : null;
    const radiusNode = Array.from(dialog.querySelectorAll("*")).find((element) => visible(element) && /^radius$/i.test(String(element.textContent || "").replace(/\s+/g, " ").trim()));
    const lowerBound = inputRect ? inputRect.bottom + 6 : 0;
    const upperBound = radiusNode instanceof HTMLElement ? radiusNode.getBoundingClientRect().top - 6 : Number.POSITIVE_INFINITY;
    const candidates = Array.from(dialog.querySelectorAll("div, span, li, [role='option'], [role='listitem'], [role='button']"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        return { text, rect };
      })
      .filter((item) => item.text && item.text.length >= 4 && item.rect.top > lowerBound && item.rect.top < upperBound && item.rect.width >= 220 && item.rect.height >= 26 && !/^change location$|^location$|^radius$/i.test(item.text))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const first = candidates[0];
    if (!first) return null;
    return { text: first.text, x: first.rect.left + Math.min(48, Math.max(18, first.rect.width * 0.12)), y: first.rect.top + first.rect.height / 2 };
  }).catch(() => null);
  if (!firstSuggestion?.y) return "";
  await page.mouse?.move?.(firstSuggestion.x, firstSuggestion.y, { steps: 3 }).catch(() => {});
  await sleep(120);
  await page.mouse?.click?.(firstSuggestion.x, firstSuggestion.y, { delay: 70 }).catch(() => {});
  await sleep(1000);
  return String(firstSuggestion.text || "").trim();
}

async function typeLocationBangAndPickFirstSuggestion(page, targetBang) {
  const selectors = [
    "[role='dialog'] input[aria-label='Location']",
    "[role='dialog'] input[aria-label*='City']",
    "[role='dialog'] input[placeholder*='City']",
    "[role='dialog'] input[placeholder*='city']",
    "[role='dialog'] input[aria-label*='Location']",
    "[role='dialog'] input[type='text']"
  ];
  let locationInput = null;
  for (const selector of selectors) {
    locationInput = await page.$(selector).catch(() => null);
    if (locationInput) break;
  }
  if (!locationInput) throw new Error("Khong tim thay o nhap Location trong dialog.");
  await locationInput.click({ clickCount: 3 });
  await sleep(150);
  await locationInput.press("Backspace").catch(() => {});
  await sleep(150);
  await locationInput.type(String(targetBang || "").trim(), { delay: 60 });
  await sleep(1800);
  await page.keyboard.press("Tab").catch(() => {});
  await sleep(350);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(1700);
  if (await isLocationApplyReady(page)) return String(await readLocationFromDialog(page).catch(() => "") || targetBang).trim();
  await page.keyboard.press("ArrowDown").catch(() => {});
  await sleep(250);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(1500);
  if (await isLocationApplyReady(page)) return String(await readLocationFromDialog(page).catch(() => "") || targetBang).trim();
  const picked = await clickFirstLocationSuggestionFallback(page);
  if (await isLocationApplyReady(page)) return String(await readLocationFromDialog(page).catch(() => "") || picked || targetBang).trim();
  throw new Error("Chua chon duoc goi y Location dau tien.");
}

async function ensureMarketplaceLocationMatchesSheetBang(interactionManager, page, row, config, log) {
  const targetBang = getSheetBang(row);
  if (!targetBang) {
    log(row.profile_id, "market location", "[" + row.uid + "] cot bang trong Sheet dang trong, bo qua doi Marketplace location.", "warn");
    return { changed: false, skipped: true, reason: "missing_bang" };
  }
  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/?ref=bookmark"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await interactionManager.waitPageLoadHumanOnPage(page, config).catch(() => sleep(1800));
  await dismissFacebookOverlays(page);
  const sidebarLocation = String(await readMarketplaceSidebarLocation(page).catch(() => "") || "").trim();
  if (sidebarLocation) log(row.profile_id, "market location", "[" + row.uid + "] Marketplace location hien tai: \"" + sidebarLocation + "\"; bang Sheet: \"" + targetBang + "\".");
  if (sidebarLocation && marketplaceLocationMatchesBang(sidebarLocation, targetBang)) {
    log(row.profile_id, "market location", "[" + row.uid + "] Location da trung bang Sheet (" + targetBang + "), giu nguyen.", "success");
    return { changed: false, before: sidebarLocation, after: sidebarLocation, targetBang };
  }
  const opened = await clickMarketplaceSidebarLocation(page);
  if (!opened) throw new Error("Khong bam duoc Location tren Marketplace.");
  const dialogReady = await waitForChangeLocationDialog(page, 18000);
  if (!dialogReady) throw new Error("Khong thay popup Change location.");
  await sleep(900);
  const dialogLocation = String(await readLocationFromDialog(page).catch(() => "") || "").trim() || sidebarLocation;
  if (dialogLocation && marketplaceLocationMatchesBang(dialogLocation, targetBang)) {
    log(row.profile_id, "market location", "[" + row.uid + "] Location trong popup da trung bang Sheet (" + targetBang + "), dong popup va giu nguyen.", "success");
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
    return { changed: false, before: dialogLocation, after: dialogLocation, targetBang };
  }
  log(row.profile_id, "market location", "[" + row.uid + "] Location khac bang Sheet, doi tu \"" + (dialogLocation || sidebarLocation || "?") + "\" sang \"" + targetBang + "\".", "warn");
  const picked = await typeLocationBangAndPickFirstSuggestion(page, targetBang);
  log(row.profile_id, "market location", "[" + row.uid + "] da chon goi y Location dau: \"" + (picked || targetBang) + "\".");
  const applied = await clickLocationDialogApply(page);
  if (!applied) throw new Error("Khong bam duoc nut Apply trong Change location.");
  await sleep(3500);
  const afterLocation = String(await readMarketplaceSidebarLocation(page).catch(() => "") || picked || targetBang).trim();
  log(row.profile_id, "market location", "[" + row.uid + "] da Apply Marketplace location: \"" + afterLocation + "\".", "success");
  return { changed: true, before: dialogLocation || sidebarLocation, after: afterLocation, targetBang };
}


const MARKET_TITLE_FILE = fileURLToPath(new URL("../data/title.txt", import.meta.url));
const MARKET_MESSAGE_FILE = fileURLToPath(new URL("../data/message.txt", import.meta.url));

function randomInt(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function randomItem(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return list.length ? list[Math.floor(Math.random() * list.length)] : "";
}

function readNonEmptyLines(filePath) {
  return String(fs.readFileSync(filePath, "utf8") || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\s*[.)-]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function pickMarketplaceSearchTitle() {
  const lines = readNonEmptyLines(MARKET_TITLE_FILE);
  if (!lines.length) throw new Error("File title.txt dang trong hoac khong doc duoc.");
  return randomItem(lines);
}

function pickMarketplaceMessage() {
  const lines = readNonEmptyLines(MARKET_MESSAGE_FILE);
  if (!lines.length) throw new Error("File message.txt dang trong hoac khong doc duoc.");
  return randomItem(lines);
}

async function clickVisiblePoint(page, point, delay = 80) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  await page.mouse?.move?.(point.x, point.y, { steps: 4 }).catch(() => {});
  await sleep(90);
  await page.mouse?.click?.(point.x, point.y, { delay }).catch(() => {});
  return true;
}

async function marketplaceSearchKeyword(page, keyword) {
  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/?ref=bookmark"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await sleep(1800);
  const inputPoint = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const inputs = Array.from(document.querySelectorAll("input[aria-label='Search Marketplace'], input[placeholder*='Search Marketplace'], input[role='combobox'], input[type='search'], input"))
      .filter((node) => node instanceof HTMLInputElement && visible(node));
    const target = inputs.find((node) => /Search Marketplace/i.test(String(node.getAttribute("aria-label") || node.getAttribute("placeholder") || ""))) || inputs.find((node) => node.getBoundingClientRect().left < 420);
    if (!(target instanceof HTMLElement)) return null;
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }).catch(() => null);
  if (!inputPoint) throw new Error("Khong tim thay o Search Marketplace.");
  await clickVisiblePoint(page, inputPoint);
  await page.keyboard.down("Control").catch(() => {});
  await page.keyboard.press("A").catch(() => {});
  await page.keyboard.up("Control").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(120);
  await page.keyboard.type(String(keyword || "").trim(), { delay: 55 });
  await sleep(250);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await sleep(3200);
}

async function clickMarketplaceFilterByText(page, textRegex, area = "sidebar") {
  const point = await page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 12 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("[role='button'], button, label, div, span"))
      .filter((node) => visible(node))
      .map((node) => {
        const text = normalize(node.innerText || node.textContent || node.getAttribute?.("aria-label") || "");
        const rect = node.getBoundingClientRect();
        return { node, text, rect };
      })
      .filter((item) => regex.test(item.text))
      .filter((item) => area !== "sidebar" || item.rect.left < 430)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = candidates[0];
    if (!chosen) return null;
    const clickable = chosen.node.closest("button, [role='button'], label, a") || chosen.node;
    const rect = clickable.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: chosen.text };
  }, textRegex.source).catch(() => null);
  return clickVisiblePoint(page, point);
}

async function ensureShippingDeliveryFilter(page, keyword) {
  const already = await page.evaluate(() => /deliveryMethod=shipping/i.test(location.href) || /Delivery method:\s*Shipping/i.test(document.body?.innerText || "")).catch(() => false);
  if (already) return true;
  await clickMarketplaceFilterByText(page, /Delivery method/).catch(() => false);
  await sleep(800);
  const clickedShipping = await clickMarketplaceFilterByText(page, /^Shipping$/).catch(() => false);
  await sleep(3500);
  const confirmed = await page.evaluate(() => /deliveryMethod=shipping/i.test(location.href) || /Delivery method:\s*Shipping/i.test(document.body?.innerText || "")).catch(() => false);
  if (confirmed) return true;
  if (!clickedShipping) {
    const url = withFacebookLocale("https://www.facebook.com/marketplace/search/?deliveryMethod=shipping&query=" + encodeURIComponent(keyword) + "&exact=false");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    await sleep(3000);
  }
  return page.evaluate(() => /deliveryMethod=shipping/i.test(location.href) || /Delivery method:\s*Shipping/i.test(document.body?.innerText || "")).catch(() => false);
}

async function getMarketplaceSearchUrl(page, keyword) {
  const current = String(page.url?.() || "");
  if (/facebook\.com\/marketplace\//i.test(current) && /query=/i.test(current)) return current;
  return withFacebookLocale("https://www.facebook.com/marketplace/search/?query=" + encodeURIComponent(keyword) + "&exact=false");
}

async function recoverMarketplaceSearch(page, searchUrl, keyword, logger = null) {
  logger?.("dang quay lai trang search Marketplace de tiep tuc.");
  await page.goto(withFacebookLocale(searchUrl || ("https://www.facebook.com/marketplace/search/?query=" + encodeURIComponent(keyword) + "&exact=false")), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await sleep(2800);
}

async function clickRandomVisibleMarketplaceProduct(page, processedKeys = new Set()) {
  const processed = [...processedKeys];
  const target = await page.evaluate((processedList) => {
    const processedSet = new Set(processedList);
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 90 && rect.height > 70 && rect.bottom > 90 && rect.top < window.innerHeight - 35 && rect.right > 360 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const links = Array.from(document.querySelectorAll("a[href*='/marketplace/item/']"))
      .filter((node) => node instanceof HTMLAnchorElement && visible(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "");
        const href = String(node.href || "").split("?")[0];
        const image = node.querySelector("img")?.getBoundingClientRect?.();
        return {
          href,
          key: href || text.slice(0, 180),
          text: text.slice(0, 260),
          top: rect.top,
          left: rect.left,
          area: rect.width * rect.height,
          x: image && image.width > 40 ? image.left + image.width / 2 : rect.left + rect.width / 2,
          y: image && image.height > 40 ? image.top + image.height / 2 : rect.top + Math.min(rect.height * 0.35, 130)
        };
      })
      .filter((item) => item.key && !processedSet.has(item.key));
    if (!links.length) return null;
    const upperHalf = links.filter((item) => item.top < window.innerHeight * 0.82);
    const pool = upperHalf.length ? upperHalf : links;
    return pool[Math.floor(Math.random() * pool.length)] || null;
  }, processed).catch(() => null);
  if (!target) return null;
  await clickVisiblePoint(page, target, 80);
  return target;
}

async function marketplaceItemHasBuyNow(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("[role='button'], button, span, div")).some((node) => visible(node) && /^Buy now$/i.test(normalize(node.innerText || node.textContent || node.getAttribute?.("aria-label") || "")));
  }).catch(() => false);
}

async function clickMarketplaceMessageButton(page) {
  const point = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 24 && rect.height > 18 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll("[role='button'], button"))
      .filter((node) => visible(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, rect, text: normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "") };
      })
      .filter((item) => /^Message$/i.test(item.text) && !item.node.closest("[aria-disabled='true']") && item.node.getAttribute("aria-disabled") !== "true")
      .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);
    const chosen = buttons[0];
    if (!chosen) return null;
    return { x: chosen.rect.left + chosen.rect.width / 2, y: chosen.rect.top + chosen.rect.height / 2, text: chosen.text };
  }).catch(() => null);
  return clickVisiblePoint(page, point, 90);
}

async function waitForMarketplaceMessageDialog(page, timeoutMs = 12000) {
  return page.waitForFunction(() => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
    return /Please type your message to the seller|Send message|Message\s+[^\n]+/i.test(text) && Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).some((node) => /Send message|Please type your message/i.test(node.innerText || node.textContent || ""));
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function clickMarketplaceMessageInput(page) {
  const point = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 80 && rect.height > 30 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find((node) => /Send message|Please type your message/i.test(node.innerText || node.textContent || ""));
    const root = dialog || document;
    const direct = Array.from(root.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")).find((node) => visible(node));
    if (direct instanceof HTMLElement) {
      direct.scrollIntoView({ block: "center", inline: "center" });
      const rect = direct.getBoundingClientRect();
      return { x: rect.left + Math.min(35, rect.width / 2), y: rect.top + Math.min(30, rect.height / 2) };
    }
    const placeholder = Array.from(root.querySelectorAll("div, label, span")).find((node) => visible(node) && /Please type your message to the seller/i.test(node.innerText || node.textContent || ""));
    if (!(placeholder instanceof HTMLElement)) return null;
    const rect = placeholder.getBoundingClientRect();
    return { x: rect.left + Math.min(42, rect.width / 2), y: rect.top + Math.min(32, rect.height / 2) };
  }).catch(() => null);
  return clickVisiblePoint(page, point, 80);
}

async function typeHumanMessageWithMistakes(page, message) {
  const text = String(message || "").trim();
  const mistakes = randomInt(0, 3);
  const mistakeAt = new Set();
  while (mistakeAt.size < mistakes && mistakeAt.size < Math.max(0, text.length - 1)) {
    const index = randomInt(0, Math.max(0, text.length - 1));
    if (/[a-z]/i.test(text[index] || "")) mistakeAt.add(index);
  }
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (mistakeAt.has(index)) {
      const wrong = letters[randomInt(0, letters.length - 1)];
      await page.keyboard.type(wrong, { delay: randomInt(70, 160) });
      await sleep(randomInt(120, 360));
      await page.keyboard.press("Backspace").catch(() => {});
      await sleep(randomInt(80, 220));
    }
    await page.keyboard.type(char, { delay: randomInt(65, 175) });
    if (Math.random() < 0.12) await sleep(randomInt(120, 420));
  }
}

async function clickSendMarketplaceMessage(page) {
  const point = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find((node) => /Send message|Please type your message/i.test(node.innerText || node.textContent || ""));
    const root = dialog || document;
    const buttons = Array.from(root.querySelectorAll("[role='button'], button"))
      .filter((node) => visible(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, rect, text: normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "") };
      })
      .filter((item) => /^(Send message|Send)$/i.test(item.text) && item.node.getAttribute("aria-disabled") !== "true" && !item.node.closest("[aria-disabled='true']"))
      .sort((a, b) => b.rect.left - a.rect.left || b.rect.top - a.rect.top);
    const chosen = buttons[0];
    if (!chosen) return null;
    return { x: chosen.rect.left + chosen.rect.width / 2, y: chosen.rect.top + chosen.rect.height / 2, text: chosen.text };
  }).catch(() => null);
  return clickVisiblePoint(page, point, 100);
}

async function messageMarketplaceItemIfPossible(page, message, logger = null) {
  const hasBuyNow = await marketplaceItemHasBuyNow(page);
  if (!hasBuyNow) return { attempted: false, reason: "no_buy_now" };
  if (Math.random() >= 0.4) return { attempted: false, reason: "skip_message_probability_60_percent" };
  const clickedMessage = await clickMarketplaceMessageButton(page);
  if (!clickedMessage) return { attempted: false, reason: "message_button_not_found" };
  const dialogReady = await waitForMarketplaceMessageDialog(page, 14000);
  if (!dialogReady) return { attempted: false, reason: "message_dialog_not_found" };
  const inputReady = await clickMarketplaceMessageInput(page);
  if (!inputReady) return { attempted: false, reason: "message_input_not_found" };
  await sleep(randomInt(250, 650));
  await typeHumanMessageWithMistakes(page, message);
  await sleep(randomInt(400, 1000));
  const sent = await clickSendMarketplaceMessage(page);
  if (!sent) return { attempted: true, sent: false, reason: "send_button_not_found" };
  logger?.("da bam Send message, doi gui xong.");
  await sleep(randomInt(2500, 4500));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  return { attempted: true, sent: true };
}


async function browseMarketplaceResultsBeforePicking(interactionManager, page, config, logger = null) {
  const scrolls = randomInt(1, 3);
  logger?.("luot cho " + scrolls + " nhip truoc khi chon random san pham.");
  for (let index = 0; index < scrolls; index += 1) {
    const fallbackScroll = randomInt(420, 760);
    await interactionManager.humanScroll(page, config, "down", index >= 1 ? "normal" : "light").catch(() => page.evaluate((amount) => window.scrollBy(0, amount), fallbackScroll).catch(() => {}));
    await interactionManager.waitHumanOnPage(page, config, 900, 2200).catch(() => sleep(randomInt(900, 1800)));
  }
}

async function runSearchShippingMarketplaceInteraction(interactionManager, page, row, config, options, log) {
  const keyword = pickMarketplaceSearchTitle();
  const targetViews = randomInt(4, 7);
  const processed = new Set();
  let viewed = 0;
  let sent = 0;
  let searchUrl = "";
  const logger = (message, type = "info") => log(row.profile_id, "market search", "[" + row.uid + "] " + message, type);
  logger("bat dau search Marketplace keyword: \"" + keyword + "\", muc tieu xem " + targetViews + " san pham.");

  await marketplaceSearchKeyword(page, keyword);
  searchUrl = await getMarketplaceSearchUrl(page, keyword);
  if (!/query=/i.test(String(page.url?.() || ""))) await recoverMarketplaceSearch(page, searchUrl, keyword, logger);
  await browseMarketplaceResultsBeforePicking(interactionManager, page, config, logger);

  let stagnant = 0;
  for (let attempt = 0; attempt < 80 && viewed < targetViews; attempt += 1) {
    if (options.runtime.stopRequested) throw buildStoppedError();
    if (typeof interactionManager.throwIfCheckpointDetected === "function") await interactionManager.throwIfCheckpointDetected(page);
    try {
      if (!/facebook\.com\/marketplace\//i.test(String(page.url?.() || "")) || /\/marketplace\/item\//i.test(String(page.url?.() || ""))) {
        await recoverMarketplaceSearch(page, searchUrl, keyword, logger);
      }
      await browseMarketplaceResultsBeforePicking(interactionManager, page, config, logger);
      const target = await clickRandomVisibleMarketplaceProduct(page, processed);
      if (!target) {
        await interactionManager.humanScroll(page, config, "down", attempt > 20 ? "heavy" : "normal").catch(() => page.evaluate(() => window.scrollBy(0, 650)).catch(() => {}));
        await interactionManager.waitHumanOnPage(page, config, 800, 1700).catch(() => sleep(1200));
        stagnant += 1;
        if (stagnant >= 8) {
          logger("khong tim thay san pham moi sau khi cuon nhieu lan, search lai de tiep tuc.", "warn");
          await recoverMarketplaceSearch(page, searchUrl, keyword, logger);
          stagnant = 0;
        }
        continue;
      }
      processed.add(target.key);
      stagnant = 0;
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 18000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(randomInt(1800, 3200));
      viewed += 1;
      logger("da mo san pham " + viewed + "/" + targetViews + ": " + (target.text || target.href || "(khong doc duoc ten)"), "success");
      const message = pickMarketplaceMessage();
      const messageResult = await messageMarketplaceItemIfPossible(page, message, (msg) => logger(msg));
      if (messageResult.sent) {
        sent += 1;
        logger("da gui message: \"" + message + "\".", "success");
      } else {
        logger("bo qua message san pham nay: " + (messageResult.reason || "unknown") + ".", "warn");
      }
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 16000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(randomInt(1600, 2800));
      if (!/query=/i.test(String(page.url?.() || ""))) {
        await recoverMarketplaceSearch(page, searchUrl, keyword, logger);
      }
      await interactionManager.waitHumanOnPage(page, config, 900, 1800).catch(() => sleep(1000));
    } catch (error) {
      logger("loi bat thuong khi xu ly san pham, quay ve search de lam tiep: " + String(error?.message || error || ""), "warn");
      await recoverMarketplaceSearch(page, searchUrl, keyword, logger).catch(() => {});
    }
  }
  logger("ket thuc market search: da xem " + viewed + "/" + targetViews + " san pham, gui " + sent + " tin nhan.", viewed >= targetViews ? "success" : "warn");
  return { keyword, viewed, targetViews, sent };
}

async function clickNextVisibleRenewTipListing(page, processedKeys = new Set()) {
  const processed = [...processedKeys].map(normalizeRenewKey).filter(Boolean);
  return page.evaluate((processedList) => {
    const processedSet = new Set(processedList);
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 80
        && rect.height > 30
        && rect.bottom > 80
        && rect.top < window.innerHeight - 20
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("[role='button'][aria-label]"))
      .filter((node) => isVisible(node) && /Tip:\s*Renew your listing\?/i.test(node.innerText || node.textContent || ""))
      .map((node) => {
        const title = normalize(node.getAttribute("aria-label") || "");
        const text = normalize(node.innerText || node.textContent || "");
        const rect = node.getBoundingClientRect();
        return {
          node,
          title,
          text,
          key: normalize(`${title}|${text}`),
          top: rect.top,
          area: rect.width * rect.height
        };
      })
      .filter((item) => item.title && item.text && !processedSet.has(item.key))
      .sort((a, b) => (a.top - b.top) || (a.area - b.area));
    const target = candidates[0];
    if (!target) return null;
    target.node.scrollIntoView({ block: "center", inline: "nearest" });
    target.node.click();
    return {
      title: target.title,
      key: target.key,
      text: target.text.slice(0, 500)
    };
  }, processed).catch(() => null);
}

async function clickRenewButtonInsideListingDialog(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(isVisible);
    const dialog = dialogs.find((node) => /Your Listing/i.test(node.innerText || node.textContent || ""));
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll("[role='button'], button")).filter(isVisible);
    const target = buttons.find((button) =>
      normalize(button.innerText || button.textContent || "") === "Renew listing"
      && normalize(button.getAttribute("aria-label") || "") === "Renew listing"
    );
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  }).catch(() => false);
}

async function getRenewDialogState(page) {
  return page.evaluate(() => {
    const bodyText = String(document.body?.innerText || "");
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).find(isVisible);
    const dialogText = String(dialog?.innerText || dialog?.textContent || "");
    const hasDialogRenewButton = dialog
      ? Array.from(dialog.querySelectorAll("[role='button'], button")).some((button) => {
          if (!isVisible(button)) return false;
          const text = String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim();
          const aria = String(button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          return text === "Renew listing" && aria === "Renew listing";
        })
      : false;
    return {
      hasYourListingDialog: Boolean(dialog && /Your Listing/i.test(dialogText)),
      hasDialogRenewButton,
      renewedToast: /Your listing has been renewed/i.test(bodyText),
      problem: /Problem Renewing Post|wasn't renewed|was not renewed/i.test(bodyText)
    };
  }).catch(() => ({
    hasYourListingDialog: false,
    hasDialogRenewButton: false,
    renewedToast: false,
    problem: false
  }));
}

async function closeTopFacebookDialog(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(isVisible);
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll("[role='button'], button")).filter(isVisible);
    const close = buttons.find((button) => /^(Close|Dong)$/i.test(String(button.innerText || button.textContent || "").trim()))
      || buttons.find((button) => /close|dong/i.test(String(button.getAttribute("aria-label") || "")));
    if (!(close instanceof HTMLElement)) return false;
    close.click();
    return true;
  }).catch(() => false);
}

async function getDashboardBucket(page, label) {
  return page.evaluate((targetLabel) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 30 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
    };
    const escaped = String(targetLabel || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelRe = new RegExp(`^${escaped}\\s+(\\d+)$`, "i");
    const nodes = Array.from(document.querySelectorAll("a, [role='link'], [role='listitem'], div"))
      .filter((node) => isVisible(node))
      .map((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        const match = text.match(labelRe);
        if (!match) return null;
        const rect = node.getBoundingClientRect();
        return {
          node,
          text,
          count: Number(match[1] || 0),
          area: rect.width * rect.height,
          top: rect.top,
          clickable: node.closest("a, [role='link']") || node
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.area - b.area) || (a.top - b.top));
    const target = nodes[0];
    if (!target) return null;
    const rect = target.clickable.getBoundingClientRect();
    return {
      text: target.text,
      count: target.count,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }, label).catch(() => null);
}

async function findDashboardBucketByScrolling(interactionManager, page, row, config, label) {
  let stagnantCount = 0;
  let lastBottom = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bucket = await getDashboardBucket(page, label);
    if (bucket) return bucket;
    await interactionManager.humanScroll(page, config, "down", attempt > 6 ? "heavy" : "normal");
    await interactionManager.waitHumanOnPage(page, config, 700, 1600);
    const scrollState = await getSellingScrollState(page);
    if (scrollState.bottom <= lastBottom + 12) stagnantCount += 1;
    else stagnantCount = 0;
    lastBottom = scrollState.bottom;
    if (stagnantCount >= 4 || scrollState.bottom >= scrollState.height - 20) break;
  }
  interactionManager.sendLog?.(`[${row.uid}] khong tim thay the ${label} tren dashboard.`, "warn");
  return null;
}

async function clickDashboardBucket(page, label) {
  if (!/\/marketplace\/you\/dashboard/i.test(page.url())) return null;
  const target = await page.evaluate((targetLabel) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 60
        && rect.height > 40
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && style.pointerEvents !== "none";
    };
    const escaped = String(targetLabel || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelRe = new RegExp(`^${escaped}\\s+(\\d+)$`, "i");
    const nodes = Array.from(document.querySelectorAll("[role='button'], a, [role='link'], [role='listitem'], div"));
    const candidates = nodes
      .filter(isVisible)
      .map((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        const match = text.match(labelRe);
        if (!match) return null;
        const rect = node.getBoundingClientRect();
        if (rect.width > 360 || rect.height > 170) return null;
        if (text.length > targetLabel.length + 12) return null;
        return {
          text,
          count: Number(match[1] || 0),
          area: rect.width * rect.height,
          top: rect.top,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.area - b.area) || (a.top - b.top));
    return candidates[0] || null;
  }, label).catch(() => null);
  if (!target) return null;
  await page.mouse.move(target.x, target.y, { steps: 4 }).catch(() => {});
  await sleep(80);
  await page.mouse.click(target.x, target.y, { delay: 80 }).catch(() => {});
  return { text: target.text, count: target.count };
}
async function getRenewPageState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8
        && rect.height > 8
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity || 1) > 0.15;
    };
    const text = normalize(document.body?.innerText || "");
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(isVisible);
    const dialog = dialogs.find((node) => /Renew listings/i.test(normalize(node.innerText || node.textContent || "")));
    const routeRoot = /\/marketplace\/selling\/renew_listings/i.test(location.pathname) ? document.body : null;
    const root = dialog || routeRoot;
    const buttons = root
      ? Array.from(root.querySelectorAll("[role='button'], button, a[role='button'], div[aria-label], span"))
        .filter(isVisible)
        .map((node) => normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || ""))
        .filter(Boolean)
        .slice(0, 40)
      : [];
    const exactRenew = root && Array.from(root.querySelectorAll("[role='button'], button, a[role='button'], div[aria-label], span"))
      .filter(isVisible)
      .some((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        const aria = normalize(node.getAttribute("aria-label") || "");
        return /^Renew$/i.test(text) || /^Renew$/i.test(aria) || /^Renewed$/i.test(text) || /^Renewed$/i.test(aria);
      });
    return {
      url: location.href,
      textLength: text.length,
      text: text.slice(0, 500),
      hasRenewListings: Boolean(root) && /Renew listings/i.test(text),
      hasRenewButton: Boolean(exactRenew),
      hasRenewRoot: Boolean(root),
      hasFacebookShellOnly: /facebook\.com\/marketplace\/selling\/renew_listings/i.test(location.href) && text.length < 80,
      buttons
    };
  }).catch((error) => ({ url: "", textLength: 0, text: "", hasRenewListings: false, hasRenewButton: false, hasRenewRoot: false, hasFacebookShellOnly: false, buttons: [], error: String(error?.message || error || "") }));
}
async function dismissFacebookOverlays(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const text = normalize(document.body?.innerText || "");
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 16
          && rect.height > 16
          && rect.bottom > 0
          && rect.top < window.innerHeight
          && rect.right > 0
          && rect.left < window.innerWidth
          && style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || 1) > 0.15;
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(visible);
      const protectedDialogOpen = dialogs.some((dialog) => /Renew listings|Your Listing|Delete listing|Renew your listing\?|Verify your identity/i.test(normalize(dialog.innerText || dialog.textContent || "")));
      const panelOpen = /Notifications\s*All\s*Unread|AllUnreadNew|See previous notifications|Notification Actions|Mark as read,|Messenger\s*,?\s*\d+ unread|Unread Chats/i.test(text);
      const buttons = Array.from(document.querySelectorAll("[role='button'], button, div[aria-label], a[aria-label]")).filter(visible);
      const closeButton = buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            aria: normalize(button.getAttribute("aria-label") || ""),
            text: normalize(button.innerText || button.textContent || ""),
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          };
        })
        .filter((item) => item.top < 180 && item.left > window.innerWidth - 620)
        .find((item) => /^(Close|Dismiss)$/i.test(item.aria) || /^(Close|Dismiss)$/i.test(item.text));
      return { panelOpen, protectedDialogOpen, closeButton };
    }).catch(() => ({ panelOpen: false, protectedDialogOpen: false }));

    if (!state.panelOpen) return true;
    if (state.closeButton && Number.isFinite(state.closeButton.x) && Number.isFinite(state.closeButton.y)) {
      try { await page.mouse?.click?.(state.closeButton.x, state.closeButton.y); } catch {}
      await sleep(600);
      continue;
    }

    if (!state.protectedDialogOpen) {
      try { await page.keyboard?.press?.("Escape"); } catch {}
      await sleep(650);
      continue;
    }
    break;
  }
  return !(await hasBlockingNotificationPanel(page).catch(() => false));
}
async function resetFacebookPageDocument(page, url) {
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(450);
  await page.goto(withFacebookLocale(url), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
}
async function hasBlockingNotificationPanel(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
    return /Notifications\s*All\s*Unread|AllUnreadNew|See previous notifications|Notification Actions|Mark as read, /i.test(text);
  }).catch(() => false);
}
function isRenewStateReady(state) {
  return Boolean(state && state.hasRenewRoot && (state.hasRenewListings || state.hasRenewButton) && !state.hasFacebookShellOnly);
}
async function getRenewButtonState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 12
        && rect.height > 12
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity || 1) > 0.15;
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(isVisible);
    const roots = dialogs.length ? dialogs : [document.body];
    const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll("[role='button'], button, a[role='button'], div[aria-label], span")));
    const visibleButtons = buttons.filter(isVisible).map((node) => {
      const text = normalize(node.innerText || node.textContent || "");
      const aria = normalize(node.getAttribute("aria-label") || "");
      const rect = node.getBoundingClientRect();
      return { text, aria, disabled: node.getAttribute("aria-disabled") || node.disabled || false, x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
    const renew = visibleButtons.filter((item) => /^Renew$/i.test(item.text) || /^Renew$/i.test(item.aria));
    const renewed = visibleButtons.filter((item) => /\bRenewed\b/i.test(`${item.text} ${item.aria}`));
    return { renewCount: renew.length, renewedCount: renewed.length, seen: visibleButtons.filter((item) => /Renew|Done/i.test(`${item.text} ${item.aria}`)).slice(0, 30) };
  }).catch(() => ({ renewCount: 0, renewedCount: 0, seen: [] }));
}

async function getVisibleRenewButtonsByXPath(page) {
  return page.evaluate(() => {
    const xpath = "(//span[normalize-space()='Renew']/ancestor::div[@role='none'][2])";
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 10
        && rect.height > 10
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && Number(style.opacity || 1) > 0.15;
    };
    const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const buttons = [];
    for (let index = 0; index < snapshot.snapshotLength; index += 1) {
      const node = snapshot.snapshotItem(index);
      if (!(node instanceof HTMLElement) || !visible(node)) continue;
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const disabled = node.getAttribute("aria-disabled") === "true"
        || node.closest("[aria-disabled='true']")
        || /\bRenewed\b/i.test(text);
      if (disabled) continue;
      const rect = node.getBoundingClientRect();
      buttons.push({
        domIndex: index,
        text,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        top: rect.top,
        width: rect.width,
        height: rect.height
      });
    }
    return buttons.sort((a, b) => a.top - b.top);
  }).catch(() => []);
}

async function prepareRenewButtonByDomIndex(page, domIndex) {
  return page.evaluate((targetDomIndex) => {
    const xpath = "(//span[normalize-space()='Renew']/ancestor::div[@role='none'][2])";
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 10
        && rect.height > 10
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && style.pointerEvents !== "none"
        && Number(style.opacity || 1) > 0.15;
    };
    const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const node = snapshot.snapshotItem(targetDomIndex);
    if (!(node instanceof HTMLElement)) return { ok: false, reason: "missing_node" };
    node.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    const disabled = node.getAttribute("aria-disabled") === "true"
      || node.closest("[aria-disabled='true']")
      || /\bRenewed\b/i.test(text);
    if (!visible(node) || disabled) return { ok: false, reason: "not_interactable", text, disabled: Boolean(disabled) };
    return { ok: true, text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, domIndex).catch((error) => ({ ok: false, reason: "prepare_failed", error: String(error?.message || error || "") }));
}

async function jsClickRenewButtonByDomIndex(page, domIndex) {
  return page.evaluate((targetDomIndex) => {
    const xpath = "(//span[normalize-space()='Renew']/ancestor::div[@role='none'][2])";
    const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const node = snapshot.snapshotItem(targetDomIndex);
    if (!(node instanceof HTMLElement)) return { ok: false, reason: "missing_node" };
    node.scrollIntoView({ block: "center", inline: "center" });
    node.click();
    return { ok: true, text: String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() };
  }, domIndex).catch((error) => ({ ok: false, reason: "js_click_failed", error: String(error?.message || error || "") }));
}

async function clickNextRenewDashboardButton(page, logger = null) {
  const before = await getRenewButtonState(page);
  const visibleButtons = await getVisibleRenewButtonsByXPath(page);
  logger?.("tim thay " + visibleButtons.length + " nut Renew dang hien bang XPath.");
  if (!visibleButtons.length) {
    const seen = before.seen || [];
    const doneVisible = seen.some((item) => /^Done$/i.test(item.text) || /^Done$/i.test(item.aria));
    return { ok: false, reason: before.renewedCount > 0 && doneVisible ? "all_visible_renewed" : "no_button", renewedCount: before.renewedCount, doneVisible, seen };
  }

  for (let buttonIndex = 0; buttonIndex < visibleButtons.length; buttonIndex += 1) {
    const target = visibleButtons[buttonIndex];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      logger?.("thu bam Renew visible " + (buttonIndex + 1) + "/" + visibleButtons.length + " attempt " + attempt + "/3 tai " + Math.round(target.x) + "," + Math.round(target.y) + ".");
      try {
        const prepared = await prepareRenewButtonByDomIndex(page, target.domIndex);
        if (!prepared.ok) {
          logger?.("Renew visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua interactable: " + (prepared.reason || "unknown") + ", thu JS click.");
          const jsClickedWhenBlocked = await jsClickRenewButtonByDomIndex(page, target.domIndex);
          await sleep(900);
          const afterBlocked = await getRenewButtonState(page);
          if (jsClickedWhenBlocked.ok && (afterBlocked.renewedCount > before.renewedCount || afterBlocked.renewCount < before.renewCount)) {
            logger?.("bam Renew visible " + (buttonIndex + 1) + " thanh cong bang JS click khi normal chua interactable o attempt " + attempt + "/3.");
            return { ok: true, text: jsClickedWhenBlocked.text || target.text, verified: true, before, after: afterBlocked };
          }
          logger?.("JS click khi chua interactable attempt " + attempt + "/3 chua thanh cong: " + (jsClickedWhenBlocked.reason || "khong doi trang thai") + ".");
          await sleep(350);
          continue;
        }
        await page.mouse?.move?.(prepared.x, prepared.y, { steps: 3 });
        await sleep(80);
        await page.mouse?.click?.(prepared.x, prepared.y, { delay: 80 });
        await sleep(800);
        let after = await getRenewButtonState(page);
        if (after.renewedCount > before.renewedCount || after.renewCount < before.renewCount) {
          logger?.("bam Renew visible " + (buttonIndex + 1) + " thanh cong bang normal click o attempt " + attempt + "/3.");
          return { ok: true, text: prepared.text, verified: true, before, after };
        }

        logger?.("normal click visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua doi trang thai, thu JS click.");
        const jsClicked = await jsClickRenewButtonByDomIndex(page, target.domIndex);
        await sleep(900);
        after = await getRenewButtonState(page);
        if (jsClicked.ok && (after.renewedCount > before.renewedCount || after.renewCount < before.renewCount)) {
          logger?.("bam Renew visible " + (buttonIndex + 1) + " thanh cong bang JS click o attempt " + attempt + "/3.");
          return { ok: true, text: jsClicked.text || prepared.text, verified: true, before, after };
        }
        logger?.("JS click visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua thanh cong: " + (jsClicked.reason || "khong doi trang thai") + ".");
      } catch (error) {
        logger?.("exception khi bam Renew visible " + (buttonIndex + 1) + " attempt " + attempt + "/3: " + String(error?.message || error || ""));
      }
      await sleep(450);
    }
    logger?.("bo qua nut Renew visible " + (buttonIndex + 1) + " sau 3 attempt, tiep tuc nut visible tiep theo.");
  }
  const after = await getRenewButtonState(page);
  logger?.("khong bam thanh cong nut Renew nao trong " + visibleButtons.length + " nut visible.");
  return { ok: false, reason: "click_failed", before, after, seen: after.seen };
}
async function scrollRenewDashboardDialog(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
      .filter(isVisible)
      .find((node) => /Renew listings/i.test(node.innerText || node.textContent || ""));
    const routeRoot = /\/marketplace\/selling\/renew_listings/i.test(location.pathname) ? document.body : null;
    const root = dialog || routeRoot;
    if (!root) return { ok: false, bottom: 0, height: 0 };
    const scrollables = Array.from(root.querySelectorAll("div"))
      .filter((node) => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 20)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const scroller = scrollables[0] || document.scrollingElement || document.documentElement;
    const before = scroller.scrollTop;
    scroller.scrollBy({ top: 460, behavior: "auto" });
    return { ok: true, before, bottom: scroller.scrollTop + scroller.clientHeight, height: scroller.scrollHeight };
  }).catch(() => ({ ok: false, bottom: 0, height: 0 }));
}

async function hasRenewDashboardDialog(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const hasDialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
      .filter(isVisible)
      .some((node) => /Renew listings/i.test(node.innerText || node.textContent || ""));
    return hasDialog || /\/marketplace\/selling\/renew_listings/i.test(location.pathname);
  }).catch(() => false);
}

async function clickRenewDashboardDone(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20
        && rect.height > 20
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(isVisible);
    const dialog = dialogs.find((node) => /Renew listings/i.test(node.innerText || node.textContent || ""));
    const routeRoot = /\/marketplace\/selling\/renew_listings/i.test(location.pathname) ? document.body : null;
    const root = dialog || routeRoot;
    if (!root) return false;
    const done = Array.from(root.querySelectorAll("[role='button'], button")).find((node) => {
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const aria = String(node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return isVisible(node) && (text === "Done" || aria === "Done");
    });
    if (!(done instanceof HTMLElement)) return false;
    done.click();
    return true;
  }).catch(() => false);
}
async function renewFromDashboard(interactionManager, page, row, config, options, log) {
  let totalRenewed = 0;
  let firstCount = null;
  let lastCount = null;

  for (let pass = 1; pass <= 4; pass += 1) {
    if (options.runtime.stopRequested) throw buildStoppedError();

    await resetFacebookPageDocument(page, "https://www.facebook.com/marketplace/you/dashboard");
    await sleep(3200);
    await dismissFacebookOverlays(page);

    const bucket = await findDashboardBucketByScrolling(interactionManager, page, row, config, "To renew");
    if (!bucket) {
      log(row.profile_id, "bam renew", `[${row.uid}] khong doc duoc To renew tren dashboard o lan ${pass}.`, "warn");
      lastCount = null;
      continue;
    }
    if (firstCount === null) firstCount = bucket.count;
    lastCount = bucket.count;
    if (!bucket.count) {
      log(row.profile_id, "bam renew", `[${row.uid}] To renew dang la 0, xong buoc renew.`, "success");
      return { renewed: totalRenewed, before: firstCount, after: 0, verified: true, passes: pass };
    }

    log(row.profile_id, "bam renew", `[${row.uid}] To renew lan ${pass}: con ${bucket.count}, dang mo Renew listings tu dashboard...`, "warn");
    await dismissFacebookOverlays(page);
    if (!/\/marketplace\/you\/dashboard/i.test(page.url())) {
      log(row.profile_id, "bam renew", `[${row.uid}] trang bi lech khoi dashboard truoc khi bam To renew: ${page.url()}, quay lai dashboard.`, "warn");
      await resetFacebookPageDocument(page, "https://www.facebook.com/marketplace/you/dashboard");
      await sleep(3000);
      await dismissFacebookOverlays(page);
      await findDashboardBucketByScrolling(interactionManager, page, row, config, "To renew");
    }
    const clickedBucket = await clickDashboardBucket(page, "To renew");
    await sleep(5000);
    await dismissFacebookOverlays(page);

    let renewState = await getRenewPageState(page);
    let dialogReady = isRenewStateReady(renewState);
    if (!dialogReady) {
      log(row.profile_id, "bam renew", `[${row.uid}] bam To renew tu dashboard chua mo duoc list: clicked=${Boolean(clickedBucket)}, url=${renewState.url}, text=${renewState.textLength}, buttons=${(renewState.buttons || []).join(" | ")}`, "warn");
      await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/selling/renew_listings/?is_routable_dialog=true"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(5000);
      await dismissFacebookOverlays(page);
      renewState = await getRenewPageState(page);
      dialogReady = isRenewStateReady(renewState);
      if (!dialogReady) {
        log(row.profile_id, "bam renew", `[${row.uid}] URL renew fallback van chua co list: url=${renewState.url}, text=${renewState.textLength}, buttons=${(renewState.buttons || []).join(" | ")}`, "warn");
        continue;
      }
    }

    let renewedThisPass = 0;
    let stagnantCount = 0;
    let lastBottom = 0;
    for (let attempt = 0; attempt < 140; attempt += 1) {
      if (options.runtime.stopRequested) throw buildStoppedError();
      const clicked = await clickNextRenewDashboardButton(page, (message) => log(row.profile_id, "bam renew", `[${row.uid}] ${message}`, "info"));
      if (clicked.ok) {
        renewedThisPass += 1;
        totalRenewed += 1;
        stagnantCount = 0;
        log(row.profile_id, "bam renew", `[${row.uid}] da bam Renew ${renewedThisPass}/${bucket.count} trong lan ${pass}.`, "success");
        await sleep(2500);
        continue;
      }

      const stillDialog = await hasRenewDashboardDialog(page);
      if (!stillDialog) {
        log(row.profile_id, "bam renew", `[${row.uid}] Renew listings da dong hoac chuyen trang, dang verify lai dashboard.`, "info");
        break;
      }
      if (clicked.reason === "all_visible_renewed") {
        log(row.profile_id, "bam renew", `[${row.uid}] tat ca nut Renew dang thay da thanh Renewed, dong popup de verify dashboard.`, "success");
        break;
      }
      if (clicked.reason === "no_button") {
        const seen = Array.isArray(clicked.seen) ? clicked.seen.map((item) => `${item.text || "?"}/${item.aria || "?"}/${item.disabled || ""}`).join(" | ") : "";
        log(row.profile_id, "bam renew", `[${row.uid}] chua thay nut Renew trong popup, dang cuon tiep. Buttons: ${seen}`, "warn");
      }
      const scrollState = await scrollRenewDashboardDialog(page);
      await sleep(850);
      if (!scrollState.ok || scrollState.bottom <= lastBottom + 8 || scrollState.bottom >= scrollState.height - 8) stagnantCount += 1;
      else stagnantCount = 0;
      lastBottom = scrollState.bottom;
      if (stagnantCount >= 3) break;
    }

    await clickRenewDashboardDone(page).catch(() => false);
    await sleep(1400);

    await resetFacebookPageDocument(page, "https://www.facebook.com/marketplace/you/dashboard");
    await sleep(3200);
    await dismissFacebookOverlays(page);
    const afterBucket = await findDashboardBucketByScrolling(interactionManager, page, row, config, "To renew");
    lastCount = afterBucket?.count ?? null;
    log(row.profile_id, "bam renew", `[${row.uid}] To renew sau lan ${pass}: ${lastCount}.`, lastCount === 0 ? "success" : "warn");
    if (lastCount === 0) {
      return { renewed: totalRenewed, before: firstCount, after: 0, verified: true, passes: pass };
    }
  }

  log(row.profile_id, "bam renew", `[${row.uid}] To renew van con ${lastCount ?? "?"} sau nhieu lan thu, tiep tuc sang Needs attention thay vi bo qua.`, "warn");
  return { renewed: totalRenewed, before: firstCount, after: lastCount, verified: lastCount === 0, passes: 4 };
}
async function clickNextNeedsAttentionListing(page, processedKeys = new Set()) {
  const processed = [...processedKeys].map(normalizeRenewKey).filter(Boolean);
  const target = await page.evaluate((processedList) => {
    const processedSet = new Set(processedList);
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const warningRegex = /Please take action on this listing\./i;
    const warningCount = (value) => (String(value || "").match(/Please take action on this listing\./gi) || []).length;
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 80
        && rect.height > 30
        && rect.bottom > 80
        && rect.top < window.innerHeight - 20
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none"
        && style.pointerEvents !== "none"
        && Number(style.opacity || 1) > 0.15;
    };
    const extractTitle = (node) => {
      const aria = normalize(node.getAttribute?.("aria-label") || "");
      const raw = String(node.innerText || node.textContent || "");
      const lines = raw.split(/\n+/).map(normalize).filter(Boolean);
      const warningIndex = lines.findIndex((line) => warningRegex.test(line));
      const title = warningIndex >= 0 ? lines.slice(warningIndex + 1).find((line) => !/^\$?\d/.test(line) && !/^(Active|Listed|Mark as sold|Promote now|Boost listing|Share|More)$/i.test(line)) : "";
      return title || aria || normalize(raw.replace(warningRegex, "")).slice(0, 160);
    };
    const strictNodes = Array.from(document.querySelectorAll("[role='article'], [role='listitem'], [role='button'][aria-label], a[role='link'], [role='link']"));
    const fallbackNodes = Array.from(document.querySelectorAll("div"));
    const buildCandidate = (node, allowFallback) => {
      if (!isVisible(node)) return null;
      const text = node.innerText || node.textContent || "";
      if (!warningRegex.test(text)) return null;
      if (warningCount(text) !== 1) return null;
      const clickable = node.closest("[role='article'], [role='listitem'], [role='button'][aria-label], a, [role='link']") || node;
      if (!isVisible(clickable)) return null;
      const rect = clickable.getBoundingClientRect();
      const rawText = normalize(clickable.innerText || clickable.textContent || text);
      if (warningCount(rawText) !== 1) return null;
      if (rawText.length > 1100) return null;
      if (rect.height > (allowFallback ? 360 : 420) || rect.width > Math.min(window.innerWidth - 40, 980)) return null;
      const hasListingControls = /Mark as sold|Promote now|Boost listing|Share/i.test(rawText);
      if (allowFallback && !hasListingControls) return null;
      const title = extractTitle(clickable);
      const image = clickable.querySelector?.("img") || null;
      const imageRect = image?.getBoundingClientRect?.();
      const x = imageRect && imageRect.width > 10 ? imageRect.left + imageRect.width / 2 : rect.left + Math.min(rect.width * 0.32, 240);
      const y = imageRect && imageRect.height > 10 ? imageRect.top + imageRect.height / 2 : rect.top + Math.min(rect.height * 0.42, 110);
      return {
        title,
        key: normalize(`${title}|${rawText.slice(0, 420)}`),
        top: rect.top,
        area: rect.width * rect.height,
        x,
        y,
        href: clickable.href || "",
        text: rawText.slice(0, 240)
      };
    };
    const candidates = strictNodes.map((node) => buildCandidate(node, false)).filter(Boolean);
    if (!candidates.length) {
      candidates.push(...fallbackNodes.map((node) => buildCandidate(node, true)).filter(Boolean));
    }
    return candidates
      .filter((item) => item.title && !processedSet.has(item.key))
      .sort((a, b) => (a.top - b.top) || (a.area - b.area))[0] || null;
  }, processed).catch(() => null);
  if (!target) return null;
  await page.mouse.move(target.x, target.y, { steps: 4 }).catch(() => {});
  await sleep(80);
  await page.mouse.down().catch(() => {});
  await sleep(90);
  await page.mouse.up().catch(() => {});
  return { title: target.title, key: target.key, href: target.href, text: target.text };
}async function hasYourListingDialog(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 60 && rect.height > 60 && rect.bottom > 0 && rect.top < window.innerHeight && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("div[role='dialog']")).filter(visible).some((dialog) => {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      return /Your Listing/i.test(text) && /Delete listing/i.test(text) && !/Are you sure (?:that )?you want to delete this listing\?/i.test(text);
    });
  }).catch(() => false);
}

async function waitForListingDialog(page, logger = null, timeoutMs = 12000) {
  logger?.("dang doi listing dialog...");
  const found = await page.waitForFunction(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 60 && rect.height > 60 && rect.bottom > 0 && rect.top < window.innerHeight && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("div[role='dialog']")).filter(visible).some((dialog) => {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      return /Your Listing/i.test(text) && /Delete listing/i.test(text) && !/Are you sure (?:that )?you want to delete this listing\?/i.test(text);
    });
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
  logger?.(found ? "Listing dialog detected." : "khong thay listing dialog trong thoi gian cho.");
  return found;
}

async function waitForDeleteConfirmationDialog(page, logger = null, timeoutMs = 12000) {
  logger?.("dang doi confirmation dialog Delete listing...");
  const found = await page.waitForFunction(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 60 && rect.height > 60 && rect.bottom > 0 && rect.top < window.innerHeight && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(visible).some((dialog) => {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      return /Delete listing/i.test(text) && /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
    });
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
  logger?.(found ? "Confirmation dialog detected." : "khong thay confirmation dialog trong thoi gian cho.");
  return found;
}



async function findDeleteMarketplaceListingButton(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const usable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 6
        && rect.height > 6
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("div[role='dialog'], [aria-modal='true']"))
      .filter((dialog) => dialog instanceof HTMLElement && usable(dialog));
    const dialog = dialogs.find((node) => {
      const text = normalize(node.innerText || node.textContent || "");
      return /Your listing/i.test(text) && (/Mark as pending|Edit Listing|Delete listing|More/i.test(text));
    }) || dialogs.find((node) => /Your listing/i.test(normalize(node.innerText || node.textContent || ""))) || dialogs[dialogs.length - 1];
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: "no_listing_dialog" };

    const labels = Array.from(dialog.querySelectorAll("span, div"))
      .filter((node) => node instanceof HTMLElement && usable(node) && normalize(node.innerText || node.textContent || "") === "Delete listing")
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => b.rect.top - a.rect.top);
    const label = labels[0];
    if (!(label?.node instanceof HTMLElement)) {
      return {
        ok: false,
        reason: "delete_listing_label_not_found",
        dialogText: normalize(dialog.innerText || dialog.textContent || "").slice(0, 260),
        ariaButtons: Array.from(dialog.querySelectorAll("[aria-label]")).map((node) => normalize(node.getAttribute("aria-label") || "")).filter(Boolean).slice(0, 40)
      };
    }

    const labelCenterX = label.rect.left + label.rect.width / 2;
    const labelTop = label.rect.top;
    const labelBottom = label.rect.bottom;
    const candidates = Array.from(dialog.querySelectorAll("div[role='button'], button, [aria-label]"))
      .filter((node) => node instanceof HTMLElement && usable(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(node.innerText || node.textContent || "");
        const aria = normalize(node.getAttribute("aria-label") || "");
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return {
          node,
          rect,
          text,
          aria,
          cx,
          cy,
          dx: Math.abs(cx - labelCenterX),
          aboveGap: labelTop - cy,
          area: rect.width * rect.height
        };
      })
      .filter((item) => item.dx < 90)
      .filter((item) => item.cy < labelBottom + 12 && item.cy > labelTop - 130)
      .filter((item) => item.node.getAttribute("aria-disabled") !== "true" && !item.node.closest("[aria-disabled='true']"))
      .filter((item) => !/Mark as sold|Edit Listing|More|Promote now|Confirm Your Identity|Cancel/i.test(item.text + " " + item.aria))
      .sort((a, b) => {
        const ariaA = /Delete marketplace listing|Delete listing/i.test(a.aria) ? 0 : 1;
        const ariaB = /Delete marketplace listing|Delete listing/i.test(b.aria) ? 0 : 1;
        return ariaA - ariaB || Math.abs(a.aboveGap - 42) - Math.abs(b.aboveGap - 42) || a.dx - b.dx || a.area - b.area;
      });
    let target = candidates[0]?.node || null;
    if (!(target instanceof HTMLElement)) {
      for (const offset of [20, 32, 44, 56, 68, 80]) {
        const hit = document.elementFromPoint(labelCenterX, labelTop - offset);
        const button = hit?.closest?.("div[role='button'], button, [aria-label]");
        if (!(button instanceof HTMLElement) || !dialog.contains(button) || !usable(button)) continue;
        const text = normalize(button.innerText || button.textContent || "");
        const aria = normalize(button.getAttribute("aria-label") || "");
        if (/Mark as sold|Edit Listing|More|Promote now|Confirm Your Identity|Cancel/i.test(text + " " + aria)) continue;
        target = button;
        break;
      }
    }
    if (!(target instanceof HTMLElement)) {
      return {
        ok: false,
        reason: "delete_icon_button_not_found",
        label: { x: labelCenterX, top: labelTop },
        nearbyButtons: candidates.map((item) => ({ text: item.text, aria: item.aria, x: Math.round(item.cx), y: Math.round(item.cy), dx: Math.round(item.dx), gap: Math.round(item.aboveGap) })).slice(0, 20)
      };
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: normalize(target.innerText || target.textContent || ""),
      aria: normalize(target.getAttribute("aria-label") || ""),
      w: rect.width,
      h: rect.height,
      labelX: labelCenterX,
      labelTop,
      method: "label-column-delete-icon"
    };
  }).catch((error) => ({ ok: false, reason: "evaluate_failed", error: String(error?.message || error || "") }));
}

async function clickDeleteMarketplaceListingButtonByJs(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const usable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 6 && rect.height > 6 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("div[role='dialog'], [aria-modal='true']")).filter((dialog) => dialog instanceof HTMLElement && usable(dialog));
    const dialog = dialogs.find((node) => /Your listing/i.test(normalize(node.innerText || node.textContent || ""))) || dialogs[dialogs.length - 1];
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: "no_listing_dialog" };
    const labels = Array.from(dialog.querySelectorAll("span, div"))
      .filter((node) => node instanceof HTMLElement && usable(node) && normalize(node.innerText || node.textContent || "") === "Delete listing")
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => b.rect.top - a.rect.top);
    const label = labels[0];
    if (!(label?.node instanceof HTMLElement)) return { ok: false, reason: "delete_listing_label_not_found" };
    const labelCenterX = label.rect.left + label.rect.width / 2;
    let target = null;
    for (const offset of [20, 32, 44, 56, 68, 80]) {
      const hit = document.elementFromPoint(labelCenterX, label.rect.top - offset);
      const button = hit?.closest?.("div[role='button'], button, [aria-label]");
      if (!(button instanceof HTMLElement) || !dialog.contains(button) || !usable(button)) continue;
      const text = normalize(button.innerText || button.textContent || "");
      const aria = normalize(button.getAttribute("aria-label") || "");
      if (/Mark as sold|Edit Listing|More|Promote now|Confirm Your Identity|Cancel/i.test(text + " " + aria)) continue;
      target = button;
      break;
    }
    if (!(target instanceof HTMLElement)) {
      target = Array.from(dialog.querySelectorAll("div[role='button'], button, [aria-label]"))
        .filter((node) => node instanceof HTMLElement && usable(node))
        .find((node) => /Delete marketplace listing|Delete listing/i.test(normalize(node.getAttribute("aria-label") || "")));
    }
    if (!(target instanceof HTMLElement)) return { ok: false, reason: "target_not_found" };
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    target.dispatchEvent(new PointerEvent("pointerover", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseover", eventInit));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));
    target.click();
    return { ok: true, text: normalize(target.innerText || target.textContent || ""), aria: normalize(target.getAttribute("aria-label") || ""), x, y };
  }).catch((error) => ({ ok: false, reason: "js_click_failed", error: String(error?.message || error || "") }));
}

async function findConfirmationDeleteButton(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const usable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 4
        && rect.height > 4
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && rect.right > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
      .filter((dialog) => dialog instanceof HTMLElement && usable(dialog));
    const dialog = dialogs.find((node) => {
      const text = normalize(node.innerText || node.textContent || "");
      return /Delete listing/i.test(text) && /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
    });
    if (!(dialog instanceof HTMLElement)) {
      return { ok: false, reason: "confirmation_dialog_not_found", dialogs: dialogs.map((node) => normalize(node.innerText || node.textContent || "").slice(0, 220)) };
    }

    const direct = Array.from(dialog.querySelectorAll("div[role='button'][aria-label='Delete'], button[aria-label='Delete'], [role='button']"))
      .filter((node) => node instanceof HTMLElement && usable(node))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node,
          rect,
          text: normalize(node.innerText || node.textContent || ""),
          aria: normalize(node.getAttribute("aria-label") || "")
        };
      })
      .filter((item) => item.aria === "Delete" || item.text === "Delete")
      .filter((item) => item.node.getAttribute("aria-disabled") !== "true" && !item.node.closest("[aria-disabled='true']"))
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    if (direct?.node instanceof HTMLElement) {
      direct.node.scrollIntoView({ block: "center", inline: "center" });
      const rect = direct.node.getBoundingClientRect();
      return {
        ok: true,
        text: direct.text,
        aria: direct.aria,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
        method: "confirm-aria-delete-button"
      };
    }

    const spans = Array.from(dialog.querySelectorAll("span, div"))
      .filter((node) => node instanceof HTMLElement && usable(node) && normalize(node.innerText || node.textContent || "") === "Delete")
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { node, rect, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })
      .filter((item) => {
        const text = normalize(item.node.closest("[role='dialog']")?.innerText || "");
        return /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
      })
      .sort((a, b) => b.x - a.x || b.y - a.y);
    const label = spans[0];
    if (!label?.node) {
      return { ok: false, reason: "delete_text_not_found", dialogText: normalize(dialog.innerText || dialog.textContent || "").slice(0, 260) };
    }

    let clickNode = null;
    let cursor = label.node;
    for (let depth = 0; depth < 8 && cursor instanceof HTMLElement; depth += 1) {
      const rect = cursor.getBoundingClientRect();
      const text = normalize(cursor.innerText || cursor.textContent || "");
      if (usable(cursor) && text === "Delete" && rect.width >= label.rect.width && rect.height >= label.rect.height) clickNode = cursor;
      cursor = cursor.parentElement;
    }
    const node = clickNode || label.node;
    node.scrollIntoView({ block: "center", inline: "center" });
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { ok: true, text: normalize(node.innerText || node.textContent || ""), aria: normalize(node.getAttribute("aria-label") || ""), x, y, w: rect.width, h: rect.height, method: "delete-text-center" };
  }).catch((error) => ({ ok: false, reason: "evaluate_failed", error: String(error?.message || error || "") }));
}

async function clickConfirmationDeleteButtonByJs(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const usable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']"))
      .find((node) => node instanceof HTMLElement && /Delete listing/i.test(normalize(node.innerText || node.textContent || "")) && /Are you sure (?:that )?you want to delete this listing\?/i.test(normalize(node.innerText || node.textContent || "")));
    if (!(dialog instanceof HTMLElement)) return { ok: false, reason: "confirmation_dialog_not_found" };
    let target = Array.from(dialog.querySelectorAll("div[role='button'][aria-label='Delete'], button[aria-label='Delete'], [role='button']"))
      .filter((node) => node instanceof HTMLElement && usable(node))
      .find((node) => {
        const text = normalize(node.innerText || node.textContent || "");
        const aria = normalize(node.getAttribute("aria-label") || "");
        return (aria === "Delete" || text === "Delete") && node.getAttribute("aria-disabled") !== "true" && !node.closest("[aria-disabled='true']");
      });
    const labels = Array.from(dialog.querySelectorAll("span, div"))
      .filter((node) => node instanceof HTMLElement && usable(node) && normalize(node.innerText || node.textContent || "") === "Delete")
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => (b.rect.left + b.rect.width / 2) - (a.rect.left + a.rect.width / 2));
    const label = labels[0];
    if (!(target instanceof HTMLElement)) {
      if (!label?.node) return { ok: false, reason: "delete_text_not_found" };
      target = label.node;
      let cursor = label.node;
      for (let depth = 0; depth < 8 && cursor instanceof HTMLElement; depth += 1) {
        const rect = cursor.getBoundingClientRect();
        const text = normalize(cursor.innerText || cursor.textContent || "");
        if (usable(cursor) && text === "Delete" && rect.width >= label.rect.width && rect.height >= label.rect.height) target = cursor;
        cursor = cursor.parentElement;
      }
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    target.dispatchEvent(new PointerEvent("pointerover", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseover", eventInit));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));
    target.click();
    return { ok: true, text: normalize(target.innerText || target.textContent || ""), aria: normalize(target.getAttribute("aria-label") || ""), x, y };
  }).catch((error) => ({ ok: false, reason: "js_click_failed", error: String(error?.message || error || "") }));
}

async function getDeleteXpathTarget(page, primaryXPath, fallbackXPath, expectedDialog, label) {
  if (expectedDialog === "listing") return findDeleteMarketplaceListingButton(page);
  if (expectedDialog === "confirm") return findConfirmationDeleteButton(page);
  return page.evaluate(({ primaryXPath, fallbackXPath, expectedDialog, label }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.15;
    };
    const dialogMatches = (dialog) => {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      if (expectedDialog === "confirm") {
        const title = document.evaluate(".//span[normalize-space()='Delete listing']", dialog, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return Boolean(title) && /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
      }
      return true;
    };
    const pick = (xpath) => {
      const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (!(node instanceof HTMLElement) || !visible(node)) continue;
        const dialog = node.closest("div[role='dialog']");
        if (!(dialog instanceof HTMLElement) || !dialogMatches(dialog)) continue;
        const disabled = node.getAttribute("aria-disabled") === "true" || node.closest("[aria-disabled='true']") || node.disabled;
        if (disabled) continue;
        node.scrollIntoView({ block: "center", inline: "center" });
        const rect = node.getBoundingClientRect();
        return { ok: true, xpath, text: normalize(node.innerText || node.textContent || ""), aria: normalize(node.getAttribute("aria-label") || ""), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label };
      }
      return null;
    };
    const target = pick(primaryXPath) || pick(fallbackXPath);
    if (target) return target;
    const dialogs = Array.from(document.querySelectorAll("div[role='dialog']")).filter(visible).map((dialog) => normalize(dialog.innerText || dialog.textContent || "").slice(0, 220));
    return { ok: false, reason: "target_not_found", label, dialogs };
  }, { primaryXPath, fallbackXPath, expectedDialog, label }).catch((error) => ({ ok: false, reason: "evaluate_failed", label, error: String(error?.message || error || "") }));
}

async function jsClickDeleteXpathTarget(page, primaryXPath, fallbackXPath, expectedDialog) {
  if (expectedDialog === "listing") return clickDeleteMarketplaceListingButtonByJs(page);
  if (expectedDialog === "confirm") return clickConfirmationDeleteButtonByJs(page);
  return page.evaluate(({ primaryXPath, fallbackXPath, expectedDialog }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialogMatches = (dialog) => {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      if (expectedDialog === "confirm") {
        const title = document.evaluate(".//span[normalize-space()='Delete listing']", dialog, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return Boolean(title) && /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
      }
      return true;
    };
    const pick = (xpath) => {
      const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (!(node instanceof HTMLElement) || !visible(node)) continue;
        const dialog = node.closest("div[role='dialog']");
        if (!(dialog instanceof HTMLElement) || !dialogMatches(dialog)) continue;
        const disabled = node.getAttribute("aria-disabled") === "true" || node.closest("[aria-disabled='true']") || node.disabled;
        if (disabled) continue;
        node.scrollIntoView({ block: "center", inline: "center" });
        node.click();
        return { ok: true, text: normalize(node.innerText || node.textContent || ""), xpath };
      }
      return null;
    };
    return pick(primaryXPath) || pick(fallbackXPath) || { ok: false, reason: "target_not_found" };
  }, { primaryXPath, fallbackXPath, expectedDialog }).catch((error) => ({ ok: false, reason: "js_click_failed", error: String(error?.message || error || "") }));
}

async function clickDeleteXpathWithRetry(page, label, expectedDialog, primaryXPath, fallbackXPath, logger = null, verify = null) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const target = await getDeleteXpathTarget(page, primaryXPath, fallbackXPath, expectedDialog, label);
      if (!target.ok) {
        logger?.(label + " button not found attempt " + attempt + "/3: " + (target.reason || "unknown") + ".");
        if (Array.isArray(target.dialogs) && target.dialogs.length) logger?.(label + " visible dialogs: " + target.dialogs.join(" || "));
        await sleep(450);
        continue;
      }
      logger?.(label + " button found attempt " + attempt + "/3 tai " + Math.round(target.x) + "," + Math.round(target.y) + ".");
      await page.mouse?.move?.(target.x, target.y, { steps: 3 });
      await sleep(80);
      await page.mouse?.click?.(target.x, target.y, { delay: 80 });
      await sleep(expectedDialog === "confirm" ? 3500 : 900);
      if (!verify || await verify()) {
        logger?.(label + " clicked bang normal click attempt " + attempt + "/3.");
        return { ok: true, method: "normal", text: target.text, aria: target.aria };
      }
      logger?.(label + " normal click attempt " + attempt + "/3 chua doi trang thai, thu JS click.");
      const jsClicked = await jsClickDeleteXpathTarget(page, primaryXPath, fallbackXPath, expectedDialog);
      await sleep(expectedDialog === "confirm" ? 3500 : 1000);
      if (jsClicked.ok && (!verify || await verify())) {
        logger?.(label + " clicked bang JS click attempt " + attempt + "/3.");
        return { ok: true, method: "js", text: jsClicked.text };
      }
      if (expectedDialog === "confirm") {
        logger?.(label + " JS click chua an, click them bang toa do trung tam nut confirm.");
        await page.mouse?.move?.(target.x, target.y, { steps: 2 });
        await sleep(120);
        await page.mouse?.click?.(target.x, target.y, { delay: 120 });
        await sleep(350);
        await page.mouse?.click?.(target.x, target.y, { delay: 120 });
        await sleep(2500);
        if (!verify || await verify()) {
          logger?.(label + " clicked thanh cong bang coordinate fallback attempt " + attempt + "/3.");
          return { ok: true, method: "coordinate", text: target.text, aria: target.aria };
        }
      }
      logger?.(label + " JS click attempt " + attempt + "/3 chua thanh cong: " + (jsClicked.reason || "khong doi trang thai") + ".");
    } catch (error) {
      logger?.("exception khi bam " + label + " attempt " + attempt + "/3: " + String(error?.message || error || ""));
    }
    await sleep(650);
  }
  return { ok: false, reason: "click_failed" };
}

async function clickDeleteListingInDialog(page, logger = null) {
  const dialogReady = await waitForListingDialog(page, logger, 30000);
  if (!dialogReady) return { ok: false, reason: "listing_dialog_not_detected" };
  logger?.("Delete listing button found check bat dau.");
  return clickDeleteXpathWithRetry(
    page,
    "Delete listing",
    "listing",
    "//div[@role='dialog']//span[normalize-space()='Delete listing']/ancestor::div[@role='button'][1]",
    "//div[@role='dialog']//span[normalize-space()='Delete listing']/ancestor::div[@role='none'][2]",
    logger,
    async () => waitForDeleteConfirmationDialog(page, logger, 8000)
  );
}

async function confirmDeleteListing(page, logger = null) {
  const dialogReady = await waitForDeleteConfirmationDialog(page, logger, 12000);
  if (!dialogReady) return { ok: false, reason: "confirmation_dialog_not_detected" };
  logger?.("Confirmation Delete button found check bat dau.");
  return clickDeleteXpathWithRetry(
    page,
    "Confirmation Delete",
    "confirm",
    "(//div[@role='dialog'][.//span[normalize-space()='Delete listing']]//span[normalize-space()='Delete']/ancestor::div[@role='button'][1])[1]",
    "(//div[@role='dialog'][.//span[normalize-space()='Delete listing']]//span[normalize-space()='Delete']/ancestor::div[@role='none'][2])[1]",
    logger,
    async () => page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      return !Array.from(document.querySelectorAll("div[role='dialog']")).some((dialog) => {
        const text = normalize(dialog.innerText || dialog.textContent || "");
        const title = document.evaluate(".//span[normalize-space()='Delete listing']", dialog, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return Boolean(title) && /Are you sure (?:that )?you want to delete this listing\?/i.test(text);
      });
    }).catch(() => false)
  );
}
async function deleteNeedsAttentionListings(interactionManager, page, row, config, options, log) {
  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/you/dashboard"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await interactionManager.waitPageLoadHumanOnPage(page, config);
  const bucket = await findDashboardBucketByScrolling(interactionManager, page, row, config, "Needs attention");
  if (!bucket) return { deleted: 0, before: null, after: null };
  if (!bucket.count) {
    log(row.profile_id, "needs attention", `[${row.uid}] Needs attention dang la 0, bo qua xoa listing.`);
    return { deleted: 0, before: 0, after: 0 };
  }

  log(row.profile_id, "needs attention", `[${row.uid}] Needs attention truoc khi chay: ${bucket.count}, dang mo thang trang Your listings.`);
  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/you/selling?referral_surface=seller_hub"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await interactionManager.waitPageLoadHumanOnPage(page, config);

  const processedKeys = new Set();
  let deleted = 0;
  let failed = 0;
  let stagnantCount = 0;
  let lastBottom = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (options.runtime.stopRequested) throw buildStoppedError();
    if (typeof interactionManager.throwIfCheckpointDetected === "function") {
      await interactionManager.throwIfCheckpointDetected(page);
    }
    const target = await clickNextNeedsAttentionListing(page, processedKeys);
    if (target) {
      processedKeys.add(target.key);
      log(row.profile_id, "needs attention", `[${row.uid}] mo listing can xoa: ${target.title}`);
      log(row.profile_id, "needs attention", `[${row.uid}] da bam listing, doi toi khi cua so load du nut Delete listing.`);
      await sleep(1200);
      const listingLogger = (message) => log(row.profile_id, "needs attention", `[${row.uid}] ${message}`, "info");
      const listingOpened = await waitForListingDialog(page, listingLogger, 30000);
      if (!listingOpened) {
        failed += 1;
        log(row.profile_id, "needs attention", `[${row.uid}] cho 30s nhung listing dialog chua load du nut Delete listing: ${target.title}`, "warn");
        await closeTopFacebookDialog(page);
        await interactionManager.waitHumanOnPage(page, config, 1200, 2200);
        continue;
      }
      await sleep(900);
      let clickedDelete = { ok: false, reason: "not_tried" };
      for (let deleteTry = 1; deleteTry <= 5; deleteTry += 1) {
        clickedDelete = await clickDeleteListingInDialog(page, (message) => log(row.profile_id, "needs attention", `[${row.uid}] ${message}`, "info"));
        if (clickedDelete.ok) break;
        await interactionManager.waitHumanOnPage(page, config, 900, 1700);
      }
      if (!clickedDelete.ok) {
        failed += 1;
        const seen = Array.isArray(clickedDelete.seen) ? clickedDelete.seen.map((item) => `${item.text || "?"}/${item.aria || "?"}`).join(" | ") : "";
        log(row.profile_id, "needs attention", `[${row.uid}] khong bam duoc Delete listing sau khi doi: ${target.title} (${clickedDelete.reason}) ${seen}`, "warn");
        await closeTopFacebookDialog(page);
        await interactionManager.waitHumanOnPage(page, config, 800, 1600);
        continue;
      }
      let confirmed = { ok: false, reason: "not_tried" };
      for (let confirmTry = 1; confirmTry <= 5; confirmTry += 1) {
        confirmed = await confirmDeleteListing(page, (message) => log(row.profile_id, "needs attention", `[${row.uid}] ${message}`, "info"));
        if (confirmed.ok) break;
        await interactionManager.waitHumanOnPage(page, config, 900, 1700);
      }
      if (confirmed.ok) {
        deleted += 1;
        log(row.profile_id, "needs attention", `[${row.uid}] da xoa listing: ${target.title}`, "success");
        log(row.profile_id, "needs attention", `[${row.uid}] Waiting 5 seconds truoc khi xu ly listing tiep theo.`);
        await sleep(5000);
        log(row.profile_id, "needs attention", `[${row.uid}] Moving to next listing.`);
      } else {
        failed += 1;
        log(row.profile_id, "needs attention", `[${row.uid}] khong xac nhan duoc Delete: ${target.title} (${confirmed.reason})`, "warn");
        await closeTopFacebookDialog(page);
        await interactionManager.waitHumanOnPage(page, config, 800, 1600);
      }
      stagnantCount = 0;
      continue;
    }

    await interactionManager.humanScroll(page, config, "down", attempt > 20 ? "heavy" : "normal");
    await interactionManager.waitHumanOnPage(page, config, 900, 2200);
    const scrollState = await getSellingScrollState(page);
    if (scrollState.bottom <= lastBottom + 12) stagnantCount += 1;
    else stagnantCount = 0;
    lastBottom = scrollState.bottom;
    if (stagnantCount >= 5 || scrollState.bottom >= scrollState.height - 20) break;
  }

  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/you/dashboard"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
  await interactionManager.waitPageLoadHumanOnPage(page, config);
  const afterBucket = await findDashboardBucketByScrolling(interactionManager, page, row, config, "Needs attention");
  const afterCount = afterBucket?.count ?? null;
  log(row.profile_id, "needs attention", `[${row.uid}] ket thuc Needs attention: da xoa ${deleted}, loi ${failed}, con lai ${afterCount}.`, failed ? "warn" : "success");
  return { deleted, failed, before: bucket.count, after: afterCount };
}

async function runRenewListingsFlow(interactionManager, page, row, config, options, log) {
  log(row.profile_id, "bam renew", `[${row.uid}] bat dau Dashboard renew + Needs attention...`);
  let renewResult = { renewed: 0, before: null, after: null, verified: false, error: "" };
  let needsResult = { deleted: 0, failed: 0, before: null, after: null, error: "" };

  try {
    renewResult = await renewFromDashboard(interactionManager, page, row, config, options, log);
  } catch (error) {
    if (String(error?.status || "").toLowerCase() === "stopped") throw error;
    renewResult.error = String(error?.message || error || "loi renew");
    log(row.profile_id, "bam renew", `[${row.uid}] loi buoc To renew nhung van chay Needs attention: ${renewResult.error}`, "warn");
  }

  try {
    needsResult = await deleteNeedsAttentionListings(interactionManager, page, row, config, options, log);
  } catch (error) {
    if (String(error?.status || "").toLowerCase() === "stopped") throw error;
    needsResult.error = String(error?.message || error || "loi needs attention");
    log(row.profile_id, "needs attention", `[${row.uid}] loi buoc Needs attention: ${needsResult.error}`, "warn");
  }

  log(row.profile_id, "bam renew", `[${row.uid}] ket thuc Dashboard renew: renew ${renewResult.renewed || 0}, To renew ${renewResult.before ?? "?"}->${renewResult.after ?? "?"}, xoa Needs attention ${needsResult.deleted || 0}.`, (renewResult.verified === false || needsResult.failed || renewResult.error || needsResult.error) ? "warn" : "success");
  return { ...renewResult, needsAttention: needsResult };
}
function mapInteractionError(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  const message = String(error?.message || error || "loi khong ro");
  if (status === "stopped") return { status: "stopped", detail: "Da dung han theo yeu cau." };
  const lower = message.toLowerCase();
  if (lower.includes("checkpoint") || lower.includes("captcha") || lower.includes("not a robot")) return { status: "loicapcha", detail: message };
  if (lower.includes("login") || lower.includes("logged out") || lower.includes("see more on facebook") || lower.includes("bi out")) return { status: "biout", detail: message };
  if (lower.includes("proxy") || lower.includes("err_tunnel") || lower.includes("err_timed_out")) return { status: "hetproxy", detail: message };
  return { status: "loi", detail: message };
}

function expandSheetUpdate(update) {
  const next = { ...update };
  const pairs = [
    ["trangThai", "trạng thái"],
    ["chiTiet", "chi tiết"],
    ["tenChuan", "tên chuẩn"]
  ];
  for (const [internalKey, sheetKey] of pairs) {
    if (Object.prototype.hasOwnProperty.call(next, internalKey)) next[sheetKey] = next[internalKey];
    if (Object.prototype.hasOwnProperty.call(next, sheetKey)) next[internalKey] = next[sheetKey];
  }
  return next;
}

async function writeSheetWithRetry(sheetSession, profileId, update, log) {
  const payload = expandSheetUpdate(update);
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await sheetSession.updateOne(profileId, payload);
      log(profileId, "ghi Sheet", "da dua ket qua tuong tac vao batch ghi Sheet", "success");
      return true;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      const isQuota = /quota|rate|429|write requests|read requests/i.test(message);
      log(profileId, "ghi Sheet", `ghi Sheet loi lan ${attempt}: ${message}`, isQuota ? "warn" : "error", message);
      if (!isQuota || attempt >= 5) break;
      await sleep(1500 * attempt);
    }
  }
  const job = sheetSession?.runtime?.jobs?.get?.(profileId);
  if (job) job.sheetWriteError = lastError?.message || "Khong ghi duoc Sheet.";
  return false;
}

function patchInteractionManagerForStop(interactionManager, runtime) {
  const originals = {
    waitHumanOnPage: interactionManager.waitHumanOnPage,
    waitPageLoadHumanOnPage: interactionManager.waitPageLoadHumanOnPage,
    humanScroll: interactionManager.humanScroll,
    pauseIfRequested: interactionManager.pauseIfRequested
  };
  const assertRunning = () => {
    if (runtime.stopRequested || interactionManager.stopAllRequested) throw buildStoppedError();
  };
  if (typeof interactionManager.waitHumanOnPage === "function") {
    interactionManager.waitHumanOnPage = async (...args) => {
      assertRunning();
      const result = await originals.waitHumanOnPage.apply(interactionManager, args);
      assertRunning();
      return result;
    };
  }
  if (typeof interactionManager.waitPageLoadHumanOnPage === "function") {
    interactionManager.waitPageLoadHumanOnPage = async (...args) => {
      assertRunning();
      const result = await originals.waitPageLoadHumanOnPage.apply(interactionManager, args);
      assertRunning();
      return result;
    };
  }
  if (typeof interactionManager.humanScroll === "function") {
    interactionManager.humanScroll = async (...args) => {
      assertRunning();
      const result = await originals.humanScroll.apply(interactionManager, args);
      assertRunning();
      return result;
    };
  }
  interactionManager.pauseIfRequested = async (...args) => {
    assertRunning();
    if (typeof originals.pauseIfRequested === "function") {
      return originals.pauseIfRequested.apply(interactionManager, args);
    }
    return true;
  };
  return () => {
    for (const [key, value] of Object.entries(originals)) {
      if (value) interactionManager[key] = value;
    }
  };
}

async function runInteractionTasks(interactionManager, page, row, config, options, log) {
  const renewResult = options.enableRenewListings
    ? await runRenewListingsFlow(interactionManager, page, row, config, options, log)
    : { renewed: 0, scanned: 0, failed: 0, skipped: true };
  if (!options.enableRenewListings) {
    log(row.profile_id, "bam renew", "da bo qua Bam renew theo cau hinh");
  }

  const tasks = interactionManager.shuffleTaskOrder(["home", "reels", "market"], config.enableRandomOrder);
  const orderedTasks = options.enableRenewListings ? ["renew", ...tasks] : tasks;
  log(row.profile_id, "thu tu tuong tac", `[${row.uid}] thu tu tuong tac: ${orderedTasks.join(" -> ")}`);
  for (const task of tasks) {
    if (options.runtime.stopRequested) throw buildStoppedError();
    if (typeof interactionManager.throwIfCheckpointDetected === "function") {
      await interactionManager.throwIfCheckpointDetected(page);
    }
    if (task === "home") {
      await interactionManager.runHomeInteraction(page, row, config);
    } else if (task === "reels") {
      await interactionManager.runReelsInteraction(page, row, config);
    } else if (task === "market") {
      await ensureMarketplaceLocationMatchesSheetBang(interactionManager, page, row, config, log);
      await runSearchShippingMarketplaceInteraction(interactionManager, page, row, config, options, log);
    }
    if (options.runtime.stopRequested) throw buildStoppedError();
    await interactionManager.returnToFacebookHome(page, row, config, task);
    await interactionManager.waitHumanOnPage(page, config, 1800, 4200);
  }

  let markAsSoldResult = false;
  if (options.enableMarkAsSold) {
    if (options.runtime.stopRequested) throw buildStoppedError();
    markAsSoldResult = await interactionManager.runMarkAsSoldFlow(page, row, config);
  } else {
    log(row.profile_id, "mark as sold", "da bo qua Mark as sold theo cau hinh");
  }
  return { markAsSoldResult, renewResult };
}

export function createTuongTac({
  getManager,
  getInteractionManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      step,
      detail,
      tool: "tuong tac"
    });
  }

  async function runStep(profileId, job, step, action) {
    if (runtime.stopRequested) throw buildStoppedError();
    if (job) job.liveStatus = step;
    log(profileId, step, `bat dau: ${step}`);
    const startedAt = Date.now();
    try {
      const result = await action();
      if (runtime.stopRequested) throw buildStoppedError();
      log(profileId, step, `xong: ${step} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") throw error;
      const rawMessage = String(error?.message || error || "loi khong ro");
      if (error && typeof error === "object") {
        error.step = error.step || step;
        error.message = `Loi o buoc "${step}": ${rawMessage}`;
        log(profileId, step, error.message, "error", rawMessage);
        throw error;
      }
      const wrapped = new Error(`Loi o buoc "${step}": ${rawMessage}`);
      wrapped.step = step;
      log(profileId, step, wrapped.message, "error", rawMessage);
      throw wrapped;
    }
  }

  async function runOne(profileId, sheetRow, config, sheetSession, options = {}) {
    const manager = getManager({ fresh: true });
    const interactionManager = getInteractionManager({ fresh: true });
    const row = buildToolRow(profileId, sheetRow);
    row.profile_id = profileId;
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    let restoreInteractionManager = () => {};
    let restorePageGotoLocale = () => {};

    try {
      const interactionConfig = buildInteractionConfig(config);
      interactionManager.config = { ...(interactionManager.config || {}), ...interactionConfig };
      interactionManager.stopAllRequested = false;
      patchStableWindowTiling(manager, interactionManager, options.workerSlot || 0, options.concurrency || 1);
      restoreInteractionManager = patchInteractionManagerForStop(interactionManager, runtime);

      if (!(runtime.activeManagers instanceof Map)) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, {
        manager: interactionManager,
        uid: row.uid,
        shouldFinish: () => false
      });

      proxyLease = await runStep(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      );

      browser = await runStep(profileId, job, "mo profile HideMyAcc", async () => manager.connectBrowser(profileId));
      page = await runStep(profileId, job, "mo tab Facebook", async () => {
        const target = await browser.newPage();
        await target.bringToFront?.().catch(() => {});
        const actual = await applyLegacyInteractionLayout(interactionManager, browser, target, options.workerSlot || 0, options.concurrency || 1);
        const screen = await interactionManager.detectScreenInfo?.(target).catch(() => null);
        const layout = interactionManager.getWindowLayout?.(options.workerSlot || 0, options.concurrency || 1, screen || null);
        log(profileId, "viewport", `worker ${(options.workerSlot || 0) + 1}/${options.concurrency || 1} legacy_layout=${layout?.width || ""}x${layout?.height || ""} inner=${layout?.innerWidth || ""}x${layout?.innerHeight || ""} zoom=${layout?.zoom || ""}, actual=${JSON.stringify(actual || {})}`);
        return target;
      });
      restorePageGotoLocale = patchPageGotoFacebookLocale(page);

      await runStep(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      });

      const interactionResult = await runStep(profileId, job, "chay tuong tac", async () =>
        runInteractionTasks(interactionManager, page, row, interactionConfig, {
          runtime,
          enableRenewListings: normalizeBool(config.interactionEnableRenewListings, false),
          enableMarkAsSold: normalizeBool(config.interactionEnableMarkAsSold, false)
        }, log)
      );

      const cookieHeader = await interactionManager.buildCurrentFacebookCookieHeader?.(page).catch(() => "") || "";
      const finalUpdate = {
        Tool: "đã tương tác",
        trangThai: "thành công",
        chiTiet: `Da hoan thanh Bam renew ${interactionResult.renewResult?.renewed || 0} listing, xoa Needs attention ${interactionResult.renewResult?.needsAttention?.deleted || 0} listing, Home, Reels, Marketplace.`,
        ...(cookieHeader ? { cookie: cookieHeader } : {})
      };
      if (job) {
        job.status = "success";
        job.liveStatus = "tuong tac thanh cong";
        job.result = { ...finalUpdate, markAsSold: interactionResult.markAsSoldResult, renew: interactionResult.renewResult };
      }
      log(profileId, "ket thuc", "tuong tac thanh cong", "success");
      await writeSheetWithRetry(sheetSession, profileId, finalUpdate, log);
      return finalUpdate;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = "da dung han, giu nguyen Sheet";
          job.result = null;
        }
        log(profileId, "dung han", "da dung han, khong ghi Sheet", "warn");
        return { stopped: true };
      }

      const mapped = mapInteractionError(error);
      const finalUpdate = {
        Tool: "tuong tac",
        trangThai: "loi",
        chiTiet: mapped.detail || "loi tuong tac"
      };
      if (job) {
        job.status = "error";
        job.liveStatus = mapped.detail;
        job.result = finalUpdate;
      }
      log(profileId, error.step || "loi tong", `loi tuong tac: ${mapped.detail}`, "error");
      await writeSheetWithRetry(sheetSession, profileId, finalUpdate, log);
      return finalUpdate;
    } finally {
      restorePageGotoLocale();
      restoreInteractionManager();
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      try { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); } catch {}
      try { if (browser) await browser.disconnect(); } catch {}
      try { stateProxy?.release?.(proxyLease); } catch {}
      await manager.stopHideMyAccProfile(profileId).catch(() => {});
      if (job) job.finishedAt = new Date().toISOString();
    }
  }

  async function runQueue(profileIds, config) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay.");

    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampToolConcurrency(config.interactionConcurrency, 4), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "tuong tac",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang tuong tac ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "tuong tac";
    setImmediate(async () => {
      try {
        let cursor = 0;
        let activeCount = 0;
        const nextId = () => {
          if (runtime.stopRequested) return "";
          if (cursor >= ids.length) return "";
          const id = ids[cursor];
          cursor += 1;
          return id;
        };
        const workers = Array.from({ length: concurrency }, async (_, workerSlot) => {
          for (;;) {
            const id = nextId();
            if (!id) break;
            const row = sheetSession.rows.get(id);
            const job = runtime.jobs.get(id);
            if (!row) {
              const update = { Tool: "tuong tac", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide." };
              if (job) {
                job.status = "error";
                job.liveStatus = update.chiTiet;
                job.finishedAt = new Date().toISOString();
                job.result = update;
              }
              log(id, "doc Sheet", update.chiTiet, "error");
              await writeSheetWithRetry(sheetSession, id, update, log);
              continue;
            }
            if (job) {
              job.status = "running";
              job.startedAt = new Date().toISOString();
              job.liveStatus = `dang bat dau o luong ${workerSlot + 1}/${concurrency}`;
            }
            activeCount += 1;
            log(id, "worker", `worker ${workerSlot + 1}/${concurrency} start, active=${activeCount}, queue_con_lai=${Math.max(0, ids.length - cursor)}`);
            try {
              await runOne(id, row, config, sheetSession, { workerSlot, concurrency });
            } finally {
              activeCount = Math.max(0, activeCount - 1);
              log(id, "worker", `worker ${workerSlot + 1}/${concurrency} end, active=${activeCount}, queue_con_lai=${Math.max(0, ids.length - cursor)}`);
            }
          }
        });
        await Promise.all(workers);
        await sheetSession.flushAll();
        if (runtime.stopRequested) {
          for (const id of ids) {
            const job = runtime.jobs.get(id);
            if (job && (job.status === "queued" || job.status === "running")) {
              job.status = "stopped";
              job.liveStatus = "da dung han, giu nguyen Sheet";
              job.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        addRuntimeLog(`Loi queue tuong tac: ${error.message}`, "error", "", {
          step: "queue tuong tac",
          tool: "tuong tac"
        });
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



















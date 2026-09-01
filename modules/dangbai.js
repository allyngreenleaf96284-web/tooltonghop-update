import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { buildStandardName, buildFullSuccessToken } from "./profile_name.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const US_LOCATION_FILE = path.resolve(__dirname, "../data/us_locations.txt");
const CREATE_ITEM_URL = "https://www.facebook.com/marketplace/create/item";
const STABLE_POST_CONCURRENCY = 4;

function clampToolConcurrency(value, fallback = STABLE_POST_CONCURRENCY) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
  return Math.max(1, Math.min(4, parsed));
}

let usLocationCache = { loadedAt: 0, lines: [] };

function sheetValue(row, ...keys) {
  const wanted = new Set(keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean));
  for (const [key, value] of Object.entries(row || {})) {
    if (!wanted.has(String(key || "").trim().toLowerCase())) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function profileUid(row, fallback = "") {
  return String(row?.uid || sheetValue(row?.raw || {}, "uid") || fallback || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomItem(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return "";
  return values[Math.floor(Math.random() * values.length)] || "";
}

async function loadUsLocationLines() {
  if (Date.now() - usLocationCache.loadedAt < 60_000 && usLocationCache.lines.length) return usLocationCache.lines;
  const raw = await readFile(US_LOCATION_FILE, "utf8").catch(() => "");
  usLocationCache = {
    loadedAt: Date.now(),
    lines: raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
  return usLocationCache.lines;
}

function extractDbToken(text) {
  const match = String(text || "").match(/(?:^|-)(DB\s*(\d+))(?=-|$)/i);
  return match?.[1] ? String(match[1]).replace(/\s+/g, " ").trim() : "";
}

function nextDbToken(currentName = "", sheetRow = {}) {
  const source = [
    currentName,
    sheetValue(sheetRow, "tên chuẩn", "ten chuan"),
    sheetValue(sheetRow, "tên profile hiện tại", "ten profile hien tai")
  ].filter(Boolean).join(" ");
  const current = extractDbToken(source);
  const currentNumber = Number((current.match(/(\d+)/) || [])[1] || 0);
  const next = currentNumber + 1;
  return `DB ${String(next).padStart(2, "0")}`;
}

function mapPostError(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  const message = String(error?.message || error || "loi khong ro");
  if (status === "stopped") return { status: "stopped", detail: "Da dung han theo yeu cau." };
  if (status === "limitdb") return { status: "limitdb", detail: message };
  if (status) return { status, detail: message };
  const lower = message.toLowerCase();
  if (lower.includes("limit reached") || lower.includes("not able to create new listings right now") || lower.includes("daily limit")) {
    return { status: "limitdb", detail: message };
  }
  if (lower.includes("cp282")) return { status: "cp282", detail: message };
  if (lower.includes("cp956")) return { status: "cp956", detail: message };
  if (lower.includes("captcha") || lower.includes("recaptcha")) return { status: "loicapcha", detail: message };
  if (lower.includes("err_timed_out") || lower.includes("err_proxy_connection_failed") || lower.includes("err_tunnel_connection_failed") || lower.includes("site can't be reached")) {
    return { status: "hetproxy", detail: message };
  }
  if (lower.includes("logged out") || lower.includes("bi out")) return { status: "biout", detail: message };
  if (lower.includes("location")) return { status: "loi location", detail: message };
  if (lower.includes("publish")) return { status: "loi publish", detail: message };
  if (lower.includes("login")) return { status: "loi login", detail: message };
  return { status: "loi", detail: message };
}

function buildRuntimeProfileName({ status = "", tenChuan = "" }) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const base = String(tenChuan || "").trim() || "profile-tool";
  if (!normalizedStatus || normalizedStatus === "thanh cong" || normalizedStatus === "thành công") return base;
  if (normalizedStatus === "loi") return `loi-${base}`;
  return `${normalizedStatus}-${base}`;
}

async function readLatestHideProfileName(manager, profileId, fallbackName = "") {
  const latestProfile = await manager.getProfileById(profileId).catch(() => null);
  return String(latestProfile?.name || fallbackName || profileId).trim();
}

export function createDangBai({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  allocateSellerInfoRow,
  updateSellerInfoUid,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "dang bai",
      step,
      detail
    });
  }

  async function step(profileId, job, name, action, options = {}) {
    if (runtime.stopRequested) {
      const stopped = new Error("Da nhan lenh dung han, tool dung batch hien tai.");
      stopped.status = "stopped";
      stopped.step = name;
      throw stopped;
    }
    const timeoutMs = Number(options.timeoutMs || 0);
    if (job) job.liveStatus = name;
    log(profileId, name, `bat dau: ${name}`);
    const startedAt = Date.now();
    try {
      const work = Promise.resolve().then(action);
      const result = timeoutMs > 0
        ? await Promise.race([
            work,
            new Promise((_, reject) => {
              setTimeout(() => {
                const timeoutError = new Error(`Timeout o buoc "${name}" sau ${timeoutMs}ms.`);
                timeoutError.step = name;
                reject(timeoutError);
              }, timeoutMs);
            })
          ])
        : await work;
      log(profileId, name, `xong: ${name} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      error.step = error.step || name;
      log(profileId, name, `loi o buoc "${name}": ${error.message || error}`, "error");
      throw error;
    }
  }

  async function rename(manager, profileId, nextName) {
    try {
      await manager.updateProfileName(profileId, nextName);
    } catch (error) {
      log(profileId, "doi ten profile", `khong doi duoc ten profile: ${error.message || error}`, "error");
    }
  }

  function expandSheetUpdate(update) {
    const next = { ...update };
    const pairs = [
      ["trangThai", "trạng thái"],
      ["soVach", "số vạch"],
      ["chiTiet", "chi tiết"],
      ["diaChiBanDau", "địa chỉ ban đầu"],
      ["tenChuan", "tên chuẩn"]
    ];
    for (const [camelKey, labelKey] of pairs) {
      if (next[camelKey] !== undefined && next[labelKey] === undefined) next[labelKey] = next[camelKey];
      if (next[labelKey] !== undefined && next[camelKey] === undefined) next[camelKey] = next[labelKey];
    }
    return next;
  }

  async function writeSheet(session, profileId, update) {
    await session.updateOne(profileId, expandSheetUpdate(update));
  }

  function createDeferredSheetWriter(sheetSession, profileId) {
    let pending = null;
    return {
      async updateOne(id, update) {
        if (String(id || "").trim() !== String(profileId || "").trim()) return 0;
        pending = { ...(pending || {}), ...expandSheetUpdate(update) };
        return 1;
      },
      async commit(update = null) {
        const finalUpdate = update ? { ...(pending || {}), ...expandSheetUpdate(update) } : pending;
        pending = null;
        if (!finalUpdate) return 0;
        return sheetSession.updateOne(profileId, finalUpdate);
      },
      discard() {
        pending = null;
      }
    };
  }

  function tileBounds(workerSlot = 0, workerTotal = 1) {
    const total = Math.max(1, Number(workerTotal || 1));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    if (total === 2) return { left: workerSlot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
    if (total === 3) return { left: workerSlot * 640, top: 0, width: 640, height: 980 };
    return {
      left: (workerSlot % 2) * 960,
      top: Math.floor(workerSlot / 2) * 520,
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
    if (!page || page.isClosed?.()) return;
    const bounds = tileBounds(workerSlot, workerTotal);
    const viewport = {
      width: Math.max(900, bounds.width - 24),
      height: Math.max(640, bounds.height - 110),
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
    const original = manager.maximizeBrowserWindow;
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

  function patchManager(manager) {
    if (typeof manager.setMarketplaceZoom === "function" && !manager.__toolDisableDomZoomPatched) {
      manager.setMarketplaceZoom = async function stableSetMarketplaceZoom(page) {
        return applyStableViewport(page, Number(this.__toolWorkerSlot || 0), Number(this.__toolWorkerTotal || 1));
      };
      manager.__toolDisableDomZoomPatched = true;
    }
    if (typeof manager.applyMarketplaceZoom === "function" && !manager.__toolApplyZoomPatched) {
      manager.applyMarketplaceZoom = async function stableApplyMarketplaceZoom(page) {
        return applyStableViewport(page, Number(this.__toolWorkerSlot || 0), Number(this.__toolWorkerTotal || 1));
      };
      manager.__toolApplyZoomPatched = true;
    }
    if (typeof manager.getProfileById !== "function") {
      manager.getProfileById = async (id) => {
        const items = await manager.listProfiles();
        return items.find((item) => String(item?.id || "") === String(id || "")) || null;
      };
    }
    if (typeof manager.buildCurrentFacebookCookieHeader !== "function") {
      manager.buildCurrentFacebookCookieHeader = async (page) => {
        const cookies = await page.cookies("https://www.facebook.com").catch(() => []);
        return cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      };
    }
  }

  async function restoreNaturalMarketplaceView(manager, page) {
    if (!page || page.isClosed?.()) return;
    await page.evaluate(() => {
      try {
        document.documentElement.style.transform = "";
        document.body.style.transform = "";
      } catch {}
    }).catch(() => {});
    await sleep(600);
  }

  function patchManagerForCentralizedLogin(manager, row) {
    const originals = {
      ensureMarketplaceSession: manager.ensureMarketplaceSession,
      ensureMarketplaceReadyOrRelogin: manager.ensureMarketplaceReadyOrRelogin,
      waitForMarketplaceReady: manager.waitForMarketplaceReady,
      loginWithCookie: manager.loginWithCookie,
      loginWithAccount: manager.loginWithAccount
    };
    const makeBiOutError = (message) => {
      const error = new Error(`[${row.uid}] ${message}`);
      error.status = "biout";
      return error;
    };
    manager.ensureMarketplaceSession = async (page) => {
      if (page && !(await manager.isLoggedOutMarketplace?.(page).catch(() => true))) return;
      throw makeBiOutError("Marketplace phat hien da bi out giua chung.");
    };
    manager.ensureMarketplaceReadyOrRelogin = async (page) => {
      if (page && !(await manager.isLoggedOutMarketplace?.(page).catch(() => false))) return;
      throw makeBiOutError("Marketplace yeu cau login lai giua chung.");
    };
    manager.waitForMarketplaceReady = async (page) => {
      await manager.gotoWithRetry(page, CREATE_ITEM_URL, row, 3);
      await page.waitForSelector("body", { timeout: 15000 });
    };
    manager.loginWithCookie = async () => { throw makeBiOutError("Tool da khoa login lai bang cookie giua chung."); };
    manager.loginWithAccount = async () => { throw makeBiOutError("Tool da khoa login lai bang tai khoan giua chung."); };
    return () => {
      for (const [key, value] of Object.entries(originals)) {
        if (value) manager[key] = value;
        else delete manager[key];
      }
    };
  }

  async function ensureCreateItemReady(manager, page, row, profileId, job) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await manager.gotoWithRetry(page, CREATE_ITEM_URL, row, 3);
      await page.waitForSelector("body", { timeout: 15000 });
      const state = await page.evaluate(() => {
        const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const title = document.title || "";
        const hasItemForSale = /item for sale/i.test(bodyText);
        const hasPreview = /preview/i.test(bodyText);
        const hasNext = /next/i.test(bodyText);
        const hasPublish = /publish/i.test(bodyText);
        const hasEnabledPublish = Array.from(document.querySelectorAll("button, [role='button']"))
          .some((node) => {
            const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
            const rect = node.getBoundingClientRect();
            return /^publish$/i.test(text) && rect.width > 0 && rect.height > 0 && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
          });
        const canContinueToPublish = hasEnabledPublish || /[?&]step=audience\b/i.test(window.location.href || "");
        const limitReached = /limit reached/i.test(bodyText)
          || /you are not able to create new listings right now/i.test(bodyText)
          || /daily limit/i.test(bodyText);
        const looksSkeleton = !bodyText || (hasPreview && !hasItemForSale && !hasNext && !hasPublish);
        return { bodyText: bodyText.slice(0, 1000), title, hasItemForSale, hasPreview, hasNext, hasPublish, hasEnabledPublish, canContinueToPublish, looksSkeleton, limitReached };
      });
      if (state.limitReached && !state.canContinueToPublish) {
        const error = new Error("Limit reached: khong the tao bai dang moi luc nay.");
        error.status = "limitdb";
        throw error;
      }
      if (state.hasItemForSale || state.hasNext || state.hasPublish) return;
      log(profileId, "vao create/item", `create/item chua tai xong lan ${attempt}/3, dang F5 lai`, "warn", state.bodyText);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await sleep(1800);
    }
    throw new Error("Marketplace create/item bi treo qua lau, da F5 3 lan van khong tai duoc.");
  }

  async function clickMoreDetailsIfNeeded(page) {
    const clicked = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("button, [role='button'], div, span"));
      const target = nodes.find((node) => /more details/i.test(String(node.textContent || "").replace(/\s+/g, " ").trim()));
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      target.click();
      return true;
    });
    if (clicked) await sleep(1200);
  }

  async function focusListingLocationInput(page, profileId = "") {
    for (let attempt = 1; attempt <= 14; attempt += 1) {
      const result = await page.evaluate(() => {
        const norm = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
        const isVisible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          if (!rect) return false;
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const isEnabled = (node) => {
          if (!node || node.disabled) return false;
          if (node.getAttribute?.("aria-disabled") === "true") return false;
          const style = window.getComputedStyle(node);
          return style.pointerEvents !== "none";
        };
        const rectInfo = (node) => {
          const rect = node?.getBoundingClientRect?.();
          if (!rect) return null;
          return {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        };
        const elementFromCenter = (node) => {
          const rect = node?.getBoundingClientRect?.();
          if (!rect) return null;
          const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!top) return null;
          return {
            tag: top.tagName || "",
            role: top.getAttribute?.("role") || "",
            ariaLabel: top.getAttribute?.("aria-label") || "",
            placeholder: top.getAttribute?.("placeholder") || "",
            same: top === node,
            contains: node.contains?.(top) || false,
            containedBy: top.contains?.(node) || false,
            text: String(top.innerText || top.textContent || top.value || "").replace(/\s+/g, " ").trim().slice(0, 160)
          };
        };
        const nodeDebug = (node, selector) => {
          const style = node ? window.getComputedStyle(node) : null;
          return {
            ok: Boolean(node),
            selector,
            fieldRect: rectInfo(node),
            visible: isVisible(node),
            enabled: isEnabled(node),
            role: node?.getAttribute?.("role") || "",
            ariaLabel: node?.getAttribute?.("aria-label") || "",
            placeholder: node?.getAttribute?.("placeholder") || "",
            pointerEvents: style?.pointerEvents || "",
            zIndex: style?.zIndex || "",
            elementFromPoint: elementFromCenter(node),
            activeTag: document.activeElement?.tagName || "",
            activeRole: document.activeElement?.getAttribute?.("role") || "",
            outerHTML: String(node?.outerHTML || "").slice(0, 900)
          };
        };
        const findSidebarScroller = () => {
          const candidates = Array.from(document.querySelectorAll("div"))
            .filter((node) => {
              if (!isVisible(node)) return false;
              const rect = node.getBoundingClientRect();
              if (rect.left > window.innerWidth * 0.35) return false;
              if (rect.width < 250 || rect.height < 280) return false;
              const style = window.getComputedStyle(node);
              return /(auto|scroll)/.test(style.overflowY || "") && node.scrollHeight > node.clientHeight + 40;
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          return candidates[0] || document.scrollingElement || document.documentElement;
        };
        const directSelectors = [
          "input[aria-label='Location'][role='combobox']",
          "input[aria-label*='Location' i][role='combobox']",
          "input[aria-label*='Location' i]",
          "input[placeholder='Enter a city'][role='combobox']",
          "input[placeholder*='city' i][role='combobox']",
          "[role='combobox'][aria-label*='Location' i]",
          "[role='textbox'][aria-label*='Location' i]"
        ];
        for (const selector of directSelectors) {
          const node = Array.from(document.querySelectorAll(selector)).find((item) => isVisible(item) && isEnabled(item));
          if (!node) continue;
          node.scrollIntoView({ block: "center", inline: "nearest" });
          node.focus({ preventScroll: true });
          node.click();
          return {
            ...nodeDebug(node, selector),
            ok: document.activeElement === node || node.matches(":focus") || node.getAttribute("aria-expanded") === "true",
            activeTag: document.activeElement?.tagName || "",
            activeRole: document.activeElement?.getAttribute?.("role") || ""
          };
        }
        const findEditableInField = (field) => {
          const selectors = [
            "input[aria-label*='Location' i]",
            "input[placeholder*='Location' i]",
            "input[autocomplete]",
            "input",
            "textarea",
            "[contenteditable='true']",
            "[role='combobox']",
            "[role='textbox']"
          ];
          for (const selector of selectors) {
            const nodes = Array.from(field?.querySelectorAll?.(selector) || [])
              .filter((node) => isVisible(node) && isEnabled(node))
              .map((node) => {
                const rect = node.getBoundingClientRect();
                const fieldRect = field.getBoundingClientRect();
                const verticalDistance = Math.abs((rect.top + rect.height / 2) - (fieldRect.top + fieldRect.height / 2));
                return { node, selector, score: verticalDistance };
              })
              .sort((a, b) => a.score - b.score);
            if (nodes[0]) return nodes[0];
          }
          return null;
        };
        const collectCandidates = () => {
          const allNodes = Array.from(document.querySelectorAll("div, span, label"));
          const candidates = [];
          for (const node of allNodes) {
            if (!isVisible(node)) continue;
            const text = norm(node.innerText || node.textContent || "");
            if (!text) continue;
            const looksLikeLocationLine =
              text === "location"
              || text.includes("enter a city")
              || text.includes("please enter a valid location")
              || /^san [a-z]/i.test(text)
              || /,\s*(california|new york|new mexico|virginia|missouri|texas|ohio|florida|maryland|arizona|colorado|georgia|nevada|new jersey)\b/i.test(text);
            if (!looksLikeLocationLine) continue;
            let current = node;
            for (let depth = 0; current && depth < 8; depth += 1) {
              const rect = current.getBoundingClientRect?.();
              if (rect && rect.left < window.innerWidth * 0.38 && rect.width > 220 && rect.width < 430 && rect.height >= 46 && rect.height <= 120) {
                const currentText = norm(current.innerText || "");
                const hasSku = currentText.includes("sku");
                const hasLocation = currentText.includes("location");
                const hasLocationValue =
                  currentText.includes("enter a city")
                  || currentText.includes("please enter a valid location")
                  || /,\s*(california|new york|new mexico|virginia|missouri|texas|ohio|florida|maryland|arizona|colorado|georgia|nevada|new jersey)\b/i.test(currentText)
                  || /^location\s+[a-z]/i.test(currentText)
                  || /^location\s+san [a-z]/i.test(currentText);
                if (!hasSku && hasLocation && hasLocationValue) {
                  candidates.push({ node: current, rect, text: currentText });
                  break;
                }
              }
              current = current.parentElement;
            }
          }
          candidates.sort((a, b) => a.rect.top - b.rect.top);
          return candidates;
        };
        const scrollRoot = findSidebarScroller();
        const field = collectCandidates()[0]?.node || null;
        if (field) {
          field.scrollIntoView({ block: "center", inline: "nearest" });
          const editable = findEditableInField(field);
          if (editable) {
            editable.node.scrollIntoView({ block: "center", inline: "nearest" });
            editable.node.focus({ preventScroll: true });
            editable.node.click();
            return {
              ...nodeDebug(editable.node, editable.selector),
              ok: document.activeElement === editable.node || editable.node.matches(":focus") || editable.node.getAttribute("aria-expanded") === "true",
              selector: editable.selector,
              fieldRect: rectInfo(editable.node),
              cardRect: rectInfo(field),
              activeTag: document.activeElement?.tagName || "",
              activeRole: document.activeElement?.getAttribute?.("role") || ""
            };
          }
          field.focus?.({ preventScroll: true });
          field.click();
          return {
            ...nodeDebug(field, "location-card-click"),
            ok: true,
            selector: "location-card-click",
            fieldRect: rectInfo(field),
            cardRect: rectInfo(field),
            activeTag: document.activeElement?.tagName || "",
            activeRole: document.activeElement?.getAttribute?.("role") || ""
          };
        }
        const scrollAmount = Math.max(180, Math.floor(window.innerHeight * 0.35));
        if (scrollRoot === document.scrollingElement || scrollRoot === document.documentElement || scrollRoot === document.body) {
          window.scrollBy(0, scrollAmount);
        } else {
          scrollRoot.scrollTop += scrollAmount;
        }
        return {
          ok: false,
          selector: "",
          fieldRect: null,
          visible: false,
          enabled: false,
          activeTag: document.activeElement?.tagName || "",
          activeRole: document.activeElement?.getAttribute?.("role") || ""
        };
      });
      log(profileId, "debug location focus", `retry ${attempt}/14 selector=${result?.selector || "none"} visible=${Boolean(result?.visible)} enabled=${Boolean(result?.enabled)} rect=${JSON.stringify(result?.fieldRect || null)} active=${result?.activeTag || ""}/${result?.activeRole || ""}`, result?.ok ? "success" : "warn", JSON.stringify(result || {}));
      if (result?.ok) {
        await sleep(700);
        const editor = await page.evaluate(() => {
          const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            if (!rect) return false;
            const style = window.getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const enabled = (node) => {
            if (!node || node.disabled) return false;
            if (node.getAttribute?.("aria-disabled") === "true") return false;
            return window.getComputedStyle(node).pointerEvents !== "none";
          };
          const rectInfo = (node) => {
            const rect = node?.getBoundingClientRect?.();
            return rect ? {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            } : null;
          };
          const isTypingTarget = (node) => {
            if (!node || !visible(node) || !enabled(node)) return false;
            const tag = String(node.tagName || "").toLowerCase();
            const role = String(node.getAttribute?.("role") || "").toLowerCase();
            return tag === "input" || tag === "textarea" || node.getAttribute?.("contenteditable") === "true" || role === "textbox" || role === "combobox";
          };
          if (isTypingTarget(document.activeElement)) {
            return {
              ready: true,
              selector: "activeElement",
              rect: rectInfo(document.activeElement),
              text: String(document.activeElement.getAttribute?.("aria-label") || document.activeElement.getAttribute?.("placeholder") || "")
            };
          }
          const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox'], [role='combobox']"))
            .filter(isTypingTarget)
            .map((node) => {
              const rect = node.getBoundingClientRect();
              const text = [
                node.getAttribute("aria-label"),
                node.getAttribute("placeholder"),
                node.getAttribute("name"),
                node.textContent,
                node.value
              ].join(" ").replace(/\s+/g, " ").trim();
              const cityScore = /location|city|search/i.test(text) ? 0 : 1000;
              const sidebarScore = rect.left < window.innerWidth * 0.45 ? 0 : 200;
              const dialogScore = node.closest("[role='dialog'], [role='listbox'], [role='presentation']") ? 0 : 80;
              return { node, text, score: cityScore + sidebarScore + dialogScore + Math.max(0, rect.top) / 1000 };
            })
            .sort((a, b) => a.score - b.score);
          const picked = candidates[0]?.node || null;
          if (!picked) return { ready: false, selector: "", rect: null, text: "" };
          picked.scrollIntoView({ block: "center", inline: "nearest" });
          picked.focus({ preventScroll: true });
          picked.click();
          return {
            ready: document.activeElement === picked || picked.matches(":focus"),
            selector: "location-editor-candidate",
            rect: rectInfo(picked),
            text: String(picked.getAttribute("aria-label") || picked.getAttribute("placeholder") || candidates[0].text || "")
          };
        }).catch((error) => ({ ready: false, error: error.message }));
        log(profileId, "debug location focus", `typing ready=${Boolean(editor?.ready)} sau retry ${attempt}/14 editor=${editor?.selector || "none"} rect=${JSON.stringify(editor?.rect || null)} text="${editor?.text || ""}"`, editor?.ready ? "success" : "warn", JSON.stringify(editor || {}));
        if (editor?.ready) return;
      }
      await sleep(450);
    }
    throw new Error("Khong tim thay o Location trong form dang bai.");
  }

  async function setListingLocationAndPickFirst(page, target, profileId = "") {
    await focusListingLocationInput(page, profileId);
    await sleep(250);
    await page.keyboard.down("Control").catch(() => {});
    await page.keyboard.press("A").catch(() => {});
    await page.keyboard.up("Control").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(target, { delay: 25 });
    await sleep(500);
    let typedState = await page.evaluate((expectedTarget) => {
      const input = document.querySelector("input[aria-label='Location'][role='combobox'], input[aria-label*='Location' i], input[placeholder='Enter a city'][role='combobox'], input[placeholder*='city' i][role='combobox']");
      const value = String(input?.value || input?.textContent || "").replace(/\s+/g, " ").trim();
      const expected = String(expectedTarget || "").replace(/\s+/g, " ").trim();
      return {
        found: Boolean(input),
        value,
        expected,
        ok: Boolean(input) && (!expected || value.toLowerCase().includes(expected.toLowerCase()) || expected.toLowerCase().includes(value.toLowerCase())),
        active: document.activeElement === input,
        tag: input?.tagName || "",
        role: input?.getAttribute?.("role") || "",
        ariaLabel: input?.getAttribute?.("aria-label") || "",
        placeholder: input?.getAttribute?.("placeholder") || ""
      };
    }, target).catch((error) => ({ found: false, ok: false, error: error.message }));
    log(profileId, "debug location type", `sau keyboard found=${Boolean(typedState?.found)} ok=${Boolean(typedState?.ok)} active=${Boolean(typedState?.active)} value="${typedState?.value || ""}"`, typedState?.ok ? "success" : "warn", JSON.stringify(typedState || {}));
    if (!typedState?.ok) {
      typedState = await page.evaluate((expectedTarget) => {
        const input = document.querySelector("input[aria-label='Location'][role='combobox'], input[aria-label*='Location' i], input[placeholder='Enter a city'][role='combobox'], input[placeholder*='city' i][role='combobox']");
        if (!input) return { found: false, ok: false, value: "", reason: "missing input" };
        input.scrollIntoView({ block: "center", inline: "nearest" });
        input.focus({ preventScroll: true });
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, expectedTarget);
        else input.value = expectedTarget;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: expectedTarget }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const value = String(input.value || "").replace(/\s+/g, " ").trim();
        const expected = String(expectedTarget || "").replace(/\s+/g, " ").trim();
        return {
          found: true,
          value,
          expected,
          ok: value.toLowerCase().includes(expected.toLowerCase()) || expected.toLowerCase().includes(value.toLowerCase()),
          active: document.activeElement === input,
          tag: input.tagName || "",
          role: input.getAttribute("role") || "",
          ariaLabel: input.getAttribute("aria-label") || "",
          placeholder: input.getAttribute("placeholder") || ""
        };
      }, target).catch((error) => ({ found: false, ok: false, error: error.message }));
      log(profileId, "debug location type", `sau native setter found=${Boolean(typedState?.found)} ok=${Boolean(typedState?.ok)} active=${Boolean(typedState?.active)} value="${typedState?.value || ""}"`, typedState?.ok ? "success" : "warn", JSON.stringify(typedState || {}));
    }
    if (!typedState?.ok) throw new Error("Da focus Location nhung text khong vao input Location.");
    await sleep(900);

    await page.keyboard.press("ArrowDown").catch(() => {});
    await sleep(250);
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(1200);

    const acceptedByKeyboard = await page.evaluate((expectedTarget) => {
      const bodyText = String(document.body?.innerText || "");
      const invalid = /please enter a valid location/i.test(bodyText);
      const field = Array.from(document.querySelectorAll("div, span, label")).find((node) => {
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const rect = node.getBoundingClientRect();
        return text === "location" && rect.width > 0 && rect.height > 0;
      });
      if (!field) return false;
      const scope = field.closest("div")?.parentElement || field.parentElement;
      const scopeText = String(scope?.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      const expected = String(expectedTarget || "").replace(/\s+/g, " ").trim().toLowerCase();
      return !invalid && expected ? scopeText.includes(expected) : (!invalid && !/location$/i.test(scopeText));
    }, target).catch(() => false);
    if (acceptedByKeyboard) {
      const picked = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll("div, span, label")).filter((node) => {
          const text = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          const rect = node.getBoundingClientRect();
          return text === "location" && rect.width > 0 && rect.height > 0;
        });
        for (const label of labels) {
          const scope = label.closest("div")?.parentElement || label.parentElement;
          const lines = String(scope?.innerText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
          const value = lines.find((line) => /,\s*/.test(line) && !/^location$/i.test(line));
          if (value) return value;
        }
        return "";
      }).catch(() => "");
      if (picked) return picked;
    }

    const firstSuggestion = await page.evaluate(() => {
      const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return rect && rect.width > 0 && rect.height > 0;
      };
      const locationLabel = Array.from(document.querySelectorAll("div, span, label")).find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && norm(node.textContent).toLowerCase() === "location";
      });
      if (!locationLabel) return null;
      const scope = locationLabel.closest("div")?.parentElement || locationLabel.parentElement;
      const scopeRect = scope?.getBoundingClientRect?.() || locationLabel.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll("li, [role='option'], div"))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const text = norm(node.textContent);
          return { node, text, rect };
        })
        .filter((item) => item.text && item.rect.width > 150 && item.rect.height > 24 && item.rect.top >= scopeRect.bottom - 4 && item.rect.left <= scopeRect.right + 20);
      const first = candidates[0];
      if (!first) return null;
      if (visible(first.node)) {
        first.node.scrollIntoView({ block: "center", inline: "nearest" });
        first.node.click();
      }
      return {
        clicked: visible(first.node),
        rect: {
          left: Math.round(first.rect.left),
          top: Math.round(first.rect.top),
          width: Math.round(first.rect.width),
          height: Math.round(first.rect.height)
        },
        text: first.text
      };
    });
    if (!firstSuggestion) throw new Error("Khong tim thay goi y dia chi dau tien.");
    log(profileId, "debug location suggestion", `selector suggestion clicked=${Boolean(firstSuggestion.clicked)} rect=${JSON.stringify(firstSuggestion.rect || null)} text="${firstSuggestion.text || ""}"`, firstSuggestion.clicked ? "success" : "warn", JSON.stringify(firstSuggestion));
    if (!firstSuggestion.clicked) throw new Error("Tim thay goi y dia chi nhung khong click duoc bang element.");
    await sleep(1200);
    return firstSuggestion.text;
  }

  async function ensurePostLocation(page, target, profileId) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const limitCheck = await page.evaluate(() => {
          const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
          const limitReached = /limit reached/i.test(text)
            || /you are not able to create new listings right now/i.test(text)
            || /daily limit/i.test(text);
          const hasEnabledPublish = Array.from(document.querySelectorAll("button, [role='button']"))
            .some((node) => {
              const label = String(node.textContent || "").replace(/\s+/g, " ").trim();
              const rect = node.getBoundingClientRect();
              return /^publish$/i.test(label) && rect.width > 0 && rect.height > 0 && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
            });
          return limitReached && !hasEnabledPublish && !/[?&]step=audience\b/i.test(window.location.href || "");
        }).catch(() => false);
        if (limitCheck) {
          const limitError = new Error("Limit reached: khong the tao bai dang moi luc nay.");
          limitError.status = "limitdb";
          throw limitError;
        }
        const suggestionText = await setListingLocationAndPickFirst(page, target, profileId);
        const valid = await page.evaluate(() => {
          const bodyText = String(document.body?.innerText || "");
          const invalid = /please enter a valid location/i.test(bodyText);
          const nextButton = Array.from(document.querySelectorAll("button, [role='button']"))
            .find((node) => /^next$/i.test(String(node.textContent || "").replace(/\s+/g, " ").trim()));
          const publishButton = Array.from(document.querySelectorAll("button, [role='button']"))
            .find((node) => /^publish$/i.test(String(node.textContent || "").replace(/\s+/g, " ").trim()));
          const button = nextButton || publishButton;
          const enabled = button
            ? button.getAttribute("aria-disabled") !== "true" && !button.disabled
            : false;
          return { invalid, enabled };
        });
        if (valid.enabled && !valid.invalid) return suggestionText;
        throw new Error("Da click goi y dau nhung nut Next van chua sang.");
      } catch (error) {
        lastError = error;
        log(profileId, "dien location dang bai", `thu lai location lan ${attempt}/3: ${error.message}`, "warn");
        await sleep(800);
      }
    }
    throw lastError || new Error("Khong dien duoc location hop le cho dang bai.");
  }

  async function waitForPublishSuccess(page) {
    await page.waitForFunction(() => {
      const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const url = window.location.href || "";
      return /boost your listing/i.test(text)
        || /posted a few seconds ago/i.test(text)
        || /\/marketplace\/you\/selling/i.test(url)
        || /your listings/i.test(text);
    }, { timeout: 120000 });
    await sleep(1500);
  }

  async function advanceToPublish(manager, page) {
    for (let guard = 0; guard < 4; guard += 1) {
      const limitReached = await page.evaluate(() => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const hasEnabledPublish = Array.from(document.querySelectorAll("button, [role='button']"))
          .some((node) => {
            const label = String(node.textContent || "").replace(/\s+/g, " ").trim();
            const rect = node.getBoundingClientRect();
            return /^publish$/i.test(label) && rect.width > 0 && rect.height > 0 && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
          });
        const limit = /limit reached/i.test(text)
          || /you are not able to create new listings right now/i.test(text)
          || /daily limit/i.test(text);
        return limit && !hasEnabledPublish && !/[?&]step=audience\b/i.test(window.location.href || "");
      }).catch(() => false);
      if (limitReached) {
        const error = new Error("Limit reached: khong the tao bai dang moi luc nay.");
        error.status = "limitdb";
        throw error;
      }
      await restoreNaturalMarketplaceView(manager, page);
      const visibleButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
          .map((node) => {
            const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
            const rect = node.getBoundingClientRect();
            const enabled = rect.width > 0 && rect.height > 0 && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
            return { text, enabled };
          });
        const publish = buttons.find((item) => /^publish$/i.test(item.text) && item.enabled);
        if (publish) return "publish";
        const next = buttons.find((item) => /^next$/i.test(item.text) && item.enabled);
        if (next) return "next";
        return "";
      });
      if (visibleButton === "publish") return;
      if (visibleButton === "next") {
        await manager.clickActionButton(page, "Next");
        await sleep(1500);
        continue;
      }
      throw new Error("Khong tim thay nut Next hoac Publish dang hoat dong.");
    }
    throw new Error("Khong the di toi buoc Publish.");
  }

  async function runPostTwoV(manager, page, payload, row, profileId, markNoRollback = () => {}) {
    const guardLimitReached = async () => {
      const limitReached = await page.evaluate(() => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const hasEnabledPublish = Array.from(document.querySelectorAll("button, [role='button']"))
          .some((node) => {
            const label = String(node.textContent || "").replace(/\s+/g, " ").trim();
            const rect = node.getBoundingClientRect();
            return /^publish$/i.test(label) && rect.width > 0 && rect.height > 0 && node.getAttribute("aria-disabled") !== "true" && !node.disabled;
          });
        const limit = /limit reached/i.test(text)
          || /you are not able to create new listings right now/i.test(text)
          || /daily limit/i.test(text);
        return limit && !hasEnabledPublish && !/[?&]step=audience\b/i.test(window.location.href || "");
      }).catch(() => false);
      if (limitReached) {
        const error = new Error("Limit reached: khong the tao bai dang moi luc nay.");
        error.status = "limitdb";
        throw error;
      }
    };
    await guardLimitReached();
    await manager.fillStepOne(page, payload);
    await guardLimitReached();
    await restoreNaturalMarketplaceView(manager, page);
    await sleep(1200);
    await clickMoreDetailsIfNeeded(page);
    const locations = await loadUsLocationLines();
    const target = randomItem(locations);
    if (!target) throw new Error("File us_locations.txt dang trong.");
    log(profileId, "location dang bai", `doi location dang bai sang "${target}"`, "info");
    const picked = await ensurePostLocation(page, target, profileId);
    log(profileId, "location dang bai", `da chon location: ${picked}`, "success");
    if (runtime.stopRequested) {
      const stopped = new Error("Da nhan lenh dung han truoc khi bam Publish.");
      stopped.status = "stopped";
      throw stopped;
    }
    await advanceToPublish(manager, page);
    await restoreNaturalMarketplaceView(manager, page);
    await guardLimitReached();
    markNoRollback();
    await manager.clickActionButton(page, "Publish");
    await waitForPublishSuccess(page);
    if (typeof manager.consumeUsedTitle === "function") {
      manager.consumeUsedTitle(payload.titleFile, payload.title);
    }
    return { ok: true, detail: "Đã đăng bài thành công.", location: picked || target };
  }

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot = 0, workerTotal = 1) {
    const manager = getManager({ fresh: true });
    patchManager(manager);
    patchStableWindowTiling(manager, workerSlot, workerTotal);
    manager.saveConfig({
      dataRoot: config.fullDataRoot,
      priceMin: config.fullPriceMin,
      priceMax: config.fullPriceMax,
      maxConcurrency: 1
    });

    const row = buildToolRow(profileId, sheetRow);
    const uid = profileUid(row, profileId);
    const job = runtime.jobs.get(profileId);
    const sheetWriter = createDeferredSheetWriter(sheetSession, profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;
    let currentName = String(sheetValue(sheetRow, "tên profile hiện tại", "ten profile hien tai") || profileId).trim();
    let originalName = currentName;
    let noRollback = false;
    let restoreManagerLoginGuards = () => {};
    let allocatedSeller = null;

    try {
      job.status = "running";
      if (manager.activeJobs) manager.activeJobs.set(uid, { type: "post", pauseRequested: false, paused: false, resumed: false, stopRequested: false });
      manager.currentActiveUid = uid;
      manager.stopAllRequested = false;
      if (!runtime.activeManagers) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid, shouldFinish: () => noRollback });
      const profileInfo = await step(profileId, job, "kiem tra profile HideMyAcc", async () => manager.getProfileById(profileId), { timeoutMs: 30000 });
      currentName = String(profileInfo?.name || currentName || profileId).trim();
      originalName = currentName;
      await writeSheet(sheetWriter, profileId, { trangThai: "", chiTiet: "đang chạy đăng bài" });

      proxyLease = await step(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      );

      await step(profileId, job, "mo profile full man hinh", async () => {
        browser = await manager.connectBrowser(profileId);
        page = await browser.newPage();
        await page.bringToFront();
        if (typeof manager.maximizeBrowserWindow === "function") await manager.maximizeBrowserWindow(browser, page).catch(() => {});
        const viewport = await applyStableViewport(page, workerSlot, workerTotal);
        log(profileId, "viewport", `worker ${workerSlot + 1}/${workerTotal} bounds=${viewport?.bounds?.width || ""}x${viewport?.bounds?.height || ""} viewport=${viewport?.width || 1365}x${viewport?.height || 900}, zoom=1, actual=${JSON.stringify(viewport?.actual || {})}`);
      }, { timeoutMs: 120000 });

      await step(profileId, job, "dang nhap va doi ngon ngu", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap", status);
        });
      }, { timeoutMs: 300000 });

      restoreManagerLoginGuards = patchManagerForCentralizedLogin(manager, row);

      await step(profileId, job, "vao create item", async () => {
        await ensureCreateItemReady(manager, page, row, profileId, job);
      }, { timeoutMs: 180000 });

      const initialState = await step(profileId, job, "check vach create item", async () => {
        let state = await manager.detectInitialMarketplaceState(page);
        if (state.kind === "unknown") {
          await sleep(2000);
          state = await manager.detectInitialMarketplaceState(page);
        }
        return state;
      }, { timeoutMs: 60000 });

      if (initialState.kind === "dead") throw new Error(initialState.detail || "Marketplace chet cho.");
      if (initialState.kind !== "publish_only" && initialState.kind !== "progress") {
        throw new Error("Khong doc duoc progress tao bai dang.");
      }

      const payload = await step(profileId, job, "lay payload dang bai", async () => manager.getRandomListingPayload(), { timeoutMs: 30000 });

      if (initialState.kind === "progress" && Number(initialState.totalSteps) === 3) {
        allocatedSeller = await step(profileId, job, "lay seller info", async () => allocateSellerInfoRow(config, uid), { timeoutMs: 30000 });
        row.raw = { ...row.raw, ...allocatedSeller.raw };
        const outcome = await step(profileId, job, "luong full goc Shipping Full Studio", async () => manager.runFullFlowAttempt(page, browser, row, profileId), { timeoutMs: 480000, allowFinishAfterStop: true });
        if (!outcome?.ok) throw new Error(outcome?.detail || "Luồng full gốc không thành công.");
        noRollback = true;
        await updateSellerInfoUid(config, allocatedSeller, uid);
        const fullToken = buildFullSuccessToken(
          allocatedSeller?.raw?.SSN || allocatedSeller?.raw?.ssn || allocatedSeller?.raw?.Ssn || ""
        );
        const tenChuan = buildStandardName({
          currentName,
          sheetRow,
          uid,
          soVach: "3v",
          fullToken
        });
        await rename(manager, profileId, tenChuan);
        const update = {
          Tool: "đã làm full",
          trangThai: "thành công",
          soVach: "3v",
          chiTiet: "đã bấm submit info thành công",
          tenChuan
        };
        await writeSheet(sheetWriter, profileId, update);
        await sheetWriter.commit();
        job.status = "success";
        job.result = update;
        return update;
      }

      const postResult = await step(profileId, job, "dang bai 2 vach", async () =>
        runPostTwoV(manager, page, payload, row, profileId, () => { noRollback = true; })
      , { timeoutMs: 480000 });
      const dbToken = nextDbToken(currentName, sheetRow);
      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid,
        soVach: "2v",
        dbToken
      });
      await rename(manager, profileId, tenChuan);
      const update = {
        Tool: "đã đăng bài",
        trangThai: "thành công",
        soVach: "2v",
        chiTiet: "đã đăng bài thành công",
        tenChuan
      };
      await writeSheet(sheetWriter, profileId, update);
      await sheetWriter.commit();
      job.status = "success";
      job.result = update;
      return update;
    } catch (error) {
      if (allocatedSeller) await updateSellerInfoUid(config, allocatedSeller, "").catch(() => {});
      const mapped = mapPostError(error);
      if (mapped.status === "stopped" && !noRollback) {
        sheetWriter.discard();
        await rename(manager, profileId, originalName).catch(() => {});
        job.status = "stopped";
        job.liveStatus = "da dung han, giu nguyen Sheet";
        job.result = null;
        return { stopped: true };
      }
      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid
      });
      await rename(manager, profileId, buildRuntimeProfileName({ status: mapped.status, tenChuan }));
      const update = {
        Tool: sheetValue(sheetRow, "Tool") || "",
        trangThai: "loi",
        chiTiet: mapped.detail,
        tenChuan
      };
      await writeSheet(sheetWriter, profileId, update);
      await sheetWriter.commit();
      job.status = "error";
      job.liveStatus = mapped.detail;
      job.result = update;
      return update;
    } finally {
      restoreManagerLoginGuards();
      if (runtime.activeManagers instanceof Map) runtime.activeManagers.delete(profileId);
      if (manager.activeJobs) manager.activeJobs.delete(uid);
      if (manager.currentActiveUid === uid) manager.currentActiveUid = "";
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
    if (!config.fullDataRoot || !config.fullPriceMin || !config.fullPriceMax) {
      throw new Error("Ban can nhap thu muc dang bai va gia min/max truoc khi chay dang bai.");
    }
    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampToolConcurrency(config.postConcurrency), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "dang bai",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang dang bai ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "dang bai";
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
            const update = { Tool: "đã đăng bài", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide." };
            if (job) {
              job.status = "error";
              job.liveStatus = update.chiTiet;
              job.finishedAt = new Date().toISOString();
              job.result = update;
            }
            log(id, "doc Sheet", update.chiTiet, "error");
            continue;
          }
          if (job) {
            job.startedAt = new Date().toISOString();
            job.liveStatus = `dang bat dau o luong ${workerSlot + 1}/${concurrency}`;
          }
          activeCount += 1;
          log(id, "worker", `worker ${workerSlot + 1}/${concurrency} start, active=${activeCount}, queue_con_lai=${Math.max(0, ids.length - cursor)}`);
          try {
            await runOne(id, row, config, sheetSession, workerSlot, concurrency);
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
              job.liveStatus = "da dung han";
              job.finishedAt = new Date().toISOString();
            }
          }
        }
      } catch (error) {
        addRuntimeLog(`Loi queue dang bai: ${error.message}`, "error", "", { step: "queue dang bai", tool: "dang bai" });
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


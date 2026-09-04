import fs from "node:fs";
import path from "node:path";

import { withFacebookLocale } from "./facebook_locale.js";

const PROFILE_URL = "https://www.facebook.com/profile";
const STABLE_AVATAR_CONCURRENCY = 2;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampToolConcurrency(value, fallback = STABLE_AVATAR_CONCURRENCY) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(2, fallback));
  return Math.max(1, Math.min(2, parsed));
}

function randomItem(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return "";
  return values[Math.floor(Math.random() * values.length)] || "";
}

function buildStoppedError() {
  const error = new Error("Da nhan lenh dung han, tool doi anh dai dien dung batch hien tai.");
  error.status = "stopped";
  error.step = "dung han";
  return error;
}

function normalizePathInput(value) {
  return String(value || "").trim().replace(/^"|"$/g, "");
}

function listImagesRecursive(dir, limit = 10000) {
  const result = [];
  const stack = [dir];
  while (stack.length && result.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function readImagePool(inputPath) {
  const target = normalizePathInput(inputPath);
  if (!target) throw new Error("Chua cau hinh duong dan thu muc/file anh dai dien.");
  if (!fs.existsSync(target)) throw new Error(`Khong ton tai duong dan anh: ${target}`);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const images = listImagesRecursive(target);
    if (!images.length) throw new Error(`Thu muc khong co anh hop le jpg/png/webp: ${target}`);
    return images;
  }
  if (stat.isFile()) {
    const ext = path.extname(target).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return [target];
    const baseDir = path.dirname(target);
    const images = fs.readFileSync(target, "utf8")
      .split(/\r?\n/)
      .map((line) => normalizePathInput(line))
      .filter(Boolean)
      .map((item) => path.isAbsolute(item) ? item : path.resolve(baseDir, item))
      .filter((item) => fs.existsSync(item) && IMAGE_EXTENSIONS.has(path.extname(item).toLowerCase()));
    if (!images.length) throw new Error(`File danh sach khong co anh hop le: ${target}`);
    return images;
  }
  throw new Error(`Duong dan anh khong hop le: ${target}`);
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
  if (!page || page.isClosed?.()) return null;
  const bounds = tileBounds(workerSlot, workerTotal);
  const compact = Number(workerTotal || 1) >= 4;
  const viewport = {
    width: Math.max(900, bounds.width - 24),
    height: compact ? 900 : Math.max(640, bounds.height - 110),
    deviceScaleFactor: 1
  };
  await page.setViewport?.(viewport).catch(() => {});
  await page.evaluate(() => {
    const compact = window.innerHeight >= 860 && window.outerHeight && window.outerHeight <= 620;
    const zoom = compact ? "0.58" : "";
    document.documentElement.style.zoom = zoom;
    if (document.body) document.body.style.zoom = zoom;
  }).catch(() => {});
  return { ...viewport, zoom: compact ? 0.58 : 1, bounds, actual: await readViewportMetrics(page) };
}

function patchStableWindowTiling(manager, workerSlot = 0, workerTotal = 1) {
  const original = manager.maximizeBrowserWindow;
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
  const targetUrl = withFacebookLocale(url);
  if (typeof manager.gotoWithRetry === "function") return manager.gotoWithRetry(page, targetUrl, row, attempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
      return true;
    } catch (error) {
      lastError = error;
      await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error(`Khong vao duoc ${targetUrl}`);
}

async function mouseClickPoint(page, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function clickText(page, patterns, options = {}) {
  const exact = Boolean(options.exact);
  const minY = Number(options.minY || 0);
  const target = await page.evaluate(({ patterns, exact, minY }) => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = patterns.map(normalize);
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 5 && rect.height > 5 && rect.bottom > minY && rect.left < window.innerWidth
        && style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
    };
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], a, div, span"));
    const candidates = [];
    for (const node of nodes) {
      if (!visible(node)) continue;
      const text = normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "");
      if (!text) continue;
      const matched = wanted.some((item) => exact ? text === item : text.includes(item));
      if (!matched) continue;
      const rect = node.getBoundingClientRect();
      candidates.push({
        node,
        area: rect.width * rect.height,
        y: rect.top,
        point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      });
    }
    candidates.sort((a, b) => a.area - b.area || b.y - a.y);
    const target = candidates[0]?.node;
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "center" });
    let parent = target.parentElement;
    while (parent) {
      const style = window.getComputedStyle(parent);
      const canScroll = /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`) && parent.scrollHeight > parent.clientHeight + 8;
      if (canScroll) parent.scrollTop = Math.max(0, target.offsetTop - Math.floor(parent.clientHeight / 2));
      parent = parent.parentElement;
    }
    target.focus?.();
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { patterns, exact, minY });
  const clicked = await mouseClickPoint(page, target).catch(() => false);
  if (!clicked) return false;
  await sleep(Number(options.delayMs || 500));
  return true;
}

async function applyCompactAvatarDialog(page) {
  await page.evaluate(() => {
    let style = document.getElementById("codex-avatar-compact-dialog-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "codex-avatar-compact-dialog-style";
      document.head.appendChild(style);
    }
    style.textContent = `
      [role="dialog"][aria-label*="profile picture" i],
      [role="dialog"][aria-label*="profile" i] {
        transform: scale(0.72) !important;
        transform-origin: top center !important;
        top: 8px !important;
        margin-top: 0 !important;
        max-height: 690px !important;
      }
      [role="dialog"][aria-label*="profile picture" i] img,
      [role="dialog"][aria-label*="profile picture" i] canvas,
      [role="dialog"][aria-label*="profile picture" i] video {
        max-height: 290px !important;
      }
    `;
    const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
    for (const dialog of dialogs) {
      const label = String(dialog.getAttribute("aria-label") || dialog.innerText || "").toLowerCase();
      if (!label.includes("profile picture")) continue;
      dialog.style.transform = "scale(0.72)";
      dialog.style.transformOrigin = "top center";
      dialog.style.top = "8px";
      dialog.style.marginTop = "0";
      dialog.style.maxHeight = "690px";
      const scrollables = Array.from(dialog.querySelectorAll("div")).filter((node) => node.scrollHeight > node.clientHeight + 8);
      for (const node of scrollables) node.scrollTop = node.scrollHeight;
    }
  }).catch(() => {});
}

async function menuProfilePictureState(page) {
  return page.evaluate(() => {
    const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 10 && rect.height > 10 && style.visibility !== "hidden" && style.display !== "none";
    };
    const texts = Array.from(document.querySelectorAll("div, span, a, button, [role='menuitem'], [role='button']"))
      .filter(visible)
      .map((node) => normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || ""))
      .filter(Boolean);
    return {
      hasSee: texts.some((text) => text === "see profile picture" || text.includes("see profile picture")),
      hasChoose: texts.some((text) => text === "choose profile picture" || text.includes("choose profile picture")),
      texts: texts.filter((text) => text.includes("profile picture")).slice(0, 10)
    };
  });
}

async function detectExistingProfileAvatar(page) {
  return page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("[aria-label='Profile picture actions'], [aria-label*='Profile picture']"))
      .find((node) => node.getAttribute("aria-label") === "Profile picture actions")
      || Array.from(document.querySelectorAll("[aria-label*='Profile picture']")).find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 80;
      });
    const avatarRoot = button?.closest?.("[role='button']") || button;
    if (!avatarRoot) return { hasAvatar: false, reason: "khong thay vung avatar" };
    const images = Array.from(avatarRoot.querySelectorAll("image, img"))
      .map((node) => String(node.currentSrc || node.src || node.getAttribute("href") || node.getAttribute("xlink:href") || "").trim())
      .filter(Boolean);
    const realImages = images.filter((src) => {
      const lower = src.toLowerCase();
      if (lower.includes("static.xx.fbcdn.net/rsrc.php")) return false;
      if (lower.includes("rsrc.php")) return false;
      if (lower.includes("/v/t1.30497-1/")) return false;
      if (lower.includes("_nc_sid=136b72")) return false;
      if (lower.includes("default") || lower.includes("silhouette")) return false;
      return /fbcdn\.net|fbsbx\.com|\.jpg|\.jpeg|\.png|\.webp/.test(lower);
    });
    return {
      hasAvatar: realImages.length > 0,
      reason: realImages.length ? "co anh dai dien that" : "khong thay anh dai dien that",
      imageCount: images.length,
      sample: (realImages[0] || images[0] || "").slice(0, 160)
    };
  }).catch((error) => ({ hasAvatar: false, reason: error?.message || "khong kiem tra duoc avatar" }));
}

async function clickProfilePictureArea(page) {
  const target = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 20 && rect.height > 20 && rect.top >= 120 && rect.top <= 850 && rect.left >= 0 && rect.left <= Math.min(900, window.innerWidth)
        && style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
    };
    window.scrollTo(0, 0);
    const nodes = Array.from(document.querySelectorAll("[aria-label], [role='button'], img, svg, div")).filter(visible);
    const buttonItems = nodes
      .map((node) => ({ node, rect: node.getBoundingClientRect(), label: String(node.getAttribute("aria-label") || node.textContent || "") }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
    const camera = buttonItems
      .filter((item) => /update profile picture|add profile picture|edit profile picture|camera/i.test(item.label))
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.node;
    const target = camera || buttonItems
      .filter((item) => /profile picture actions/i.test(item.label))
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.node || nodes
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter((item) => item.rect.width >= 70 && item.rect.height >= 70 && item.rect.width <= 280 && item.rect.height <= 280
        && item.rect.top >= 300 && item.rect.top <= 820 && item.rect.left >= 120 && item.rect.left <= 850
        && Math.abs(item.rect.width - item.rect.height) < Math.max(70, item.rect.width * 0.55))
      .sort((a, b) => a.rect.left - b.rect.left || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.node;
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus?.();
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const clicked = await mouseClickPoint(page, target).catch(() => false);
  await sleep(700);
  return clicked;
}

async function openProfilePictureMenu(page, logStep) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(500);
    const clicked = await clickProfilePictureArea(page);
    await sleep(900);
    const state = await menuProfilePictureState(page).catch(() => ({ hasSee: false, hasChoose: false, texts: [] }));
    logStep?.("menu avatar", `lan ${attempt}: clicked=${clicked}, see=${state.hasSee}, choose=${state.hasChoose}, texts=${JSON.stringify(state.texts || [])}`);
    if (state.hasSee || state.hasChoose) return state;
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 220)).catch(() => {});
    await sleep(400);
  }
  throw new Error("Khong mo duoc menu anh dai dien de thay Choose profile picture.");
}

async function waitForSaveEnabled(page, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await applyCompactAvatarDialog(page);
    const ready = await page.evaluate(() => {
      const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      return buttons.some((button) => {
        const text = normalize(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
        if (text !== "save") return false;
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const disabled = button.disabled || button.getAttribute("aria-disabled") === "true";
        return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none" && !disabled;
      });
    }).catch(() => false);
    if (ready) return true;
    await sleep(750);
  }
  return false;
}

async function uploadProfilePicture(page, imagePath) {
  const state = await openProfilePictureMenu(page);
  await applyCompactAvatarDialog(page);
  if (state.hasSee) return { alreadyHadAvatar: true };
  if (!state.hasChoose) throw new Error("Khong thay Choose profile picture trong menu avatar.");
  if (!await clickText(page, ["Choose profile picture"], { exact: true, delayMs: 900 })) {
    throw new Error("Khong bam duoc Choose profile picture.");
  }
  const [fileChooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 15000 }),
    clickText(page, ["Upload photo"], { exact: true, delayMs: 300 })
  ]);
  if (!fileChooser) throw new Error("Khong mo duoc hop thoai chon file anh.");
  await fileChooser.accept([imagePath]);
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => {});
  await applyCompactAvatarDialog(page);
  if (!await waitForSaveEnabled(page)) throw new Error("Anh upload xong nhung nut Save chua san sang.");
  await applyCompactAvatarDialog(page);
  if (!await clickText(page, ["Save"], { exact: true, delayMs: 1000 })) throw new Error("Khong bam duoc Save.");
  await sleep(10000);
  return { alreadyHadAvatar: false };
}

async function runAvatarFlow(manager, page, row, imagePool, logStep, workerSlot = 0, workerTotal = 1, replaceExisting = false) {
  await gotoWithRetry(manager, page, PROFILE_URL, row, 3);
  await applyStableViewport(page, workerSlot, workerTotal).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(2500);
  const avatarState = await detectExistingProfileAvatar(page);
  logStep?.("kiem tra avatar", `${avatarState.reason}, replaceExisting=${replaceExisting ? "bat" : "tat"}, imageCount=${avatarState.imageCount || 0}, sample=${avatarState.sample || ""}`);
  if (avatarState.hasAvatar && !replaceExisting) return { changed: false, detail: "da co anh dai dien, khong doi" };
  const currentMenu = await openProfilePictureMenu(page, logStep);
  if (currentMenu.hasSee && !replaceExisting) {
    await page.keyboard.press("Escape").catch(() => {});
    return { changed: false, detail: "da co anh dai dien, khong doi" };
  }
  await page.keyboard.press("Escape").catch(() => {});

  const tried = new Set();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const available = imagePool.filter((item) => !tried.has(item));
    const imagePath = randomItem(available.length ? available : imagePool);
    tried.add(imagePath);
    if (!imagePath) throw new Error("Khong co anh de upload.");
    try {
      logStep?.("upload avatar", `thu anh ${attempt}/3: ${imagePath}`);
      const result = await uploadProfilePicture(page, imagePath);
      if (result?.alreadyHadAvatar) return { changed: false, detail: "da co anh dai dien, khong doi" };
      return { changed: true, detail: "da doi anh dai dien", imagePath };
    } catch (error) {
      lastError = error;
      await gotoWithRetry(manager, page, PROFILE_URL, row, 2).catch(() => {});
      await applyStableViewport(page, workerSlot, workerTotal).catch(() => {});
      await sleep(1500);
    }
  }
  throw new Error(`Khong doi duoc anh dai dien sau 3 lan thu: ${lastError?.message || "loi khong ro"}`);
}

function mapAvatarError(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  const message = String(error?.message || error || "loi khong ro");
  if (status === "stopped") return { status: "stopped", detail: "Da dung han theo yeu cau." };
  const lower = message.toLowerCase();
  if (lower.includes("login") || lower.includes("logged out") || lower.includes("see more on facebook") || lower.includes("bi out")) {
    return { status: "biout", detail: message };
  }
  if (lower.includes("captcha") || lower.includes("checkpoint") || lower.includes("not a robot")) {
    return { status: "loicapcha", detail: message };
  }
  return { status: "loi", detail: message };
}

export function createAvatarTool({
  getManager,
  dangNhap,
  addRuntimeLog,
  buildToolRow,
  createSheetRowSession,
  stateProxy,
  runtime
}) {
  function log(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "doi avatar",
      step,
      detail
    });
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

  function expandSheetUpdate(update) {
    const next = { ...update };
    const pairs = [
      ["trangThai", "trạng thái"],
      ["chiTiet", "chi tiết"]
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

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot = 0, workerTotal = 1, imagePool = []) {
    const manager = getManager({ fresh: true });
    patchStableWindowTiling(manager, workerSlot, workerTotal);
    const row = buildToolRow(profileId, sheetRow);
    const uid = String(row.uid || profileId || "").trim();
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;

    try {
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

      browser = await step(profileId, job, "mo profile HideMyAcc", async () => manager.connectBrowser(profileId), { timeoutMs: 120000 });
      page = await step(profileId, job, "mo tab Facebook", async () => {
        const pages = await browser.pages().catch(() => []);
        const target = pages.find((item) => !item.isClosed?.()) || await browser.newPage();
        if (typeof manager.maximizeBrowserWindow === "function") await manager.maximizeBrowserWindow(browser, target).catch(() => {});
        const viewport = await applyStableViewport(target, workerSlot, workerTotal);
        log(profileId, "viewport", `worker ${workerSlot + 1}/${workerTotal} bounds=${viewport?.bounds?.width || ""}x${viewport?.bounds?.height || ""} viewport=${viewport?.width || ""}x${viewport?.height || ""}, zoom=1, actual=${JSON.stringify(viewport?.actual || {})}`);
        return target;
      });

      await step(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      }, { timeoutMs: 300000 });

      const result = await step(profileId, job, "doi anh dai dien", async () =>
        runAvatarFlow(manager, page, row, imagePool, (stepName, message) => log(profileId, stepName, message), workerSlot, workerTotal, Boolean(config.avatarReplaceExisting))
      , { timeoutMs: 240000 });

      const finalUpdate = {
        Tool: "đã đổi avatar",
        trangThai: "thành công",
        chiTiet: result.detail === "da co anh dai dien, khong doi" ? "đã có ảnh đại diện, không đổi" : "đã đổi ảnh đại diện"
      };
      await writeSheet(sheetSession, profileId, finalUpdate);
      if (job) {
        job.status = "success";
        job.liveStatus = finalUpdate.chiTiet;
        job.result = finalUpdate;
      }
      log(profileId, "ket thuc", finalUpdate.chiTiet, "success");
      return finalUpdate;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") {
        if (job) {
          job.status = "stopped";
          job.liveStatus = "da dung han, giu nguyen Sheet";
          job.result = null;
        }
        return { stopped: true };
      }
      const mapped = mapAvatarError(error);
      const finalUpdate = {
        Tool: "đổi avatar",
        trangThai: "loi",
        chiTiet: mapped.detail
      };
      await writeSheet(sheetSession, profileId, finalUpdate);
      if (job) {
        job.status = "error";
        job.liveStatus = mapped.detail;
        job.result = finalUpdate;
      }
      return finalUpdate;
    } finally {
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
    const imagePool = readImagePool(config.avatarImagePath);
    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampToolConcurrency(config.avatarConcurrency), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "doi avatar",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang doi avatar ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "doi avatar";
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
              const update = { Tool: "đổi avatar", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide." };
              if (job) {
                job.status = "error";
                job.liveStatus = update.chiTiet;
                job.finishedAt = new Date().toISOString();
                job.result = update;
              }
              await writeSheet(sheetSession, id, update);
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
              await runOne(id, row, config, sheetSession, workerSlot, concurrency, imagePool);
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
        addRuntimeLog(`Loi queue doi avatar: ${error.message}`, "error", "", {
          step: "queue doi avatar",
          tool: "doi avatar"
        });
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });
    return { started: ids.length, concurrency, imageCount: imagePool.length };
  }

  return { runQueue };
}

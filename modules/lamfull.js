import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildFullSuccessToken, buildStandardName } from "./profile_name.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const US_STATES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
  "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
  "wisconsin", "wyoming",
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
  "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
  "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
  "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy"
]);
const DEFAULT_US_LOCATION_LINES = [
  "San Francisco, California",
  "Reston, Virginia",
  "Albuquerque, New Mexico",
  "New York, New York",
  "Kansas City, Missouri"
];
const STABLE_FULL_CONCURRENCY = 4;
const US_LOCATION_FILE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, "$1")),
  "..",
  "data",
  "us_locations.txt"
);

function clampToolConcurrency(value, fallback = STABLE_FULL_CONCURRENCY) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
  return Math.max(1, Math.min(4, parsed));
}

function ensureUsLocationFile() {
  const dir = path.dirname(US_LOCATION_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(US_LOCATION_FILE_PATH)) {
    fs.writeFileSync(US_LOCATION_FILE_PATH, `${DEFAULT_US_LOCATION_LINES.join("\n")}\n`, "utf8");
  }
}

function loadUsLocationLines() {
  ensureUsLocationFile();
  const lines = fs.readFileSync(US_LOCATION_FILE_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : [...DEFAULT_US_LOCATION_LINES];
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function profileUid(row, profileId) {
  return String(row.uid || row.raw?.uid || profileId || "").trim();
}

function isUsLocation(locationText) {
  const normalized = String(locationText || "").trim().toLowerCase();
  if (!normalized || !normalized.includes(",")) return false;
  const parts = normalized.split(",");
  const statePart = parts[parts.length - 1].trim();
  if (US_STATES.has(statePart)) return true;
  for (const state of US_STATES) {
    if (state.length > 2 && statePart.includes(state)) return true;
  }
  return false;
}

function stableBarValue(currentName, sheetRow, nextBar = "") {
  const direct = String(nextBar || "").trim().toLowerCase();
  if (direct === "2v" || direct === "3v" || direct === "4v") return direct;
  const fromSheet = String(
    sheetRow?.["số vạch"] ||
    sheetRow?.soVach ||
    sheetRow?.["so vach"] ||
    ""
  ).trim().toLowerCase();
  if (fromSheet === "2v" || fromSheet === "3v" || fromSheet === "4v") return fromSheet;
  const fromName = String(currentName || "").match(/(?:^|-)(2v|3v|4v)(?=-|$)/i)?.[1] || "";
  return String(fromName || "").trim().toLowerCase();
}

function cleanProfileBase(name) {
  const original = String(name || "profile").trim();
  let base = original;
  const patterns = [
    /^k co Offer shipping(?:-3v)?-/i,
    /^loilogin-/i,
    /^loi(?:-[^-]+)?(?:-3v)?-/i,
    /^loi login-/i,
    /^loicapcha-/i,
    /^cp282-/i,
    /^cp956-/i,
    /^cp049-/i,
    /^loipb-/i,
    /^hetproxy-/i,
    /^die cho-/i,
    /^2v-/i,
    /^3v-/i,
    /^4v-/i,
    /^full\s+\d{1,2}\/\d{1,2}\s+\S+-/i
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = base.replace(pattern, "");
      if (next !== base) {
        base = next.trim();
        changed = true;
      }
    }
  }
  base = base.replace(/^-+/, "").replace(/-+$/, "").trim();
  if (!base || /^tool$/i.test(base)) {
    const restored = original
      .replace(/^k co Offer shipping(?:-3v)?-/i, "")
      .replace(/^loilogin-/i, "")
      .replace(/^loi login-/i, "")
      .replace(/^loi-/i, "")
      .replace(/^loicapcha-/i, "")
      .replace(/^cp282-/i, "")
      .replace(/^cp956-/i, "")
      .replace(/^cp049-/i, "")
      .replace(/^loipb-/i, "")
      .replace(/^hetproxy-/i, "")
      .replace(/^die cho-/i, "")
      .replace(/^2v-/i, "")
      .replace(/^3v-/i, "")
      .replace(/^4v-/i, "")
      .trim();
    if (restored && !/^tool$/i.test(restored)) {
      base = restored;
    }
  }
  if (!base || /^tool$/i.test(base)) {
    base = "profile";
  }
  return base.endsWith("-tool") ? base : `${base}-tool`;
}

function stripResolvedNamePrefixes(name) {
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
    /^biout-/i,
    /^k co Offer shipping(?:-3v)?-/i,
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
  next = next.replace(/^-+/, "").trim();
  return next || String(name || "").trim();
}

function mapFullError(error) {
  const status = String(error?.status || "").trim();
  const message = String(error?.message || error || "loi khong ro");
  if (status === "stopped") return { status: "stopped", detail: "Da dung han theo yeu cau." };
  if (status === "seller_info_invalid") return { status: "loi seller info", detail: message };
  if (status) return { status, detail: message };
  const lower = message.toLowerCase();
  if (lower.includes("cp282")) return { status: "cp282", detail: message };
  if (lower.includes("cp956")) return { status: "cp956", detail: message };
  if (lower.includes("bi out") || lower.includes("bị out") || lower.includes("logged out")) return { status: "biout", detail: message };
  if (lower.includes("recaptcha") || lower.includes("captcha") || lower.includes("i'm not a robot") || lower.includes("not a robot") || lower.includes("loicapcha")) return { status: "loicapcha", detail: message };
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
  ) return { status: "hetproxy", detail: message };
  if (lower.includes("ghosty") || lower.includes("browsertype") || lower.includes("browsersource")) return { status: "loipb", detail: message };
  if (lower.includes("offer shipping")) return { status: "k co Offer shipping", detail: message };
  if (lower.includes("marketplace isn't available") || lower.includes("pages can't use marketplace")) return { status: "die cho", detail: message };
  if (lower.includes("seller info") || lower.includes("seller information")) return { status: "loi seller info", detail: message };
  if (lower.includes("ssn") || lower.includes("tax")) return { status: "loi ssn", detail: message };
  if (lower.includes("bank")) return { status: "loi bank", detail: message };
  if (lower.includes("login") || lower.includes("dang nhap")) return { status: "loi login", detail: message };
  return { status: "loi", detail: message };
}

function buildRuntimeProfileName({ status = "", tenChuan = "" }) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const base = String(tenChuan || "").trim() || "profile-tool";
  if (!normalizedStatus || normalizedStatus === "thanh cong" || normalizedStatus === "thành công") return base;
  if (normalizedStatus === "loi") return `loi-${base}`;
  return `${normalizedStatus}-${base}`;
}

function extractLocationFromProfileName(name) {
  const text = String(name || "").trim();
  const match = text.match(/-([^-]+,\s*[^-]+)(?:-tool)?$/i);
  return String(match?.[1] || "").trim();
}

async function readLatestHideProfileName(manager, profileId, fallbackName = "") {
  const latestProfile = await manager.getProfileById(profileId).catch(() => null);
  return String(latestProfile?.name || fallbackName || profileId).trim();
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
      .find((element) => visible(element) && element.getBoundingClientRect().left < 420);
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

    const sidebar = heading.closest("div[role='navigation'], nav, div") || heading.parentElement;
    if (!sidebar) return "";
    const lines = Array.from(sidebar.querySelectorAll("a, [role='link'], span, div"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter((item) =>
        item.rect.left < 420 &&
        item.rect.top > heading.getBoundingClientRect().bottom - 5 &&
        item.text.includes(",") &&
        /within\s+\d+/i.test(item.text)
      )
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = lines[0];
    if (!chosen) return "";
    return normalize(chosen.text.split("·")[0] || chosen.text);
  });
}

async function clickMarketplaceSidebarLocation(page) {
  const directButton = await page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = Array.from(document.querySelectorAll("[role='button'][aria-label^='Location:']"))
      .find((element) => visible(element) && element.getBoundingClientRect().left < 420);
    if (!(target instanceof HTMLElement)) return null;
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + Math.min(rect.width * 0.5, rect.width - 8),
      y: rect.top + rect.height / 2
    };
  });
  if (directButton) {
    await page.mouse.move(directButton.x, directButton.y);
    await sleep(100);
    await page.mouse.click(directButton.x, directButton.y);
    return true;
  }
  const target = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const headings = Array.from(document.querySelectorAll("span, div, h1, h2, h3, h4"))
      .filter((element) => visible(element))
      .map((element) => ({ element, text: normalize(element.innerText || element.textContent || "") }))
      .filter((item) => /^location$/i.test(item.text));
    const heading = headings[0]?.element;
    if (!heading) return false;

    const sidebar = heading.closest("div[role='navigation'], nav, div") || heading.parentElement;
    if (!sidebar) return false;
    const lines = Array.from(sidebar.querySelectorAll("a, [role='link'], span, div"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter((item) =>
        item.rect.left < 420 &&
        item.rect.top > heading.getBoundingClientRect().bottom - 5 &&
        item.text.includes(",") &&
        /within\s+\d+/i.test(item.text)
      )
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const chosen = lines[0];
    if (!chosen) return null;
    const clickable = chosen.element.closest("a, button, [role='button'], [role='link']") || chosen.element.parentElement || chosen.element;
    const rect = (clickable instanceof HTMLElement ? clickable : chosen.element).getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + Math.min(rect.width * 0.6, rect.width - 8),
      y: rect.top + rect.height / 2
    };
  });
  if (!target) return false;
  await page.mouse.move(target.x, target.y);
  await sleep(100);
  await page.mouse.click(target.x, target.y);
  return true;
}

async function waitForChangeLocationDialog(page) {
  await page.waitForFunction(
    () => {
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
      return dialogs.some((dialog) => /change location/i.test(dialog.innerText || dialog.textContent || ""));
    },
    { timeout: 15000 }
  );
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
    const handle = await page.$(selector);
    if (handle) {
      const value = await handle.evaluate((element) => String(element.value || "").trim());
      if (value) return value;
    }
  }
  return "";
}

async function clickDialogApply(page) {
  return page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) =>
      /change location/i.test(item.innerText || item.textContent || "")
    );
    if (!(dialog instanceof HTMLElement)) return false;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) =>
      visible(element) && /apply/i.test(String(element.innerText || element.textContent || ""))
    );
    if (!(applyButton instanceof HTMLElement)) return false;
    const ariaDisabled = String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    const disabled = ariaDisabled || applyButton.matches?.(":disabled");
    if (disabled) return false;
    applyButton.click();
    return true;
  });
}

async function readMarketplaceCreateState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const bodyText = normalize(document.body?.innerText || "");
    const url = String(window.location.href || "");
    const title = String(document.title || "");
    const hasProgress = Array.from(document.querySelectorAll("[aria-label]")).some((element) =>
      /Progress,\s*currently on step\s*\d+\s*of\s*\d+/i.test(String(element.getAttribute("aria-label") || ""))
    );
    const hasActionButton = Array.from(document.querySelectorAll("button, [role='button'], span, div"))
      .some((element) => /^(Next|Publish|Continue)$/i.test(normalize(element.innerText || element.textContent || element.getAttribute("aria-label") || "")));
    const previewVisible = /(^|\s)Preview(\s|$)/i.test(bodyText);
    const placeholderCount = Array.from(document.querySelectorAll("*")).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 12) return false;
      const style = window.getComputedStyle(element);
      const bg = style.backgroundColor || "";
      const radius = style.borderRadius || "";
      return /rgb\(228,\s*230,\s*235\)|rgb\(240,\s*242,\s*245\)/i.test(bg) || /9999px|50%/.test(radius);
    }).length;
    return {
      url,
      title,
      bodyTextSample: bodyText.slice(0, 1200),
      hasProgress,
      hasActionButton,
      previewVisible,
      placeholderCount
    };
  }).catch(() => ({
    url: "",
    title: "",
    bodyTextSample: "",
    hasProgress: false,
    hasActionButton: false,
    previewVisible: false,
    placeholderCount: 0
  }));
}

function isMarketplaceCreateStuck(snapshot) {
  const url = String(snapshot?.url || "");
  if (!/facebook\.com\/marketplace\/create\/item/i.test(url)) return false;
  if (snapshot?.hasProgress || snapshot?.hasActionButton) return false;
  if (snapshot?.previewVisible && Number(snapshot?.placeholderCount || 0) >= 6) return true;
  const text = String(snapshot?.bodyTextSample || "");
  return /Preview/i.test(text) && !/Next|Publish|Continue|Delivery method|Title|Price/i.test(text);
}

async function ensureMarketplaceCreatePageReady(manager, page, row) {
  let lastSnapshot = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await manager.gotoWithRetry(page, "https://www.facebook.com/marketplace/create/item", row, 3);
    if (await manager.isLoggedOutMarketplace?.(page).catch(() => false)) {
      throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung khi vao Marketplace.`);
    }
    try {
      await Promise.race([
        Promise.resolve(manager.waitForMarketplaceUiStable?.(page)),
        sleep(25000).then(() => {
          const error = new Error("Marketplace create/item tai qua lau.");
          error.code = "MARKETPLACE_UI_TIMEOUT";
          throw error;
        })
      ]);
    } catch (error) {
      lastSnapshot = await readMarketplaceCreateState(page).catch(() => null);
      manager.sendLog?.(
        `[${row.uid}] Marketplace create/item dang treo lan ${attempt}/3, F5 lai trang.`,
        "warn"
      );
      if (attempt >= 3) break;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(1800);
      continue;
    }
    lastSnapshot = await readMarketplaceCreateState(page).catch(() => null);
    if (!isMarketplaceCreateStuck(lastSnapshot)) {
      return true;
    }
    manager.sendLog?.(
      `[${row.uid}] Marketplace create/item chi hien skeleton lan ${attempt}/3, dang F5 lai.`,
      "warn"
    );
    if (attempt >= 3) break;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    await sleep(1800);
  }
  const error = new Error("Marketplace create/item bi treo qua lau, da F5 3 lan van khong tai duoc.");
  error.status = "loi";
  error.detail = JSON.stringify(lastSnapshot || {});
  throw error;
}

async function typeDialogLocationAndPickFirstSuggestion(page, target) {
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
    locationInput = await page.$(selector);
    if (locationInput) break;
  }
  if (!locationInput) throw new Error("Khong tim thay o nhap dia chi trong dialog.");

  await locationInput.click({ clickCount: 3 });
  await sleep(150);
  await locationInput.press("Backspace").catch(() => {});
  await sleep(150);
  await locationInput.type(String(target || "").trim(), { delay: 50 });
  await sleep(1800);

  await page.keyboard.press("ArrowDown").catch(() => {});
  await sleep(250);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(1600);

  const applyReadyAfterKeyboard = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) =>
      /change location/i.test(item.innerText || item.textContent || "")
    );
    if (!(dialog instanceof HTMLElement)) return false;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) =>
      visible(element) && /apply/i.test(String(element.innerText || element.textContent || ""))
    );
    if (!(applyButton instanceof HTMLElement)) return false;
    const ariaDisabled = String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    const disabled = ariaDisabled || applyButton.matches?.(":disabled");
    return !disabled;
  });
  if (applyReadyAfterKeyboard) {
    return String(await readLocationFromDialog(page).catch(() => "") || "").trim() || String(target || "").trim();
  }

  const firstSuggestion = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) =>
      /change location/i.test(item.innerText || item.textContent || "")
    );
    if (!(dialog instanceof HTMLElement)) return null;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const input = dialog.querySelector("input[type='text'], input[type='search'], input[aria-label], input");
    const inputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : null;
    const radiusNode = Array.from(dialog.querySelectorAll("*"))
      .find((element) => visible(element) && /^radius$/i.test(String(element.textContent || "").replace(/\s+/g, " ").trim()));
    const lowerBound = inputRect ? inputRect.bottom + 6 : 0;
    const upperBound = radiusNode instanceof HTMLElement ? radiusNode.getBoundingClientRect().top - 6 : Number.POSITIVE_INFINITY;
    const candidates = Array.from(dialog.querySelectorAll("div, span, li, [role='option'], [role='listitem'], [role='button']"))
      .filter((element) => visible(element))
      .map((element) => {
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter((item) => {
        if (!item.text || item.text.length < 4) return false;
        if (item.rect.top <= lowerBound || item.rect.top >= upperBound) return false;
        if (item.rect.width < 220 || item.rect.height < 26) return false;
        if (/^change location$/i.test(item.text) || /^location$/i.test(item.text) || /^radius$/i.test(item.text)) return false;
        return true;
      })
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const first = candidates[0];
    if (!first) return null;
    return {
      text: first.text,
      leftX: first.rect.left + Math.min(48, Math.max(18, first.rect.width * 0.12)),
      centerX: first.rect.left + first.rect.width / 2,
      rightX: first.rect.right - Math.min(28, Math.max(18, first.rect.width * 0.08)),
      y: first.rect.top + first.rect.height / 2
    };
  });
  if (firstSuggestion?.y) {
    const clickPoints = [firstSuggestion.leftX, firstSuggestion.centerX, firstSuggestion.rightX]
      .filter((value) => Number.isFinite(value));
    for (const x of clickPoints) {
      await page.mouse.move(x, firstSuggestion.y);
      await sleep(120);
      await page.mouse.down().catch(() => {});
      await sleep(70);
      await page.mouse.up().catch(() => {});
      await sleep(1000);
      const applyReady = await page.evaluate(() => {
        const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) =>
          /change location/i.test(item.innerText || item.textContent || "")
        );
        if (!(dialog instanceof HTMLElement)) return false;
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) =>
          visible(element) && /apply/i.test(String(element.innerText || element.textContent || ""))
        );
        if (!(applyButton instanceof HTMLElement)) return false;
        const ariaDisabled = String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true";
        const disabled = ariaDisabled || applyButton.matches?.(":disabled");
        return !disabled;
      });
      if (applyReady) {
        return String(await readLocationFromDialog(page).catch(() => "") || "").trim() || String(firstSuggestion.text || "").trim() || String(target || "").trim();
      }
    }
  }
  const applyReadyAfterClick = await page.evaluate(() => {
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) =>
      /change location/i.test(item.innerText || item.textContent || "")
    );
    if (!(dialog instanceof HTMLElement)) return false;
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const applyButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((element) =>
      visible(element) && /apply/i.test(String(element.innerText || element.textContent || ""))
    );
    if (!(applyButton instanceof HTMLElement)) return false;
    const ariaDisabled = String(applyButton.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    const disabled = ariaDisabled || applyButton.matches?.(":disabled");
    return !disabled;
  });
  if (!applyReadyAfterClick) {
    throw new Error("Chua chon duoc goi y dia chi dau tien.");
  }
  return String(await readLocationFromDialog(page).catch(() => "") || "").trim() || String(firstSuggestion?.text || "").trim();
}

async function ensureUsMarketplaceLocation(manager, page, row) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await manager.gotoWithRetry(page, "https://www.facebook.com/marketplace/", row, 2);
      await sleep(2000);
      await manager.dismissCheckpointIfNeeded?.(page, row).catch(() => {});

      const sidebarLocation = String(await readMarketplaceSidebarLocation(page).catch(() => "") || "").trim();
      if (sidebarLocation) {
        manager.sendLog?.(`[${row.uid}] dia chi tren Marketplace: "${sidebarLocation}"`, "info");
      }
      if (sidebarLocation && isUsLocation(sidebarLocation)) {
        return { initialLocation: sidebarLocation, currentLocation: sidebarLocation };
      }

      const opened = await clickMarketplaceSidebarLocation(page);
      if (!opened) throw new Error("Khong bam duoc dong location tren Marketplace.");
      await waitForChangeLocationDialog(page);
      await sleep(1200);

      const initialLocation = String(await readLocationFromDialog(page).catch(() => "") || "").trim() || sidebarLocation;
      manager.sendLog?.(`[${row.uid}] dia chi ban dau trong dialog: "${initialLocation || "(trong)"}"`, "info");
      if (initialLocation && isUsLocation(initialLocation)) {
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(500);
        return { initialLocation, currentLocation: initialLocation };
      }

      const target = randomItem(loadUsLocationLines());
      manager.sendLog?.(`[${row.uid}] dia chi khong phai My, doi sang "${target}"`, "warn");
      const picked = await typeDialogLocationAndPickFirstSuggestion(page, target);
      if (picked) {
        manager.sendLog?.(`[${row.uid}] da chon goi y dau: "${picked}"`, "info");
      } else {
        manager.sendLog?.(`[${row.uid}] khong doc duoc text goi y dau, van tiep tuc theo "${target}"`, "warn");
      }

      let currentLocation = String(await readLocationFromDialog(page).catch(() => "") || "").trim();
      if (!currentLocation) {
        await sleep(1500);
        currentLocation = String(await readLocationFromDialog(page).catch(() => "") || "").trim();
      }
      if (!currentLocation) currentLocation = picked || target;
      manager.sendLog?.(`[${row.uid}] dia chi sau khi chon goi y: "${currentLocation || "(trong)"}"`, "info");

      const applied = await clickDialogApply(page);
      if (!applied) throw new Error("Khong bam duoc nut Apply.");
      await sleep(2500);

      return { initialLocation, currentLocation };
    } catch (error) {
      lastError = error;
      manager.sendLog?.(`[${row.uid}] doi location loi lan ${attempt}: ${error.message}`, "warn");
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(1200);
    }
  }
  throw lastError || new Error("Khong doi duoc location Marketplace.");
}

export function createLamFull({
  getManager,
  getLocationManager,
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
      tool: "lam full",
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
      const execution = Promise.resolve().then(action);
      const result = timeoutMs > 0
        ? await Promise.race([
          execution,
          new Promise((_, reject) => {
            const timer = setTimeout(() => {
              const error = new Error(`buoc "${name}" treo qua ${Math.round(timeoutMs / 1000)}s`);
              error.status = "loi";
              error.step = name;
              reject(error);
            }, timeoutMs);
            execution.finally(() => clearTimeout(timer)).catch(() => {});
          })
        ])
        : await execution;
      if (runtime.stopRequested && !options.allowFinishAfterStop) {
        const stopped = new Error("Da nhan lenh dung han, tool dung batch hien tai.");
        stopped.status = "stopped";
        stopped.step = name;
        throw stopped;
      }
      log(profileId, name, `xong: ${name} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      const raw = String(error?.message || error || "loi khong ro");
      const isTimeout = /timeout|timed out|waiting/i.test(raw);
      if (error && typeof error === "object") {
        error.step = error.step || name;
        error.message = `${isTimeout ? "Timeout" : "Loi"} o buoc "${name}": ${raw}`;
        log(profileId, name, error.message, "error", raw);
        throw error;
      }
      const wrapped = new Error(`${isTimeout ? "Timeout" : "Loi"} o buoc "${name}": ${raw}`);
      wrapped.step = name;
      log(profileId, name, wrapped.message, "error", raw);
      throw wrapped;
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
    for (const [internalKey, sheetKey] of pairs) {
      if (Object.prototype.hasOwnProperty.call(next, internalKey)) next[sheetKey] = next[internalKey];
      if (Object.prototype.hasOwnProperty.call(next, sheetKey)) next[internalKey] = next[sheetKey];
    }
    return next;
  }

  async function writeSheet(sheetSession, profileId, update) {
    await sheetSession.updateOne(profileId, expandSheetUpdate(update));
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

  function patchManager(manager, locationManager) {
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
        const cookies = await page.cookies("https://www.facebook.com");
        return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      };
    }
  }

  function patchInitialLocationCapture(manager, capture, fallbackName) {
    if (typeof manager.readMarketplaceInitialLocation !== "function") return () => {};
    const original = manager.readMarketplaceInitialLocation;
    manager.readMarketplaceInitialLocation = async function patchedReadMarketplaceInitialLocation(page, row) {
      if (capture.initial) {
        return capture.initial;
      }
      try {
        const value = await original.call(this, page, row);
        const normalized = String(value || "").trim();
        capture.initial = normalized;
        capture.current = normalized;
        return value;
      } catch (error) {
        const fallback = extractLocationFromProfileName(fallbackName);
        if (!fallback) throw error;
        capture.initial = fallback;
        capture.current = fallback;
        this.sendLog?.(`[${row.uid}] khong doc duoc dialog location, dung dia chi tu ten profile: ${fallback}`, "warn");
        return fallback;
      }
    };
    return () => {
      manager.readMarketplaceInitialLocation = original;
    };
  }

  function patchProgressCapture(manager, profileId, sheetSession, capture) {
    if (typeof manager.detectInitialMarketplaceState !== "function") return () => {};
    const original = manager.detectInitialMarketplaceState;
    manager.detectInitialMarketplaceState = async function patchedDetectInitialMarketplaceState(page) {
      const state = await original.call(this, page);
      if (state?.kind === "progress" && [2, 3].includes(Number(state.totalSteps))) {
        capture.value = `${Number(state.totalSteps)}v`;
        await writeSheet(sheetSession, profileId, {
          soVach: capture.value,
          chiTiet: `đã kiểm tra ${capture.value}`
        }).catch(() => {});
      }
      return state;
    };
    return () => {
      manager.detectInitialMarketplaceState = original;
    };
  }

  function buildLoggedOutError(context = "") {
    const error = new Error(context || "Nick bi out giua chung, tool da dung.");
    error.status = "biout";
    return error;
  }

  function patchManagerForCentralizedLogin(manager, row) {
    const originals = {
      ensureMarketplaceSession: manager.ensureMarketplaceSession,
      ensureMarketplaceReadyOrRelogin: manager.ensureMarketplaceReadyOrRelogin,
      waitForMarketplaceReady: manager.waitForMarketplaceReady,
      loginWithCookie: manager.loginWithCookie,
      loginWithAccount: manager.loginWithAccount
    };

    manager.ensureMarketplaceSession = async (page) => {
      if (page && !(await manager.isLoggedOutMarketplace?.(page).catch(() => true))) return;
      throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung khi vao Marketplace.`);
    };

    manager.ensureMarketplaceReadyOrRelogin = async (page) => {
      if (await manager.isLoggedOutMarketplace?.(page).catch(() => false)) {
        throw buildLoggedOutError(`[${row.uid}] Nick bi out giua chung trong luc chay lam full.`);
      }
    };

    manager.waitForMarketplaceReady = async (page, currentRow = null) => {
      await ensureMarketplaceCreatePageReady(manager, page, currentRow || row);
    };

    manager.loginWithCookie = async () => {
      throw buildLoggedOutError(`[${row.uid}] Marketplace yeu cau login lai bang cookie giua chung.`);
    };

    manager.loginWithAccount = async () => {
      throw buildLoggedOutError(`[${row.uid}] Marketplace yeu cau login lai bang tai khoan giua chung.`);
    };

    return () => {
      for (const [key, value] of Object.entries(originals)) {
        if (value) {
          manager[key] = value;
        } else {
          delete manager[key];
        }
      }
    };
  }

  async function runOldFullAttemptWithRetry(manager, page, browser, row, profileId, job) {
    if (job) job.liveStatus = "dang chay luong full goc";
    return manager.runFullFlowAttempt(page, browser, row, profileId);
  }

  async function runMarketplaceAndFullWithRetry(manager, page, browser, row, profileId, job, locationCapture, progressCapture, sheetSession, currentName, markNoRollback = () => {}, onSellerInfoInvalid = null) {
    let lastError = null;
    let genericFailures = 0;
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let restoreLocationCapture = () => {};
      let restoreProgressCapture = () => {};
      try {
        if (attempt > 1) {
          log(profileId, "retry full flow", `thu lai full flow lan ${attempt}/${maxAttempts} tu buoc Marketplace`, "warn");
        }
        const resolvedLocation = await step(profileId, job, "vao Marketplace va doi location", async () =>
          ensureUsMarketplaceLocation(manager, page, row)
        , { timeoutMs: 180000 });
        locationCapture.initial = String(resolvedLocation?.initialLocation || "").trim();
        locationCapture.current = String(resolvedLocation?.currentLocation || "").trim() || locationCapture.initial;
        if (locationCapture.initial) {
          await writeSheet(sheetSession, profileId, { diaChiBanDau: locationCapture.initial });
        }
        restoreLocationCapture = patchInitialLocationCapture(manager, locationCapture, currentName);
        restoreProgressCapture = patchProgressCapture(manager, profileId, sheetSession, progressCapture);
        markNoRollback();
        const outcome = await step(profileId, job, "luong full goc Shipping Full Studio", async () =>
          runOldFullAttemptWithRetry(manager, page, browser, row, profileId, job)
        , { timeoutMs: 480000, allowFinishAfterStop: true });
        restoreLocationCapture();
        restoreProgressCapture();
        return { resolvedLocation, outcome };
      } catch (error) {
        restoreLocationCapture();
        restoreProgressCapture();
        lastError = error;
        const mappedStatus = String(error?.status || "").trim().toLowerCase();
        if (mappedStatus === "seller_info_invalid") {
          if (typeof onSellerInfoInvalid !== "function" || attempt >= maxAttempts) throw error;
          await onSellerInfoInvalid(error, attempt);
          try {
            await page.bringToFront().catch(() => {});
            await page.goto("https://www.facebook.com/marketplace/create/item", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
            await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
            await sleep(1800);
          } catch {}
          continue;
        }
        if (mappedStatus && mappedStatus !== "loi" && mappedStatus !== "loi login") throw error;
        genericFailures += 1;
        if (genericFailures >= 3) break;
        try {
          await page.bringToFront().catch(() => {});
          await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
          await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
          await sleep(1500);
        } catch {}
      }
    }
    throw lastError || new Error("Khong the hoan tat full flow.");
  }

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot = 0, workerTotal = 1) {
    const manager = getManager({ fresh: true });
    const locationManager = getLocationManager({ fresh: true });
    patchManager(manager, locationManager);
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
    let currentName = String(sheetRow["tên profile hiện tại"] || sheetRow["ten profile hien tai"] || profileId).trim();
    let originalName = currentName;
    let barStatus = "";
    let sellerAllocation = null;
    let submittedSellerInfo = false;
    let noRollback = false;
    const locationCapture = { initial: "", current: "" };
    const progressCapture = { value: "" };
    let restoreLocationCapture = () => {};
    let restoreProgressCapture = () => {};
    let restoreManagerLoginGuards = () => {};

    try {
      job.status = "running";
      if (manager.activeJobs) manager.activeJobs.set(uid, { type: "full", pauseRequested: false, paused: false, resumed: false, stopRequested: false });
      manager.currentActiveUid = uid;
      manager.stopAllRequested = false;
      if (!runtime.activeManagers) runtime.activeManagers = new Map();
      runtime.activeManagers.set(profileId, { manager, uid, shouldFinish: () => noRollback || submittedSellerInfo });

      const profileInfo = await step(profileId, job, "kiem tra profile HideMyAcc", async () => manager.getProfileById(profileId), { timeoutMs: 30000 });
      currentName = String(profileInfo?.name || currentName || profileId).trim();
      originalName = currentName;
      const browserType = String(profileInfo?.browserType || "").trim().toLowerCase();
      const browserSource = String(profileInfo?.browserSource || "").trim().toLowerCase();
      if ((browserType && browserType !== "chrome") || browserSource === "ghosty") {
        const error = new Error(browserSource === "ghosty" ? "HideMyAcc profile browserSource=ghosty." : `HideMyAcc profile browserType=${browserType}.`);
        error.status = "loipb";
        throw error;
      }

      sellerAllocation = await step(profileId, job, "lay seller info", async () => allocateSellerInfoRow(config, uid), { timeoutMs: 30000 });
      row.raw = { ...row.raw, ...sellerAllocation.raw };
      await writeSheet(sheetWriter, profileId, { trangThai: "", chiTiet: "đang chạy làm full" });

      proxyLease = await step(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      , { timeoutMs: 120000 });

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

      currentName = await step(profileId, job, "quet ten profile Hide", async () =>
        readLatestHideProfileName(manager, profileId, currentName || profileId)
      , { timeoutMs: 30000 });

      restoreManagerLoginGuards = patchManagerForCentralizedLogin(manager, row);

      const cleanedNameAfterLogin = stripResolvedNamePrefixes(currentName);
      if (cleanedNameAfterLogin && cleanedNameAfterLogin !== currentName) {
        await step(profileId, job, "xoa prefix loi login cu", async () => {
          await rename(manager, profileId, cleanedNameAfterLogin);
          currentName = cleanedNameAfterLogin;
        }, { timeoutMs: 20000 });
      }

      const existingFullToken = buildStandardName({
        currentName,
        sheetRow,
        uid
      }).match(/(?:^|-)(full\s+\d{1,2}\/\d{1,2}\s+\d+)(?=-|$)/i)?.[1] || "";

      const flowResult = await runMarketplaceAndFullWithRetry(
        manager,
        page,
        browser,
        row,
        profileId,
        job,
        locationCapture,
        progressCapture,
        sheetWriter,
        currentName,
        () => { noRollback = true; },
        async (error, retryAttempt) => {
          const reason = String(error?.sellerInfoReason || "sai seller info").trim() || "sai seller info";
          if (sellerAllocation) {
            const oldRowNumber = sellerAllocation.rowNumber || "";
            await updateSellerInfoUid(config, sellerAllocation, reason);
            log(profileId, "seller info invalid", `seller info dong ${oldRowNumber} bi Facebook tu choi: ${reason}. Doi sang dong khac truoc khi retry lan ${retryAttempt + 1}.`, "warn");
          }
          sellerAllocation = await step(profileId, job, "lay seller info moi", async () => allocateSellerInfoRow(config, uid), { timeoutMs: 30000 });
          row.raw = { ...row.raw, ...sellerAllocation.raw };
          submittedSellerInfo = false;
          log(profileId, "seller info invalid", `da cap seller info moi dong ${sellerAllocation.rowNumber || ""} de lam lai tu Marketplace item`, "warn");
        }
      );
      const outcome = flowResult.outcome;

      barStatus = stableBarValue(currentName, sheetRow, String(outcome?.barStatus || progressCapture.value || "").trim());
      const status = String(outcome?.status || "").trim();
      const detail = String(outcome?.detail || "").trim();

      if (["2v", "4v"].includes(barStatus) || status === "loi 2v" || status === "loi 4v") {
        const checkedBar = barStatus === "4v" || status === "loi 4v" ? "4v" : "2v";
        const tenChuan = buildStandardName({
          currentName,
          sheetRow,
          uid,
          soVach: checkedBar,
          location: locationCapture.current || locationCapture.initial
        });
        await rename(manager, profileId, tenChuan);
        const update = { Tool: "đã làm full", trangThai: "thành công", soVach: checkedBar, chiTiet: `đã kiểm tra ${checkedBar}`, tenChuan };
        if (locationCapture.initial) update.diaChiBanDau = locationCapture.initial;
        await writeSheet(sheetWriter, profileId, update);
        await sheetWriter.commit();
        job.status = "success";
        job.result = update;
        if (sellerAllocation) await updateSellerInfoUid(config, sellerAllocation, "").catch(() => {});
        return update;
      }

      if (outcome?.ok) {
        submittedSellerInfo = true;
        await updateSellerInfoUid(config, sellerAllocation, uid);
        const fullToken = existingFullToken || buildFullSuccessToken(
          sellerAllocation?.raw?.SSN || sellerAllocation?.raw?.ssn || sellerAllocation?.raw?.Ssn || ""
        );
        const tenChuan = buildStandardName({
          currentName,
          sheetRow,
          uid,
          fullToken,
          soVach: stableBarValue(currentName, sheetRow, barStatus || "3v"),
          location: locationCapture.current || locationCapture.initial
        });
        await rename(manager, profileId, tenChuan);
        const update = { Tool: "đã làm full", trangThai: "thành công", soVach: barStatus || "3v", chiTiet: "đã bấm submit info thành công", tenChuan };
        if (locationCapture.initial) update.diaChiBanDau = locationCapture.initial;
        await writeSheet(sheetWriter, profileId, update);
        await sheetWriter.commit();
        job.status = "success";
        job.result = update;
        return update;
      }

      const mappedError = mapFullError({ status, message: detail || status || "loi" });
      const mappedStatus = mappedError.status || "loi";
      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid,
        fullToken: existingFullToken,
        soVach: stableBarValue(currentName, sheetRow, barStatus || progressCapture.value),
        location: locationCapture.current || locationCapture.initial
      });
      await rename(manager, profileId, buildRuntimeProfileName({ status: mappedStatus, tenChuan }));
      const update = { Tool: "đã làm full", trangThai: "loi", soVach: stableBarValue(currentName, sheetRow, barStatus), chiTiet: mappedError.detail || detail || mappedStatus, tenChuan };
      if (locationCapture.initial) update.diaChiBanDau = locationCapture.initial;
      await writeSheet(sheetWriter, profileId, update);
      await sheetWriter.commit();
      job.status = "error";
      job.liveStatus = update.chiTiet;
      job.result = update;
      if (sellerAllocation) await updateSellerInfoUid(config, sellerAllocation, "").catch(() => {});
      return update;
    } catch (error) {
      const mapped = mapFullError(error);
      if (sellerAllocation && !submittedSellerInfo) await updateSellerInfoUid(config, sellerAllocation, "").catch(() => {});
      if (mapped.status === "stopped") {
        sheetWriter.discard();
        if (!noRollback) await rename(manager, profileId, originalName).catch(() => {});
        job.status = "stopped";
        job.liveStatus = noRollback ? "da dung sau diem khong quay dau" : "da dung han, giu nguyen Sheet";
        job.result = null;
        return { stopped: true };
      }
      const tenChuan = buildStandardName({
        currentName,
        sheetRow,
        uid,
        soVach: stableBarValue(currentName, sheetRow, barStatus || progressCapture.value),
        location: locationCapture.current || locationCapture.initial
      });
      await rename(manager, profileId, buildRuntimeProfileName({ status: mapped.status, tenChuan }));
      const update = {
        Tool: "đã làm full",
        trangThai: "loi",
        soVach: stableBarValue(currentName, sheetRow, barStatus || progressCapture.value),
        chiTiet: mapped.detail,
        tenChuan
      };
      if (locationCapture.initial) update.diaChiBanDau = locationCapture.initial;
      await writeSheet(sheetWriter, profileId, update);
      await sheetWriter.commit();
      job.status = "error";
      job.liveStatus = mapped.detail;
      job.result = update;
      log(profileId, error.step || "loi tong", `loi lam full: ${mapped.detail}`, "error");
      return update;
    } finally {
      restoreLocationCapture();
      restoreProgressCapture();
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
      throw new Error("Ban can nhap thu muc dang bai va gia min/max truoc khi chay full.");
    }
    if (!config.sellerSpreadsheetId) {
      throw new Error("Ban can nhap Seller Info Spreadsheet ID truoc khi chay full.");
    }
    const sheetSession = await createSheetRowSession(config, ids);

    const concurrency = Math.min(clampToolConcurrency(config.fullConcurrency), ids.length);

    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "lam full",
        status: "queued",
        liveStatus: `dang cho chay ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang lam full ${concurrency} luong`);
    }

    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "lam full";
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
            const update = { Tool: "đã làm full", trangThai: "loi", chiTiet: "Khong tim thay dong du lieu trong Sheet theo id hide." };
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
        addRuntimeLog(`Loi queue lam full: ${error.message}`, "error", "", { step: "queue lam full", tool: "lam full" });
      } finally {
        runtime.running = false;
        runtime.stopRequested = false;
        runtime.currentTool = "";
      }
    });
    return { started: ids.length, concurrency };
  }

  function pauseCurrent() {
    const manager = getManager();
    return manager.pauseCurrentJob?.() || { ok: true, count: 0 };
  }

  function resumeCurrent() {
    const manager = getManager();
    return manager.resumeCurrentJob?.() || { ok: true, count: 0 };
  }

  return { runQueue, pauseCurrent, resumeCurrent };
}






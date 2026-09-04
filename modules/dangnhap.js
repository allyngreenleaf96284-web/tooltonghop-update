import crypto from "node:crypto";
import { withFacebookLocale } from "./facebook_locale.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00c4\u2018/gi, "d")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function getRawField(raw, aliases) {
  const entries = Object.entries(raw || {});
  for (const alias of aliases) {
    const expected = normalizeKey(alias);
    const match = entries.find(([key]) => normalizeKey(key) === expected);
    if (match && String(match[1] || "").trim()) return String(match[1]).trim();
  }
  return "";
}

function getAccountValue(row) {
  return String(row?.uid || getRawField(row?.raw, ["tai khoan", "uid", "username", "email"]) || "").trim();
}

function getPasswordValue(row) {
  return getRawField(row?.raw, ["mat khau", "password", "pass"]);
}

function getTwofaValue(row) {
  return getRawField(row?.raw, ["2fa", "otp", "totp", "ma 2fa"]);
}

function getCookieValue(row) {
  return getRawField(row?.raw, ["cookie", "cookies"]);
}

function parseCookieHeader(header) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
    })
    .filter(Boolean);
}

function decodeBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(secret || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, step = 30, digits = 6) {
  const key = decodeBase32(secret);
  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

export function createDangNhap({ addRuntimeLog }) {
  function logLogin(profileId, step, message, type = "info", detail = "") {
    addRuntimeLog(`[${profileId}] ${message}`, type, profileId, {
      tool: "dang nhap",
      step,
      detail
    });
  }

  async function loginStep(profileId, updateLiveStatus, step, message, action) {
    updateLiveStatus(message);
    logLogin(profileId, step, message);
    const startedAt = Date.now();
    try {
      const result = await action();
      logLogin(profileId, step, `xong: ${step} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      const rawMessage = String(error?.message || error || "loi khong ro");
      const isTimeout = /timeout|timed out|waiting/i.test(rawMessage);
      const isProxyFailure = /err_tunnel_connection_failed|err_proxy_connection_failed|err_timed_out|proxy connection failed|proxy_connection_failed|checking the proxy|took too long to respond|site can.?t be reached|het proxy/i.test(rawMessage);
      const prefix = isTimeout ? `Timeout o buoc "${step}"` : `Loi o buoc "${step}"`;
      if (error && typeof error === "object") {
        error.step = error.step || step;
        if (!error.status && isProxyFailure) error.status = "hetproxy";
        error.message = `${prefix}: ${rawMessage}`;
        logLogin(profileId, step, error.message, "error", rawMessage);
        throw error;
      }

      const wrapped = new Error(`${prefix}: ${rawMessage}`);
      wrapped.step = step;
      if (isProxyFailure) wrapped.status = "hetproxy";
      logLogin(profileId, step, wrapped.message, "error", rawMessage);
      throw wrapped;
    }
  }

  async function gotoWithFallback(_manager, page, url, _row, attempts = 2) {
    const targetUrl = withFacebookLocale(url);
    if (typeof _manager?.gotoWithRetry === "function") {
      await _manager.gotoWithRetry(page, targetUrl, _row, attempts);
      return;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector("body", { timeout: 12000 }).catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        await sleep(1200 * attempt);
      }
    }
    throw lastError || new Error(`Khong mo duoc ${targetUrl}`);
  }

  function mainProfileUid(row, profileId) {
    return String(row?.uid || row?.raw?.uid || row?.raw?.UID || profileId || "").replace(/[^\d]/g, "").trim();
  }

  function normalizeIdentityText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function mainProfileNameFromRow(row) {
    const uid = mainProfileUid(row, "");
    const rawName = String(
      row?.raw?.["tên profile hiện tại"] ||
      row?.raw?.["ten profile hien tai"] ||
      row?.raw?.["tên profile"] ||
      row?.raw?.["ten profile"] ||
      row?.raw?.name ||
      ""
    ).trim();
    if (uid && rawName.includes(uid)) {
      const tail = rawName.slice(rawName.indexOf(uid) + uid.length).replace(/^[-_\s]+/, "").trim();
      if (tail) return tail;
    }
    return rawName;
  }

  async function readProfilePhpContext(manager, page, row) {
    await gotoWithFallback(manager, page, "https://www.facebook.com/profile.php", row, 2);
    await page.waitForSelector("body", { timeout: 12000 }).catch(() => {});
    await sleep(1200);
    const url = page.url();
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {}
    const pathname = String(parsed?.pathname || url || "").toLowerCase().replace(/\/+$/, "");
    const isMainProfile = pathname.endsWith("/profile.php");
    return {
      isMainProfile,
      url,
      pathname,
      reason: isMainProfile ? "profile.php van la nick chinh" : `profile.php bi redirect sang ${url}`
    };
  }

  async function readMainProfileName(manager, page, row, profileId) {
    const uid = mainProfileUid(row, profileId);
    if (!uid) return "";
    await gotoWithFallback(manager, page, `https://www.facebook.com/profile.php?id=${uid}`, row, 2);
    await page.waitForSelector("body", { timeout: 12000 }).catch(() => {});
    await sleep(1200);
    return page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.top >= 80 && rect.top < 430 && style.display !== "none" && style.visibility !== "hidden";
      };
      return Array.from(document.querySelectorAll("h1, [role='main'] h1, strong, [dir='auto']"))
        .filter(visible)
        .map((el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
        .find((text) => text && text.length >= 2 && text.length <= 80 && !/friends|followers|photos|posts|about|settings/i.test(text)) || "";
    }).catch(() => "");
  }

  async function isAccountMenuOpen(page) {
    return page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 80 && rect.height > 80 && style.display !== "none" && style.visibility !== "hidden";
      };
      const profileDialog = document.querySelector("[role='dialog'][aria-label='Your profile']");
      if (profileDialog && visible(profileDialog)) return true;
      return Array.from(document.querySelectorAll("[role='dialog']"))
        .filter(visible)
        .some((dialog) => /see all profiles|settings & privacy|log out|meta business suite/i.test(String(dialog.innerText || dialog.textContent || "")));
    }).catch(() => false);
  }

  async function openAccountMenu(page) {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(250);
    const points = await page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 16 && rect.height > 16 && rect.top >= 0 && rect.top < 95 && rect.right > window.innerWidth - 230
          && style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
      };
      const center = (node, source) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, right: rect.right, source };
      };
      const smallTopButton = (node) => {
        if (!visible(node)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width <= 90 && rect.height <= 90;
      };
      const addUnique = (list, point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        if (list.some((item) => Math.abs(item.x - point.x) < 4 && Math.abs(item.y - point.y) < 4)) return;
        list.push(point);
      };

      const candidates = [];
      for (const node of Array.from(document.querySelectorAll("[aria-label='Your profile']"))) {
        const button = node.closest("[role='button'], button, a") || node;
        if (smallTopButton(button)) addUnique(candidates, center(button, "exact-your-profile"));
      }
      for (const node of Array.from(document.querySelectorAll("[aria-label*='profile' i]"))) {
        const button = node.closest("[role='button'], button, a") || node;
        if (smallTopButton(button)) addUnique(candidates, center(button, "aria-profile"));
      }

      const topRightButtons = Array.from(document.querySelectorAll("[role='button'], button, a, [aria-label]"))
        .filter(smallTopButton)
        .map((node) => ({ node, rect: node.getBoundingClientRect(), label: String(node.getAttribute("aria-label") || node.textContent || "") }))
        .sort((a, b) => b.rect.right - a.rect.right);
      for (const item of topRightButtons) {
        if (/your profile|account|profile/i.test(item.label)) addUnique(candidates, center(item.node, "top-profile"));
      }
      for (const item of topRightButtons.slice(0, 4)) {
        addUnique(candidates, center(item.node, "top-right"));
      }
      addUnique(candidates, { x: Math.max(20, window.innerWidth - 36), y: 28, right: window.innerWidth, source: "coordinate-fallback" });
      return candidates.map(({ x, y, source }) => ({ x, y, source }));
    }).catch(() => []);
    for (const point of points) {
      await page.mouse.click(point.x, point.y).catch(() => {});
      await sleep(850);
      if (await isAccountMenuOpen(page)) return true;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(180);
    }
    return false;
  }

  async function clickIdentityFromAccountMenu(page, { uid = "", name = "", excludeSlug = "" } = {}) {
    const wantedUid = String(uid || "").trim();
    const excludedKey = normalizeIdentityText(excludeSlug).replace(/[^a-z0-9]+/g, "");
    const wantedNames = [...new Set(
      String(name || "")
        .split(/\s*\|\s*/)
        .map((item) => normalizeIdentityText(item))
        .filter(Boolean)
    )];
    const findPoint = async () => page.evaluate(({ wantedUid, wantedNames, excludedKey }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const compact = (value) => normalize(value).replace(/[^a-z0-9]+/g, "");
      const dialog = document.querySelector("[role='dialog'][aria-label='Your profile']");
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 20 && rect.height > 20 && rect.left > window.innerWidth - 540 && rect.top >= 70 && rect.top < 560
          && style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
      };
      const scope = dialog || document;
      const roots = Array.from(scope.querySelectorAll("a[href], [role='button'], [role='listitem'], [tabindex='0'], div"))
        .filter(visible)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const href = String(node.getAttribute("href") || node.closest("a[href]")?.getAttribute("href") || "");
          const text = normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "");
          return { rect, href, text, area: rect.width * rect.height, role: node.getAttribute("role") || "" };
        })
        .filter((item) => item.area >= 900 && item.area <= 80000 && item.rect.height >= 32 && item.rect.height <= 90 && !/see all profiles|log out|settings|privacy|help|support|business suite/i.test(item.text))
        .filter((item) => !excludedKey || !compact(item.text).includes(excludedKey))
        .sort((a, b) => a.area - b.area || a.rect.top - b.rect.top);
      const byUid = wantedUid ? roots.find((item) => item.href.includes(wantedUid) || item.text.includes(wantedUid)) : null;
      const byName = wantedNames.length ? roots.find((item) => wantedNames.some((wantedName) => {
        if (item.text === wantedName) return true;
        if (wantedName.length <= 4) return item.text.split(/\s+/).includes(wantedName);
        return item.text.includes(wantedName);
      })) : null;
      const dialogRect = dialog?.getBoundingClientRect?.() || null;
      const identityFallback = roots
        .filter((item) => {
          if (!dialogRect) return false;
          if (item.rect.width < 240 || item.rect.height < 36 || item.rect.height > 72) return false;
          if (item.rect.top < dialogRect.top + 70 || item.rect.top > dialogRect.top + 250) return false;
          if (!item.text || item.text.includes(" ")) return Boolean(item.text);
          return item.text.length >= 2;
        })
        .sort((a, b) => a.rect.top - b.rect.top || a.area - b.area)[0];
      const target = byUid || byName || identityFallback;
      if (!target) return null;
      return { x: target.rect.left + Math.min(target.rect.width - 12, Math.max(32, target.rect.width * 0.18)), y: target.rect.top + target.rect.height / 2 };
    }, { wantedUid, wantedNames, excludedKey }).catch(() => null);

    let point = await findPoint();
    if (!point) {
      const seeAll = await page.evaluate(() => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && rect.left > window.innerWidth - 540 && style.display !== "none" && style.visibility !== "hidden";
        };
        const target = Array.from(document.querySelectorAll("a[href], [role='button'], [tabindex='0'], button, div"))
          .filter(visible)
          .map((node) => ({ rect: node.getBoundingClientRect(), text: normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || "") }))
          .find((item) => item.text.includes("see all profiles"));
        if (!target) return null;
        return { x: target.rect.left + target.rect.width / 2, y: target.rect.top + target.rect.height / 2 };
      }).catch(() => null);
      if (seeAll) {
        await page.mouse.click(seeAll.x, seeAll.y).catch(() => {});
        await sleep(900);
        point = await findPoint();
      }
    }
    if (!point) return false;
    await page.mouse.click(point.x, point.y).catch(() => {});
    await sleep(2500);
    return true;
  }

  async function ensureMainFacebookIdentity(manager, page, row, profileId, updateLiveStatus = () => {}) {
    const uid = mainProfileUid(row, profileId);
    if (!uid) return { ok: false, skipped: true, reason: "khong co uid nick chinh" };
    updateLiveStatus("dang kiem tra dang o nick chinh hay Page");
    const before = await readProfilePhpContext(manager, page, row);
    if (before.isMainProfile) {
      logLogin(profileId, "login: chuyen ve nick chinh", `dang o nick chinh: ${before.url}`, "success");
      return { ok: true, switched: false, alreadyMain: true, url: before.url };
    }

    updateLiveStatus("dang o Page, dang chuyen ve nick chinh");
    let mainName = mainProfileNameFromRow(row);
    if (!mainName) mainName = await readMainProfileName(manager, page, row, profileId);
    const menuOpened = await openAccountMenu(page);
    if (!menuOpened) {
      logLogin(profileId, "login: chuyen ve nick chinh", `dang o Page (${before.url}) nhung khong mo duoc menu tai khoan de chuyen ve nick chinh`, "warn");
      return { ok: false, switched: false, mainName, beforeUrl: before.url, reason: "khong mo duoc menu tai khoan" };
    }
    const excludeSlug = String(before.pathname || "").split("/").filter(Boolean)[0] || "";
    const switched = await clickIdentityFromAccountMenu(page, { uid, name: mainName, excludeSlug });
    if (switched) {
      const after = await readProfilePhpContext(manager, page, row).catch((error) => ({ isMainProfile: false, url: "", reason: error?.message || "khong verify duoc" }));
      if (after.isMainProfile) {
        logLogin(profileId, "login: chuyen ve nick chinh", `da chuyen ve nick chinh${mainName ? `: ${mainName}` : ""}`, "success", `${before.url} -> ${after.url}`);
        return { ok: true, switched: true, mainName, beforeUrl: before.url, afterUrl: after.url };
      }
      logLogin(profileId, "login: chuyen ve nick chinh", `da click identity nhung profile.php van chua ve nick chinh: ${after.url || after.reason}`, "warn");
      return { ok: false, switched: true, mainName, beforeUrl: before.url, afterUrl: after.url };
    }
    logLogin(profileId, "login: chuyen ve nick chinh", `dang o Page (${before.url}) nhung khong thay identity nick chinh trong menu${mainName ? `: ${mainName}` : ""}, tiep tuc`, "warn");
    return { ok: false, switched: false, mainName, beforeUrl: before.url };
  }

  async function hasActiveFacebookSession(page) {
    const cookies = await page.cookies("https://www.facebook.com").catch(() => []);
    return cookies.some((cookie) => cookie.name === "c_user" && String(cookie.value || "").trim());
  }

  async function buildCurrentFacebookCookieHeader(page) {
    const cookies = await page.cookies("https://www.facebook.com").catch(() => []);
    if (!cookies.length) return "";
    return cookies
      .filter((cookie) => String(cookie.name || "").trim() && String(cookie.value || "").trim())
      .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
      .trim();
  }

  async function clearFacebookCookiesOnly(page) {
    const cookies = await page.cookies().catch(() => []);
    const facebookCookies = cookies.filter((cookie) => /(^|\.)facebook\.com$/i.test(String(cookie.domain || "").trim()));
    if (!facebookCookies.length) return 0;
    await page.deleteCookie(...facebookCookies).catch(() => {});
    return facebookCookies.length;
  }

  async function suppressBrowserPrompts(page) {
    const client = await page.target().createCDPSession().catch(() => null);
    if (!client) return;
    try {
      await client.send("Browser.setPermission", {
        permission: { name: "notifications" },
        setting: "denied",
        origin: "https://www.facebook.com"
      }).catch(() => {});
      await client.send("Browser.setPermission", {
        permission: { name: "camera" },
        setting: "denied",
        origin: "https://www.facebook.com"
      }).catch(() => {});
      await client.send("Browser.setPermission", {
        permission: { name: "microphone" },
        setting: "denied",
        origin: "https://www.facebook.com"
      }).catch(() => {});
    } finally {
      await client.detach().catch(() => {});
    }
  }

  async function blockFacebookNotificationsInChrome(page) {
    const settingsUrl = "chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.facebook.com";
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("body", { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    await page.evaluate(() => {
      const allRoots = [];
      const queue = [document];
      while (queue.length) {
        const root = queue.shift();
        allRoots.push(root);
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
        for (const node of nodes) {
          if (node.shadowRoot) queue.push(node.shadowRoot);
        }
      }
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      for (const root of allRoots) {
        const gotIt = Array.from(root.querySelectorAll?.("button, cr-button, [role='button']") || [])
          .find((element) => visible(element) && /got it|ok, got it|understood/.test(textOf(element)));
        if (gotIt instanceof HTMLElement) {
          gotIt.click();
          break;
        }
      }
    }).catch(() => {});
    await sleep(800);
    const blocked = await page.evaluate(() => {
      const queue = [document];
      const roots = [];
      while (queue.length) {
        const root = queue.shift();
        roots.push(root);
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
        for (const node of nodes) {
          if (node.shadowRoot) queue.push(node.shadowRoot);
        }
      }
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const setDropdownValue = (host, wanted) => {
        const candidates = [];
        if (host instanceof HTMLElement) candidates.push(host);
        if (host?.shadowRoot) {
          candidates.push(...host.shadowRoot.querySelectorAll("select, option, [role='combobox'], [role='listbox'], cr-button, button"));
        }
        if (host?.querySelectorAll) {
          candidates.push(...host.querySelectorAll("select, option, [role='combobox'], [role='listbox'], cr-button, button"));
        }
        const select = candidates.find((node) => node instanceof HTMLSelectElement);
        if (select) {
          const option = Array.from(select.options).find((item) => /block/i.test(String(item.textContent || item.label || "")));
          if (option) {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            select.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }
        }
        const dropdownHost = candidates.find((node) => node instanceof HTMLElement && /ask|allow|block/.test(textOf(node)));
        if (dropdownHost instanceof HTMLElement) {
          dropdownHost.click();
          return "opened";
        }
        return false;
      };
      for (const root of roots) {
        const rows = Array.from(root.querySelectorAll?.("*") || []);
        for (const row of rows) {
          const label = textOf(row);
          if (!/\bnotifications\b/.test(label)) continue;
          const result = setDropdownValue(row, "block");
          if (result) return result;
        }
      }
      return false;
    }).catch(() => false);
    if (blocked === "opened") {
      await sleep(300);
      await page.keyboard.press("ArrowDown").catch(() => {});
      await sleep(120);
      await page.keyboard.press("ArrowDown").catch(() => {});
      await sleep(120);
      await page.keyboard.press("Enter").catch(() => {});
      await sleep(500);
    }
    const isBlocked = await page.evaluate(() => {
      const queue = [document];
      const roots = [];
      while (queue.length) {
        const root = queue.shift();
        roots.push(root);
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
        for (const node of nodes) if (node.shadowRoot) queue.push(node.shadowRoot);
      }
      const textOf = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      for (const root of roots) {
        const rows = Array.from(root.querySelectorAll?.("*") || []);
        for (const row of rows) {
          if (!/\bnotifications\b/.test(textOf(row))) continue;
          if (/\bblock\b/.test(textOf(row)) && !/\bask \(default\)\b/.test(textOf(row))) return true;
        }
      }
      return false;
    }).catch(() => false);
    if (!isBlocked) {
      throw new Error("Khong block duoc Notifications cho facebook.com trong Chrome settings.");
    }
  }

  async function handlePostLoginDismiss(_manager, page) {
    if (typeof _manager?.handlePostLoginDismiss === "function") {
      await _manager.handlePostLoginDismiss(page).catch(() => {});
    }
    if (typeof _manager?.suppressFacebookBrowserPrompts === "function") {
      await _manager.suppressFacebookBrowserPrompts(page).catch(() => {});
    }
    await suppressBrowserPrompts(page).catch(() => {});
    await page.evaluate(() => {
      try {
        window.Notification?.requestPermission && (window.Notification.requestPermission = async () => "denied");
      } catch {}
      try {
        if (navigator.credentials) {
          navigator.credentials.get = async () => null;
          navigator.credentials.store = async () => null;
          navigator.credentials.preventSilentAccess = async () => {};
          navigator.credentials.create = async () => null;
        }
      } catch {}
    }).catch(() => {});

    const labelPatterns = [
      /not now/i,
      /dismiss/i,
      /skip/i,
      /close/i,
      /cancel/i,
      /ok/i,
      /allow essential and optional cookies/i,
      /allow all cookies/i,
      /block/i,
      /don'?t allow/i,
      /khong bay gio/i,
      /bo qua/i,
      /dong/i
    ];
    for (let round = 0; round < 4; round += 1) {
      const clicked = await page.evaluate((patterns) => {
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, div[tabindex='0']"));
        const target = nodes.find((node) => {
          const element = node instanceof HTMLElement ? node : node?.parentElement;
          if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
          const text = String(element.innerText || element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          return patterns.some((pattern) => new RegExp(pattern, "i").test(text));
        });
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      }, labelPatterns.map((pattern) => pattern.source)).catch(() => false);
      if (!clicked) break;
      await sleep(900);
    }

    for (let round = 0; round < 3; round += 1) {
      const closePoint = await page.evaluate(() => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const dialogs = Array.from(document.querySelectorAll("[role='dialog'], div"))
          .filter((dialog) => dialog instanceof HTMLElement && isVisible(dialog))
          .map((dialog) => ({ dialog, text: normalize(dialog.innerText || dialog.textContent || "") }))
          .filter(({ text }) =>
            text.includes("what happened")
            || text.includes("you can no longer request a review")
            || text.includes("couldn't create multiple sessions")
            || text.includes("no longer request a review")
          );
        for (const entry of dialogs) {
          const dialogRect = entry.dialog.getBoundingClientRect();
          const closeCandidates = Array.from(entry.dialog.querySelectorAll("div[role='button'], button, [aria-label], svg, span"))
            .map((node) => (node instanceof HTMLElement ? node : node?.parentElement))
            .filter((node) => node instanceof HTMLElement && isVisible(node))
            .map((node) => {
              const rect = node.getBoundingClientRect();
              const label = normalize(node.getAttribute("aria-label") || node.innerText || node.textContent || "");
              return { node, rect, label };
            });
          const closeTarget = closeCandidates.find(({ rect, label }) => {
            const nearTopRight = rect.right >= dialogRect.right - 90 && rect.top <= dialogRect.top + 90;
            return nearTopRight || label === "close" || label === "đóng" || label === "x";
          });
          if (closeTarget) {
            return {
              x: Math.round(closeTarget.rect.left + (closeTarget.rect.width / 2)),
              y: Math.round(closeTarget.rect.top + (closeTarget.rect.height / 2))
            };
          }
          if (dialogRect.width > 120 && dialogRect.height > 120) {
            return {
              x: Math.round(dialogRect.right - 36),
              y: Math.round(dialogRect.top + 28)
            };
          }
        }
        return null;
      }).catch(() => null);
      const closed = Boolean(closePoint && Number.isFinite(closePoint.x) && Number.isFinite(closePoint.y));
      if (closed) {
        await page.mouse.click(closePoint.x, closePoint.y, { delay: 40 }).catch(() => {});
      }
      if (!closed) break;
      await sleep(900);
    }
  }

  async function detectCaptchaChallenge(page) {
    return page.evaluate(() => {
      const url = String(window.location.href || "").toLowerCase();
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ").toLowerCase();
      const hasRecaptchaFrame = Array.from(document.querySelectorAll("iframe[src], div, textarea"))
        .some((node) => {
          const text = `${node.getAttribute?.("src") || ""} ${node.getAttribute?.("title") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.innerText || ""}`.toLowerCase();
          return /recaptcha|i'm not a robot|i am not a robot/.test(text);
        });
      return (
        url.includes("/two_step_verification/authentication")
        && (
          body.includes("i'm not a robot")
          || body.includes("recaptcha")
          || body.includes("combat harmful conduct")
          || hasRecaptchaFrame
        )
      );
    }).catch(() => false);
  }

  async function throwIfCaptchaChallenge(page, step = "login: kiem tra captcha") {
    if (!(await detectCaptchaChallenge(page))) return;
    const error = new Error("Facebook yeu cau reCAPTCHA / I'm not a robot khi dang nhap.");
    error.status = "loicapcha";
    error.step = step;
    throw error;
  }

  async function getCheckpointStatus(page) {
    return page.evaluate(() => {
      try {
        const url = new URL(String(window.location.href || ""));
        const parts = url.pathname.split("/").filter(Boolean);
        const checkpointIndex = parts.findIndex((part) => String(part).toLowerCase() === "checkpoint");
        if (checkpointIndex < 0) return "";
        const ids = parts.slice(checkpointIndex + 1).filter(Boolean);
        const tail = String(ids[ids.length - 1] || "");
        if (/956$/.test(tail)) return "cp956";
        if (/282$/.test(tail)) return "cp282";
        return "checkpoint";
      } catch {
        return "";
      }
    }).catch(() => "");
  }

  async function throwIfCheckpointDetected(page) {
    const checkpointStatus = await getCheckpointStatus(page);
    if (!checkpointStatus) return;
    const error = new Error(
      checkpointStatus === "cp956"
        ? "Nick bi checkpoint cp956."
        : checkpointStatus === "cp282"
          ? "Nick bi checkpoint cp282."
          : "Nick dang o trang checkpoint."
    );
    error.status = checkpointStatus;
    throw error;
  }

  async function isLoggedOutFacebook(page) {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const url = String(window.location.href || "").toLowerCase();
      if (url.includes("/login") || url.includes("/recover")) return true;
      if (/continue as /i.test(bodyText) && /use another profile/i.test(bodyText)) return true;
      if (/email or phone number/i.test(bodyText) && /password/i.test(bodyText) && /log in/i.test(bodyText)) return true;
      return false;
    }).catch(() => false);
  }

  async function isStandardLoginFormVisible(page) {
    return page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const emailInput = Array.from(document.querySelectorAll("input")).some((input) => {
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) return false;
        const hint = normalize(`${input.name} ${input.placeholder} ${input.getAttribute("aria-label") || ""} ${input.autocomplete}`);
        return /email|phone|username/.test(hint);
      });
      const passwordInput = Array.from(document.querySelectorAll("input")).some((input) => {
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) return false;
        const hint = normalize(`${input.type} ${input.placeholder} ${input.getAttribute("aria-label") || ""} ${input.autocomplete}`);
        return /password/.test(hint) || input.type === "password" || input.autocomplete === "current-password";
      });
      const body = normalize(document.body?.innerText || "");
      return emailInput && passwordInput && /\blog in\b/.test(body);
    }).catch(() => false);
  }

  async function isProfileChooserState(page) {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const normalizedBody = bodyText.toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      if (/forgot password\?/i.test(bodyText) && /\blog in\b/i.test(bodyText) && /\bpassword\b/i.test(bodyText)) {
        return false;
      }
      const passwordLikeVisible = Array.from(document.querySelectorAll("input")).some((input) => {
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) return false;
        const rect = input.getBoundingClientRect();
        const hint = `${input.type || ""} ${input.placeholder || ""} ${input.getAttribute("aria-label") || ""} ${input.autocomplete || ""}`.toLowerCase();
        return (/password/.test(hint) || input.type === "password" || input.autocomplete === "current-password")
          && rect.width >= 220 && rect.height >= 30;
      });
      const loginButtonVisible = Array.from(document.querySelectorAll("button, [role='button'], div, span")).some((node) => {
        const el = node instanceof HTMLElement ? node : node?.parentElement;
        if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const text = String(el.innerText || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim().toLowerCase();
        return (text === "log in" || text === "login") && rect.width >= 180 && rect.height >= 30;
      });
      if (passwordLikeVisible || loginButtonVisible) return false;
      const visiblePasswordModal = Array.from(document.querySelectorAll("[role='dialog'], div"))
        .some((dialog) => {
          if (!(dialog instanceof HTMLElement)) return false;
          const rect = dialog.getBoundingClientRect();
          const style = window.getComputedStyle(dialog);
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") return false;
          return Boolean(dialog.querySelector("input[type='password'], input[placeholder='Password'], input[aria-label='Password']"));
        });
      if (visiblePasswordModal) return false;
      if (/use another profile/i.test(bodyText) && /continue as /i.test(bodyText)) return true;
      if (/use another profile/i.test(bodyText) && /create new account/i.test(bodyText) && /\bcontinue\b/i.test(bodyText)) return true;
      if (/use another profile/i.test(bodyText) && /\bcontinue\b/i.test(bodyText) && !/\bpassword\b/.test(normalizedBody)) return true;
      return Array.from(document.querySelectorAll("button, [role='button'], a, div"))
        .some((node) => {
          const text = String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          return (text === "continue" || text.startsWith("continue as ")) && /use another profile|create new account/i.test(bodyText);
        });
    }).catch(() => false);
  }

  async function isPasswordConfirmModalVisible(page) {
    return page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const chooserButtons = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
        .map((node) => node instanceof HTMLElement ? node : node?.parentElement)
        .filter(Boolean)
        .filter((element) => isVisible(element))
        .map((element) => normalize(element.innerText || element.textContent || ""))
        .filter(Boolean);
      if (chooserButtons.some((text) => text === "continue" || text.startsWith("continue as "))) {
        return false;
      }
      return Array.from(document.querySelectorAll("[role='dialog'], form, div"))
        .some((container) => {
          const element = container instanceof HTMLElement ? container : null;
          if (!element || !isVisible(element)) return false;
          const passwordInput = element.querySelector("input[type='password'], input[autocomplete='current-password'], input[placeholder='Password'], input[aria-label='Password']");
          if (!(passwordInput instanceof HTMLElement) || !isVisible(passwordInput)) return false;
          const text = normalize(element.innerText || element.textContent || "");
          return /password|continue|log in|login/.test(text);
        });
    }).catch(() => false);
  }

  async function passwordStepReady(page) {
    return isPasswordConfirmModalVisible(page);
  }

  async function isInvalidRequestPopupVisible(page) {
    return page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      return Array.from(document.querySelectorAll("[role='dialog'], div")).some((dialog) => {
        if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) return false;
        const text = String(dialog.innerText || dialog.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return /invalid request/.test(text) && /please try starting the flow from beginning|we could not validate your request/.test(text);
      });
    }).catch(() => false);
  }

  async function dismissInvalidRequestPopup(page) {
    const visible = await isInvalidRequestPopupVisible(page);
    if (!visible) return false;
    const clicked = await clickByText(page, ["OK"]).catch(() => false);
    if (!clicked) {
      await page.evaluate(() => {
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const target = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
          .find((node) => {
            const el = node instanceof HTMLElement ? node : node?.parentElement;
            if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
            const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return text === "ok";
          });
        if (target instanceof HTMLElement) target.click();
      }).catch(() => {});
    }
    await sleep(1800);
    return true;
  }

  async function waitForLoginSuccess(manager, page, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await handlePostLoginDismiss(manager, page);
      if (await hasActiveFacebookSession(page) && !(await isLoggedOutFacebook(page))) {
        return true;
      }
      const url = String(page.url() || "").toLowerCase();
      if (!url.includes("/login") && !url.includes("/recover") && await hasActiveFacebookSession(page)) {
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  async function waitAfterContinueForNextStep(manager, page, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await isInvalidRequestPopupVisible(page)) return "invalid_request";
      if (await isPasswordConfirmModalVisible(page) || await passwordStepReady(page)) return "password_modal";
      const stepResult = await waitForCredentialStepResult(manager, page, 1200).catch(() => "timeout");
      if (stepResult === "twofa" || stepResult === "checkpoint") return "twofa";
      if (stepResult === "logged_in") return "logged_in";
      if (await waitForLoginSuccess(manager, page, 1500).catch(() => false)) return "logged_in";
      if (!(await isPasswordConfirmModalVisible(page)) && !(await passwordStepReady(page)) && await isProfileChooserState(page)) return "continue";
      await sleep(350);
    }
    return "timeout";
  }

  async function waitForPasswordModalAfterContinue(manager, page, timeoutMs = 4500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await isInvalidRequestPopupVisible(page)) return "invalid_request";
      if (await isPasswordConfirmModalVisible(page) || await passwordStepReady(page)) return "password_modal";
      const stepResult = await waitForCredentialStepResult(manager, page, 900).catch(() => "timeout");
      if (stepResult === "twofa" || stepResult === "checkpoint") return "twofa";
      if (stepResult === "logged_in") return "logged_in";
      await sleep(220);
    }
    return "timeout";
  }

  async function typeIntoFirst(page, selectors, value, options = {}) {
    const delay = Number(options.delay || 95);
    const afterTypeSleep = Number(options.afterTypeSleep || 300);
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (!element) continue;
      await element.click({ clickCount: 3 }).catch(() => {});
      await element.press("Backspace").catch(() => {});
      await sleep(350);
      await element.type(value, { delay }).catch(() => {});
      await sleep(afterTypeSleep);
      return true;
    }
    return false;
  }

  async function clickFirstSelector(page, selectors) {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (!element) continue;
      try {
        await element.click({ delay: 30 });
        return true;
      } catch {}
      try {
        const clicked = await page.$eval(selector, (node) => {
          if (!(node instanceof HTMLElement)) return false;
          node.click();
          return true;
        });
        if (clicked) return true;
      } catch {}
    }
    return false;
  }

  async function clickByText(page, fragments) {
    const list = fragments.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
    const clicked = await page.evaluate((targets) => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const nodes = Array.from(document.querySelectorAll("button, [role='button'], a, div, span, label"));
      const target = nodes.find((node) => {
        const element = node instanceof HTMLElement ? node : node?.parentElement;
        if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
        const text = String(element.innerText || element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        return targets.some((item) => text === item || text.startsWith(item));
      });
      if (!(target instanceof HTMLElement)) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    }, list).catch(() => false);
    if (clicked) {
      await sleep(1200);
      return true;
    }
    return false;
  }

  async function clickProfileChooserContinue(page) {
    const target = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, div, span"))
        .map((node) => {
          const element = node instanceof HTMLElement ? node : node?.parentElement;
          if (!(element instanceof HTMLElement) || !isVisible(element)) return null;
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!(text === "continue" || text.startsWith("continue as "))) return null;
          const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, area: rect.width * rect.height };
        })
        .filter(Boolean)
        .sort((left, right) => right.area - left.area);
      return candidates[0] || null;
    }).catch(() => null);
    if (target && Number.isFinite(target.left)) {
      const x = Math.round(target.left + target.width / 2);
      const y = Math.round(target.top + target.height / 2);
      await page.mouse.move(x, y, { steps: 8 }).catch(() => {});
      await sleep(170);
      await page.mouse.down().catch(() => {});
      await sleep(80);
      await page.mouse.up().catch(() => {});
      await sleep(1200);
      return true;
    }
    return clickByText(page, ["Continue", "Continue as"]);
  }

  async function submitPasswordConfirmModal(page) {
    const target = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], div"));
      for (const dialog of dialogs) {
        if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) continue;
        const hasPassword = Array.from(dialog.querySelectorAll("input"))
          .some((input) => input instanceof HTMLInputElement
            && isVisible(input)
            && (
              input.type === "password"
              || /password/i.test(String(input.placeholder || ""))
              || /password/i.test(String(input.getAttribute("aria-label") || ""))
              || input.autocomplete === "current-password"
            ));
        if (!hasPassword) continue;
        const candidates = Array.from(dialog.querySelectorAll("button, [role='button'], input[type='submit'], div, span"))
          .map((node) => node instanceof HTMLElement ? node : node?.parentElement)
          .filter((node) => node instanceof HTMLElement && isVisible(node))
          .map((node) => {
            const text = String(node.innerText || node.textContent || node.getAttribute("value") || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (!/^(log in|login)$/.test(text)) return null;
            const rect = node.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              area: rect.width * rect.height,
              centerY: rect.top + rect.height / 2
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.area - a.area || b.centerY - a.centerY);
        if (candidates.length) return candidates[0];
      }
      return null;
    }).catch(() => null);
    if (target && Number.isFinite(target.left)) {
      const x = Math.round(target.left + target.width / 2);
      const y = Math.round(target.top + target.height / 2);
      await page.mouse.move(x, y, { steps: 8 }).catch(() => {});
      await sleep(180);
      await page.mouse.down().catch(() => {});
      await sleep(80);
      await page.mouse.up().catch(() => {});
      await sleep(1200);
      return true;
    }
    return page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], div"));
      for (const dialog of dialogs) {
        if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) continue;
        const hasPassword = dialog.querySelector("input[type='password'], input[placeholder='Password'], input[aria-label='Password']");
        if (!hasPassword) continue;
        const target = Array.from(dialog.querySelectorAll("button, [role='button'], input[type='submit'], div, span"))
          .map((node) => node instanceof HTMLElement ? node : node?.parentElement)
          .find((node) => {
            if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
            const text = String(node.innerText || node.textContent || node.getAttribute("value") || "").replace(/\s+/g, " ").trim().toLowerCase();
            return text === "log in" || text === "login";
          });
        if (target instanceof HTMLElement) {
          target.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
  }

  async function fillPasswordConfirmModal(page, password) {
    const ready = await page.waitForFunction(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      const hasAnyInput = Array.from(document.querySelectorAll("input")).some((input) => input instanceof HTMLInputElement && isVisible(input));
      const hasLogin = Array.from(document.querySelectorAll("button, [role='button'], div, span"))
        .some((node) => {
          const el = node instanceof HTMLElement ? node : node?.parentElement;
          if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
          const text = String(el.innerText || el.textContent || el.getAttribute("value") || "").replace(/\s+/g, " ").trim().toLowerCase();
          return text === "log in" || text === "login";
        });
      return hasAnyInput && hasLogin && (/password/.test(bodyText) || /forgot password\?/.test(bodyText));
    }, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!ready) return false;

    const clickedCandidate = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], div"))
        .filter((dialog) => dialog instanceof HTMLElement && isVisible(dialog))
        .map((dialog) => {
          const rect = dialog.getBoundingClientRect();
          const text = normalize(dialog.innerText || dialog.textContent || "");
          const score = rect.width * rect.height
            + (/forgot password/.test(text) ? 500000 : 0)
            + (/log in/.test(text) ? 500000 : 0)
            + (/password/.test(text) ? 400000 : 0);
          return { dialog, score };
        })
        .sort((a, b) => b.score - a.score);
      for (const entry of dialogs) {
        const inputs = Array.from(entry.dialog.querySelectorAll("input"))
          .filter((input) => input instanceof HTMLInputElement && isVisible(input))
          .map((input) => {
            const rect = input.getBoundingClientRect();
            const textHint = normalize(`${input.type || ""} ${input.placeholder || ""} ${input.getAttribute("aria-label") || ""} ${input.autocomplete || ""}`);
            const score = (textHint.includes("password") ? 1000 : 0)
              + (input.type === "password" ? 900 : 0)
              + (input.autocomplete === "current-password" ? 800 : 0)
              + rect.width * rect.height;
            return { input, score, rect };
          })
          .sort((a, b) => b.score - a.score);
        if (!inputs.length) continue;
        const best = inputs[0];
        best.input.focus();
        best.input.click();
        return {
          ok: true,
          x: Math.round(best.rect.left + best.rect.width / 2),
          y: Math.round(best.rect.top + best.rect.height / 2)
        };
      }
      return { ok: false };
    }).catch(() => ({ ok: false }));

    if (clickedCandidate?.ok && Number.isFinite(clickedCandidate.x)) {
      await page.mouse.move(clickedCandidate.x, clickedCandidate.y, { steps: 8 }).catch(() => {});
      await sleep(120);
      await page.mouse.down().catch(() => {});
      await sleep(60);
      await page.mouse.up().catch(() => {});
      await sleep(180);
    }

    const result = await page.evaluate((passwordValue) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const scoreInput = (input) => {
        if (!(input instanceof HTMLInputElement) || !isVisible(input)) return -1;
        const rect = input.getBoundingClientRect();
        const type = normalize(input.type || "");
        const autocomplete = normalize(input.autocomplete || "");
        const placeholder = normalize(input.placeholder || "");
        const aria = normalize(input.getAttribute("aria-label") || "");
        let score = 0;
        if (type === "password") score += 20;
        if (autocomplete === "current-password") score += 10;
        if (/password/.test(placeholder)) score += 8;
        if (/password/.test(aria)) score += 8;
        if (rect.width >= 220 && rect.height >= 30) score += 4;
        if (rect.left >= 300) score += 2;
        const parent = input.closest("[role='dialog'], div");
        if (parent instanceof HTMLElement) {
          const text = normalize(parent.innerText || parent.textContent || "");
          const parentAria = normalize(parent.getAttribute("aria-label") || "");
          if (/profile password entry/.test(parentAria)) score += 12;
          if (/forgot password/.test(text)) score += 10;
          if (/log in/.test(text)) score += 10;
        }
        return score;
      };
      const candidates = Array.from(document.querySelectorAll("input"))
        .map((input) => ({ input, score: scoreInput(input) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      if (!candidates.length) return { ok: false };
      const setterFor = (input) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      for (const { input } of candidates) {
        try {
          input.focus();
          input.click();
          const setter = setterFor(input);
          if (setter) setter.call(input, "");
          else input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          if (setter) setter.call(input, passwordValue);
          else input.value = passwordValue;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, data: passwordValue, inputType: "insertText" }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("blur", { bubbles: true }));
          if (String(input.value || "").length > 0) return { ok: true };
        } catch {}
      }
      return { ok: false };
    }, String(password || "")).catch(() => ({ ok: false }));

    if (result?.ok) return true;

    const fallbackInput = await page.$("input[type='password'], input[autocomplete='current-password'], input[placeholder='Password'], input[aria-label='Password'], div[role='dialog'] input");
    if (!fallbackInput) return false;
    await fallbackInput.click({ clickCount: 1, delay: 50 }).catch(() => {});
    await sleep(120);
    await page.keyboard.down("Control").catch(() => {});
    await page.keyboard.press("A").catch(() => {});
    await page.keyboard.up("Control").catch(() => {});
    await sleep(80);
    await page.keyboard.press("Backspace").catch(() => {});
    await sleep(100);
    await page.keyboard.type(String(password || ""), { delay: 35 }).catch(() => {});
    await sleep(250);
    return page.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) return false;
      return String(input.value || "").length > 0;
    }, fallbackInput).catch(() => false);
  }

  async function openFreshFacebookTabForRelogin(page) {
    const browser = page.browser();
    const freshPage = await browser.newPage();
    const currentViewport = page.viewport?.() || null;
    if (currentViewport?.width && currentViewport?.height) {
      await freshPage.setViewport(currentViewport).catch(() => {});
    }
    await freshPage.bringToFront().catch(() => {});
    await freshPage.goto(withFacebookLocale("https://www.facebook.com/"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await freshPage.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    await sleep(1000);
    try {
      if (!page.isClosed()) {
        await page.close({ runBeforeUnload: false }).catch(() => {});
      }
    } catch {}
    return freshPage;
  }

  async function waitForLoginSettled(manager, page, timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await handlePostLoginDismiss(manager, page);
      const url = String(page.url() || "").toLowerCase();
      const bodyText = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
      if (
        await hasActiveFacebookSession(page)
        || url.includes("/checkpoint/")
        || url.includes("two_step_verification")
        || /we suspect automated behavior on your account/i.test(bodyText)
      ) {
        return;
      }
      await sleep(700);
    }
  }

  async function findVisibleTwofaInput(page) {
    const handle = await page.evaluateHandle(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const preferred = Array.from(document.querySelectorAll("input")).find((element) => {
        if (!(element instanceof HTMLInputElement) || !isVisible(element)) return false;
        const placeholder = normalize(element.getAttribute("placeholder") || "");
        const aria = normalize(element.getAttribute("aria-label") || "");
        const label = normalize(element.labels?.[0]?.innerText || element.labels?.[0]?.textContent || "");
        const name = normalize(element.getAttribute("name") || "");
        const auto = normalize(element.getAttribute("autocomplete") || "");
        return /approvals_code|security_code/.test(name)
          || /one time code|one-time-code/.test(auto)
          || /code/.test(placeholder)
          || /code/.test(aria)
          || /code/.test(label);
      });
      if (preferred) return preferred;
      const bodyText = normalize(document.body?.innerText || "");
      if (/authentication app|two-factor|two factor|login code/.test(bodyText)) {
        return Array.from(document.querySelectorAll("input")).find((element) => {
          if (!(element instanceof HTMLInputElement) || !isVisible(element)) return false;
          const type = normalize(element.getAttribute("type") || "text");
          return ["text", "tel", "number", ""].includes(type);
        }) || null;
      }
      return null;
    });
    const asElement = handle.asElement();
    if (!asElement) {
      await handle.dispose().catch(() => {});
      return null;
    }
    return asElement;
  }

  async function chooseAuthenticationAppTwofa(page) {
    const onAnotherDeviceStep = await page.evaluate(() => {
      const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      return /check your notifications on another device/i.test(text)
        || (/waiting for approval/i.test(text) && /try another way/i.test(text));
    }).catch(() => false);
    if (!onAnotherDeviceStep) return false;

    const clickedTryAnotherWay = await clickByText(page, ["Try another way"]).catch(() => false);
    if (!clickedTryAnotherWay) return false;
    await sleep(1400);

    await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll("label, [role='radio'], [role='button'], button, div"));
      for (const node of candidates) {
        const element = node instanceof HTMLElement ? node : node?.parentElement;
        if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
        const text = normalize(element.innerText || element.textContent || "");
        if (!/authentication app/.test(text)) continue;
        const radio = element.querySelector("input[type='radio']") || element;
        if (radio instanceof HTMLElement) {
          radio.click();
          element.click();
          break;
        }
      }
    }).catch(() => {});

    await sleep(1000);
    const clickedContinue = await clickByText(page, ["Continue"]).catch(() => false);
    if (!clickedContinue) {
      await clickFirstSelector(page, ["button[type='submit']", "input[type='submit']"]).catch(() => false);
    }
    await sleep(2200);
    return true;
  }

  async function completeTwofaIfNeeded(manager, page, row) {
    const secret = getTwofaValue(row);
    if (!secret) return false;
    await sleep(2000);
    let input = await findVisibleTwofaInput(page);
    if (!input) {
      const switched = await chooseAuthenticationAppTwofa(page).catch(() => false);
      if (switched) {
        await page.waitForSelector("body", { timeout: 12000 }).catch(() => {});
        await sleep(1500);
        input = await findVisibleTwofaInput(page);
      }
    }
    if (!input) {
      throw new Error("Da vao man 2FA nhung khong tim thay o nhap ma.");
    }

    const otp = generateTotp(secret);
    await page.evaluate((otpValue) => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const bodyText = normalize(document.body?.innerText || "");
      const field = Array.from(document.querySelectorAll("input")).find((element) => {
        if (!(element instanceof HTMLInputElement) || !isVisible(element)) return false;
        const placeholder = normalize(element.getAttribute("placeholder") || "");
        const aria = normalize(element.getAttribute("aria-label") || "");
        const label = normalize(element.labels?.[0]?.innerText || element.labels?.[0]?.textContent || "");
        const name = normalize(element.getAttribute("name") || "");
        const auto = normalize(element.getAttribute("autocomplete") || "");
        return /approvals_code|security_code/.test(name)
          || /one time code|one-time-code/.test(auto)
          || /code/.test(placeholder)
          || /code/.test(aria)
          || /code/.test(label)
          || /authentication app|two-factor|two factor|login code/.test(bodyText);
      });
      if (!(field instanceof HTMLInputElement)) return false;
      field.focus();
      field.click();
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      if (setter) setter.call(field, otpValue);
      else field.value = otpValue;
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: otpValue, inputType: "insertText" }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }, otp).catch(() => {});

    const clicked = await clickFirstSelector(page, [
      "#checkpointSubmitButton",
      "button[type='submit']",
      "input[type='submit']",
      "div[role='button'][aria-label='Continue']",
      "div[role='button'][aria-label='Log in']"
    ]);
    if (!clicked) {
      await page.keyboard.press("Enter").catch(() => {});
    }
    await sleep(3000);
    await clickFirstSelector(page, ["#checkpointSubmitButton", "button[type='submit']", "input[type='submit']"]).catch(() => false);
    await sleep(2500);
    await waitForLoginSettled(manager, page, 15000).catch(() => {});
    await handlePostLoginDismiss(manager, page);
    return true;
  }

  async function waitForCredentialStepResult(manager, page, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (await hasActiveFacebookSession(page)) return "logged_in";
        const url = String(page.url() || "").toLowerCase();
        if (url.includes("two_step_verification") || url.includes("two-factor")) return "twofa";
        const hasTwofa = await findVisibleTwofaInput(page);
        if (hasTwofa) return "twofa";
        if (url.includes("checkpoint")) {
          const checkpointStatus = await getCheckpointStatus(page);
          if (checkpointStatus) return checkpointStatus;
          return "checkpoint";
        }
        if (await waitForLoginSuccess(manager, page, 1500).catch(() => false)) return "logged_in";
        if (!(await isPasswordConfirmModalVisible(page)) && await isProfileChooserState(page)) {
          return "continue";
        }
      } catch (error) {
        if (String(error?.message || "").toLowerCase().includes("execution context was destroyed")) {
          await sleep(1200);
          continue;
        }
        throw error;
      }
      await sleep(350);
    }
    return "timeout";
  }

  async function continueFromProfileChooser(manager, page, row) {
    try {
      const password = getPasswordValue(row);
      if (!password) throw new Error(`Nick ${row.uid} thieu mat khau de vuot man Continue.`);
      await gotoWithFallback(manager, page, "https://www.facebook.com/", row, 2);
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(1100);
      let waitingForPasswordAfterContinue = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await dismissInvalidRequestPopup(page)) {
          waitingForPasswordAfterContinue = false;
          page = await openFreshFacebookTabForRelogin(page);
          continue;
        }
        if (await waitForLoginSuccess(manager, page, 3500).catch(() => false)) return page;
        if (await isStandardLoginFormVisible(page)) throw new Error("STANDARD_LOGIN_FORM_VISIBLE");
        if (waitingForPasswordAfterContinue || await isPasswordConfirmModalVisible(page) || await passwordStepReady(page)) {
          const typedPass = await fillPasswordConfirmModal(page, password);
          if (!typedPass) {
            const followStep = await waitAfterContinueForNextStep(manager, page, 3500).catch(() => "timeout");
            if (followStep === "password_modal") {
              await sleep(700);
              continue;
            }
            if (followStep === "twofa") {
              await completeTwofaIfNeeded(manager, page, row);
              await sleep(2200);
              continue;
            }
            if (followStep === "logged_in") return page;
            if (followStep === "continue" || await isProfileChooserState(page)) {
              waitingForPasswordAfterContinue = false;
              await sleep(900);
              continue;
            }
            throw new Error("Khong tim thay o nhap mat khau sau nut Continue.");
          }
          waitingForPasswordAfterContinue = false;
          await sleep(320);
          const clickedLogin = await submitPasswordConfirmModal(page);
          if (!clickedLogin) {
            const passInput = await page.$("div[role='dialog'] input[type='password'], input[type='password']");
            await passInput?.press("Enter").catch(() => {});
          }
          await sleep(850);
          await waitForLoginSettled(manager, page, 12000).catch(() => {});
          const postPasswordStep = await waitAfterContinueForNextStep(manager, page, 9000);
          if (postPasswordStep === "invalid_request") {
            page = await openFreshFacebookTabForRelogin(page);
            continue;
          }
          if (postPasswordStep === "twofa") {
            await completeTwofaIfNeeded(manager, page, row);
            await sleep(2200);
            continue;
          }
          if (postPasswordStep === "logged_in") return page;
          page = await openFreshFacebookTabForRelogin(page);
          continue;
        }
        if (await isProfileChooserState(page)) {
          const clickedContinue = await clickProfileChooserContinue(page);
          if (!clickedContinue) throw new Error("Khong bam duoc nut Continue tren facebook.com.");
          waitingForPasswordAfterContinue = true;
          const nextStep = await waitForPasswordModalAfterContinue(manager, page, 5000);
          if (nextStep === "password_modal") continue;
          if (nextStep === "twofa") {
            await completeTwofaIfNeeded(manager, page, row);
            await sleep(2200);
            continue;
          }
          if (nextStep === "logged_in") return page;
          if (nextStep === "invalid_request") {
            page = await openFreshFacebookTabForRelogin(page);
            continue;
          }
          await sleep(1200);
          continue;
        }
        if (await isPasswordConfirmModalVisible(page) || await passwordStepReady(page)) {
          waitingForPasswordAfterContinue = true;
          continue;
        }
        const stepResult = await waitForCredentialStepResult(manager, page, 12000).catch(() => "timeout");
        if (stepResult === "twofa" || stepResult === "checkpoint") {
          await completeTwofaIfNeeded(manager, page, row);
          await sleep(2200);
          continue;
        }
        await handlePostLoginDismiss(manager, page);
        if (await waitForLoginSuccess(manager, page, 6000).catch(() => false)) return page;
        await sleep(900);
      }
      await handlePostLoginDismiss(manager, page);
      if (await waitForLoginSuccess(manager, page, 18000).catch(() => false)) return page;
      if (!(await hasActiveFacebookSession(page))) {
        throw new Error("Da xu ly Continue nhung session Facebook van chua on dinh.");
      }
      return page;
    } catch (error) {
      if (error && typeof error === "object" && !error.page) {
        error.page = page;
      }
      throw error;
    }
  }

  async function loginWithCookie(manager, page, row) {
    const cookieHeader = getCookieValue(row);
    if (!cookieHeader) throw new Error(`Nick ${row.uid} khong co cookie de fallback.`);
    await gotoWithFallback(manager, page, "https://www.facebook.com/", row, 2);
    await clearFacebookCookiesOnly(page).catch(() => {});
    const cookies = parseCookieHeader(cookieHeader).map((cookie) => ({ ...cookie, domain: ".facebook.com", path: "/" }));
    if (!cookies.length) throw new Error("Cookie fallback sai dinh dang.");
    await page.setCookie(...cookies);
    await gotoWithFallback(manager, page, "https://www.facebook.com/", row, 2);
    await sleep(2200);
    await throwIfCheckpointDetected(page);
    await throwIfCaptchaChallenge(page, "login: cookie");
    if (await hasActiveFacebookSession(page)) {
      await handlePostLoginDismiss(manager, page);
      return { ok: true, page };
    }
    if (await isProfileChooserState(page)) {
      return { ok: true, page };
    }
    throw new Error("Login bang cookie khong thanh cong tren facebook.com.");
  }

  async function loginWithAccount(manager, page, row) {
    const account = getAccountValue(row);
    const password = getPasswordValue(row);
    if (!account || !password) throw new Error(`Nick ${row.uid} thieu tai khoan hoac mat khau de dang nhap.`);
    await gotoWithFallback(manager, page, "https://www.facebook.com/", row, 2);
    await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    await sleep(1500);
    if (await isProfileChooserState(page)) {
      try {
        page = await continueFromProfileChooser(manager, page, row);
      } catch (error) {
        if (String(error?.message || "") !== "STANDARD_LOGIN_FORM_VISIBLE") throw error;
      }
      await handlePostLoginDismiss(manager, page);
      if (await waitForLoginSuccess(manager, page, 10000).catch(() => false)) return { ok: true, page };
    }

    const typedUser = await typeIntoFirst(
      page,
      [
        "#email",
        "input[name='email']",
        "input[autocomplete='username']",
        "input[placeholder='Email or mobile number']",
        "input[aria-label='Email or mobile number']",
        "input[placeholder='Email or phone number']",
        "input[aria-label='Email or phone number']",
        "input[type='text']"
      ],
      account,
      { delay: 90, afterTypeSleep: 450 }
    );
    const typedPass = await typeIntoFirst(
      page,
      [
        "#pass",
        "input[name='pass']",
        "input[autocomplete='current-password']",
        "div[role='dialog'] input[type='password']",
        "input[placeholder='Password']",
        "input[aria-label='Password']",
        "input[type='password']"
      ],
      password,
      { delay: 95, afterTypeSleep: 500 }
    );
    if (!typedUser || !typedPass) throw new Error("Khong tim thay form dang nhap Facebook de nhap tai khoan.");

    const passwordInput = await page.$("#pass, input[name='pass'], input[autocomplete='current-password'], input[type='password']");
    const clicked = await clickFirstSelector(page, [
      "button[name='login']",
      "button[type='submit']",
      "#loginbutton",
      "input[name='login']",
      "input[type='submit']",
      "div[role='button'][aria-label='Log in']",
      "div[role='button'][aria-label='Dang nhap']"
    ]);
    if (!clicked) {
      await passwordInput?.press("Enter").catch(() => {});
    }
    await sleep(3200);
    await throwIfCaptchaChallenge(page, "login: tai khoan mat khau");
    await throwIfCheckpointDetected(page);
    let stepResult = await waitForCredentialStepResult(manager, page, 12000);
    if (stepResult === "twofa" || stepResult === "checkpoint") {
      await completeTwofaIfNeeded(manager, page, row);
      await sleep(3200);
      stepResult = await waitForCredentialStepResult(manager, page, 12000);
    }
    if (stepResult === "cp956" || stepResult === "cp282") {
      const error = new Error(stepResult === "cp956" ? "Nick bi checkpoint cp956." : "Nick bi checkpoint cp282.");
      error.status = stepResult;
      throw error;
    }
    if (stepResult === "logged_in" || await waitForLoginSuccess(manager, page, 10000).catch(() => false)) {
      await handlePostLoginDismiss(manager, page);
      return { ok: true, page };
    }
    throw new Error("Dang nhap bang tai khoan khong thanh cong.");
  }

  async function ensureEnglishLanguageFallback(manager, page, row, profileId) {
    try {
      const hasRefreshConfirmDialog = async () => page.evaluate(() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
        if (dialogs.length >= 2) return true;
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        return dialogs.some((dialog) => {
          const text = normalize(dialog.innerText || dialog.textContent || "");
          const hasActionButtons = Array.from(dialog.querySelectorAll("button, [role='button']")).filter(visible).length >= 2;
          return hasActionButtons && /refresh|reload|lam moi trang|actualiser|rafraichir|changes saved|da luu|đã lưu|cap nhat|cập nhật/i.test(text);
        });
      }).catch(() => false);

      const clickLanguageRow = async () => {
        const rowTarget = await page.evaluate(() => {
          const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const buttons = Array.from(document.querySelectorAll("[role='button'], button, a[href], div[tabindex='0']"))
            .filter((el) => isVisible(el))
            .map((el) => ({
              text: normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || ""),
              rect: el.getBoundingClientRect()
            }))
            .filter((item) => item.rect.top >= 120 && item.rect.top <= 380 && item.rect.width > 350 && item.rect.height >= 35 && item.rect.height <= 220);
          const preferred = buttons.find((item) => item.text.includes("account language") || item.text.includes("ngon ngu cua tai khoan") || item.text.includes("ngôn ngữ của tài khoản"));
          const target = preferred || buttons.find((item) => /language|ngon ngu|idioma|langue/.test(item.text)) || buttons[0];
          if (!target) return null;
          return {
            x: target.rect.left + Math.min(80, Math.max(30, target.rect.width * 0.12)),
            y: target.rect.top + target.rect.height / 2
          };
        }).catch(() => null);
        if (!rowTarget?.x || !rowTarget?.y) return false;
        await page.mouse.move(rowTarget.x, rowTarget.y).catch(() => {});
        await sleep(120);
        await page.mouse.down().catch(() => {});
        await sleep(70);
        await page.mouse.up().catch(() => {});
        return true;
      };

      const chooseEnglishUs = async () => {
        const searchInput = await page.$("[role='dialog'] input[type='text'], [role='dialog'] input[type='search'], [role='dialog'] input[aria-label], [role='dialog'] input");
        if (!searchInput) return false;
        await searchInput.click({ clickCount: 3 }).catch(() => {});
        await searchInput.press("Backspace").catch(() => {});
        await searchInput.type("english (us)", { delay: 30 }).catch(() => {});
        await sleep(1200);

        for (let attempt = 0; attempt < 3; attempt += 1) {
          await page.keyboard.press("Tab").catch(() => {});
          await sleep(220);
          await page.keyboard.press("Enter").catch(() => {});
          await sleep(1400);
          if (await hasRefreshConfirmDialog()) return true;
        }

        await page.keyboard.press("ArrowDown").catch(() => {});
        await sleep(250);
        await page.keyboard.press("Enter").catch(() => {});
        await sleep(1200);
        if (await hasRefreshConfirmDialog()) return true;

        const optionTarget = await page.evaluate(() => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((item) => {
            const text = String(item.innerText || item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return /account language|ngon ngu cua tai khoan|ngôn ngữ của tài khoản/.test(text);
          });
          if (!(dialog instanceof HTMLElement)) return null;
          const input = dialog.querySelector("input[type='text'], input[type='search'], input[aria-label], input");
          const inputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : null;
          const rows = Array.from(dialog.querySelectorAll("div, span, label, [role='radio'], [role='button'], [tabindex], li"))
            .filter((el) => visible(el))
            .map((el) => {
              const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
              const rect = el.getBoundingClientRect();
              return { text, rect };
            })
            .filter((item) => {
              if (!/english\s*\(us\)/i.test(item.text)) return false;
              if (item.rect.width < 360 || item.rect.height < 28) return false;
              if (inputRect && item.rect.top <= inputRect.bottom + 6) return false;
              return true;
            })
            .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
          const first = rows[0];
          if (!first) return null;
          return {
            leftX: first.rect.left + Math.min(48, Math.max(18, first.rect.width * 0.12)),
            centerX: first.rect.left + first.rect.width / 2,
            radioX: first.rect.right - Math.min(28, Math.max(18, first.rect.width * 0.07)),
            y: first.rect.top + first.rect.height / 2
          };
        }).catch(() => null);
        if (!optionTarget?.y) return false;
        const points = [optionTarget.radioX, optionTarget.centerX, optionTarget.leftX].filter((value) => Number.isFinite(value));
        for (const x of points) {
          await page.mouse.move(x, optionTarget.y).catch(() => {});
          await sleep(120);
          await page.mouse.down().catch(() => {});
          await sleep(70);
          await page.mouse.up().catch(() => {});
          await sleep(1100);
          if (await hasRefreshConfirmDialog()) return true;
        }
        return false;
      };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await gotoWithFallback(manager, page, "https://www.facebook.com/settings/?tab=language", row, 2);
        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        await sleep(1500);
        if (await isFacebookLanguageReady(page)) {
          logLogin(profileId, "login: doi ngon ngu English", "Facebook da la English", "success");
          return true;
        }
        const rowClicked = await clickLanguageRow();
        if (!rowClicked) {
          logLogin(profileId, "login: doi ngon ngu English", "khong mo duoc man hinh chon ngon ngu", "warn");
          continue;
        }
        await sleep(1500);
        await page.waitForSelector("[role='dialog']", { timeout: 6000 }).catch(() => {});
        const selected = await chooseEnglishUs();
        if (!selected) {
          logLogin(profileId, "login: doi ngon ngu English", `lan ${attempt}: chua click duoc dong English (US)`, "warn");
          continue;
        }
        await sleep(800);
        await page.evaluate(() => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
          const latest = dialogs[dialogs.length - 1] || document.body;
          const buttons = Array.from(latest.querySelectorAll("button, [role='button'], input[type='submit']")).filter(visible);
          const okButton = buttons.find((el) => /^(ok|okay|d'accord|xac nhan|dong y|đồng ý|continue|tiep tuc|tiếp tục)$/.test(normalize(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "")));
          const fallback = okButton || buttons[buttons.length - 1];
          if (fallback instanceof HTMLElement) fallback.click();
        }).catch(() => {});
        await sleep(2500);
        await gotoWithFallback(manager, page, "https://www.facebook.com/settings/?tab=language", row, 2);
        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        await sleep(1500);
        if (await isFacebookLanguageReady(page)) {
          logLogin(profileId, "login: doi ngon ngu English", "da chon English va xac nhan lam moi trang", "success");
          return true;
        }
        logLogin(profileId, "login: doi ngon ngu English", `lan ${attempt}: da click nhung chua doi sang English`, "warn");
      }
      return false;
    } catch (error) {
      logLogin(profileId, "login: doi ngon ngu English", `loi khi doi ngon ngu: ${error.message}, bo qua`, "warn", error.message);
      return false;
    }
  }

  async function isFacebookLanguageReady(page) {
    return page.evaluate(() => {
      const body = (document.body?.innerText || "").toLowerCase();
      return /\baccount language\b/.test(body)
        || /\blanguage of the app\b/.test(body)
        || /\bfacebook language\b/.test(body);
    }).catch(() => false);
  }

  async function hasLanguageRefreshConfirmDialog(page) {
    return page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible);
      if (dialogs.length >= 2) return true;
      return dialogs.some((dialog) => {
        const text = normalize(dialog.innerText || dialog.textContent || "");
        const buttons = Array.from(dialog.querySelectorAll("button, [role='button']")).filter(visible);
        return buttons.length >= 2 && /refresh|reload|lam moi trang|actualiser|rafraichir|changes saved|da luu/i.test(text);
      });
    }).catch(() => false);
  }

  async function detectCurrentState(manager, page) {
    await throwIfCaptchaChallenge(page, "login: doc trang thai hien tai");
    return {
      hasSession: typeof manager?.hasActiveFacebookSession === "function"
        ? await manager.hasActiveFacebookSession(page).catch(() => false)
        : await hasActiveFacebookSession(page).catch(() => false),
      onLoginForm: typeof manager?.isStandardLoginFormVisible === "function"
        ? await manager.isStandardLoginFormVisible(page).catch(() => false)
        : await isStandardLoginFormVisible(page).catch(() => false),
      onContinue: typeof manager?.isProfileChooserState === "function"
        ? await manager.isProfileChooserState(page).catch(() => false)
        : await isProfileChooserState(page).catch(() => false),
      onPasswordModal: typeof manager?.isPasswordConfirmModalVisible === "function"
        ? await manager.isPasswordConfirmModalVisible(page).catch(() => false)
        : await isPasswordConfirmModalVisible(page).catch(() => false),
      credentialStep: typeof manager?.waitForCredentialStepResult === "function"
        ? await manager.waitForCredentialStepResult(page, 2000).catch(() => "timeout")
        : await waitForCredentialStepResult(manager, page, 2000).catch(() => "timeout"),
      checkpointStatus: typeof manager?.getCheckpointStatus === "function"
        ? await manager.getCheckpointStatus(page).catch(() => "")
        : await getCheckpointStatus(page).catch(() => "")
    };
  }

  async function ensureFacebookLogin(manager, page, row, profileId, updateLiveStatus) {
    await loginStep(profileId, updateLiveStatus, "login: block Notifications chrome", "dang block Notifications cho facebook.com", async () => {
      await blockFacebookNotificationsInChrome(page);
    });
    await loginStep(profileId, updateLiveStatus, "login: vao facebook.com", "dang vao facebook.com", async () => {
      await gotoWithFallback(manager, page, "https://www.facebook.com/", row, 3);
      await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await throwIfCaptchaChallenge(page, "login: vao facebook.com");
    });

    await loginStep(profileId, updateLiveStatus, "login: tat popup facebook", "dang tat popup Facebook", async () => {
      await handlePostLoginDismiss(manager, page);
    });

    const currentState = await loginStep(profileId, updateLiveStatus, "login: doc trang thai hien tai", "dang doc trang thai dang nhap", async () => {
      const state = await detectCurrentState(manager, page);
      if (state.checkpointStatus) {
        const error = new Error(`Checkpoint ${state.checkpointStatus} khi dang nhap.`);
        error.status = state.checkpointStatus === "cp282" || state.checkpointStatus === "cp956" ? state.checkpointStatus : "loi";
        throw error;
      }
      return state;
    });

    let loginSource = "login";
    if (currentState.hasSession && !currentState.onLoginForm && !currentState.onContinue && !currentState.onPasswordModal && currentState.credentialStep !== "twofa") {
      updateLiveStatus("dang nhap Facebook da co san");
      logLogin(profileId, "login: session co san", "dang nhap Facebook da co san", "success");
      loginSource = "session";
    } else {
      try {
        await loginStep(profileId, updateLiveStatus, "login: cookie", "dang login bang cookie", async () => {
          const result = typeof manager?.loginWithCookie === "function"
            ? await manager.loginWithCookie(page, row)
            : await loginWithCookie(manager, page, row);
          page = result.page || page;
        });

        const needsContinue = await loginStep(profileId, updateLiveStatus, "login: kiem tra continue sau cookie", "dang kiem tra Continue/2FA sau cookie", async () => {
          const state = await detectCurrentState(manager, page);
          return state.onContinue || state.onPasswordModal || state.credentialStep === "twofa";
        });

        if (needsContinue) {
          page = await loginStep(profileId, updateLiveStatus, "login: xu ly continue sau cookie", "dang xu ly Continue/2FA sau cookie", async () => {
            const nextPage = typeof manager?.continueFromProfileChooser === "function"
              ? await manager.continueFromProfileChooser(page, row)
              : await continueFromProfileChooser(manager, page, row);
            await handlePostLoginDismiss(manager, nextPage);
            await throwIfCaptchaChallenge(nextPage, "login: xu ly continue sau cookie");
            return nextPage;
          });
        }
        loginSource = "cookie";
      } catch (cookieError) {
        if (cookieError?.page && typeof cookieError.page.isClosed === "function" && !cookieError.page.isClosed()) {
          page = cookieError.page;
        }
        if (["cp282", "cp956", "loicapcha"].includes(String(cookieError?.status || "").trim())) throw cookieError;
        logLogin(profileId, "login: cookie", `login cookie loi: ${cookieError.message}. Chuyen sang tai khoan/mat khau.`, "warn", cookieError.message);
        await loginStep(profileId, updateLiveStatus, "login: tai khoan mat khau", "dang login bang tai khoan/mat khau", async () => {
          const result = typeof manager?.loginWithAccount === "function"
            ? await manager.loginWithAccount(page, row)
            : await loginWithAccount(manager, page, row);
          page = result.page || page;
          await handlePostLoginDismiss(manager, page);
          await throwIfCaptchaChallenge(page, "login: tai khoan mat khau");
        });
        loginSource = "account";
      }
    }

    const loggedIn = await loginStep(profileId, updateLiveStatus, "login: xac nhan c_user", "dang xac nhan session c_user", async () => {
      await throwIfCaptchaChallenge(page, "login: xac nhan c_user");
      await throwIfCheckpointDetected(page);
      return hasActiveFacebookSession(page).catch(() => false);
    });
    if (!loggedIn) {
      throw new Error("Da thu dang nhap nhung facebook.com chua co session c_user.");
    }

    const cookieHeader = await loginStep(profileId, updateLiveStatus, "login: lay cookie moi", "dang lay cookie moi", async () => {
      if (typeof manager?.buildCurrentFacebookCookieHeader === "function") {
        return manager.buildCurrentFacebookCookieHeader(page).catch(() => "");
      }
      return buildCurrentFacebookCookieHeader(page).catch(() => "");
    });
    await loginStep(profileId, updateLiveStatus, "login: chuyen ve nick chinh", "dang dam bao dang dung nick chinh", async () => {
      const identity = await ensureMainFacebookIdentity(manager, page, row, profileId, updateLiveStatus);
      if (!identity.ok && !identity.skipped) {
        const error = new Error(`Facebook dang o Page context nhung khong chuyen ve duoc nick chinh: ${identity.beforeUrl || identity.reason || ""}`);
        error.status = "loi login";
        throw error;
      }
    });
    await loginStep(profileId, updateLiveStatus, "login: doi ngon ngu English", "dang kiem tra ngon ngu Facebook", async () => {
      const ok = await ensureEnglishLanguageFallback(manager, page, row, profileId);
      if (!ok) {
        const error = new Error("Khong doi duoc Facebook sang English (US).");
        error.status = "loi login";
        throw error;
      }
    });
    updateLiveStatus("dang nhap Facebook thanh cong");
    logLogin(profileId, "login: thanh cong", "dang nhap Facebook thanh cong", "success");
    return { ok: true, source: loginSource, cookieHeader, page };
  }

  return { ensureFacebookLogin, ensureMainFacebookIdentity };
}

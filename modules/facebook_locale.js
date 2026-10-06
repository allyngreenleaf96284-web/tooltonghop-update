import { buildMarketplaceIneligibleName } from "./profile_name.js";

const FACEBOOK_LOCALE = "en_US";

export function isFacebookCaptchaError(error) {
  const status = String(error?.status || "").trim().toLowerCase();
  if (["stopped", "die cho", "cp282", "cp956"].includes(status) || error?.code === "MARKETPLACE_INELIGIBLE") return false;
  return error?.code === "LOGIN_CAPTCHA" || ["capcha", "loicapcha"].includes(status)
    || /captcha|capcha|not a robot/i.test(String(error?.message || error || ""));
}

export function isMarketplaceIneligibleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /(^|\.)facebook\.com$/i.test(url.hostname) && /^\/marketplace\/ineligible(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isMarketplaceIneligibleError(error) {
  return error?.code === "MARKETPLACE_INELIGIBLE"
    || String(error?.status || "").trim().toLowerCase() === "die cho"
    || /die cho|marketplace\/ineligible|marketplace (?:isn['\u2019]t|is not) available|pages can['\u2019]t use marketplace|marketplace chet cho/i.test(String(error?.message || error || ""));
}

export function readMarketplaceIneligibleBanner() {
  const text = String(document.body?.innerText || "").replace(/\u2019/g, "'").replace(/\s+/g, " ");
  return /marketplace (?:isn't|is not) available to you/i.test(text)
    && /age and eligibility|not available in your country|joined facebook/i.test(text);
}

function marketplaceIneligibleError(url) {
  const error = new Error(`die cho: Marketplace isn't available to you (${url}).`);
  error.status = "die cho";
  error.code = "MARKETPLACE_INELIGIBLE";
  error.retryable = false;
  return error;
}

export function installMarketplaceAccessGuard(manager, page, profileId, fallbackName = "", onIneligible = () => {}) {
  const browser = page.browser();
  if (browser.__marketplaceAccess) {
    browser.__marketplaceAccess.attach(page);
    return browser.__marketplaceAccess;
  }
  if (!(manager.__marketplaceBlockedNames instanceof Map)) manager.__marketplaceBlockedNames = new Map();
  manager.__marketplaceBlockedNames.delete(String(profileId));
  if (!manager.__marketplaceRenamePatched && typeof manager.updateProfileName === "function") {
    const update = manager.updateProfileName;
    manager.updateProfileName = function updateWithMarketplaceStatus(id, name, ...args) {
      const marked = this.__marketplaceBlockedNames?.get(String(id));
      return update.call(this, id, marked || name, ...args);
    };
    manager.__marketplaceRenamePatched = true;
  }
  const state = { error: null, notification: null, attach: null, pending: new Set() };
  const mark = (url) => {
    if (state.error) return;
    state.error = marketplaceIneligibleError(url);
    state.notification = (async () => {
      onIneligible(state.error);
      const name = typeof manager.getProfileNameById === "function"
        ? await manager.getProfileNameById(profileId).catch(() => "")
        : await manager.getProfileById?.(profileId).then((profile) => profile?.name || "").catch(() => "");
      const markedName = buildMarketplaceIneligibleName(name || fallbackName || profileId);
      state.profileName = markedName;
      manager.__marketplaceBlockedNames.set(String(profileId), markedName);
      await manager.updateProfileName(profileId, markedName);
    })().catch((error) => {
      manager.sendLog?.(`[${profileId}] die cho: khong ghi duoc ten profile: ${error.message}`, "error");
    });
    for (const reject of state.pending) reject(state.error);
  };
  const rejectBlocked = async () => {
    if (!state.error) return;
    let timer;
    try {
      await Promise.race([state.notification, new Promise((resolve) => { timer = setTimeout(resolve, 15000); })]);
    } finally {
      clearTimeout(timer);
    }
    throw state.error;
  };
  state.attach = (target) => {
    if (!target || target.__marketplaceAccess) return;
    target.__marketplaceAccess = state;
    const evaluate = target.evaluate.bind(target);
    const inspect = async () => {
      const url = String(target.url() || "");
      if (isMarketplaceIneligibleUrl(url)) mark(url);
      if (!state.error) {
        let marketplace = false;
        try {
          const parsed = new URL(url);
          marketplace = /(^|\.)facebook\.com$/i.test(parsed.hostname) && /^\/marketplace(?:\/|$)/i.test(parsed.pathname);
        } catch {}
        if (marketplace && await evaluate(readMarketplaceIneligibleBanner).catch(() => false)) mark(url);
      }
      await rejectBlocked();
    };
    target.__assertMarketplaceAccess = inspect;
    for (const method of ["goto", "reload", "evaluate", "evaluateHandle", "waitForSelector", "waitForFunction", "$", "$$", "$eval", "$$eval"]) {
      if (typeof target[method] !== "function") continue;
      const original = target[method].bind(target);
      target[method] = async (...args) => {
        await inspect();
        let rejectAccess;
        const blocked = new Promise((_, reject) => { rejectAccess = reject; });
        state.pending.add(rejectAccess);
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => original(...args)),
            blocked
          ]);
          await inspect();
          return result;
        } catch (error) {
          await inspect();
          throw error;
        } finally {
          state.pending.delete(rejectAccess);
        }
      };
    }
    target.on?.("framenavigated", (frame) => {
      if (frame === target.mainFrame() && isMarketplaceIneligibleUrl(frame.url())) mark(frame.url());
    });
    target.on?.("domcontentloaded", () => { void inspect().catch(() => {}); });
  };
  browser.__marketplaceAccess = state;
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    await rejectBlocked();
    const target = await newPage(...args);
    state.attach(target);
    return target;
  };
  state.attach(page);
  return state;
}

export async function assertMarketplaceAccess(page) {
  if (page?.__assertMarketplaceAccess) await page.__assertMarketplaceAccess();
}

export function withFacebookLocale(rawUrl) {
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

export async function gotoFacebookLocale(page, rawUrl, options = {}) {
  return page.goto(withFacebookLocale(rawUrl), options);
}

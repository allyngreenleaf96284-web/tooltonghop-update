const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DASHBOARD_URL = "https://www.facebook.com/marketplace/you/dashboard";
const RENEW_URL = "https://www.facebook.com/marketplace/selling/renew_listings/?is_routable_dialog=true";
const SELLING_URL = "https://www.facebook.com/marketplace/you/selling?referral_surface=seller_hub";

export function createRenewDocLapTool({
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
      tool: "renew doc lap",
      step,
      detail
    });
  }

  function stoppedError() {
    const error = new Error("Da nhan lenh dung han, tool Renew doc lap dung batch hien tai.");
    error.status = "stopped";
    error.step = "dung han";
    return error;
  }

  function clampConcurrency(value, fallback = 1) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return Math.max(1, Math.min(4, fallback));
    return Math.max(1, Math.min(4, parsed));
  }

  async function step(profileId, job, name, action, timeoutMs = 0) {
    if (runtime.stopRequested) throw stoppedError();
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
      if (runtime.stopRequested) throw stoppedError();
      log(profileId, name, `xong: ${name} (${Date.now() - startedAt}ms)`, "success");
      return result;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") throw error;
      log(profileId, name, `loi o buoc "${name}": ${error.message || error}`, "error");
      throw error;
    }
  }

  function boundsFor(workerSlot = 0, workerTotal = 1) {
    const total = Math.max(1, Math.min(4, Number(workerTotal || 1)));
    const slot = Math.max(0, Math.min(total - 1, Number(workerSlot || 0)));
    if (total <= 1) return { left: 0, top: 0, width: 1280, height: 980 };
    if (total === 2) return { left: slot % 2 === 0 ? 0 : 960, top: 0, width: 960, height: 980 };
    if (total === 3) return { left: slot * 640, top: 0, width: 640, height: 980 };
    return { left: (slot % 2) * 960, top: Math.floor(slot / 2) * 520, width: 960, height: 520 };
  }

  async function preparePage(browser, workerSlot, workerTotal) {
    const page = await browser.newPage();
    const bounds = boundsFor(workerSlot, workerTotal);
    const session = await page.target().createCDPSession().catch(() => null);
    if (session) {
      const win = await session.send("Browser.getWindowForTarget").catch(() => null);
      if (win?.windowId !== undefined) {
        await session.send("Browser.setWindowBounds", {
          windowId: win.windowId,
          bounds: { windowState: "normal", ...bounds }
        }).catch(() => {});
      }
      await session.detach().catch(() => {});
    }
    await page.setViewport({
      width: Math.max(workerTotal >= 4 ? 760 : 900, bounds.width - 24),
      height: Math.max(workerTotal >= 4 ? 430 : 640, bounds.height - 110),
      deviceScaleFactor: 1
    }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return page;
  }

  async function gotoClean(page, url) {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await sleep(350);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForSelector("body", { timeout: 15000 }).catch(() => {});
  }

  async function closeTopPanels(page) {
    for (let i = 0; i < 5; i += 1) {
      const panel = await page.evaluate(() => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /Notifications\s*All\s*Unread|AllUnreadNew|See previous notifications|Notification Actions|Mark as read,|Messenger\s*,?\s*\d+ unread|Unread Chats/i.test(text);
      }).catch(() => false);
      if (!panel) return true;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(600);
    }
    return false;
  }

  async function dashboardBucket(page, label) {
    return page.evaluate(async (targetLabel) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const escaped = String(targetLabel || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped}\\s+(\\d+)$`, "i");
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 60 && rect.height > 40 && rect.bottom > 0 && rect.top < innerHeight && style.display !== "none" && style.visibility !== "hidden";
      };
      scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (let step = 0; step < 10; step += 1) {
        const candidates = Array.from(document.querySelectorAll("[role='button'], a, [role='link'], [role='listitem'], div"))
          .filter(visible)
          .map((node) => {
            const text = normalize(node.innerText || node.textContent || "");
            const match = text.match(re);
            if (!match) return null;
            const rect = node.getBoundingClientRect();
            if (rect.width > 380 || rect.height > 180 || text.length > targetLabel.length + 16) return null;
            return { count: Number(match[1] || 0), text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top, area: rect.width * rect.height };
          })
          .filter(Boolean)
          .sort((a, b) => a.area - b.area || a.top - b.top);
        if (candidates[0]) return candidates[0];
        scrollBy(0, Math.round(innerHeight * 0.65));
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    }, label).catch(() => null);
  }

  async function renewState(page) {
    return page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 8 && rect.height > 8 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && style.display !== "none" && style.visibility !== "hidden";
      };
      const text = normalize(document.body?.innerText || "");
      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(visible);
      const root = dialogs.find((dialog) => /Renew listings/i.test(normalize(dialog.innerText || dialog.textContent || "")))
        || (/\/marketplace\/selling\/renew_listings/i.test(location.pathname) ? document.body : null);
      const buttons = root ? Array.from(root.querySelectorAll("[role='button'], button, a[role='button'], div[aria-label], span"))
        .filter(visible)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            text: normalize(node.innerText || node.textContent || ""),
            aria: normalize(node.getAttribute("aria-label") || ""),
            disabled: node.getAttribute("aria-disabled") || node.disabled || false,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            top: rect.top
          };
        }) : [];
      return {
        url: location.href,
        textLength: text.length,
        ready: Boolean(root) && /Renew listings/i.test(text),
        buttons: buttons.filter((button) => /Renew|Renewed|Done|Close/i.test(`${button.text} ${button.aria}`)).slice(0, 30)
      };
    }).catch(() => ({ url: "", textLength: 0, ready: false, buttons: [] }));
  }

  async function getVisibleRenewButtonsByXPath(page) {
    return page.evaluate(() => {
      const xpath = "(//span[normalize-space()='Renew']/ancestor::div[@role='none'][2])";
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 10
          && rect.height > 10
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth
          && style.display !== "none"
          && style.visibility !== "hidden"
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
        buttons.push({ domIndex: index, text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top });
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
        const style = getComputedStyle(element);
        return rect.width > 10
          && rect.height > 10
          && rect.bottom > 0
          && rect.top < innerHeight
          && rect.right > 0
          && rect.left < innerWidth
          && style.display !== "none"
          && style.visibility !== "hidden"
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

  async function clickNextRenew(page, profileId, row) {
    const before = await renewState(page);
    const visibleButtons = await getVisibleRenewButtonsByXPath(page);
    log(profileId, "renew", "[" + row.uid + "] tim thay " + visibleButtons.length + " nut Renew dang hien bang XPath.");
    if (!visibleButtons.length) {
      const scrolled = await page.evaluate(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 10 && rect.height > 10 && style.display !== "none" && style.visibility !== "hidden";
        };
        const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true']")).filter(visible);
        const root = dialogs.find((dialog) => /Renew listings/i.test(String(dialog.innerText || dialog.textContent || "")))
          || (/\/marketplace\/selling\/renew_listings/i.test(location.pathname) ? document.body : null);
        if (!root) return { reason: "no_root" };
        const scroller = Array.from(root.querySelectorAll("div"))
          .filter((node) => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 20)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement;
        const beforeTop = scroller.scrollTop;
        scroller.scrollBy({ top: 420, behavior: "auto" });
        return { reason: "no_button", before: beforeTop, after: scroller.scrollTop, bottom: scroller.scrollTop + scroller.clientHeight, height: scroller.scrollHeight };
      }).catch((error) => ({ reason: "scroll_failed", error: String(error?.message || error || "") }));
      return { ok: false, ...scrolled, state: before };
    }

    for (let buttonIndex = 0; buttonIndex < visibleButtons.length; buttonIndex += 1) {
      const target = visibleButtons[buttonIndex];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        log(profileId, "renew", "[" + row.uid + "] thu bam Renew visible " + (buttonIndex + 1) + "/" + visibleButtons.length + " attempt " + attempt + "/3 tai " + Math.round(target.x) + "," + Math.round(target.y) + ".");
        try {
          const prepared = await prepareRenewButtonByDomIndex(page, target.domIndex);
          if (!prepared.ok) {
            log(profileId, "renew", "[" + row.uid + "] Renew visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua interactable: " + (prepared.reason || "unknown") + ", thu JS click.", "warn");
            const jsClickedWhenBlocked = await jsClickRenewButtonByDomIndex(page, target.domIndex);
            await sleep(900);
            const afterBlocked = await renewState(page);
            const blockedAfterRenew = (afterBlocked.buttons || []).filter((button) => /^Renew$/i.test(button.text) || /^Renew$/i.test(button.aria)).length;
            const blockedBeforeRenew = (before.buttons || []).filter((button) => /^Renew$/i.test(button.text) || /^Renew$/i.test(button.aria)).length;
            const blockedAfterRenewed = (afterBlocked.buttons || []).filter((button) => /\bRenewed\b/i.test((button.text || "") + " " + (button.aria || ""))).length;
            const blockedBeforeRenewed = (before.buttons || []).filter((button) => /\bRenewed\b/i.test((button.text || "") + " " + (button.aria || ""))).length;
            if (jsClickedWhenBlocked.ok && (blockedAfterRenew < blockedBeforeRenew || blockedAfterRenewed > blockedBeforeRenewed)) {
              log(profileId, "renew", "[" + row.uid + "] bam Renew visible " + (buttonIndex + 1) + " thanh cong bang JS click khi normal chua interactable o attempt " + attempt + "/3.", "success");
              return { ok: true, text: jsClickedWhenBlocked.text || target.text, verified: true };
            }
            log(profileId, "renew", "[" + row.uid + "] JS click khi chua interactable attempt " + attempt + "/3 chua thanh cong: " + (jsClickedWhenBlocked.reason || "khong doi trang thai") + ".", "warn");
            await sleep(350);
            continue;
          }
          await page.mouse.move(prepared.x, prepared.y, { steps: 4 }).catch(() => {});
          await sleep(120);
          await page.mouse.click(prepared.x, prepared.y, { delay: 80 }).catch(() => {});
          await sleep(850);
          let after = await renewState(page);
          const afterRenew = (after.buttons || []).filter((button) => /^Renew$/i.test(button.text) || /^Renew$/i.test(button.aria)).length;
          const beforeRenew = (before.buttons || []).filter((button) => /^Renew$/i.test(button.text) || /^Renew$/i.test(button.aria)).length;
          const afterRenewed = (after.buttons || []).filter((button) => /\bRenewed\b/i.test((button.text || "") + " " + (button.aria || ""))).length;
          const beforeRenewed = (before.buttons || []).filter((button) => /\bRenewed\b/i.test((button.text || "") + " " + (button.aria || ""))).length;
          if (afterRenew < beforeRenew || afterRenewed > beforeRenewed) {
            log(profileId, "renew", "[" + row.uid + "] bam Renew visible " + (buttonIndex + 1) + " thanh cong bang normal click o attempt " + attempt + "/3.", "success");
            return { ok: true, text: prepared.text, verified: true };
          }

          log(profileId, "renew", "[" + row.uid + "] normal click visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua doi trang thai, thu JS click.", "warn");
          const jsClicked = await jsClickRenewButtonByDomIndex(page, target.domIndex);
          await sleep(950);
          after = await renewState(page);
          const jsAfterRenew = (after.buttons || []).filter((button) => /^Renew$/i.test(button.text) || /^Renew$/i.test(button.aria)).length;
          const jsAfterRenewed = (after.buttons || []).filter((button) => /\bRenewed\b/i.test((button.text || "") + " " + (button.aria || ""))).length;
          if (jsClicked.ok && (jsAfterRenew < beforeRenew || jsAfterRenewed > beforeRenewed)) {
            log(profileId, "renew", "[" + row.uid + "] bam Renew visible " + (buttonIndex + 1) + " thanh cong bang JS click o attempt " + attempt + "/3.", "success");
            return { ok: true, text: jsClicked.text || prepared.text, verified: true };
          }
          log(profileId, "renew", "[" + row.uid + "] JS click visible " + (buttonIndex + 1) + " attempt " + attempt + "/3 chua thanh cong: " + (jsClicked.reason || "khong doi trang thai") + ".", "warn");
        } catch (error) {
          log(profileId, "renew", "[" + row.uid + "] exception khi bam Renew visible " + (buttonIndex + 1) + " attempt " + attempt + "/3: " + String(error?.message || error || ""), "warn");
        }
        await sleep(450);
      }
      log(profileId, "renew", "[" + row.uid + "] bo qua nut Renew visible " + (buttonIndex + 1) + " sau 3 attempt, tiep tuc nut visible tiep theo.", "warn");
    }
    return { ok: false, reason: "click_failed" };
  }

  async function closeRenewDialog(page) {
    const target = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 10 && rect.height > 10 && rect.bottom > 0 && rect.top < innerHeight && style.display !== "none" && style.visibility !== "hidden";
      };
      const button = Array.from(document.querySelectorAll("[role='button'], button"))
        .filter(visible)
        .find((node) => /^(Done|Close)$/i.test(normalize(node.innerText || node.textContent || "")) || /^(Done|Close)$/i.test(normalize(node.getAttribute("aria-label") || "")));
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }).catch(() => null);
    if (target) await page.mouse.click(target.x, target.y, { delay: 80 }).catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
    await sleep(1200);
  }

  async function runRenew(page, row, profileId) {
    let total = 0;
    await gotoClean(page, DASHBOARD_URL);
    await sleep(3500);
    await closeTopPanels(page);
    const before = await dashboardBucket(page, "To renew");
    if (!before) {
      log(profileId, "renew", `[${row.uid}] khong thay bucket To renew tren dashboard.`, "warn");
      return { renewed: 0, before: null, after: null, verified: false };
    }
    if (!before.count) {
      log(profileId, "renew", `[${row.uid}] To renew = 0, bo qua.`, "success");
      return { renewed: 0, before: 0, after: 0, verified: true };
    }

    log(profileId, "renew", `[${row.uid}] To renew truoc khi chay: ${before.count}, bam bucket tai ${Math.round(before.x)},${Math.round(before.y)}.`);
    await page.mouse.click(before.x, before.y, { delay: 80 }).catch(() => {});
    await sleep(5000);
    await closeTopPanels(page);
    let state = await renewState(page);
    if (!state.ready) {
      log(profileId, "renew", `[${row.uid}] bam bucket chua mo Renew list, mo thang URL renew. url=${state.url} text=${state.textLength}`, "warn");
      await page.goto(RENEW_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForSelector("body", { timeout: 15000 }).catch(() => {});
      await sleep(5000);
      await closeTopPanels(page);
      state = await renewState(page);
      if (!state.ready) {
        log(profileId, "renew", `[${row.uid}] URL renew van chua ready. url=${state.url} text=${state.textLength} buttons=${state.buttons.map((b) => `${b.text}/${b.aria}`).join(" | ")}`, "warn");
        return { renewed: 0, before: before.count, after: before.count, verified: false };
      }
    }

    let stagnant = 0;
    for (let i = 0; i < 140; i += 1) {
      if (runtime.stopRequested) throw stoppedError();
      const clicked = await clickNextRenew(page, profileId, row);
      if (clicked.ok) {
        total += 1;
        log(profileId, "renew", `[${row.uid}] da bam Renew ${total}/${before.count}.`, "success");
        await sleep(2500);
        continue;
      }
      if (clicked.reason === "no_button") {
        if (Math.abs(Number(clicked.after || 0) - Number(clicked.before || 0)) < 4 && Number(clicked.bottom || 0) >= Number(clicked.height || 0) - 8) break;
        await sleep(850);
        stagnant = 0;
        continue;
      }
      stagnant += 1;
      if (stagnant >= 3) break;
      await sleep(1000);
    }
    await closeRenewDialog(page);
    await gotoClean(page, DASHBOARD_URL);
    await sleep(3500);
    await closeTopPanels(page);
    const after = await dashboardBucket(page, "To renew");
    log(profileId, "renew", `[${row.uid}] To renew sau khi chay: ${after?.count ?? "?"}.`, after?.count === 0 ? "success" : "warn");
    return { renewed: total, before: before.count, after: after?.count ?? null, verified: after?.count === 0 };
  }

  async function needsCount(page) {
    await gotoClean(page, DASHBOARD_URL);
    await sleep(3000);
    await closeTopPanels(page);
    const bucket = await dashboardBucket(page, "Needs attention");
    return bucket?.count ?? null;
  }

  async function runNeedsAttention(page, row, profileId) {
    const before = await needsCount(page);
    if (!before) {
      log(profileId, "needs attention", `[${row.uid}] Needs attention = ${before ?? "?"}, bo qua.`, "success");
      return { deleted: 0, before: before ?? null, after: before ?? null };
    }
    log(profileId, "needs attention", `[${row.uid}] Needs attention con ${before}; tool doc lap moi chi verify count, chua xoa trong ban test dau.`, "warn");
    return { deleted: 0, before, after: before };
  }

  async function runOne(profileId, sheetRow, config, sheetSession, workerSlot, workerTotal) {
    const manager = getManager({ fresh: true });
    const row = buildToolRow(profileId, sheetRow);
    row.profile_id = profileId;
    const job = runtime.jobs.get(profileId);
    let browser = null;
    let page = null;
    let proxyLease = null;

    try {
      proxyLease = await step(profileId, job, "gan proxy bang", async () =>
        stateProxy?.ensureForProfile?.({
          config,
          profileId,
          row,
          log: (stepName, message, type = "info") => log(profileId, stepName, message, type)
        })
      , 120000);
      browser = await step(profileId, job, "mo profile HideMyAcc", async () => manager.connectBrowser(profileId), 120000);
      page = await step(profileId, job, "mo tab doc lap", async () => preparePage(browser, workerSlot, workerTotal), 60000);
      await step(profileId, job, "dang nhap Facebook", async () => {
        await dangNhap.ensureFacebookLogin(manager, page, row, profileId, (status) => {
          if (job) job.liveStatus = status;
          log(profileId, "dang nhap Facebook", status);
        });
      }, 300000);
      const renew = await step(profileId, job, "renew doc lap", async () => runRenew(page, row, profileId), 420000);
      const needs = await step(profileId, job, "needs attention doc lap", async () => runNeedsAttention(page, row, profileId), 180000);
      const finalUpdate = {
        Tool: "renew doc lap",
        trangThai: renew.verified ? "thanh cong" : "loi",
        chiTiet: `Renew doc lap: bam ${renew.renewed}, To renew ${renew.before ?? "?"}->${renew.after ?? "?"}, Needs attention ${needs.before ?? "?"}.`
      };
      if (job) {
        job.status = renew.verified ? "success" : "error";
        job.liveStatus = finalUpdate.chiTiet;
        job.result = finalUpdate;
      }
      await sheetSession.updateOne(profileId, finalUpdate).catch((error) => {
        log(profileId, "ghi Sheet", `ghi Sheet loi: ${error.message || error}`, "warn");
      });
      return finalUpdate;
    } catch (error) {
      if (String(error?.status || "").toLowerCase() === "stopped") throw error;
      const finalUpdate = { Tool: "renew doc lap", trangThai: "loi", chiTiet: String(error?.message || error || "loi renew doc lap") };
      if (job) {
        job.status = "error";
        job.liveStatus = finalUpdate.chiTiet;
        job.result = finalUpdate;
      }
      await sheetSession.updateOne(profileId, finalUpdate).catch(() => {});
      throw error;
    } finally {
      if (proxyLease?.release) await proxyLease.release().catch(() => {});
      if (page && !page.isClosed?.()) await page.close().catch(() => {});
      if (browser) await browser.disconnect().catch(() => {});
      await manager.stopHideMyAccProfile?.(profileId).catch(() => {});
    }
  }

  async function runQueue(profileIds, config, options = {}) {
    if (runtime.running) throw new Error("Dang co tool khac chay, vui long doi xong.");
    const ids = [...new Set(profileIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw new Error("Chua chon profile de chay Renew doc lap.");
    const sheetSession = await createSheetRowSession(config, ids);
    const concurrency = Math.min(clampConcurrency(options.concurrency || config.interactionConcurrency || 1, 1), ids.length);
    for (const id of ids) {
      runtime.jobs.set(id, {
        profileId: id,
        tool: "renew doc lap",
        status: "queued",
        liveStatus: `dang cho chay Renew doc lap ${concurrency} luong`,
        logs: [],
        startedAt: "",
        finishedAt: "",
        result: null,
        sheetWriteError: ""
      });
      log(id, "xep hang", `da xep hang Renew doc lap ${concurrency} luong`);
    }
    runtime.running = true;
    runtime.stopRequested = false;
    runtime.currentTool = "renew doc lap";
    setImmediate(async () => {
      try {
        let cursor = 0;
        const nextId = () => {
          if (runtime.stopRequested || cursor >= ids.length) return "";
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
              if (job) {
                job.status = "error";
                job.liveStatus = "Khong tim thay dong Sheet.";
                job.finishedAt = new Date().toISOString();
              }
              continue;
            }
            if (job) {
              job.status = "running";
              job.startedAt = new Date().toISOString();
              job.liveStatus = `dang chay Renew doc lap o luong ${workerSlot + 1}/${concurrency}`;
            }
            try {
              await runOne(id, row, config, sheetSession, workerSlot, concurrency);
            } catch (error) {
              if (String(error?.status || "").toLowerCase() === "stopped") {
                if (job) job.status = "stopped";
              } else {
                log(id, "loi", error.message || String(error), "error");
              }
            } finally {
              if (job && job.status === "running") job.status = "success";
              if (job) job.finishedAt = new Date().toISOString();
            }
          }
        });
        await Promise.all(workers);
        await sheetSession.flushAll?.().catch(() => {});
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

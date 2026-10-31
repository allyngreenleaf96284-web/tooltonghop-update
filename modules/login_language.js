const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Executed inside the page: no coordinates or minimum pixel sizes, so the
// same controls work at 25–100% zoom and in tiled windows.
function languageControl(kind) {
  const visible = (el) => {
    if (!(el instanceof HTMLElement) || el.closest('[aria-hidden="true"], [inert]')) return false;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const text = (el) => String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
  const dialog = dialogs.at(-1);
  const clickable = 'button, [role="button"], a[href], [role="radio"], [role="option"], [tabindex="0"]';
  if (kind === "confirm" || kind === "confirmAfter") {
    if (!dialog) return null;
    const search = dialog.querySelector('input[type="search"], input[type="text"]');
    if (search && kind !== "confirmAfter") return null;
    return [...dialog.querySelectorAll(clickable)].filter(visible).find((el) =>
      (search ? /^(Save|Save changes|Lưu|Lưu thay đổi)$/i : /^(OK|Okay|Save|Save changes|Refresh(?: page| Facebook)?|Reload(?: page)?|Continue|Đồng ý|Xác nhận|Lưu|Lưu thay đổi)$/i).test(text(el))
      && !el.matches(':disabled, [aria-disabled="true"]')) || null;
  }
  const option = () => dialog ? [...dialog.querySelectorAll(`${clickable}, label, span`)].filter(visible)
    .find((el) => /^English\s*\(US\)$/i.test(text(el))) || null : null;
  if (kind === "option") return option();
  if (kind === "entry") return dialog ? option() || [...dialog.querySelectorAll('input:not([type="hidden"])')].find(visible) || null : null;
  const rows = [...document.querySelectorAll(clickable)].filter(visible).filter((el) =>
    !el.closest('[role="dialog"], [role="alertdialog"]') && /account language|facebook language|ngôn ngữ của tài khoản|ngon ngu cua tai khoan|idioma de facebook|langue de facebook/i.test(text(el)));
  if (kind === "row") return rows.sort((a, b) => text(a).length - text(b).length)[0] || null;
  if (kind === "ready") {
    // An English option in the picker is not proof that it was saved.
    if (dialogs.length) return false;
    if (rows.some((el) => /English\s*\(US\)/i.test(text(el)))) return true;
    const englishDocument = /^en(?:[-_]US)?$/i.test(document.documentElement.lang);
    const body = document.body?.innerText || "";
    return englishDocument && /account language|facebook language|language of the app/i.test(body);
  }
  return null;
}

export async function ensureLoginEnglish(page, { navigate, check = async () => {}, onProgress = () => {}, timeoutMs = 120000, controlWaitMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const find = async (kind) => {
    try { return await page.evaluateHandle(languageControl, kind); }
    catch (error) {
      if (!/execution context was destroyed|cannot find context/i.test(error.message)) throw error;
      return null;
    }
  };
  const ready = async () => {
    const handle = await find("ready");
    if (!handle) return false;
    try { return await handle.jsonValue(); } finally { await handle.dispose(); }
  };
  const wait = async (kind) => {
    const until = Math.min(deadline, Date.now() + controlWaitMs);
    while (Date.now() < until) {
      await check();
      if (await ready()) return "ready";
      const handle = await find(kind);
      const el = handle?.asElement();
      if (el) return el;
      await handle?.dispose();
      await sleep(300);
    }
    return null;
  };
  const click = async (el) => {
    try { await el.evaluate((node) => node.scrollIntoView({ block: "center" })); await el.click(); }
    finally { await el.dispose(); }
  };
  await navigate();
  for (let attempt = 1; attempt <= 2 && Date.now() < deadline; attempt++) {
    onProgress("dang cho Facebook tai cai dat ngon ngu");
    // Resume a picker/confirmation already opened before an operator pause.
    let option = await find("option");
    let picker = option?.asElement();
    if (!picker) await option?.dispose();
    if (!picker) {
      const confirm = await find("confirm");
      if (confirm?.asElement()) await click(confirm.asElement());
      else await confirm?.dispose();
      const row = await wait("row");
      if (row === "ready") return true;
      if (!row) continue;
      await click(row);
      const entry = await wait("entry");
      if (entry === "ready") return true;
      if (entry && await entry.evaluate((node) => node instanceof HTMLInputElement)) {
        try { await entry.evaluate((node) => node.select()); await entry.press("Backspace"); await entry.type("English", { delay: 30 }); }
        finally { await entry.dispose(); }
        picker = await wait("option");
      } else {
        picker = entry;
      }
      if (picker === "ready") return true;
    }
    if (!picker) continue;
    await click(picker);
    onProgress("da chon English (US), dang cho luu va xac nhan ngon ngu");
    const until = Math.min(deadline, Date.now() + controlWaitMs);
    while (Date.now() < until) {
      await check();
      if (await ready()) return true;
      const confirm = await find("confirmAfter");
      if (confirm?.asElement()) await click(confirm.asElement());
      else await confirm?.dispose();
      await sleep(300);
    }
    // Do not reload while a slow save/navigation is still in progress.
  }
  await check();
  return ready();
}

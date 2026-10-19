const UI_WAIT_MS = 15000;
const UI_POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const LISTING_CONDITIONS = ["New", "Used - Like New", "Used - Good", "Used - Fair"];

export function normalizeListingCondition(value) {
  const key = String(value || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  return LISTING_CONDITIONS.find((label) => label.toLowerCase() === key) || "Used - Like New";
}

export async function chooseListingCondition(page, condition) {
  const clean = (value) => String(value || "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const label = normalizeListingCondition(condition);
  const wanted = clean(label);
  for (let recovery = 1; recovery <= 3; recovery += 1) {
    const alreadySelected = await page.evaluate((value) => {
      const cleanText = (text) => String(text || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
      return Array.from(document.querySelectorAll("label[role='combobox'], [role='combobox']"))
        .some((node) => cleanText(node.innerText || node.textContent || "").replace(/^condition\s*/, "") === value);
    }, wanted).catch(() => false);
    if (alreadySelected) return;

    const opened = await page.evaluate(() => {
      const visible = (node) => {
        const rect = node?.getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0 && window.getComputedStyle(node).display !== "none");
      };
      const cleanText = (text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
      const target = Array.from(document.querySelectorAll("label[role='combobox'], [role='combobox']"))
        .find((node) => visible(node) && /^condition\b/.test(cleanText(node.innerText || node.textContent || "")));
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.click();
      return true;
    }).catch(() => false);
    if (!opened) {
      await sleep(UI_POLL_MS);
      continue;
    }

    let clicked = false;
    for (let waitAttempt = 1; waitAttempt <= Math.ceil(UI_WAIT_MS / UI_POLL_MS); waitAttempt += 1) {
      clicked = await page.evaluate((value) => {
        const cleanText = (text) => String(text || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (node) => {
          const rect = node?.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0 && window.getComputedStyle(node).display !== "none");
        };
        const option = Array.from(document.querySelectorAll("[role='option'], [role='menuitem'], div, span"))
          .find((node) => visible(node) && cleanText(node.innerText || node.textContent || "") === value);
        if (!option) return false;
        const target = option.closest?.("[role='option'], [role='menuitem'], [role='button'], button") || option;
        target.click();
        return true;
      }, wanted).catch(() => false);
      if (clicked) break;
      await sleep(UI_POLL_MS);
    }
    if (clicked) {
      for (let waitAttempt = 1; waitAttempt <= Math.ceil(UI_WAIT_MS / UI_POLL_MS); waitAttempt += 1) {
        const selected = await page.evaluate((value) => {
          const cleanText = (text) => String(text || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
          return Array.from(document.querySelectorAll("label[role='combobox'], [role='combobox']"))
            .some((node) => cleanText(node.innerText || node.textContent || "").replace(/^condition\s*/, "") === value);
        }, wanted).catch(() => false);
        if (selected) return;
        await sleep(UI_POLL_MS);
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(UI_POLL_MS);
  }
  const error = new Error(`Khong chon duoc Condition = ${label}.`);
  error.status = "loisp";
  throw error;
}

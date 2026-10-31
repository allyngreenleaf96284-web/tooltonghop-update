const UI_WAIT_MS = 15000;
const UI_POLL_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const LISTING_CONDITIONS = ["New", "Used - Like New", "Used - Good", "Used - Fair"];

export function normalizeListingCondition(value) {
  const key = String(value || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  return LISTING_CONDITIONS.find((label) => label.toLowerCase() === key) || "Used - Like New";
}

// Runs in the page. Scope the option to Condition, rather than another visible
// "New" in the product preview or a different dropdown.
function conditionElement(kind, wanted) {
  const clean = (value) => String(value || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = (node) => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const label = (node) => [node.getAttribute("aria-label"),
    ...(node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent),
    ...(Array.from(node.labels || []).map((item) => item.innerText)), node.innerText].filter(Boolean).join(" ");
  const control = Array.from(document.querySelectorAll("select, [role='combobox'], button, [role='button']"))
    .find((node) => visible(node) && /^condition(?:\b|new|used)/i.test(clean(label(node))));
  if (!control) return null;
  if (kind === "control") return control;
  if (kind === "selected") {
    const texts = control.tagName === "SELECT"
      ? Array.from(control.selectedOptions).map((option) => option.textContent)
      : [control.getAttribute("aria-valuetext"), control.value, control.innerText, control.getAttribute("aria-label")];
    return texts.some((text) => clean(text).replace(/^condition\s*[:*]?\s*(?:required\s*)?/, "") === wanted) ? control : null;
  }
  if (kind === "option") {
    const roots = (control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || "")
      .split(/\s+/).map((id) => document.getElementById(id)).filter((node) => node && visible(node));
    if (!roots.length) roots.push(...Array.from(document.querySelectorAll("[role='listbox'], [role='menu']")).filter(visible));
    const semantic = roots.length ? roots.flatMap((root) => Array.from(root.querySelectorAll("[role='option'], [role='menuitem']")))
      : Array.from(document.querySelectorAll("[role='option'], [role='menuitem']"));
    const option = semantic.find((node) => visible(node) && node.getAttribute("aria-disabled") !== "true"
      && clean(node.innerText || node.textContent) === wanted);
    if (option) return option;
    return roots.flatMap((root) => Array.from(root.querySelectorAll("div, span, li, button")))
      .find((node) => visible(node) && node.getAttribute("aria-disabled") !== "true"
        && clean(node.innerText || node.textContent) === wanted) || null;
  }
  return null;
}

async function find(page, kind, wanted) {
  const handle = await page.evaluateHandle(conditionElement, kind, wanted);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); return null; }
  return element;
}

async function waitFor(page, kind, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const element = await find(page, kind, wanted);
    if (element) return element;
    await sleep(UI_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

async function click(element) {
  await element.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
  await element.click();
}

export async function chooseListingCondition(page, condition, { timeoutMs = UI_WAIT_MS, recoveryCount = 3 } = {}) {
  const label = normalizeListingCondition(condition), wanted = label.toLowerCase();
  let stage = "chua tim thay truong Condition";
  for (let recovery = 0; recovery < recoveryCount; recovery++) {
    try {
      const selected = await find(page, "selected", wanted);
      if (selected) { await selected.dispose(); return true; }
      const control = await waitFor(page, "control", wanted, timeoutMs);
      if (!control) continue;
      try {
        const native = await control.evaluate((node) => node.tagName === "SELECT");
        if (native) {
          const value = await control.evaluate((node, text) => Array.from(node.options).find((option) =>
            String(option.textContent || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase() === text)?.value, wanted);
          if (value !== undefined) await control.select(value);
        } else {
          if (!(await control.evaluate((node) => node.getAttribute("aria-expanded") === "true"))) await click(control);
          stage = "menu Condition chua hien lua chon";
          const option = await waitFor(page, "option", wanted, timeoutMs);
          if (!option) { await page.keyboard.press("Escape"); continue; }
          try { await click(option); } finally { await option.dispose(); }
        }
      } finally { await control.dispose(); }
      stage = "da bam lua chon nhung truong Condition chua cap nhat";
      const verified = await waitFor(page, "selected", wanted, timeoutMs);
      if (verified) { await verified.dispose(); return true; }
      await page.keyboard.press("Escape");
    } catch (error) {
      if (["LOGIN_PAUSED", "LOGIN_RETRY", "LOGIN_MANUAL_DONE"].includes(error.code) || error.status === "stopped") throw error;
      stage = error.message || "truong Condition vua tai lai";
      if (recovery + 1 < recoveryCount) {
        await page.keyboard.press("Escape");
        await sleep(UI_POLL_MS);
      }
    }
  }
  const error = new Error(`Khong chon duoc Condition = ${label}: ${stage}.`);
  error.status = "loisp";
  throw error;
}

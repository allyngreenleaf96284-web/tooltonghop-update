import { assertMarketplaceAccess } from "./facebook_locale.js";
import { SELLER_ADDRESS_ERROR, isSellerAddressError } from "./seller_info_status.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sellerAddressElement(kind) {
  const clean = (value) => String(value || "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  const visible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const isError = (text) => /invalid address|please make sure (?:that )?your address is correct|po boxes can't be used/i.test(clean(text));
  const controls = (root) => Array.from(root.querySelectorAll("button, [role='button'], [tabindex='0'], span")).filter(visible);
  const closeIn = (root) => controls(root).find((node) => /^ok$/i.test(clean(node.innerText)))
    || controls(root).find((node) => /^(?:close(?: dialog)?|dismiss|×|x)$/i.test(clean(node.getAttribute("aria-label") || node.innerText)));
  const candidates = Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']"));
  if (!candidates.some((node) => visible(node) && !node.querySelector("input") && isError(node.innerText))) {
    for (const title of document.querySelectorAll("h1, h2, h3, span")) {
      if (!visible(title) || !/^invalid address$/i.test(clean(title.innerText))) continue;
      let parent = title.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (!parent.querySelector("input") && closeIn(parent)) { candidates.push(parent); break; }
      }
    }
  }
  const errors = candidates
    .filter((node) => visible(node) && !node.querySelector("input") && isError(node.innerText) && closeIn(node));
  const error = errors.filter((node) => !errors.some((other) => other !== node && node.contains(other))).at(-1);
  if (kind === "invalid") return error || null;
  if (kind === "dismiss") return error ? closeIn(error) : null;
  const fieldName = (node) => {
    const labelled = (node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    let wrapper = node.parentElement, nearby = "";
    for (let depth = 0; wrapper && depth < 2; depth++, wrapper = wrapper.parentElement) {
      if (wrapper.querySelectorAll("input").length !== 1) break;
      nearby += ` ${wrapper.innerText}`;
    }
    return clean(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""} ${labelled} ${Array.from(node.labels || []).map((item) => item.innerText).join(" ")} ${nearby}`);
  };
  const street = Array.from(document.querySelectorAll("input"))
    .find((node) => visible(node) && /street address/i.test(fieldName(node)));
  const form = street?.closest("[role='dialog']") || street?.closest("form");
  if (kind === "form") {
    if (error || !street || street.disabled || !form) return null;
    const rect = street.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit && (hit === street || street.contains(hit)) ? street : null;
  }
  if (kind === "next") return form && !error ? controls(form).find((node) => /^next$/i.test(clean(node.innerText))
    && !node.disabled && !node.closest("[aria-disabled='true'], [disabled]")) || null : null;
  if (kind === "advanced") {
    const heading = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading'], span, div"))
      .find((node) => visible(node) && /^(?:confirm your information|your tax information)$/i.test(clean(node.innerText)));
    if (heading) return heading;
    return Array.from(document.querySelectorAll("input"))
      .find((node) => visible(node) && /social security|\bssn\b/i.test(fieldName(node))) || null;
  }
  return null;
}

async function find(page, kind) {
  const handle = await page.evaluateHandle(sellerAddressElement, kind);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); return null; }
  return element;
}

async function click(element) {
  await element.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
  await element.click();
}

export async function dismissSellerAddressErrors(page, { timeoutMs = 30000, quietMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let readySince = 0, dismissed = 0;
  do {
    await assertMarketplaceAccess(page);
    const close = await find(page, "dismiss");
    if (close) {
      readySince = 0;
      try { await click(close); dismissed++; } finally { await close.dispose(); }
    } else {
      const form = await find(page, "form");
      if (form) {
        await form.dispose();
        readySince ||= Date.now();
        if (Date.now() - readySince >= quietMs) return dismissed;
      } else readySince = 0;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error("Seller Info: chua dong het thong bao Invalid address de quay lai o nhap dia chi.");
}

async function nextAddressResult(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    await assertMarketplaceAccess(page);
    const invalid = await find(page, "invalid");
    if (invalid) { await invalid.dispose(); return "invalid"; }
    const advanced = await find(page, "advanced");
    if (advanced) { await advanced.dispose(); return "advanced"; }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error("Seller Info: bam Next nhung chua thay buoc tiep theo hoac thong bao dia chi.");
}

export function installSellerAddressRecovery(manager, { row, quarantine, replace, onProgress = () => {},
  timeoutMs = 30000, quietMs = 2000, maxReplacements = 5 }) {
  if (typeof manager.clickSellerInfoNext !== "function") return () => {};
  const original = manager.clickSellerInfoNext;
  const originalThrow = manager.throwIfSellerInfoInvalidDialog;
  let replacements = 0;
  async function recover(page, owner) {
    try {
      onProgress("Invalid address: dang danh dau loi dia chi cho cac dong cung SSN");
      await quarantine(SELLER_ADDRESS_ERROR);
      onProgress("Invalid address: dang dong cac thong bao de tro lai form dia chi");
      await dismissSellerAddressErrors(page, { timeoutMs, quietMs });
      if (replacements >= maxReplacements) throw new Error(`Seller Info: da doi ${maxReplacements} bo thong tin nhung van bi tu choi dia chi.`);
      await replace(); replacements++;
      onProgress("Seller Info: dang dien bo thong tin moi tren form hien tai");
      await owner.fillSellerInformation(page, row);
    } catch (error) {
      // Never restart the listing or release a quarantined row after recovery
      // failed partway through a Sheet write or repeated error dialogs.
      error.sellerAddressRecoveryHandled = true;
      throw error;
    }
  }
  manager.clickSellerInfoNext = async function addressNext(page) {
    for (;;) {
      const invalid = await find(page, "invalid");
      if (!invalid) {
        const deadline = Date.now() + timeoutMs;
        let next;
        do {
          await assertMarketplaceAccess(page);
          next = await find(page, "next");
          if (!next) await sleep(250);
        } while (!next && Date.now() < deadline);
        if (!next) throw new Error("Seller Info: chua tim thay nut Next san sang trong form dia chi.");
        try { await click(next); } finally { await next.dispose(); }
        try {
          if (await nextAddressResult(page, timeoutMs) === "advanced") return true;
        } catch (error) {
          // Preserve existing handling for other validation failures, e.g. ZIP.
          try { await originalThrow?.call(this, page, { timeoutMs: 100, dismiss: true }); }
          catch (validation) { if (!isSellerAddressError(validation)) throw validation; await recover(page, this); continue; }
          throw error;
        }
      } else await invalid.dispose();
      await recover(page, this);
    }
  };
  if (typeof originalThrow === "function") {
    manager.throwIfSellerInfoInvalidDialog = async function addressValidation(page, options) {
      const invalid = await find(page, "invalid");
      if (invalid) {
        await invalid.dispose();
        await recover(page, this);
        await this.clickSellerInfoNext(page);
        return;
      }
      try { return await originalThrow.call(this, page, options); }
      catch (error) {
        if (!isSellerAddressError(error)) throw error;
        // Covers a delayed dialog discovered by the bundled validation wait,
        // including a popup that the old detector has already dismissed once.
        await recover(page, this);
        await this.clickSellerInfoNext(page);
      }
    };
  }
  return () => {
    manager.clickSellerInfoNext = original;
    if (originalThrow) manager.throwIfSellerInfoInvalidDialog = originalThrow;
  };
}

import { assertMarketplaceAccess } from "./facebook_locale.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs in the page. Avoid pixel-size thresholds: Login can display content at
// 25-200% and in a small tiled browser window.
function locationElement(kind, target = "") {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const inputIn = (root) => Array.from(root.querySelectorAll("input:not([type='hidden'])"))
    .find((node) => visible(node) && !node.disabled && !["checkbox", "radio", "range", "button", "submit"].includes(node.type));
  const applyIn = (root) => Array.from(root.querySelectorAll("button, [role='button']"))
    .find((node) => visible(node) && /^apply$/i.test(clean(node.innerText || node.getAttribute("aria-label"))));
  const dialog = Array.from(document.querySelectorAll("[role='dialog']"))
    .filter(visible).find((node) => inputIn(node) && applyIn(node)
      && /location|radius/i.test(`${node.getAttribute("aria-label") || ""} ${node.innerText} ${inputIn(node)?.getAttribute("aria-label") || ""}`));
  if (kind === "dialog") return dialog || null;
  if (kind === "input") return dialog ? inputIn(dialog) : null;
  if (kind === "apply") {
    const button = dialog && applyIn(dialog);
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
  }
  if (kind === "suggestion") {
    if (!dialog) return null;
    const input = inputIn(dialog);
    const city = clean(target.split(",")[0]).toLowerCase();
    const relevant = (node) => visible(node) && clean(node.innerText).toLowerCase().includes(city);
    const lists = [dialog];
    for (const id of `${input?.getAttribute("aria-controls") || ""} ${input?.getAttribute("aria-owns") || ""}`.split(/\s+/)) {
      const list = id && document.getElementById(id);
      if (list && visible(list)) lists.push(list);
    }
    const semantic = Array.from(document.querySelectorAll("[role='option']"))
      .find((node) => relevant(node) && (dialog.contains(node) || node.closest("[role='listbox']")));
    if (semantic) return semantic;
    const candidates = lists.flatMap((root) => Array.from(root.querySelectorAll("li, [role='button'], div, span")))
      .filter((node) => relevant(node) && !node.contains(input) && !node.querySelector("input")
        && clean(node.innerText).includes(",") && clean(node.innerText).length < 220
        && !node.contains(applyIn(dialog)));
    // Prefer the smallest matching row, not the container holding all results.
    return candidates.find((node) => !candidates.some((other) => other !== node && node.contains(other))) || null;
  }
  if (kind === "sidebar") {
    const direct = Array.from(document.querySelectorAll("[aria-label]"))
      .find((node) => visible(node) && /^location\s*:/i.test(node.getAttribute("aria-label") || "")
        && node.matches("button, a, [role='button'], [role='link']"));
    if (direct) return direct;
    const heading = Array.from(document.querySelectorAll("span, div, h1, h2, h3, h4"))
      .find((node) => visible(node) && /^location$/i.test(clean(node.innerText)));
    let root = heading?.parentElement;
    for (let depth = 0; root && depth < 5; depth++, root = root.parentElement) {
      const nodes = Array.from(root.querySelectorAll("a, button, [role='button'], [role='link'], span"))
        .filter((node) => visible(node) && node !== heading && /within\s+\d+/i.test(clean(node.innerText))
          && clean(node.innerText).includes(",") && clean(node.innerText).length < 180);
      const node = nodes.find((node) => !nodes.some((other) => other !== node && node.contains(other)));
      if (node) return node.closest("a, button, [role='button'], [role='link']") || node;
    }
  }
  return null;
}

async function find(page, kind, target = "") {
  const handle = await page.evaluateHandle(locationElement, kind, target);
  const element = handle.asElement();
  if (!element) { await handle.dispose(); return null; }
  return element;
}

async function click(element) {
  await element.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
  await element.click();
}

async function waitFor(page, kind, timeoutMs, target = "") {
  const deadline = Date.now() + timeoutMs;
  do {
    await assertMarketplaceAccess(page);
    const element = await find(page, kind, target);
    if (element) return element;
    await sleep(300);
  } while (Date.now() < deadline);
  return null;
}

export async function readMarketplaceSidebarLocation(page) {
  const element = await find(page, "sidebar");
  if (!element) return "";
  try {
    return await element.evaluate((node) => String(node.getAttribute("aria-label")?.match(/^location\s*:\s*(.*)/i)?.[1]
      || node.innerText || "").split(/[·•]/)[0].replace(/\s+/g, " ").trim());
  } finally { await element.dispose(); }
}

export async function openMarketplaceLocationDialog(page, timeoutMs = 30000) {
  let dialog = await find(page, "dialog");
  if (dialog) { await dialog.dispose(); return; }
  const sidebar = await waitFor(page, "sidebar", timeoutMs);
  if (!sidebar) throw new Error("Location: trang chua hien nut dia chi Marketplace sau 30 giay.");
  try { await click(sidebar); } finally { await sidebar.dispose(); }
  dialog = await waitFor(page, "dialog", timeoutMs);
  if (!dialog) throw new Error("Location: da bam dia chi nhung hop Location chua hien o nhap va nut Apply sau 30 giay.");
  await dialog.dispose();
}

export async function readLocationFromDialog(page) {
  const input = await find(page, "input");
  if (!input) return "";
  try { return await input.evaluate((node) => String(node.value || "").trim()); }
  finally { await input.dispose(); }
}

export async function selectMarketplaceLocation(page, target, timeoutMs = 30000) {
  const input = await waitFor(page, "input", timeoutMs);
  if (!input) throw new Error("Location: khong tim thay o nhap dia chi.");
  try {
    await click(input);
    await input.evaluate((node) => node.select());
    await input.press("Backspace");
    await input.type(target, { delay: 40 });
  } finally { await input.dispose(); }
  const suggestion = await waitFor(page, "suggestion", timeoutMs, target);
  if (!suggestion) throw new Error(`Location: chua hien goi y dia chi cho "${target}" sau 30 giay.`);
  try { await click(suggestion); } finally { await suggestion.dispose(); }
  const apply = await waitFor(page, "apply", timeoutMs);
  if (!apply) throw new Error("Location: da chon goi y nhung nut Apply chua san sang.");
  await apply.dispose();
  return readLocationFromDialog(page);
}

export async function applyMarketplaceLocation(page, timeoutMs = 30000) {
  const button = await waitFor(page, "apply", timeoutMs);
  if (!button) throw new Error("Location: nut Apply chua san sang de luu dia chi.");
  try { await click(button); } finally { await button.dispose(); }
  const deadline = Date.now() + timeoutMs;
  do {
    await assertMarketplaceAccess(page);
    const dialog = await find(page, "dialog");
    if (!dialog) return;
    await dialog.dispose();
    await sleep(300);
  } while (Date.now() < deadline);
  throw new Error("Location: da bam Apply nhung hop dia chi chua dong; chua xac nhan da luu.");
}

import { withFacebookLocale } from "./facebook_locale.js";

function itemLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /(^|\.)facebook\.com$/i.test(url.hostname) && /^\/marketplace\/item\/\d+\/?$/.test(url.pathname)) {
      return withFacebookLocale(url.href);
    }
  } catch {}
  return "";
}

export async function findPublishedListingLink(page, title, { timeoutMs = 15000, pollMs = 500, maxAttempts = 5 } = {}) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));
  await page.goto(withFacebookLocale("https://www.facebook.com/marketplace/you/selling"), { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("body", { timeout: 20000 }).catch(() => {});
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Pulse tables visually truncate titles, but their action labels contain
    // the complete title. Wait for either signal without refreshing early.
    await page.waitForFunction((wantedTitle) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = clean(wantedTitle);
      return clean(document.body?.innerText).includes(wanted)
        || Array.from(document.querySelectorAll("[aria-label]")).some((node) => clean(node.getAttribute("aria-label")).includes(wanted));
    }, { timeout: timeoutMs }, title).catch(() => {});

    const direct = await page.evaluate((wantedTitle) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = clean(wantedTitle);
      const visible = (node) => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
      for (const link of document.querySelectorAll("a[href*='/marketplace/item/']")) {
        if (!visible(link) || link.closest("[role='menu']")) continue;
        let container = link;
        for (let depth = 0; container && depth < 7; depth += 1, container = container.parentElement) {
          // A parent spanning several products cannot identify this link.
          const urls = new Set(Array.from(container.querySelectorAll("a[href*='/marketplace/item/']"), (node) => node.href.split("?")[0]));
          if (urls.size > 1) break;
          const actions = container.querySelectorAll("[aria-label^='More actions for'], [aria-label^='More options for']");
          if (actions.length > 1) break;
          if (clean(container.innerText || container.textContent).includes(wanted)
            || clean(container.getAttribute("aria-label")).includes(wanted)) return link.href;
          if (container.matches("tr, [role='row']")) break;
        }
      }
      return "";
    }, title).catch(() => "");
    if (itemLink(direct)) return itemLink(direct);

    const menuOpened = await page.evaluate((wantedTitle) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = clean(wantedTitle);
      const visible = (node) => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
      const more = Array.from(document.querySelectorAll("button, [role='button'], [aria-label]"))
        .find((node) => {
          const label = clean(node.getAttribute("aria-label"));
          return visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true"
            && /^more (?:options|actions) for\s*:?\s*/.test(label)
            && label.replace(/^more (?:options|actions) for\s*:?\s*/, "") === wanted;
        });
      if (!more) return false;
      more.scrollIntoView({ block: "center", inline: "nearest" });
      if (more.getAttribute("aria-expanded") !== "true") more.click();
      return true;
    }, title).catch(() => false);

    if (menuOpened) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const navigated = itemLink(String(page.url() || ""));
        if (navigated) return navigated;
        const opened = await page.evaluate(() => {
          const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const visible = (node) => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
          const menus = Array.from(document.querySelectorAll("[role='menu'], [role='dialog'], [role='presentation']")).filter(visible);
          for (const scope of menus.length ? menus : [document]) {
            const item = Array.from(scope.querySelectorAll("button, a, [role='button'], [role='menuitem'], div, span"))
              .find((node) => visible(node) && ["view", "view listing"].includes(clean(node.innerText || node.textContent)));
            if (!item) continue;
            const target = item.closest("a, button, [role='button'], [role='menuitem']") || item;
            if (target.disabled || target.getAttribute("aria-disabled") === "true") continue;
            const href = target.href || "";
            target.click();
            return { clicked: true, href };
          }
          return { clicked: false, href: "" };
        }).catch(() => ({ clicked: false, href: "" }));
        if (opened.clicked) {
          if (itemLink(opened.href)) return itemLink(opened.href);
          await page.waitForFunction(() => /^\/marketplace\/item\/\d+\/?$/.test(location.pathname), { timeout: timeoutMs }).catch(() => {});
          const link = itemLink(String(page.url() || ""));
          if (link) return link;
          break;
        }
        await pause();
      }
      const navigated = itemLink(String(page.url() || ""));
      if (navigated) return navigated;
    }
    if (attempt < maxAttempts) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await pause();
    }
  }
  const error = new Error(`Da dang bai nhung khong tim thay link listing theo title: ${title}`);
  error.status = "loi link sp";
  throw error;
}

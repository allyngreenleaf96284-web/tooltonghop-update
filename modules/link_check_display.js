import { createLoginDisplay } from "./login_display.js";

export function checkWindowBounds(slot, count, area) {
  const total = Math.max(1, Math.floor(count));
  const maxColumns = Math.max(1, Math.min(total, Math.floor(area.width / 500)));
  let columns = 1, best = Infinity;
  for (let n = 1; n <= maxColumns; n++) {
    const rows = Math.ceil(total / n);
    const height = area.height / rows;
    const score = Math.abs(Math.log((area.width / n) / height / 1.6))
      + 10 * (n * rows - total) / total + (height < 180 ? 10 : 0);
    if (score < best) { best = score; columns = n; }
  }
  const rows = Math.ceil(total / columns);
  const width = Math.floor(area.width / columns), height = Math.floor(area.height / rows);
  return { left: area.left + (slot % columns) * width,
    top: area.top + Math.floor(slot / columns) * height, width, height };
}

export function createLinkCheckDisplay(options = {}) {
  const display = createLoginDisplay(options), configured = new WeakSet();
  let zoom = 0.5;
  return {
    reset(percent = 50) { display.reset(); zoom = Math.max(25, Math.min(200, Number(percent) || 50)) / 100; },
    async apply(page, slot, count) {
      const bounds = checkWindowBounds(slot, count, await display.area(page));
      const session = await page.target().createCDPSession();
      try {
        const { windowId } = await session.send("Browser.getWindowForTarget");
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await session.send("Browser.setWindowBounds", { windowId, bounds });
      } finally { await session.detach(); }
      await page.setViewport({ width: Math.max(1, bounds.width - 24),
        height: Math.max(1, bounds.height - 110), deviceScaleFactor: 1 });
      const setZoom = value => {
        const apply = () => { if (document.documentElement) document.documentElement.style.zoom = String(value); };
        apply(); document.addEventListener("DOMContentLoaded", apply, { once: true });
      };
      if (!configured.has(page)) { await page.evaluateOnNewDocument(setZoom, zoom); configured.add(page); }
      await page.evaluate(setZoom, zoom);
      await page.bringToFront?.();
      return bounds;
    }
  };
}

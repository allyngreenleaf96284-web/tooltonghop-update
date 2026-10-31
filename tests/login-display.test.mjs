import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createLoginDisplay } from "../modules/login_display.js";
import { applyStableViewport, tileBounds } from "../modules/tool_login.js";

test("all workers share one native work area and refresh it only for the next batch", async () => {
  let reads = 0;
  const display = createLoginDisplay({ readWorkArea: async () => {
    reads++;
    await Promise.resolve();
    return { left: 0, top: 0, width: 1920, height: reads === 1 ? 1032 : 1040 };
  } });
  const page = { evaluate() { throw Error("profile screen must not be used"); } };
  const areas = await Promise.all(Array.from({ length: 6 }, () => display.area(page)));
  assert.equal(reads, 1);
  assert.ok(areas.every((area) => area === areas[0]));
  assert.equal(areas[0].height, 1032);
  display.reset();
  assert.equal((await display.area(page)).height, 1040);
  assert.equal(reads, 2);
});

test("native detection failure uses one shared fallback rather than mixing profile resolutions", async () => {
  let warnings = 0, browserReads = 0;
  const display = createLoginDisplay({ readWorkArea: async () => { throw Error("fixture"); }, onFallback: () => warnings++ });
  const first = { evaluate: async () => { browserReads++; return { left: 0, top: 0, width: 1600, height: 860 }; } };
  const second = { evaluate() { throw Error("must reuse first fallback"); } };
  assert.deepEqual(await display.area(first), await display.area(second));
  assert.equal(warnings, 1);
  assert.equal(browserReads, 1);
});

test("six windows on a 1360px monitor use two columns to respect Chrome minimum width", () => {
  const area = { left: 0, top: 0, width: 1360, height: 728 };
  const boxes = Array.from({ length: 6 }, (_, index) => tileBounds(index, 6, area));
  assert.equal(new Set(boxes.map((box) => box.left)).size, 2);
  for (const box of boxes) {
    assert.ok(box.width >= 500);
    assert.ok(box.left + box.width <= area.width);
    assert.ok(box.top + box.height <= area.height);
  }
});

test("1600x900 and 1360x768 profiles get equal viewport, DPR and configured content scale after navigation", async () => {
  const require = createRequire(import.meta.url);
  const browser = await require("puppeteer-core").launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true
  });
  const display = createLoginDisplay({ readWorkArea: async () => ({ left: 0, top: 0, width: 1920, height: 1032 }) });
  const results = [];
  try {
    for (const [index, width, height] of [[0, 1600, 900], [1, 1360, 768]]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: index + 1 });
      await page.evaluateOnNewDocument((size) => {
        Object.defineProperty(screen, "availWidth", { get: () => size.width });
        Object.defineProperty(screen, "availHeight", { get: () => size.height - 40 });
      }, { width, height });
      const settings = await applyStableViewport(page, index, 6, 75, display);
      await page.goto("data:text/html,<h1>Profile display</h1>");
      results.push(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        zoom: document.documentElement.style.zoom })));
      assert.equal(results[index].width, settings.width);
      assert.equal(results[index].height, settings.height);
    }
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].dpr, 1);
    assert.equal(results[0].zoom, "0.75");
  } finally { await browser.close(); }
});

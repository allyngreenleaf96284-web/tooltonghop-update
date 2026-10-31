import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, after, test } from "node:test";
import { ensureUsMarketplaceLocation } from "../modules/lamfull.js";
import { openMarketplaceLocationDialog, selectMarketplaceLocation, applyMarketplaceLocation } from "../modules/marketplace_location.js";

const require = createRequire(import.meta.url);
let browser;
before(async () => { browser = await require("puppeteer-core").launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });

async function fixture({ zoom = 50, dialogDelay = 0, suggestionDelay = 0, portal = false, location = "Colombo, Sri Lanka", applyCloses = true, fallback = false, semantic = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 616, height: 406 });
  await page.setContent(`<style>html{zoom:${zoom / 100}} [role=dialog]{position:fixed;top:15px;left:20px;width:360px;background:white;color:black;padding:12px}
    button,input{display:block;height:36px;margin:6px} [role=option]{padding:6px;cursor:pointer}</style>
    <nav><div><h3>Location</h3><a href="#" id="location" ${fallback ? "" : `role="button" aria-label="Location: ${location}"`}>${location} · Within 40 mi</a></div></nav>`);
  await page.evaluate(({ dialogDelay, suggestionDelay, portal, applyCloses, semantic }) => {
    window.openCount = 0; window.applyCount = 0;
    document.getElementById("location").onclick = (event) => {
      event.preventDefault(); window.openCount++;
      setTimeout(() => {
        if (document.querySelector("[role=dialog]")) return;
        const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog");
        dialog.innerHTML = '<h2>Location</h2><input aria-label="Location" type="text" value="Colombo, Sri Lanka" aria-controls="suggestions"><div id="inline"></div><label>Radius</label><button id="apply" disabled>Apply</button>';
        document.body.append(dialog);
        const input = dialog.querySelector("input"), apply = dialog.querySelector("button");
        input.addEventListener("input", () => {
          const value = input.value;
          document.getElementById("suggestions")?.remove();
          apply.disabled = true;
          if (!value.includes(",") || value.length < 10) return;
          setTimeout(() => {
            if (input.value !== value || !input.isConnected) return;
            document.getElementById("suggestions")?.remove();
            const list = document.createElement("div"); list.id = "suggestions"; list.setAttribute("role", "listbox");
            const option = document.createElement("div"); if (semantic) option.setAttribute("role", "option"); option.textContent = value;
            option.onclick = () => { input.value = value; apply.disabled = false; list.remove(); };
            list.append(option);
            (portal ? document.body : dialog.querySelector("#inline")).append(list);
          }, suggestionDelay);
        });
        apply.onclick = () => {
          window.applyCount++;
          if (!applyCloses) return;
          setTimeout(() => {
            const location = document.getElementById("location");
            location.setAttribute("aria-label", `Location: ${input.value}`);
            location.textContent = `${input.value} · Within 40 mi`; dialog.remove();
          }, 250);
        };
      }, dialogDelay);
    };
  }, { dialogDelay, suggestionDelay, portal, applyCloses, semantic });
  return page;
}

for (const options of [{ zoom: 25, portal: true }, { zoom: 50, suggestionDelay: 650, fallback: true, semantic: false }, { zoom: 100 }]) {
  test(`location changes and verifies saved US address at ${options.zoom}% zoom`, async () => {
    const page = await fixture(options);
    let navigations = 0;
    const progress = [];
    try {
      const result = await ensureUsMarketplaceLocation({ gotoWithRetry: async () => { navigations++; } }, page, { uid: "fixture" }, { onProgress: (message) => progress.push(message) });
      assert.equal(result.initialLocation, "Colombo, Sri Lanka");
      assert.ok(result.currentLocation.includes(","));
      assert.notEqual(result.currentLocation, result.initialLocation);
      assert.equal(navigations, 1);
      assert.equal(await page.evaluate(() => applyCount), 1);
      assert.ok(progress.at(-1).startsWith("Location: da luu"));
    } finally { await page.close(); }
  });
}

test("an already US location keeps its value without opening or applying a dialog", async () => {
  const page = await fixture({ location: "Reston, Virginia" });
  try {
    const result = await ensureUsMarketplaceLocation({ gotoWithRetry: async () => {} }, page, { uid: "fixture" });
    assert.deepEqual(result, { initialLocation: "Reston, Virginia", currentLocation: "Reston, Virginia" });
    assert.equal(await page.evaluate(() => openCount), 0);
  } finally { await page.close(); }
});

test("a dialog appearing after 16 seconds is recognized without the old 15-second failure", async () => {
  const page = await fixture({ dialogDelay: 16000 });
  try {
    await openMarketplaceLocationDialog(page);
    assert.equal(await page.evaluate(() => openCount), 1);
    assert.ok(await page.$("[role=dialog] input"));
  } finally { await page.close(); }
});

test("an Apply that does not finish is reported as unsaved", async () => {
  const page = await fixture({ applyCloses: false });
  try {
    await openMarketplaceLocationDialog(page, 1000);
    await openMarketplaceLocationDialog(page, 1000);
    assert.equal(await page.evaluate(() => openCount), 1);
    await selectMarketplaceLocation(page, "Reston, Virginia", 1500);
    await assert.rejects(applyMarketplaceLocation(page, 300), /chua dong; chua xac nhan da luu/);
  } finally { await page.close(); }
});

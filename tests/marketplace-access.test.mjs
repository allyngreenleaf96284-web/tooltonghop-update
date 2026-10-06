import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildMarketplaceIneligibleName } from "../modules/profile_name.js";
import { isMarketplaceIneligibleUrl, installMarketplaceAccessGuard, assertMarketplaceAccess } from "../modules/facebook_locale.js";
import { isUnknownFailure, startAutoRetryBatch } from "../modules/batch_retry.js";
import { mapFullError, buildRuntimeProfileName } from "../modules/lamfull.js";
import { createMarketplaceLinkOrderTool } from "../modules/marketplace_link_order.js";
import { createCheckTb } from "../modules/checktb.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const banner = "<h1>Marketplace isn't available to you</h1><p>Your account doesn't meet our age and eligibility criteria.</p>";

async function fixtureBrowser(html = "<h1>Marketplace</h1>") {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const newPage = browser.newPage.bind(browser);
  let requests = 0;
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      requests += 1;
      void request.respond({ status: 200, contentType: "text/html", body: html }).catch(() => {});
    });
    return page;
  };
  return { browser, requestCount: () => requests };
}

function fixtureManager(name = "2v-61500000000000-Arizona-tool") {
  const names = new Map([["p1", name], ["p2", "other-profile"]]);
  const updates = [];
  return {
    names, updates,
    async getProfileNameById(id) { return names.get(id) || ""; },
    async updateProfileName(id, value) { names.set(id, value); updates.push([id, value]); return true; },
    sendLog() {}
  };
}

test("URL detection requires a Facebook domain and the exact ineligible route", () => {
  for (const url of ["https://www.facebook.com/marketplace/ineligible/?locale=en_US", "https://facebook.com/marketplace/ineligible", "https://m.facebook.com/marketplace/ineligible/#x"]) assert.equal(isMarketplaceIneligibleUrl(url), true);
  for (const url of ["https://notfacebook.com/marketplace/ineligible/", "https://facebook.com.evil.test/marketplace/ineligible/", "https://www.facebook.com/marketplace/item/123", "https://www.facebook.com/marketplace/ineligible-product", "about:blank"]) assert.equal(isMarketplaceIneligibleUrl(url), false);
});

test("name marker is idempotent, removes old duplicates, and preserves the rest of the name", () => {
  for (const value of ["die cho-die cho-Full 15/7-61500000000000-Arizona-tool", "Full 15/7-61500000000000-Arizona-tool", "DIE CHO-Full 15/7-61500000000000-Arizona-tool"]) {
    const marked = buildMarketplaceIneligibleName(value);
    assert.equal(marked, "die cho-Full 15/7-61500000000000-Arizona-tool");
    assert.equal(buildMarketplaceIneligibleName(marked), marked);
  }
  assert.equal(buildMarketplaceIneligibleName("vip-die cho-2v-name-tool"), "die cho-vip-2v-name-tool");
  assert.equal(buildRuntimeProfileName({ status: "die cho", tenChuan: "die cho-name-tool" }), "die cho-name-tool");
});

test("known ineligible errors override generic wrappers and never enter unknown retries", async () => {
  const message = "Timeout at create/item: https://www.facebook.com/marketplace/ineligible/?locale=en_US";
  assert.equal(mapFullError({ status: "loi", message }).status, "die cho");
  for (const detail of [message, "Marketplace isn't available to you", "die cho: Marketplace isn't available to you"]) {
    assert.equal(isUnknownFailure({ status: "error", result: { trangThai: "loi", chiTiet: detail } }), false);
  }
  assert.equal(isUnknownFailure({ status: "error", result: { trangThai: "loi", chiTiet: "Timeout finding Title input" } }), true);
  const runtime = { jobs: new Map(), running: false };
  let runs = 0;
  await startAutoRetryBatch({ runtime, tool: "lam full", profileIds: ["p1"], config: {}, maxRetries: 2, module: {
    async runQueue() { runs += 1; runtime.jobs.set("p1", { status: "error", result: { trangThai: "loi", chiTiet: message } }); return {}; }
  } });
  for (let i = 0; i < 100 && runtime.batch.active; i += 1) await pause(10);
  assert.equal(runtime.batch.active, false);
  assert.equal(runs, 1);
});

test("URL-only restriction stops navigation, renames once, and protects future tabs and error renames", async () => {
  const { browser, requestCount } = await fixtureBrowser("<body></body>");
  try {
    const page = await browser.newPage();
    const second = await browser.newPage();
    const manager = fixtureManager("die cho-die cho-2v-61500000000000-Arizona-tool");
    let notifications = 0;
    const state = installMarketplaceAccessGuard(manager, page, "p1", "", () => { notifications += 1; });
    state.attach(second);
    await assert.rejects(page.goto("https://www.facebook.com/marketplace/ineligible/?locale=en_US"), (error) => error.status === "die cho" && error.retryable === false);
    const marked = "die cho-2v-61500000000000-Arizona-tool";
    assert.equal(manager.names.get("p1"), marked);
    assert.equal(notifications, 1);
    assert.equal(manager.updates.length, 1);
    const before = requestCount();
    await assert.rejects(page.reload(), (error) => error.code === "MARKETPLACE_INELIGIBLE");
    await assert.rejects(second.goto("https://www.facebook.com/"), (error) => error.status === "die cho");
    await assert.rejects(browser.newPage(), (error) => error.status === "die cho");
    assert.equal(requestCount(), before);
    await manager.updateProfileName("p1", "loi-new-generated-name");
    assert.equal(manager.names.get("p1"), marked);
    await manager.updateProfileName("p2", "healthy-new-name");
    assert.equal(manager.names.get("p2"), "healthy-new-name");
    assert.equal(state.pending.size, 0);
  } finally { await browser.close(); }
});

test("restriction banner is detected on create/item even without an ineligible URL", async () => {
  const { browser } = await fixtureBrowser(banner);
  try {
    const page = await browser.newPage();
    const manager = fixtureManager();
    installMarketplaceAccessGuard(manager, page, "p1");
    await assert.rejects(page.goto("https://www.facebook.com/marketplace/create/item?locale=en_US"), (error) => error.status === "die cho");
    assert.equal(manager.names.get("p1"), "die cho-2v-61500000000000-Arizona-tool");
  } finally { await browser.close(); }
});

test("healthy navigation is unchanged; a late SPA restriction interrupts an outstanding wait", async () => {
  const { browser } = await fixtureBrowser();
  try {
    const page = await browser.newPage();
    const manager = fixtureManager();
    const state = installMarketplaceAccessGuard(manager, page, "p1");
    await page.goto("https://www.facebook.com/marketplace/");
    assert.equal(await page.evaluate(() => document.querySelector("h1").innerText), "Marketplace");
    assert.equal(state.pending.size, 0);
    const wait = page.waitForSelector("#never-shown", { timeout: 45000 });
    const rejected = assert.rejects(wait, (error) => error.status === "die cho");
    await pause(100);
    const start = Date.now();
    await assert.rejects(page.evaluate(() => history.pushState({}, "", "/marketplace/ineligible/")), (error) => error.status === "die cho");
    await rejected;
    assert.ok(Date.now() - start < 3000);
    assert.equal(state.pending.size, 0);
  } finally { await browser.close(); }
});

test("check-link queue stops permanently blocked profiles instead of reopening them after 60 seconds", async () => {
  const runtime = { jobs: new Map(), running: false, activeManagers: new Map() };
  const browsers = [];
  const starts = [];
  const writes = [];
  const manager = fixtureManager();
  manager.connectBrowser = async (id) => {
    starts.push(id);
    const { browser } = await fixtureBrowser();
    browsers.push(browser);
    browser.disconnect = async () => {};
    return browser;
  };
  manager.stopHideMyAccProfile = async () => {};
  const tool = createMarketplaceLinkOrderTool({
    runtime, getHideManager: () => manager,
    dangNhap: { async ensureFacebookLogin(manager, page, row, id) { installMarketplaceAccessGuard(manager, page, id, row.name); } },
    buildToolRow: (id, raw) => ({ uid: raw.uid, raw, name: `2v-${raw.uid}-tool` }),
    getRowsByProfileIds: async () => new Map([["p1", { uid: "61500000000001" }], ["p2", { uid: "61500000000002" }]]),
    getGoogleAccessToken: async () => "fixture-token",
    addRuntimeLog() {},
    SheetsClient: class {
      async metadata() { return { sheets: [{ properties: { title: "Orders", sheetId: 0 } }] }; }
      async getValues() { return [["uid", "LINK SP", "tình trạng nick 1"], ["1", "https://www.facebook.com/marketplace/ineligible/", ""], ["2", "https://www.facebook.com/marketplace/ineligible/", ""]]; }
      async batchUpdateValues(value) { writes.push(value); }
    }
  });
  try {
    await tool.run({ marketplaceCheckNick1Id: "p1", marketplaceCheckTabsPerNick: 1, marketplaceCheckSpreadsheetIds: ["fixture-sheet"], credentialsPath: "fixture-only" });
    const deadline = Date.now() + 10000;
    while (runtime.running && Date.now() < deadline) await pause(50);
    assert.equal(runtime.running, false, "Permanent failures must not enter the 60-second restart loop.");
    assert.deepEqual(starts, ["p1"]);
    for (const id of ["p1"]) {
      assert.equal(runtime.jobs.get(id).status, "error");
      assert.equal(runtime.jobs.get(id).result.trangThai, "die cho");
      assert.ok(manager.names.get(id).startsWith("die cho-"));
    }
    assert.deepEqual(writes, []);
  } finally {
    runtime.stopRequested = true;
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  }
});

test("notification tool preserves the marked original name across separate login and profile managers", async () => {
  const { browser } = await fixtureBrowser();
  const runtime = { jobs: new Map(), running: false };
  const manager = fixtureManager("vip-Full 15/7-61500000000000-Arizona-tool");
  manager.getProfileById = async (id) => ({ name: manager.names.get(id), browserType: "chrome" });
  const loginManager = { ...manager, connectBrowser: async () => browser, stopHideMyAccProfile: async () => {} };
  browser.disconnect = async () => {};
  const writes = [];
  const tool = createCheckTb({
    runtime, getManager: () => manager, getLoginManager: () => loginManager, addRuntimeLog() {},
    buildToolRow: (id, raw) => ({ uid: raw.uid, raw }),
    mapErrorForSheet: (error) => { const mapped = mapFullError(error); return { renameStatus: mapped.status, detail: mapped.detail }; },
    createSheetRowSession: async () => ({ rows: new Map([["p1", { uid: "61500000000000" }]]), updateOne: async (id, update) => writes.push(update) }),
    dangNhap: { async ensureFacebookLogin(manager, page, row, id) {
      installMarketplaceAccessGuard(manager, page, id);
      await page.goto("https://www.facebook.com/marketplace/ineligible/");
    } }
  });
  try {
    await tool.runNotificationQueue(["p1"], {}, {});
    const deadline = Date.now() + 10000;
    while (runtime.running && Date.now() < deadline) await pause(50);
    assert.equal(runtime.running, false);
    assert.equal(manager.names.get("p1"), "die cho-vip-Full 15/7-61500000000000-Arizona-tool");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].trangThai, "die cho");
    assert.equal(writes[0].tenChuan, manager.names.get("p1"));
    assert.equal(isUnknownFailure(runtime.jobs.get("p1")), false);
  } finally { runtime.stopRequested = true; await browser.close(); }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chooseListingCondition, LISTING_CONDITIONS } from "../modules/listing_condition.js";
import { createDangBai } from "../modules/dangbai.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const conditionHtml = `
  <div role="combobox" id="condition" onclick="document.querySelector('#options').hidden=false">Condition Used - Like New</div>
  <div id="options" hidden>${LISTING_CONDITIONS.map((label) => `<div role="option" onclick="document.querySelector('#condition').textContent='Condition '+this.textContent;this.parentElement.hidden=true">${label}</div>`).join("")}</div>`;

test("Condition selects every exact option, including New when Used - Like New is already selected", async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage();
    for (const label of LISTING_CONDITIONS) {
      await page.setContent(conditionHtml);
      await chooseListingCondition(page, label);
      assert.equal(await page.$eval("#condition", (node) => node.textContent), `Condition ${label}`);
      assert.equal(await page.$eval("#options", (node) => node.hidden), true);
    }
  } finally { await browser.close(); }
});

test("3v posts normally by default, or hands off to Full only after closing its posting session", async (t) => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = schedule(callback, milliseconds, ...args);
    if (milliseconds >= 30000) timer.unref();
    return timer;
  });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "posting-options-"));
  await fs.writeFile(path.join(folder, "description.txt"), "Fixture description");
  const titleFile = path.join(folder, "title.txt");
  await fs.writeFile(titleFile, "Canonical title\r\n");
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    for (const enabled of [false, true]) {
      const runtime = { jobs: new Map(), running: false };
      const events = [], writes = [];
      let page, published = 0, fullCalls = 0;
      const manager = {
        saveConfig() {},
        async getProfileById() { return { name: "3v-61500000000000-Nuevo, California-tool" }; },
        async updateProfileName() {},
        async connectBrowser() {
          page = await browser.newPage();
          await page.setRequestInterception(true);
          page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: `<h1>Item for sale</h1><p>Preview</p>${conditionHtml}<button>Publish</button>` }).catch(() => {}));
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async gotoWithRetry(target, url) { await target.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: 3 }; },
        async getRandomListingPayload() { return { folderPath: folder, titleFile, title: "Canonical title", photos: [], price: 25 }; },
        async chooseConditionNew() { throw new Error("Original condition must be replaced"); },
        async fillStepOne(target) {
          await this.chooseConditionNew(target);
          assert.equal(await target.$eval("#condition", (node) => node.textContent), "Condition New");
        },
        async setFieldValueByExactLabel() {},
        async clickActionButton(target, label) {
          assert.equal(label, "Publish");
          published += 1;
          await target.setContent("<h1>Your listings</h1>");
        },
        async consumeUsedTitle() { throw new Error("Title must be preserved"); },
        async stopHideMyAccProfile() { events.push("closed"); }
      };
      const sheet = {
        rows: new Map([["p1", { "tên profile hiện tại": "3v-61500000000000-Nuevo, California-tool" }]]),
        async updateOne(id, value) { writes.push(value); }, async flushAll() {}
      };
      const posting = createDangBai({
        getManager: () => manager, dangNhap: { ensureFacebookLogin: async () => ({ ok: true }) },
        addRuntimeLog() {}, buildToolRow: () => ({ uid: "61500000000000", raw: {} }),
        createSheetRowSession: async () => sheet, stateProxy: { ensureForProfile: async () => null }, runtime,
        async runFullProfile(id, row, config, session, slot, total, options) {
          fullCalls += 1;
          assert.equal(page.isClosed(), true);
          assert.deepEqual(events, ["closed"]);
          assert.equal(options.condition, "New");
          assert.equal(session, sheet);
          assert.equal(runtime.running, true);
          assert.equal(runtime.jobs.get(id).finishedAt, "");
          runtime.jobs.get(id).status = "success";
          runtime.jobs.get(id).result = { Tool: "đã làm full", trangThai: "thành công", soVach: "3v" };
        }
      });
      await posting.runQueue(["p1"], { fullDataRoot: folder, fullPriceMin: 20, fullPriceMax: 25, sellerSpreadsheetId: "fixture", postCondition: "New", postThreeVFull: enabled, postConcurrency: 1 });
      for (let i = 0; i < 3000 && runtime.running; i += 1) await pause(10);
      assert.equal(runtime.running, false);
      assert.equal(runtime.jobs.get("p1").status, "success", JSON.stringify(runtime.jobs.get("p1").result));
      assert.equal(fullCalls, enabled ? 1 : 0);
      assert.equal(published, enabled ? 0 : 1);
      assert.equal(await fs.readFile(titleFile, "utf8"), "Canonical title\r\n");
      if (!enabled) assert.equal(writes.at(-1).soVach, "3v");
    }
  } finally {
    await browser.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDangBai } from "../modules/dangbai.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("2v posting preserves title.txt byte-for-byte and can reuse the title on the next run", async (t) => {
  // Legacy step deadlines remain scheduled after success; do not let them keep the test runner open.
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = schedule(callback, milliseconds, ...args);
    if (milliseconds >= 30000) timer.unref();
    return timer;
  });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "post-title-preservation-"));
  const titleFile = path.join(folder, "title.txt");
  const original = Buffer.from("Canonical product title\r\nSecond product title\r\n", "utf8");
  await fs.writeFile(titleFile, original);
  await fs.writeFile(path.join(folder, "description.txt"), "Fixture description", "utf8");
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  let consumed = 0, published = 0, stopped = 0;
  const titles = [], writes = [], logs = [];
  const runtime = { jobs: new Map(), running: false };
  let name = "2v-61500000000000-Nuevo, California-tool";
  const manager = {
    saveConfig() {},
    async getProfileById() { return { name }; },
    async updateProfileName(id, next) { name = next; },
    async connectBrowser() {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        void request.respond({ status: 200, contentType: "text/html", body: `
          <h1>Item for sale</h1><p>Preview</p>
          <section style="width:340px">
            <div><span>Location</span></div>
            <input aria-label="Location" role="combobox" style="width:320px;height:40px">
            <p id="selected"></p>
          </section>
          <button id="publish">Publish</button>
          <script>
            document.querySelector('input').addEventListener('keydown', (event) => {
              if (event.key === 'Enter') document.querySelector('#selected').textContent = event.target.value;
            });
          </script>` }).catch(() => {});
      });
      return { newPage: async () => page, disconnect: async () => {} };
    },
    async gotoWithRetry(page, url) { await page.goto(url, { waitUntil: "domcontentloaded" }); },
    async detectInitialMarketplaceState() { return published === 0 ? { kind: "progress", totalSteps: 2 } : { kind: "publish_only" }; },
    async getRandomListingPayload() {
      const title = (await fs.readFile(titleFile, "utf8")).split(/\r?\n/).filter(Boolean)[0];
      assert.ok(title, "The same folder must remain usable after posting.");
      return { folderPath: folder, titleFile, title, photos: [], price: 25 };
    },
    async fillStepOne(page, payload) { titles.push(payload.title); },
    async setFieldValueByExactLabel(page, label, value) { assert.equal(label, "Description"); assert.equal(value, "Fixture description"); },
    async clickActionButton(page, label) {
      assert.equal(label, "Publish");
      published += 1;
      await page.setContent("<h1>Your listings</h1>");
    },
    async consumeUsedTitle() { consumed += 1; await fs.writeFile(titleFile, ""); },
    async stopHideMyAccProfile() { stopped += 1; }
  };
  const sheet = {
    rows: new Map([["p1", { "tên profile hiện tại": name }]]),
    async updateOne(id, value) { writes.push(value); }, async flushAll() {}
  };
  const posting = createDangBai({
    getManager: () => manager, dangNhap: { ensureFacebookLogin: async () => ({ ok: true }) },
    addRuntimeLog: (message) => logs.push(message), buildToolRow: () => ({ uid: "61500000000000", raw: {} }),
    createSheetRowSession: async () => sheet, stateProxy: { ensureForProfile: async () => null }, runtime
  });
  try {
    for (let run = 0; run < 2; run += 1) {
      await posting.runQueue(["p1"], { fullDataRoot: folder, fullPriceMin: 20, fullPriceMax: 25, postConcurrency: 1 });
      for (let i = 0; i < 3000 && runtime.running; i += 1) await pause(10);
      assert.equal(runtime.running, false, JSON.stringify({ logs, job: runtime.jobs.get("p1") }));
      assert.equal(runtime.jobs.get("p1").status, "success", JSON.stringify(runtime.jobs.get("p1").result));
      assert.equal(runtime.jobs.get("p1").result.soVach, "2v");
      assert.deepEqual(await fs.readFile(titleFile), original);
      assert.equal(writes.at(-1).trangThai, "thành công");
    }
    assert.deepEqual(titles, ["Canonical product title", "Canonical product title"]);
    assert.equal(consumed, 0);
    assert.equal(published, 2);
    assert.equal(stopped, 2);
  } finally {
    await browser.close();
    assert.equal(path.dirname(folder), os.tmpdir());
    await fs.rm(folder, { recursive: true, force: true });
  }
});

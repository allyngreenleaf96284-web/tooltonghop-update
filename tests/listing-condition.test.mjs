import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createRequire } from "node:module";
import { chooseListingCondition, LISTING_CONDITIONS } from "../modules/listing_condition.js";
import { createLamFull } from "../modules/lamfull.js";

const require = createRequire(import.meta.url);
let browser;
before(async () => { browser = await require("puppeteer-core").launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });

async function fixture({ zoom = 50, delay = 0, ignoreFirst = false, plain = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 616, height: 406 });
  await page.setContent(`<style>html{zoom:${zoom / 100}}#field{margin-top:600px;width:300px;height:50px} [role=option]{padding:8px;cursor:pointer}</style>
    <div role="combobox" aria-label="Category">New</div><aside><span>New</span><span>Used - Like New</span></aside>
    <button id="field" role="combobox" aria-label="Condition" aria-controls="conditions" aria-expanded="false">Condition</button>`);
  await page.evaluate(({ delay, ignoreFirst, plain, labels }) => {
    window.opens = 0; window.selections = 0;
    const field = document.getElementById("field");
    field.onclick = () => {
      if (field.getAttribute("aria-expanded") === "true") return;
      window.opens++; field.setAttribute("aria-expanded", "true");
      setTimeout(() => {
        document.getElementById("conditions")?.remove();
        const menu = document.createElement("div"); menu.id = "conditions"; menu.setAttribute("role", "listbox");
        for (const label of labels) {
          const option = document.createElement("div");
          if (!plain) option.setAttribute("role", "option");
          option.textContent = label;
          option.onclick = () => {
            window.selections++;
            field.setAttribute("aria-expanded", "false"); menu.remove();
            if (ignoreFirst && window.selections === 1) return;
            setTimeout(() => { field.textContent = label; field.setAttribute("aria-valuetext", label); }, 120);
          };
          menu.append(option);
        }
        field.after(menu);
      }, delay);
    };
    addEventListener("keydown", (event) => { if (event.key === "Escape") { document.getElementById("conditions")?.remove(); field.setAttribute("aria-expanded", "false"); } });
  }, { delay, ignoreFirst, plain, labels: LISTING_CONDITIONS });
  return page;
}

for (const [zoom, label] of [[25, "New"], [50, "Used - Like New"], [100, "Used - Good"], [75, "Used - Fair"]]) {
  test(`selects ${label} at ${zoom}% while ignoring other New text`, async () => {
    const page = await fixture({ zoom, plain: zoom === 75 });
    try {
      assert.equal(await chooseListingCondition(page, label), true);
      assert.equal(await page.$eval("#field", (node) => node.textContent), label);
      await chooseListingCondition(page, label);
      assert.equal(await page.evaluate(() => selections), 1);
    } finally { await page.close(); }
  });
}

test("a menu delayed beyond the legacy 1.4 seconds is selected without reloading", async () => {
  const page = await fixture({ delay: 2200 });
  try {
    await chooseListingCondition(page, "New");
    assert.equal(await page.evaluate(() => opens), 1);
    assert.equal(await page.$eval("#field", (node) => node.textContent), "New");
  } finally { await page.close(); }
});

test("a click that does not update Condition is retried and never counted as success", async () => {
  const page = await fixture({ ignoreFirst: true });
  try {
    await chooseListingCondition(page, "New", { timeoutMs: 500, recoveryCount: 2 });
    assert.equal(await page.evaluate(() => selections), 2);
    assert.equal(await page.$eval("#field", (node) => node.textContent), "New");
  } finally { await page.close(); }
});

test("native select identified by its label is supported", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<label for="condition">Condition</label><select id="condition"><option value="">Choose</option><option value="new">New</option><option value="used">Used – Like New</option></select>');
    await chooseListingCondition(page, "Used - Like New");
    assert.equal(await page.$eval("select", (node) => node.value), "used");
  } finally { await page.close(); }
});

test("an ignored selection reports failure instead of accepting New from the preview", async () => {
  const page = await fixture({ ignoreFirst: true });
  try {
    await assert.rejects(chooseListingCondition(page, "New", { timeoutMs: 1000, recoveryCount: 1 }),
      (error) => error.status === "loisp" && /truong Condition chua cap nhat/.test(error.message));
    assert.equal(await page.$eval("#field", (node) => node.textContent), "Condition");
  } finally { await page.close(); }
});

test("Full always replaces the bundled chooser, including its default New", async () => {
  for (const condition of [undefined, "Used - Like New"]) {
    const page = await fixture({ zoom: 50 });
    let name = "3v-61500000000001-Nuevo, California";
    const runtime = { jobs: new Map([["p1", { status: "running" }]]) };
    const manager = { saveConfig() {}, getProfileById: async () => ({ name }), getProfileNameById: async () => name,
      updateProfileName: async (id, next) => { name = next; },
      chooseConditionNew: async () => { throw Error("Không chọn được Condition = New."); },
      async runFullFlowAttempt(target) { await this.chooseConditionNew(target); return { ok: true, barStatus: "3v" }; } };
    const full = createLamFull({ getManager: () => manager, getLocationManager: () => ({}), runtime, addRuntimeLog() {},
      buildToolRow: () => ({ uid: "61500000000001", raw: {} }), allocateSellerInfoRow: async () => ({ raw: { SSN: "123456789" } }), updateSellerInfoUid: async () => {} });
    try {
      await full.runProfile("p1", {}, {}, { updateOne: async () => {}, flushAll: async () => {} }, 0, 1,
        { condition, existingSession: { browser: {}, page, location: { initial: "Nuevo, California", current: "Nuevo, California" }, configureManager() {} } });
      assert.equal(runtime.jobs.get("p1").status, "success", JSON.stringify(runtime.jobs.get("p1").result));
      assert.equal(await page.$eval("#field", (node) => node.textContent), condition || "New");
    } finally { await page.close(); }
  }
});

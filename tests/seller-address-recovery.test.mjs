import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createRequire } from "node:module";
import { installSellerAddressRecovery } from "../modules/seller_address_recovery.js";
import { createLamFull } from "../modules/lamfull.js";
import { SELLER_ADDRESS_ERROR, markSellerAddressInvalid, setSellerUid, sellerAddressIsBlocked } from "../modules/seller_info_status.js";

const require = createRequire(import.meta.url);
let browser;
before(async () => { browser = await require("puppeteer-core").launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });

async function fixture({ zoom = 50, popups = 3 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 616, height: 406 });
  await page.setContent(`<style>html{zoom:${zoom / 100}}[role=dialog]{width:350px;background:white;padding:12px} input,button{display:block;height:30px;margin:5px}
    [role=alertdialog]{position:fixed;inset:0;background:rgba(240,240,240,.95);z-index:100;display:flex;justify-content:center;align-items:center}
    .error-card{background:white;padding:15px;width:320px}</style>
    <div role="dialog"><h2>Seller information setup</h2><label>First name<input id="name" aria-label="First name"></label>
    <label>Street address<input id="street" aria-label="Street address"></label><button id="next">Next</button></div>`);
  await page.evaluate((popups) => {
    window.popupsShown = 0; window.dismissed = 0; window.nextClicks = 0;
    function showError(remaining) {
      window.popupsShown++;
      const overlay = document.createElement("div"); overlay.setAttribute("role", "alertdialog");
      const closeOnly = remaining % 2 === 1;
      overlay.innerHTML = '<div class="error-card"><h3>Invalid address</h3><p>Please make sure that your address is correct. Please note that PO boxes can\'t be used.</p>'
        + (closeOnly ? '<button aria-label="Close">×</button>' : '<button>OK</button>') + '</div>';
      overlay.querySelector("button").onclick = () => { window.dismissed++; overlay.remove(); if (remaining > 1) setTimeout(() => showError(remaining - 1), 150); };
      document.body.append(overlay);
    }
    document.getElementById("next").onclick = () => {
      window.nextClicks++;
      if (document.getElementById("street").value === "Rejected address") showError(popups);
      else {
        document.querySelector("[role=dialog]").remove();
        const heading = document.createElement("div"); heading.textContent = "Your tax information"; document.body.append(heading);
      }
    };
  }, popups);
  return page;
}

for (const zoom of [25, 50, 100]) {
  test(`dismisses three repeated popups and replaces seller on the same form at ${zoom}%`, async () => {
    const page = await fixture({ zoom });
    const row = { raw: { address: "Rejected address" } };
    let marked = 0, replacements = 0;
    const manager = {
      async clickSellerInfoNext() { throw Error("legacy Next must not run"); },
      async fillSellerInformation(target, current) { await target.$eval("#street", (input, value) => { input.value = value; }, current.raw.address); }
    };
    const restore = installSellerAddressRecovery(manager, { row, timeoutMs: 3000, quietMs: 300,
      quarantine: async (reason) => { assert.equal(reason, "lỗi địa chỉ"); marked++; },
      replace: async () => {
        assert.equal(await page.evaluate(() => dismissed), 3);
        assert.equal(await page.$("[role=alertdialog]"), null);
        replacements++; row.raw = { address: "Corrected address" };
      }
    });
    try {
      await manager.fillSellerInformation(page, row);
      await manager.clickSellerInfoNext(page);
      assert.equal(marked, 1);
      assert.equal(replacements, 1);
      assert.equal(await page.evaluate(() => nextClicks), 2);
      assert.equal(await page.evaluate(() => popupsShown), 3);
    } finally { restore(); await page.close(); }
  });
}

test("Sheet marking failure stops recovery before another seller is used", async () => {
  const page = await fixture({ popups: 1 });
  const row = { raw: {} };
  const manager = { async clickSellerInfoNext() {}, async fillSellerInformation() {} };
  let replacements = 0;
  const restore = installSellerAddressRecovery(manager, { row, timeoutMs: 1000, quietMs: 100,
    quarantine: async () => { throw Error("Sheet unavailable"); }, replace: async () => { replacements++; } });
  try {
    await page.$eval("#street", (input) => { input.value = "Rejected address"; });
    await assert.rejects(manager.clickSellerInfoNext(page), (error) => error.sellerAddressRecoveryHandled && error.message === "Sheet unavailable");
    assert.equal(replacements, 0);
  } finally { restore(); await page.close(); }
});

test("a delayed address error discovered by the bundled validation wait also resumes in place", async () => {
  const page = await fixture({ popups: 1 });
  const row = { raw: { address: "Rejected address" } };
  let marked = 0, replacements = 0;
  const originalValidation = async () => {
    throw Object.assign(new Error("Invalid address"), { status: "seller_info_invalid", sellerInfoReason: "sai address" });
  };
  const manager = {
    async clickSellerInfoNext() {}, throwIfSellerInfoInvalidDialog: originalValidation,
    async fillSellerInformation(target, current) { await target.$eval("#street", (input, value) => { input.value = value; }, current.raw.address); }
  };
  const restore = installSellerAddressRecovery(manager, { row, timeoutMs: 1500, quietMs: 100,
    quarantine: async () => { marked++; }, replace: async () => { replacements++; row.raw.address = "Corrected address"; } });
  try {
    await manager.throwIfSellerInfoInvalidDialog(page, { timeoutMs: 100 });
    assert.equal(marked, 1); assert.equal(replacements, 1);
    assert.equal(await page.evaluate(() => nextClicks), 1);
  } finally { restore(); assert.equal(manager.throwIfSellerInfoInvalidDialog, originalValidation); await page.close(); }
});

test("Full quarantines matching SSNs, refills the open form and completes without restarting the listing", async () => {
  const page = await fixture();
  const rows = [
    { rowNumber: 2, raw: { SSN: "111223333", address: "Rejected address", uid: "" }, values: ["111223333", "Rejected address", ""] },
    { rowNumber: 3, raw: { SSN: "111-22-3333", address: "Rejected address", uid: "" }, values: ["111-22-3333", "Rejected address", ""] },
    { rowNumber: 4, raw: { SSN: "222334444", address: "Corrected address", uid: "" }, values: ["222334444", "Corrected address", ""] }
  ];
  const writes = [], fills = [], allocations = [];
  const sellerSheet = { title: "Seller", rows, uidIndex: 2, client: { batchUpdateValues: async (data) => writes.push(...data) } };
  let name = "3v-61500000000001-Nuevo, California", listingStarts = 0;
  const runtime = { jobs: new Map([["p1", { status: "running" }]]) };
  const manager = {
    saveConfig() {}, getProfileById: async () => ({ name }), getProfileNameById: async () => name,
    updateProfileName: async (id, next) => { name = next; },
    async clickSellerInfoNext() { throw Error("legacy Next must not run"); },
    async fillSellerInformation(target, current) {
      fills.push(current.raw.SSN);
      await target.$eval("#street", (input, value) => { input.value = value; }, current.raw.address);
    },
    async runFullFlowAttempt(target, borrowedBrowser, row) {
      listingStarts++;
      await this.fillSellerInformation(target, row);
      await this.clickSellerInfoNext(target);
      assert.equal(row.raw.SSN, "222334444");
      return { ok: true, barStatus: "3v" };
    }
  };
  const full = createLamFull({ getManager: () => manager, getLocationManager: () => ({}), runtime, addRuntimeLog() {},
    buildToolRow: () => ({ uid: "61500000000001", raw: {} }),
    allocateSellerInfoRow: async () => {
      const row = rows.find((item) => !item.raw.uid);
      if (!row) throw Error("No free seller");
      setSellerUid(sellerSheet, row, "dang dung:p1"); allocations.push(row.rowNumber);
      return { sheetTitle: sellerSheet.title, rowNumber: row.rowNumber, raw: { ...row.raw } };
    },
    updateSellerInfoUid: async (config, allocation, value) => {
      if (value === SELLER_ADDRESS_ERROR) return markSellerAddressInvalid(sellerSheet, allocation);
      const row = rows.find((item) => item.rowNumber === allocation.rowNumber);
      if (allocation.addressInvalid || sellerAddressIsBlocked(row)) return false;
      setSellerUid(sellerSheet, row, value); return true;
    }
  });
  try {
    await full.runProfile("p1", {}, {}, { updateOne: async () => {}, flushAll: async () => {} }, 0, 1,
      { existingSession: { page, browser: {}, location: { initial: "Nuevo, California", current: "Nuevo, California" }, configureManager() {} } });
    assert.equal(runtime.jobs.get("p1").status, "success", JSON.stringify(runtime.jobs.get("p1").result));
    assert.equal(listingStarts, 1);
    assert.deepEqual(allocations, [2, 4]);
    assert.deepEqual(fills, ["111223333", "222334444"]);
    assert.deepEqual(rows.map((item) => item.raw.uid), ["lỗi địa chỉ", "lỗi địa chỉ", "61500000000001"]);
    assert.equal(writes.length, 2);
  } finally { await page.close(); }
});

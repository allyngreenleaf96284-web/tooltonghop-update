import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bankCellText, createBankBrowser, createChangeBankTool, openBankSheet } from "../modules/change_bank.js";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (stringValue) => ({ formattedValue: stringValue, effectiveValue: { stringValue } });
const accounts = ["00000011", "00000022", "00000033", "00000044", "00000055"];
const network = () => new Error("net::ERR_PROXY_CONNECTION_FAILED");

test("uses exact gid, maps columns by header, keeps digits, and writes the UID as text by grid ID", async () => {
  let updates;
  const client = {
    async metadata() { return { sheets: [{ properties: { sheetId: 0 } }, { properties: { sheetId: 42 } }] }; },
    async request(endpoint, options) {
      assert.match(endpoint, /^:getByDataFilter\?/);
      assert.deepEqual(JSON.parse(options.body).dataFilters, [{ gridRange: { sheetId: 42 } }]);
      return { sheets: [{ properties: { sheetId: 42 }, data: [{ rowData: [
        { values: [text(" UID "), text("note"), text("Bank Account Number")] },
        { values: [text(""), text(""), text(accounts[0])] },
        { values: [text(""), text(""), { effectiveValue: { numberValue: 1234567890123450 }, formattedValue: "1234567890123450" }] }
      ] }] }] };
    },
    async batchUpdate(requests, options) { updates = requests; assert.equal(options.maxAttempts, 1); }
  };
  await assert.rejects(openBankSheet(client, "fixture", "43"), /gid/);
  const sheet = await openBankSheet(client, "fixture", "42");
  const { rows, uidColumn } = await sheet.read();
  assert.equal(rows[0].account, accounts[0]);
  assert.match(rows[1].error, /Văn bản thuần/);
  assert.throws(() => bankCellText({ effectiveValue: { numberValue: 12345 }, formattedValue: "1.23E+4" }), /chính xác/);
  assert.equal(bankCellText({ effectiveValue: { numberValue: 123 }, formattedValue: "00123" }), "00123");
  assert.equal(bankCellText(text("000123456789012345678")), "000123456789012345678");
  await sheet.write(uidColumn, [rows[0]], "00012");
  assert.deepEqual(updates[0].updateCells, {
    start: { sheetId: 42, rowIndex: 1, columnIndex: 0 },
    rows: [{ values: [{ userEnteredValue: { stringValue: "00012" } }] }],
    fields: "userEnteredValue"
  });
  const broken = await openBankSheet({
    ...client, async request() {
      return { sheets: [{ properties: { sheetId: 42 }, data: [{ rowData: [{ values: [text("UID")] }] }] }] };
    }
  }, "fixture", "42");
  await assert.rejects(broken.read(), /bank account number/);
});

async function fixture(t, { values, profiles = { p1: "profile one" }, behavior = {} }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "change-bank-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = path.join(dir, "journal.json");
  const rows = values.map(([account, uid = ""], index) => ({ rowNumber: index + 2, account, uid }));
  const names = new Map(Object.entries(profiles));
  const uids = new Map([...names.keys()].map((id, i) => [id, String(10000 + i)]));
  const runtime = { jobs: new Map() };
  const events = [], logs = [];
  let active = 0, maxActive = 0;
  const tool = createChangeBankTool({
    runtime, journalPath,
    async openSheet() {
      return {
        key: "fixture:42",
        async read() { return { rows: structuredClone(rows), accountColumn: 0, uidColumn: 1 }; },
        async write(column, targets, value) {
          events.push(["write", targets.map((row) => row.rowNumber), value]);
          await behavior.write?.(targets, value, rows);
          for (const { rowNumber } of targets) rows[rowNumber - 2].uid = value;
        }
      };
    },
    getManager() {
      return {
        async getProfileById(id) { return { name: names.get(id) }; },
        async updateProfileName(id, name) {
          await behavior.rename?.(id);
          names.set(id, name);
          events.push(["rename", id, name]);
        },
        async connectBrowser(id) {
          events.push(["open", id]);
          active += 1;
          maxActive = Math.max(active, maxActive);
          const page = { id, async goto(url) { assert.match(url, /\/link_payments/); await behavior.goto?.(id); },
            async cookies() { return [{ name: "c_user", value: uids.get(id) }]; },
            async close() {} };
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async stopHideMyAccProfile(id) { active -= 1; events.push(["close", id]); }
      };
    },
    async getRowsByProfileIds(_, ids) { return new Map(ids.map((id) => [id, { uid: uids.get(id) }])); },
    buildToolRow: (_, row) => row,
    dangNhap: { async ensureFacebookLogin() {} },
    stateProxy: {
      async ensureForProfile({ profileId, previousLease }) {
        events.push(["proxy", profileId, previousLease?.raw]);
        await behavior.proxy?.(profileId, names);
        return { raw: previousLease ? "proxy-2" : "proxy-1" };
      },
      release() {}
    },
    addRuntimeLog(message) { logs.push(message); },
    bankBrowser: {
      async prepare(page, account) {
        events.push(["prepare", page.id, account]);
        await behavior.prepare?.(page.id, account, rows);
      },
      async submit(page, account) {
        events.push(["submit", page.id, account]);
        return behavior.submit ? behavior.submit(page.id, account, rows) : "success";
      },
      async dismiss(page) { events.push(["dismiss", page.id]); },
      async recheck(page, account) {
        events.push(["recheck", page.id, account]);
        return behavior.recheck?.(page.id, account) ?? false;
      }
    }
  });
  async function run(ids = [...names.keys()], options = {}) {
    const result = await tool.run(ids, { browserApiProvider: "gpm" }, { concurrency: 4, authorized: true, ...options });
    const deadline = Date.now() + 5000;
    while (runtime.running && Date.now() < deadline) await pause();
    assert.equal(runtime.running, false);
    assert.ok(logs.every((line) => accounts.every((account) => !line.includes(account))));
    return result;
  }
  return { run, rows, names, events, logs, runtime, journalPath, get maxActive() { return maxActive; } };
}

test("limits workers to four, processes only selected profiles, and skips initial and newly renamed profiles", async (t) => {
  const f = await fixture(t, {
    values: accounts.map((account) => [account]),
    profiles: { p1: "one", p2: "two", p3: "three", p4: "four", p5: "five", p6: "paused full", p7: "ORDER test", p8: "late", p9: "not selected", p10: "old-DDbank profile" },
    behavior: {
      proxy(id, names) { if (id === "p8") names.set(id, "DDBANK-late"); },
      async submit() { await pause(50); return "success"; }
    }
  });
  const result = await f.run(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p10"], { concurrency: 20 });
  assert.equal(result.concurrency, 4);
  assert.equal(f.maxActive, 4);
  assert.deepEqual(f.events.filter(([event]) => event === "open").map(([, id]) => id), ["p1", "p2", "p3", "p4", "p5"]);
  for (const id of ["p6", "p7", "p8", "p10"]) assert.equal(f.runtime.jobs.get(id).status, "skipped");
});

test("serializes duplicate accounts and marks only empty matching rows at or below a rejected row", async (t) => {
  let rejectLimit;
  const hold = new Promise((resolve) => { rejectLimit = resolve; });
  const f = await fixture(t, {
    values: [[accounts[0], "123"], [accounts[0]], [accounts[0], "999"], [accounts[0]], [accounts[1]], [accounts[2]]],
    profiles: { p1: "one", p2: "two" },
    behavior: {
      async submit(id, account) {
        if (account === accounts[0]) { await hold; return "limit"; }
        if (id === "p2") rejectLimit();
        return "success";
      }
    }
  });
  await f.run();
  assert.deepEqual(f.events.filter(([type]) => type === "submit").map(([, id, account]) => [id, account]), [
    ["p1", accounts[0]], ["p2", accounts[1]], ["p1", accounts[2]]
  ]);
  assert.deepEqual(f.rows.map(({ uid }) => uid), ["123", "x", "999", "x", "10001", "10000"]);
  assert.equal(f.names.get("p1"), "ddbank-one");
});

test("bank exhaustion lets the submitted result finish and prevents opening another profile", async (t) => {
  const f = await fixture(t, {
    values: [[accounts[0]]], profiles: { p1: "one", p2: "two" },
    behavior: { async submit() { await pause(40); return "success"; } }
  });
  await f.run();
  assert.equal(f.events.filter(([type]) => type === "open").length, 1);
  assert.equal(f.rows[0].uid, "10000");
  assert.match(f.runtime.jobs.get("p2").liveStatus, /Hết bank/);
});

test("rotates proxy before submit, preserves the same bank and sends exactly once", async (t) => {
  let failure = true;
  const f = await fixture(t, { values: [[accounts[0]]], behavior: { goto() { if (failure) { failure = false; throw network(); } } } });
  await f.run();
  assert.deepEqual(f.events.filter(([type]) => type === "proxy").map(([, , previous]) => previous), [undefined, "proxy-1"]);
  assert.deepEqual(f.events.filter(([type]) => type === "submit").map(([, , account]) => account), [accounts[0]]);
  assert.equal(f.rows[0].uid, "10000");
});

for (const verified of [true, false]) {
  test(`post-submit proxy loss rechecks the same session owner without resubmission (verified=${verified})`, async (t) => {
    const f = await fixture(t, {
      values: [[accounts[0]], [accounts[1]]],
      behavior: { submit() { throw network(); }, recheck() { return verified; } }
    });
    await f.run();
    assert.equal(f.events.filter(([type]) => type === "open").length, 2);
    assert.equal(f.events.filter(([type]) => type === "recheck").length, 1);
    assert.equal(f.rows[0].uid, verified ? "10000" : "");
    if (!verified) {
      assert.match(f.runtime.jobs.get("p1").liveStatus, /Cần kiểm tra/);
      const journal = await readFile(f.journalPath, "utf8");
      assert.match(journal, /submitting/);
      assert.ok(!journal.includes(accounts[0]));
      await f.run();
    }
    assert.equal(f.events.filter(([type]) => type === "submit").length, 1);
  });
}

test("checks fresh Sheet before submit and preserves any concurrent edits after submit", async (t) => {
  const before = await fixture(t, {
    values: [[accounts[0]]], behavior: { prepare(id, account, rows) { rows[0].account = accounts[1]; } }
  });
  await before.run();
  assert.equal(before.events.some(([type]) => type === "submit"), false);
  assert.match(before.runtime.jobs.get("p1").liveStatus, /Dòng Sheet đã thay đổi/);

  const after = await fixture(t, {
    values: [[accounts[0]]], behavior: { submit(id, account, rows) { rows[0].uid = "888"; return "success"; } }
  });
  await after.run();
  assert.equal(after.rows[0].uid, "888");
  assert.match(after.runtime.jobs.get("p1").liveStatus, /Facebook đã xác nhận/);
  await after.run(["p1"], { retryOnly: true, authorized: false });
  assert.equal(after.rows[0].uid, "888");
  assert.equal(after.events.filter(([type]) => type === "submit").length, 1);
});

test("retries only the missing Sheet write or rename after Facebook success", async (t) => {
  let writeFails = true;
  let renameFails = true;
  const f = await fixture(t, {
    values: [[accounts[0]]],
    behavior: {
      write() { if (writeFails) { writeFails = false; throw new Error("fixture write error"); } },
      rename() { if (renameFails) { renameFails = false; throw new Error("fixture rename error"); } }
    }
  });
  await f.run();
  assert.equal(f.rows[0].uid, "");
  assert.match(f.runtime.jobs.get("p1").liveStatus, /Facebook đã xác nhận/);
  await f.run(["p1"], { retryOnly: true, authorized: false });
  assert.equal(f.rows[0].uid, "10000");
  assert.equal(f.names.get("p1"), "profile one");
  await f.run(["p1"], { retryOnly: true, authorized: false });
  assert.equal(f.names.get("p1"), "ddbank-profile one");
  assert.equal(f.events.filter(([type]) => type === "submit").length, 1);
  assert.equal(f.events.filter(([type]) => type === "write").length, 2);
  assert.equal(f.events.filter(([type]) => type === "open").length, 1);
});

test("browser reads real control states, handles two successive limit dialogs, and waits for sales after click", async () => {
  const require = createRequire(import.meta.url);
  const browser = await require("puppeteer-core").launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: `
      <div role="dialog"><h2>Link payment account</h2>
        <label>Bank account number<input id="account"></label>
        <label>Confirm bank account number<input id="confirmation"></label>
        <button id="submit">Link bank account</button>
      </div>
      <script>
      window.submissions = [];
      const show = (message, done) => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'alertdialog');
        dialog.innerHTML = '<p>' + message + '</p><button>OK</button>';
        dialog.querySelector('button').onclick = () => { dialog.remove(); done(); };
        document.body.append(dialog);
      };
      document.querySelector('#submit').onclick = () => {
        window.submissions.push([document.querySelector('#account').value, document.querySelector('#confirmation').value]);
        if (window.submissions.length === 1) {
          setTimeout(() => show('Error 1861012', () => setTimeout(() => show(
            'This bank account has been added to Facebook the maximum number of times.', () => {}
          ), 30)), 20);
        } else setTimeout(() => history.pushState({}, '', '/marketplace/you/sales'), 30);
      };
      </script>` }).catch(() => {}));
    await page.goto("https://www.facebook.com/marketplace/seller/link_payments");
    const ui = createBankBrowser({ waitMs: 1800, pollMs: 25, dismissQuietMs: 100 });
    await ui.prepare(page, accounts[0]);
    assert.equal(await ui.submit(page, accounts[0]), "limit");
    await ui.dismiss(page);
    assert.equal(await page.$('[role="alertdialog"]'), null);
    await ui.prepare(page, accounts[1]);
    assert.equal(await ui.submit(page, accounts[1]), "success");
    assert.deepEqual(await page.evaluate(() => window.submissions), [[accounts[0], accounts[0]], [accounts[1], accounts[1]]]);
  } finally { await browser.close(); }
});

test("the Đổi Bank UI filters by UID and sends only selected IDs", async () => {
  const require = createRequire(import.meta.url);
  const browser = await require("puppeteer-core").launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true
  });
  try {
    const [html, source] = await Promise.all([
      readFile(new URL("../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/app.js", import.meta.url), "utf8")
    ]);
    const page = await browser.newPage();
    const fixtureHtml = html.slice(html.indexOf('<section id="changeBankModule"'), html.indexOf('<section id="postModule"')).replace("module-view hidden", "module-view");
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: fixtureHtml }).catch(() => {}));
    await page.goto("https://change-bank.test/");
    assert.ok(await page.$(".control-deck .search-panel #changeBankSearch"));
    const parser = source.slice(source.indexOf("function parseBulkTerms("), source.indexOf("function profileHaystack("));
    const uiScript = `
      const $ = id => document.getElementById(id);
      const state = { selectedFolderId: "all", profiles: [
        { id: "p1", uid: "10001", name: "one" },
        { id: "p2", uid: "10002", name: "10001 appears in the profile name only" }
      ] };
      const compareProfiles = () => 0;
      const sheetValue = () => "";
      const escapeHtml = String, escapeAttr = String;
      const pageProfileTable = profiles => profiles;
      const orderProfilesByPastedTerms = profiles => profiles;
      const orderProfileIdsTopDown = ids => ids;
      const saveConfig = async () => {};
      const startToolStatusPolling = () => {};
      const refreshToolStatus = async () => {};
      const stopCurrentTool = () => {};
      const api = async (url, options) => {
        window.started = { url, ...JSON.parse(options.body) };
        return { data: { started: 1, concurrency: 4 } };
      };
      ${parser}
      ${source.slice(source.indexOf("const changeBankSelected = new Set();"))}
      renderChangeBankRows();
    `;
    await page.addScriptTag({ content: uiScript });
    await page.type("#changeBankSearch", "10001");
    assert.deepEqual(await page.$$eval("[data-bank-profile]", (nodes) => nodes.map((node) => node.dataset.bankProfile)), ["p1"]);
    await page.click('[data-bank-profile="p1"]');
    await page.type("#changeBankSheetLink", "https://docs.google.com/spreadsheets/d/test/edit?gid=42");
    await page.$eval("#changeBankConcurrency", (node) => { node.value = "9"; });
    await page.click("#changeBankAuthorized");
    await page.click("#changeBankRun");
    assert.deepEqual(await page.evaluate(() => window.started), {
      url: "/api/tools/doi-bank", profileIds: ["p1"], concurrency: 4,
      sheetLink: "https://docs.google.com/spreadsheets/d/test/edit?gid=42", authorized: true, retryOnly: false
    });
    await page.reload();
    await page.addScriptTag({ content: uiScript });
    assert.equal(await page.$eval("#changeBankSheetLink", (input) => input.value), "https://docs.google.com/spreadsheets/d/test/edit?gid=42");
  } finally { await browser.close(); }
});

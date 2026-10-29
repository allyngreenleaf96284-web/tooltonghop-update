import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createToolLogin } from "../modules/tool_login.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Login enters Full only for 3v with the option on, and honours Stop during handoff", async (t) => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = schedule(callback, milliseconds, ...args);
    if (milliseconds >= 25000) timer.unref();
    return timer;
  });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    for (const [enabled, bars, stop] of [[false, 3, false], [true, 3, false], [true, 2, false], [true, 4, false], [true, 3, true]]) {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: '<h1>Item for sale</h1><p>Preview</p><button role="button" aria-label="Location: Nuevo, California">Nuevo, California</button><input aria-label="Title"><button>Next</button>' }).catch(() => {}));
      const runtime = { jobs: new Map(), running: false };
      const writes = [], events = [];
      let name = "61594499510154-Nuevo, California", fullCalls = 0;
      const sheet = {
        rows: new Map([["p1", { "tên profile hiện tại": name }]]),
        async updateOne(id, update) { writes.push(update); }, async flushAll() {}
      };
      const manager = {
        async getProfileById() { return { name, browserType: "chrome" }; },
        async updateProfileName(id, next) { name = next; },
        async connectBrowser() { return { newPage: async () => page, disconnect: async () => {} }; },
        async gotoWithRetry(target, url) { await target.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: bars }; },
        async stopHideMyAccProfile() { events.push("closed"); if (stop) runtime.stopRequested = true; }
      };
      const login = createToolLogin({
        getManager: () => manager, dangNhap: { ensureFacebookLogin: async () => ({ ok: true }) },
        addRuntimeLog() {}, buildToolRow: () => ({ uid: "61594499510154", raw: {} }),
        createSheetRowSession: async () => sheet, runtime,
        stateProxy: { ensureForProfile: async () => null },
        async runFullProfile(id, row, config, session, slot, total) {
          fullCalls += 1;
          assert.equal(page.isClosed(), true);
          assert.deepEqual(events, ["closed"]);
          assert.equal(session, sheet);
          assert.equal(slot, 0);
          assert.equal(total, 1);
          assert.equal(runtime.running, true);
          assert.equal(runtime.jobs.get(id).status, "running");
          assert.equal(runtime.jobs.get(id).finishedAt, "");
          assert.equal(writes.some((update) => update.trangThai === "thành công"), false);
          runtime.jobs.get(id).status = "success";
          runtime.jobs.get(id).result = { Tool: "đã làm full", trangThai: "thành công", soVach: "3v" };
        }
      });
      await login.runQueue(["p1"], { loginConcurrency: 1, loginThreeVFull: enabled, fullDataRoot: "fixture", fullPriceMin: 20, fullPriceMax: 25, sellerSpreadsheetId: "fixture" });
      for (let attempt = 0; attempt < 2000 && runtime.running; attempt += 1) await pause(10);
      assert.equal(runtime.running, false);
      const job = runtime.jobs.get("p1");
      assert.equal(job.status, stop ? "stopped" : "success", JSON.stringify(job.result));
      assert.equal(fullCalls, enabled && bars === 3 && !stop ? 1 : 0);
      if (!stop && !(enabled && bars === 3)) {
        assert.equal(job.result.Tool, "tool login");
        assert.equal(job.result.soVach, `${bars}v`);
        assert.match(name, new RegExp(`${bars}v`));
      }
    }
  } finally { await browser.close(); }
});

test("Login validates Full settings only when the 3v Full option is enabled", async () => {
  const login = createToolLogin({ getManager() {}, addRuntimeLog() {}, runtime: { jobs: new Map() },
    createSheetRowSession: async () => { throw new Error("unexpected Sheet access"); }, runFullProfile: async () => {} });
  await assert.rejects(login.runQueue(["p1"], { loginThreeVFull: true }), /Seller Info Spreadsheet ID/);
});

test("Login holds an errored worker, other workers continue, and F9 saves its name to Sheet before advancing", async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const runtime = { jobs: new Map(), running: false };
  const pages = new Map(), names = new Map(["p1", "p2", "p3"].map((id) => [id, `61594499510154-Nuevo, California-${id}`]));
  const writes = [], closed = [];
  const sheet = { rows: new Map([...names].map(([id, name]) => [id, { "tên profile hiện tại": name }])),
    async updateOne(id, update) { writes.push({ id, update }); }, async flushAll() {} };
  const login = createToolLogin({
    getManager: () => {
      let ownId;
      return {
        async getProfileById(id) { return { name: names.get(id), browserType: "chrome" }; },
        async updateProfileName(id, value) { names.set(id, value); },
        async connectBrowser(id) {
          ownId = id;
          const page = await browser.newPage(); pages.set(id, page);
          await page.setRequestInterception(true);
          page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: '<h1>Item for sale</h1><p>Preview</p><button role="button" aria-label="Location: Nuevo, California">Nuevo, California</button><input aria-label="Title"><button>Next</button>' }).catch(() => {}));
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async gotoWithRetry(page, url) { await page.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: 3 }; },
        async stopHideMyAccProfile(id) { closed.push(id || ownId); }
      };
    },
    dangNhap: { ensureFacebookLogin: async (manager, page, row, id) => { if (id === "p1") throw Object.assign(Error("fixture needs user attention"), { status: "stopped" }); return { ok: true }; } },
    addRuntimeLog() {}, buildToolRow: () => ({ uid: "61594499510154", raw: {} }),
    createSheetRowSession: async () => sheet, runtime, stateProxy: { ensureForProfile: async () => null }
  });
  const until = async (check) => {
    for (let i = 0; i < 1500; i++) { if (check()) return; await pause(10); }
    throw Error("fixture timed out");
  };
  try {
    await login.runQueue(["p1", "p2", "p3"], { loginConcurrency: 2 });
    await until(() => runtime.jobs.get("p1")?.loginNeedsAttention && runtime.jobs.get("p3")?.status === "success");
    assert.equal(runtime.jobs.get("p1").status, "running");
    assert.equal(closed.includes("p1"), false);
    assert.ok(writes.some(({ id, update }) => id === "p1" && update.trangThai === "chờ xử lý"));
    const page = pages.get("p1");
    await page.keyboard.press("F9");
    await page.waitForSelector("#tool-login-operator-dialog input:not(:disabled)");
    await page.waitForFunction(() => !document.querySelector("#tool-login-operator-dialog button").disabled);
    await page.$eval("#tool-login-operator-dialog input", (input) => { input.value = "operator-note-p1"; });
    await page.click("#tool-login-operator-dialog button");
    await until(() => !runtime.running);
    assert.equal(runtime.jobs.get("p1").status, "skipped");
    assert.equal(runtime.jobs.get("p1").manualHandled, true);
    assert.equal(names.get("p1"), "operator-note-p1");
    assert.equal(closed.filter((id) => id === "p1").length, 1);
    assert.ok(writes.some(({ id, update }) => id === "p1" && update["tên profile hiện tại"] === "operator-note-p1"));
    assert.equal(runtime.jobs.get("p2").status, "success");
  } finally {
    runtime.stopRequested = true;
    await browser.close();
  }
});

test("Login retries a proxy failure before opening a browser without restarting other workers", async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const runtime = { jobs: new Map(), running: false };
  const pages = new Map(), names = new Map(["p1", "p2", "p3"].map((id) => [id, `61594499510154-Nuevo, California-${id}`]));
  const writes = [], closed = [];
  let attempts = 0;
  const sheet = { rows: new Map([...names].map(([id, name]) => [id, { "tên profile hiện tại": name }])),
    async updateOne(id, update) { writes.push({ id, update }); }, async flushAll() {} };
  const login = createToolLogin({
    getManager: () => {
      let ownId;
      return {
        async getProfileById(id) { return { name: names.get(id), browserType: "chrome" }; },
        async updateProfileName(id, value) { names.set(id, value); },
        async connectBrowser(id) {
          ownId = id;
          const page = await browser.newPage(); pages.set(id, page);
          await page.setRequestInterception(true);
          page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: '<h1>Item for sale</h1><p>Preview</p><button role="button" aria-label="Location: Nuevo, California">Nuevo, California</button><input aria-label="Title"><button>Next</button>' }).catch(() => {}));
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async gotoWithRetry(page, url) { await page.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: 3 }; },
        async stopHideMyAccProfile(id) { closed.push(id || ownId); }
      };
    },
    dangNhap: { ensureFacebookLogin: async (manager, page, row, id) => { return { ok: true }; } },
    addRuntimeLog() {}, buildToolRow: () => ({ uid: "61594499510154", raw: {} }),
    createSheetRowSession: async () => sheet, runtime, stateProxy: { ensureForProfile: async ({ profileId }) => { if (profileId === "p1" && ++attempts === 1) throw Error("proxy allocation failed"); return null; } }
  });
  const until = async (check) => {
    for (let i = 0; i < 1500; i++) { if (check()) return; await pause(10); }
    throw Error("fixture timed out");
  };
  try {
    await login.runQueue(["p1", "p2", "p3"], { loginConcurrency: 2 });
    await until(() => runtime.jobs.get("p1")?.loginNeedsAttention && runtime.jobs.get("p3")?.status === "success");
    assert.equal(runtime.jobs.get("p1").status, "running");
    assert.equal(closed.includes("p1"), false);
    assert.ok(writes.some(({ id, update }) => id === "p1" && update.trangThai === "chờ xử lý"));
    assert.equal(pages.has("p1"), false);
    login.retryProfile("p1");
    assert.equal(login.retryProfile("p1").retrying, true);
    await until(() => !runtime.running);
    assert.equal(runtime.jobs.get("p1").status, "success");
    assert.equal(attempts, 2);
    assert.equal(closed.filter((id) => id === "p2").length, 1);
    assert.equal(runtime.jobs.get("p2").status, "success");
  } finally {
    runtime.stopRequested = true;
    await browser.close();
  }
});

test("Login retries an outer profile validation error in the same worker", async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const runtime = { jobs: new Map(), running: false };
  const pages = new Map(), names = new Map(["p1", "p2", "p3"].map((id) => [id, `61594499510154-Nuevo, California-${id}`]));
  const writes = [], closed = [];
  let attempts = 0;
  const sheet = { rows: new Map([...names].map(([id, name]) => [id, { "tên profile hiện tại": name }])),
    async updateOne(id, update) { writes.push({ id, update }); }, async flushAll() {} };
  const login = createToolLogin({
    getManager: () => {
      let ownId;
      return {
        async getProfileById(id) { return { name: names.get(id), browserType: id === "p1" && ++attempts === 1 ? "unsupported" : "chrome" }; },
        async updateProfileName(id, value) { names.set(id, value); },
        async connectBrowser(id) {
          ownId = id;
          const page = await browser.newPage(); pages.set(id, page);
          await page.setRequestInterception(true);
          page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: '<h1>Item for sale</h1><p>Preview</p><button role="button" aria-label="Location: Nuevo, California">Nuevo, California</button><input aria-label="Title"><button>Next</button>' }).catch(() => {}));
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async gotoWithRetry(page, url) { await page.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: 3 }; },
        async stopHideMyAccProfile(id) { closed.push(id || ownId); }
      };
    },
    dangNhap: { ensureFacebookLogin: async (manager, page, row, id) => { return { ok: true }; } },
    addRuntimeLog() {}, buildToolRow: () => ({ uid: "61594499510154", raw: {} }),
    createSheetRowSession: async () => sheet, runtime, stateProxy: { ensureForProfile: async () => null }
  });
  const until = async (check) => {
    for (let i = 0; i < 1500; i++) { if (check()) return; await pause(10); }
    throw Error("fixture timed out");
  };
  try {
    await login.runQueue(["p1", "p2", "p3"], { loginConcurrency: 2 });
    await until(() => runtime.jobs.get("p1")?.loginNeedsAttention && runtime.jobs.get("p3")?.status === "success");
    assert.equal(runtime.jobs.get("p1").status, "running");
    assert.equal(closed.includes("p1"), false);
    assert.ok(writes.some(({ id, update }) => id === "p1" && update.trangThai === "chờ xử lý"));
    assert.equal(pages.has("p1"), false);
    login.retryProfile("p1");
    assert.equal(login.retryProfile("p1").retrying, true);
    await until(() => !runtime.running);
    assert.equal(runtime.jobs.get("p1").status, "success");
    assert.ok(attempts >= 2);
    assert.equal(closed.filter((id) => id === "p2").length, 1);
    assert.equal(runtime.jobs.get("p2").status, "success");
  } finally {
    runtime.stopRequested = true;
    await browser.close();
  }
});

test("F10 closes only the focused profile and requests another proxy before restarting it", async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const runtime = { jobs: new Map(), running: false };
  const pages = new Map(), names = new Map(["p1", "p2", "p3"].map((id) => [id, `61594499510154-Nuevo, California-${id}`]));
  const writes = [], closed = [];
  let loginAttempts = 0, allocations = 0;
  const sheet = { rows: new Map([...names].map(([id, name]) => [id, { "tên profile hiện tại": name }])),
    async updateOne(id, update) { writes.push({ id, update }); }, async flushAll() {} };
  const login = createToolLogin({
    getManager: () => {
      let ownId;
      return {
        async getProfileById(id) { return { name: names.get(id), browserType: "chrome" }; },
        async updateProfileName(id, value) { names.set(id, value); },
        async connectBrowser(id) {
          ownId = id;
          const page = await browser.newPage(); pages.set(id, page);
          await page.setRequestInterception(true);
          page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: '<h1>Item for sale</h1><p>Preview</p><button role="button" aria-label="Location: Nuevo, California">Nuevo, California</button><input aria-label="Title"><button>Next</button>' }).catch(() => {}));
          return { newPage: async () => page, disconnect: async () => {} };
        },
        async gotoWithRetry(page, url) { await page.goto(url); },
        async detectInitialMarketplaceState() { return { kind: "progress", totalSteps: 3 }; },
        async stopHideMyAccProfile(id) { closed.push(id || ownId); }
      };
    },
    dangNhap: { ensureFacebookLogin: async (manager, page, row, id) => { if (id === "p1" && ++loginAttempts === 1) throw Object.assign(Error("fixture needs user attention"), { status: "stopped" }); return { ok: true }; } },
    addRuntimeLog() {}, buildToolRow: () => ({ uid: "61594499510154", raw: {} }),
    createSheetRowSession: async () => sheet, runtime, stateProxy: { ensureForProfile: async ({ profileId, previousLease }) => {
      if (profileId !== "p1") return null;
      allocations++;
      if (allocations === 2) {
        assert.equal(previousLease.raw, "old-proxy");
        assert.equal(closed.filter((id) => id === "p1").length, 1);
        assert.equal(pages.get("p1").isClosed(), true);
      }
      return { raw: allocations === 1 ? "old-proxy" : "new-proxy" };
    }, release() {} }
  });
  const until = async (check) => {
    for (let i = 0; i < 1500; i++) { if (check()) return; await pause(10); }
    throw Error("fixture timed out");
  };
  try {
    await login.runQueue(["p1", "p2", "p3"], { loginConcurrency: 2 });
    await until(() => runtime.jobs.get("p1")?.loginNeedsAttention && runtime.jobs.get("p3")?.status === "success");
    assert.equal(runtime.jobs.get("p1").status, "running");
    assert.equal(closed.includes("p1"), false);
    assert.ok(writes.some(({ id, update }) => id === "p1" && update.trangThai === "chờ xử lý"));
    const page = pages.get("p1");
    await page.keyboard.press("F10");
    await until(() => !runtime.running);
    assert.equal(runtime.jobs.get("p1").status, "success");
    assert.equal(allocations, 2);
    assert.equal(closed.filter((id) => id === "p1").length, 2);
    assert.equal(closed.filter((id) => id === "p2").length, 1);
    assert.equal(runtime.jobs.get("p2").status, "success");
  } finally {
    runtime.stopRequested = true;
    await browser.close();
  }
});

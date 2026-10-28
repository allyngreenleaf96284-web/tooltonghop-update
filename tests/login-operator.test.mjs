import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";
import { createLoginOperator } from "../modules/login_operator.js";
import { createLoginPause } from "../modules/login_pause.js";
import { createLiveSheetWriter } from "../modules/tool_login.js";

function fixture() {
  const runtime = { running: true, currentTool: "tool login", jobs: new Map(["a", "b"].map((id) => [id, { status: "running", tool: "tool login" }])) };
  const pause = createLoginPause(runtime), operator = createLoginOperator(runtime, pause);
  const names = new Map([["a", "old A"], ["b", "old B"]]);
  const events = [];
  const manager = {
    getProfileById: async (id) => ({ name: names.get(id) }),
    updateProfileName: async (id, name) => { names.set(id, name); events.push(`name:${id}`); },
    stopHideMyAccProfile: async (id) => { events.push(`close:${id}`); }
  };
  for (const id of names.keys()) operator.register(id, { manager, job: runtime.jobs.get(id), writer: { commit: async () => { events.push(`sheet:${id}`); } } });
  return { operator, runtime, pause, names, events, manager };
}

test("manual editor pauses only its profile and closes only after confirmed name and Sheet save", async () => {
  const f = fixture();
  const opened = await f.operator.request("a", { action: "open" });
  assert.equal(opened.name, "old A");
  assert.equal(f.runtime.jobs.get("a").loginPaused, true);
  assert.notEqual(f.runtime.jobs.get("b").loginPaused, true);
  await f.operator.request("a", { action: "save", token: opened.token, name: "manual note A" });
  assert.deepEqual(f.events, ["name:a", "sheet:a", "close:a"]);
  assert.equal(f.names.get("b"), "old B");
  assert.equal(f.runtime.jobs.get("a").manualHandled, true);
  await assert.rejects(f.pause.gate("a"), (e) => e.code === "LOGIN_MANUAL_DONE");
});

test("F9 binding inherited from an expired browser-opening context can save while automation stays paused", async () => {
  const f = fixture();
  f.pause.guard(f.manager, ["updateProfileName"]);
  let browserBinding, staleRename;
  await f.pause.run("a", async () => {
    browserBinding = AsyncResource.bind((input) => f.operator.request("a", input));
    staleRename = AsyncResource.bind(() => f.manager.updateProfileName("b", "must not run"));
  });
  const opened = await browserBinding({ action: "open" });
  assert.equal(f.runtime.jobs.get("a").loginPaused, true);
  await assert.rejects(staleRename(), (error) => error.code === "LOGIN_PAUSED");
  await browserBinding({ action: "save", token: opened.token, name: "F9 note" });
  assert.deepEqual(f.events, ["name:a", "sheet:a", "close:a"]);
  assert.equal(f.names.get("a"), "F9 note");
  assert.equal(f.names.get("b"), "old B");
});

test("F9 dialog saves through a real browser connection created in a completed automation step", async () => {
  const puppeteer = createRequire(import.meta.url)("puppeteer-core");
  const f = fixture();
  f.pause.guard(f.manager, ["updateProfileName"]);
  const browser = await f.pause.run("a", () => puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }));
  try {
    const page = await browser.newPage();
    await f.operator.attach(page, "a");
    await page.goto("data:text/html,<h1>Profile A</h1>");
    await page.keyboard.press("F9");
    await page.waitForSelector("#tool-login-operator-dialog input:not(:disabled)");
    await page.$eval("#tool-login-operator-dialog input", (input) => { input.value = "direct F9"; });
    await page.click("#tool-login-operator-dialog button");
    await page.waitForFunction(() => !document.getElementById("tool-login-operator-dialog"));
    assert.equal(f.names.get("a"), "direct F9");
    assert.deepEqual(f.events, ["name:a", "sheet:a", "close:a"]);
    assert.equal(f.names.get("b"), "old B");
  } finally { await browser.close(); }
});

test("Sheet failure keeps profile open and allows retry without overwriting another profile", async () => {
  const f = fixture();
  const state = f.operator.get("a");
  let fails = true;
  state.writer.commit = async () => { if (fails) throw Error("Sheet offline"); f.events.push("sheet:a"); };
  const opened = await f.operator.request("a", { action: "open" });
  await assert.rejects(f.operator.request("a", { action: "save", token: opened.token, name: "note" }), /Sheet offline/);
  assert.equal(f.names.get("a"), "note");
  assert.equal(f.events.some((e) => e.startsWith("close")), false);
  assert.notEqual(f.runtime.jobs.get("a").manualHandled, true);
  fails = false;
  await f.operator.request("a", { action: "save", token: opened.token, name: "note" });
  assert.equal(f.events.at(-1), "close:a");
});

test("stale editor or changed GPM name cannot silently overwrite a newer name", async () => {
  const f = fixture();
  const old = await f.operator.request("a", { action: "open" });
  const fresh = await f.operator.request("a", { action: "open" });
  await assert.rejects(f.operator.request("a", { action: "save", token: old.token, name: "bad" }), /da cu/);
  f.names.set("a", "externally edited");
  await assert.rejects(f.operator.request("a", { action: "save", token: fresh.token, name: "bad" }), /da thay doi/);
  assert.equal(f.names.get("a"), "externally edited");
});

test("live Sheet writer sends each step before final commit and serializes updates", async () => {
  const events = [];
  const session = { rows: new Map([["a", {}]]), updateOne: async (id, values) => { events.push({ id, values }); }, flushAll: async () => { events.push("flushed"); } };
  const writer = createLiveSheetWriter(session, "a");
  await writer.update({ trangThai: "đang chạy", chiTiet: "login" });
  assert.equal(events.length, 1);
  assert.equal(events[0].values["chi tiết"], "login");
  await writer.update({ "tên profile hiện tại": "new name" });
  await writer.commit({ trangThai: "Đã xử lý thủ công" });
  assert.equal(events[1].values["tên profile hiện tại"], "new name");
  assert.equal(events.at(-1), "flushed");
});

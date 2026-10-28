import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoginPause } from "../modules/login_pause.js";
import { createRequire } from "node:module";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture() {
  const runtime = { running: true, currentTool: "tool login", jobs: new Map(["a", "b", "c"].map((id) => [id, { tool: "tool login", status: "running" }])) };
  return { runtime, control: createLoginPause(runtime) };
}
test("global resume preserves independent per-profile pause and shifts countdown", async () => {
  const { runtime, control } = fixture();
  const job = runtime.jobs.get("a");
  job.twofaCountdownEndsAt = Date.now() + 120000;
  const original = job.twofaCountdownEndsAt;
  control.toggle("a"); control.toggle();
  assert.equal(runtime.jobs.get("b").loginPaused, true);
  await sleep(20);
  control.toggle();
  assert.equal(runtime.jobs.get("b").loginPaused, false);
  assert.equal(job.loginPaused, true);
  control.toggle("a");
  assert.ok(job.twofaCountdownEndsAt > original);
});
test("paused browser step restarts on resume and stale pending work cannot click", async () => {
  const { control } = fixture();
  let releaseOld, started, attempts = 0, clicks = 0;
  const ready = new Promise((r) => { started = r; });
  const oldRequest = new Promise((r) => { releaseOld = r; });
  const page = control.guard({ async click() { clicks++; } }, ["click"]);
  const work = control.run("a", async () => {
    attempts++;
    if (!control.resuming()) { started(); await oldRequest; }
    await page.click();
  }, 1000, true);
  await ready;
  control.toggle("a");
  await sleep(30);
  assert.equal(clicks, 0);
  control.toggle("a");
  await work;
  releaseOld(); await sleep(30);
  assert.equal(attempts, 2);
  assert.equal(clicks, 1);
});
test("pause time does not consume the step deadline and other workers continue", async () => {
  const { control } = fixture();
  let started;
  const ready = new Promise((r) => { started = r; });
  const work = control.run("a", async () => {
    if (!control.resuming()) { started(); await sleep(500); }
    return "resumed";
  }, 200, true);
  await ready; control.toggle("a");
  assert.equal(await control.run("b", async () => "other"), "other");
  await sleep(350); control.toggle("a");
  assert.equal(await work, "resumed");
});
test("Stop exits a paused worker without resuming browser operations", async () => {
  const { runtime, control } = fixture();
  control.toggle();
  const work = control.run("a", async () => { throw Error("must not run"); });
  runtime.stopRequested = true;
  await assert.rejects(work, (e) => e.status === "stopped");
});

test("F8 toggles all workers in a profile page and survives navigation", async () => {
  const require = createRequire(import.meta.url);
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage();
    const { runtime, control } = fixture();
    await control.attach(page);
    await page.goto("data:text/html,<h1>First</h1>");
    await page.keyboard.press("F8");
    for (let i = 0; i < 50 && !runtime.loginPaused; i++) await sleep(10);
    assert.equal(runtime.loginPaused, true);
    assert.equal(runtime.jobs.get("a").loginPaused, true);
    await page.goto("data:text/html,<h1>Next</h1>");
    await page.keyboard.press("F8");
    for (let i = 0; i < 50 && runtime.loginPaused; i++) await sleep(10);
    assert.equal(runtime.loginPaused, false);
  } finally { await browser.close(); }
});

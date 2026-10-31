import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

test("Login progress resizes, retains its size after polling, and copies only UID", async () => {
  const [app, css, html] = await Promise.all(["app.js", "styles.css", "index.html"].map((file) =>
    readFile(new URL(`../public/${file}`, import.meta.url), "utf8").then((source) => source.replace(/\r\n/g, "\n"))));
  const section = html.slice(html.indexOf('<section id="loginToolProgressPanel"'), html.indexOf('<details id="loginRetryErrorsPanel"'));
  const render = app.slice(app.indexOf("function renderToolProgressPanel("), app.indexOf("let loginPauseRequestPending"));
  const copy = app.slice(app.indexOf("async function copyLoginUid("), app.indexOf("const loginRetryPending"));
  const clickStart = app.indexOf('document.addEventListener("click", (event) => {\n  const row = event.target.closest?.("[data-login-profile-row]");');
  const click = app.slice(clickStart, app.indexOf('document.addEventListener("keydown"', clickStart));
  const require = createRequire(import.meta.url);
  const browser = await require("puppeteer-core").launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 950 });
    await page.setContent(`<style>${css}</style><main style="width:1100px;margin:20px">${section}</main>`);
    await page.evaluate(`${render}\n${copy}\n${click}\n` + `
      window.$ = id => document.getElementById(id);
      window.state = { profiles: [] };
      window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
      window.escapeAttr = escapeHtml;
      window.refreshLoginTwofaCountdowns = () => {};
      window.formatLoginTwofaCountdown = () => '';
      window.selectedLoginProfile = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copied = value; } } });
      window.renderFixture = () => renderToolProgressPanel({
        panelId: 'loginToolProgressPanel', listId: 'loginToolProgressList', stateId:'loginToolProgressState', countId:'loginToolProgressCount',
        textId:'loginToolProgressText', barId:'loginToolProgressBar', stateLabel:'running', countLabel:'0 / 1', textLabel:'Running',percent:0,
        showTimeColumn:true, jobs:[{profileId:'hide-internal-id',uid:'61512345678901',currentName:'old-profile-name',tool:'tool login',status:'running',liveStatus:'Login'}]
      });
      renderFixture();
    `);
    assert.equal(await page.$eval("#loginToolProgressList .tool-progress-column-head span", (node) => node.textContent), "UID");
    assert.equal(await page.$eval("#loginToolProgressList [data-login-profile-row] > span", (node) => node.textContent.trim()), "61512345678901");
    await page.click("[data-copy-login-uid]");
    assert.equal(await page.evaluate(() => window.copied), "61512345678901");
    assert.equal(await page.evaluate(() => selectedLoginProfile), "hide-internal-id");
    assert.equal(await page.$eval("[data-login-manual-id]", (node) => node.dataset.loginManualId), "hide-internal-id");
    const panel = await page.$("#loginToolProgressPanel");
    const before = await panel.boundingBox();
    await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width - 203, before.y + before.height + 157, { steps: 10 });
    await page.mouse.up();
    const resized = await panel.boundingBox();
    assert.ok(resized.width < before.width - 100);
    assert.ok(resized.height > before.height + 100);
    await page.evaluate(() => renderFixture());
    assert.deepEqual(await panel.boundingBox(), resized);
    // Clipboard-denied environments use the legacy copy path without changing the UID cell.
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw Error("denied"); };
      document.execCommand = (command) => { if (command === "copy") window.copied = document.activeElement.value; return true; };
    });
    await page.click("[data-copy-login-uid]");
    assert.equal(await page.evaluate(() => window.copied), "61512345678901");
    assert.equal(await page.$$eval("textarea", (nodes) => nodes.length), 0);
  } finally { await browser.close(); }
});

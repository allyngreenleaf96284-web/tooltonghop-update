import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { clickLoginDismissControl } from "../modules/dangnhap.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
let browser;
let page;

before(async () => {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome"
  ].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) {
      executablePath = candidate;
      break;
    }
  }
  assert.ok(executablePath, "Set CHROME_PATH to run browser regression tests.");
  browser = await puppeteer.launch({ executablePath, headless: true });
  page = await browser.newPage();
});

after(async () => { await browser?.close(); });

async function fixture(html) {
  await page.setContent(html);
  await page.evaluate(() => {
    window.clickedLabels = [];
    document.addEventListener("click", (event) => {
      window.clickedLabels.push(event.target.innerText || event.target.getAttribute("aria-label") || "");
      event.preventDefault();
    });
  });
}

test("old popup matcher clicks Facebook Lite after submitting Login", async () => {
  await fixture('<form><input name="email"><input type="password"><button name="login">Log in</button></form><a href="https://www.facebook.com/lite/">Facebook Lite</a>');
  const selected = await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll("button, [role='button'], a, div[tabindex='0']"))
      .find((node) => /ok/i.test(node.innerText));
    target?.click();
    return target?.innerText;
  });
  assert.equal(selected, "Facebook Lite");
});

test("new popup matcher leaves Login and footer navigation untouched on every poll", async () => {
  await fixture('<form><input name="email"><input type="password"><button name="login">Log in</button></form><a href="https://www.facebook.com/lite/">Facebook Lite</a><a role="button" href="/lite/">OK</a><div tabindex="0">Facebook</div><button>Skip to content</button><button>Cancel</button>');
  for (let poll = 0; poll < 4; poll += 1) {
    assert.equal(await page.evaluate(clickLoginDismissControl), false);
  }
  assert.deepEqual(await page.evaluate(() => window.clickedLabels), []);
});

test("real dialog actions are still dismissed", async () => {
  for (const label of ["OK", "Close", "Cancel", "Skip", "Block"]) {
    await fixture(`<a href="/lite/">Facebook Lite</a><div role="dialog"><button>${label}</button></div>`);
    assert.equal(await page.evaluate(clickLoginDismissControl), true);
    assert.deepEqual(await page.evaluate(() => window.clickedLabels), [label]);
  }
});

test("cookie and not-now buttons work without a dialog wrapper", async () => {
  for (const label of ["Not now", "Allow all cookies", "Allow essential and optional cookies"]) {
    await fixture(`<a href="/lite/">Facebook Lite</a><button>${label}</button>`);
    assert.equal(await page.evaluate(clickLoginDismissControl), true);
    assert.deepEqual(await page.evaluate(() => window.clickedLabels), [label]);
  }
});

test("hidden and disabled controls are ignored", async () => {
  await fixture('<div role="dialog"><button style="display:none">OK</button><button disabled>Close</button><div role="button" aria-disabled="true">Cancel</div></div>');
  assert.equal(await page.evaluate(clickLoginDismissControl), false);
  assert.deepEqual(await page.evaluate(() => window.clickedLabels), []);
});

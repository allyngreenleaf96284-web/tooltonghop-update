import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { passwordManagerControl, prepareFacebookPasswordManager, authenticationAppControl, chooseAuthenticationAppTwofa } from "../modules/dangnhap.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
let browser;
let page;
before(async () => {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true
  });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

async function addDummyPassword(site, username) {
  await page.goto("chrome://password-manager/passwords");
  await page.waitForFunction(() => document.querySelector("password-manager-app")?.shadowRoot
    ?.querySelector("passwords-section")?.shadowRoot?.querySelector("#addPasswordButton"));
  await page.evaluate(() => document.querySelector("password-manager-app").shadowRoot
    .querySelector("passwords-section").shadowRoot.querySelector("#addPasswordButton").click());
  for (const [id, value] of [["websiteInput", site], ["usernameInput", username], ["passwordInput", "DummyOnlyNotARealLogin42"]]) {
    await page.evaluate((id) => {
      const roots = [document];
      while (roots.length) {
        for (const node of roots.shift().querySelectorAll("*")) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
          if (node.id === id) { node.shadowRoot.querySelector("input").focus(); return; }
        }
      }
    }, id);
    await page.keyboard.type(value);
    await page.keyboard.press("Tab");
  }
  await page.evaluate(() => {
    const roots = [document];
    while (roots.length) {
      for (const node of roots.shift().querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.id === "addButton") { node.click(); return; }
      }
    }
  });
  await page.waitForFunction(() => {
    const roots = [document];
    while (roots.length) {
      for (const node of roots.shift().querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.localName === "add-password-dialog") return false;
      }
    }
    return true;
  });
}

test("empty Chrome store disables saving, persists after reload, and is idempotent", async () => {
  assert.deepEqual(await prepareFacebookPasswordManager(page), { deleted: 0, savingDisabled: true });
  assert.equal((await page.evaluate(passwordManagerControl)).checked, false);
  assert.deepEqual(await prepareFacebookPasswordManager(page), { deleted: 0, savingDisabled: true });
});

test("deletes every saved Facebook account, but preserves another website", async () => {
  await addDummyPassword("https://www.facebook.com", "regression-facebook-1");
  await addDummyPassword("https://www.facebook.com", "regression-facebook-2");
  await addDummyPassword("https://example.com", "regression-unrelated");
  const result = await prepareFacebookPasswordManager(page);
  assert.deepEqual(result, { deleted: 2, savingDisabled: true });
  await page.goto("chrome://password-manager/passwords/example.com");
  await page.waitForFunction(() => {
    const app = document.querySelector("password-manager-app");
    return Boolean(app?.shadowRoot?.querySelector("password-details-section")?.shadowRoot?.querySelector("password-details-card"));
  });
  assert.equal(page.url(), "chrome://password-manager/passwords/example.com");
  assert.equal(await page.evaluate(passwordManagerControl, "delete").then((value) => value.clicked), undefined);
});

test("slow 2FA method modal waits for app selection and code screen before proceeding", async () => {
  const twofaPage = await browser.newPage();
  try {
    await twofaPage.setContent('<h1>Check your notifications on another device</h1><p>Waiting for approval</p><button id="try">Try another way</button>');
    await twofaPage.evaluate(() => {
      window.actions = [];
      document.querySelector("#try").onclick = () => {
        window.actions.push("try");
        setTimeout(() => {
          const modal = document.createElement("div");
          modal.setAttribute("role", "dialog");
          modal.innerHTML = '<label><input type="radio" name="method" checked>Notification on another device</label><label id="app"><input type="radio" name="method">Authentication app</label><button id="next" disabled>Continue</button>';
          document.body.append(modal);
          modal.querySelector("#app input").onclick = () => {
            window.actions.push("app");
            setTimeout(() => { modal.querySelector("#next").disabled = false; }, 150);
          };
          modal.querySelector("#next").onclick = () => {
            const checked = modal.querySelector("#app input").checked;
            window.actions.push(checked ? "continue-app" : "WRONG-METHOD");
            setTimeout(() => { document.body.innerHTML = '<input autocomplete="one-time-code" placeholder="Code">'; }, 200);
          };
        }, 200);
      };
    });
    let progressUpdates = 0;
    const result = await chooseAuthenticationAppTwofa(twofaPage, {
      timeoutMs: 3000, pollMs: 20, actionDelayMs: 30, onProgress: () => { progressUpdates += 1; }
    });
    assert.equal(result, true);
    assert.equal((await twofaPage.evaluate(authenticationAppControl)).stage, "code");
    assert.deepEqual(await twofaPage.evaluate(() => window.actions), ["try", "app", "continue-app"]);
    assert.ok(progressUpdates > 5, "Countdown updates continue while the UI renders.");
  } finally { await twofaPage.close(); }
});

test("ARIA radios select only Authentication app; unavailable app never submits Continue", async () => {
  const twofaPage = await browser.newPage();
  try {
    await twofaPage.setContent('<div role="dialog"><div role="radio" aria-checked="true">Notification on another device</div><div role="radio" id="app" aria-checked="false">Authentication app</div><button id="next">Continue</button></div>');
    await twofaPage.evaluate(() => {
      window.clicked = [];
      document.querySelector("#app").onclick = (event) => { event.currentTarget.setAttribute("aria-checked", "true"); window.clicked.push("app"); };
      document.querySelector("#next").onclick = () => { window.clicked.push("continue"); document.body.innerHTML = '<input name="approvals_code">'; };
    });
    assert.equal(await chooseAuthenticationAppTwofa(twofaPage, { timeoutMs: 1000, pollMs: 20, actionDelayMs: 10 }), true);
    assert.deepEqual(await twofaPage.evaluate(() => window.clicked), ["app", "continue"]);
    await twofaPage.setContent('<div role="dialog"><div role="radio" aria-disabled="true">Authentication app</div><button id="next">Continue</button></div>');
    await twofaPage.evaluate(() => { window.submitted = false; document.querySelector("#next").onclick = () => { window.submitted = true; }; });
    assert.equal(await chooseAuthenticationAppTwofa(twofaPage, { timeoutMs: 100, pollMs: 20, actionDelayMs: 10 }), false);
    assert.equal(await twofaPage.evaluate(() => window.submitted), false);
  } finally { await twofaPage.close(); }
});

test("normal code form is not changed or delayed by method selection", async () => {
  const twofaPage = await browser.newPage();
  try {
    await twofaPage.setContent('<input autocomplete="one-time-code" placeholder="Code"><button>Continue</button>');
    assert.equal(await chooseAuthenticationAppTwofa(twofaPage), true);
    assert.equal(await twofaPage.$eval("input", (node) => node.value), "");
  } finally { await twofaPage.close(); }
});

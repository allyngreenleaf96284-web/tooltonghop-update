import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { twofaCodeControl, fillTwofaInput, submitTwofaCode, chooseAuthenticationAppTwofa } from "../modules/dangnhap.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
let browser;
before(async () => {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(html, url = "https://www.facebook.com/two_step_verification/two_factor/?flow=two_factor_login") {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => { void request.respond({ status: 200, contentType: "text/html", body: "<body></body>" }).catch(() => {}); });
  await page.goto(url);
  await page.setContent(html);
  return page;
}

function screen(label, next, other) {
  return `<main><form><label for="react-dynamic-id">${label}</label><input id="react-dynamic-id" type="text" autocomplete="off" dir="ltr"><input type="submit" aria-hidden="true" tabindex="-1"></form><div role="button" id="next" aria-disabled="true">${next}</div><div role="button" id="other">${other}</div></main>`;
}

test("localized code screens without OTP metadata fill the same input and submit only the adjacent primary action", async () => {
  for (const labels of [["कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"], ["รหัส", "ดำเนินการต่อ", "ลองวิธีอื่น"], ["الرمز", "متابعة", "جرّب طريقة أخرى"], ["Código", "Continuar", "Probar otra forma"]]) {
    const page = await fixture(screen(...labels));
    try {
      assert.deepEqual(await page.evaluate(twofaCodeControl), { stage: "code", filled: false, canContinue: false, invalid: false });
      assert.equal(await chooseAuthenticationAppTwofa(page), true);
      await page.evaluate(() => {
        window.actions = [];
        document.querySelector("#other").onclick = () => window.actions.push("WRONG-OTHER");
        document.querySelector("#next").onclick = () => window.actions.push("continue");
        document.querySelector("input[type='text']").oninput = () => setTimeout(() => document.querySelector("#next").setAttribute("aria-disabled", "false"), 200);
      });
      const input = await page.evaluateHandle(twofaCodeControl, "input");
      assert.equal(await fillTwofaInput(page, input, "012345"), true);
      await input.dispose();
      assert.equal(await page.$eval("input[type='text']", (node) => node.value), "012345");
      let updates = 0;
      await submitTwofaCode(page, { timeoutMs: 2000, pollMs: 20, onProgress: () => { updates += 1; } });
      assert.ok(updates > 1, "Wait for the delayed primary button instead of clicking the already-enabled alternative.");
      assert.deepEqual(await page.evaluate(() => window.actions), ["continue"]);
    } finally { await page.close(); }
  }
});

test("standard OTP attributes and native submit remain supported, ignoring hidden and unrelated inputs", async () => {
  const page = await fixture('<input type="text" style="display:none"><input type="search"><form><input name="approvals_code" autocomplete="one-time-code"><button type="submit">Continue</button></form>');
  try {
    await page.evaluate(() => { window.sent = 0; document.querySelector("form").onsubmit = (event) => { event.preventDefault(); window.sent += 1; }; });
    const input = await page.evaluateHandle(twofaCodeControl, "input");
    assert.equal(await fillTwofaInput(page, input, "123456"), true);
    await input.dispose();
    await submitTwofaCode(page);
    assert.equal(await page.evaluate(() => window.sent), 1);
    assert.equal(await page.$eval("input[type='search']", (node) => node.value), "");
  } finally { await page.close(); }
});

test("Facebook authentication route also supports localized code forms without changing URL or refreshing", async () => {
  const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"), "https://www.facebook.com/two_step_verification/authentication/?flow=pre_authentication");
  try {
    assert.equal((await page.evaluate(twofaCodeControl)).stage, "code");
    assert.equal(new URL(page.url()).pathname, "/two_step_verification/authentication/");
  } finally { await page.close(); }
});

test("localized native button uses its default submit semantics without an English label", async () => {
  const page = await fixture('<form><label for="otp">Código</label><input id="otp" autocomplete="off"><button>Continuar</button></form>');
  try {
    await page.evaluate(() => { window.sent = 0; document.querySelector("form").onsubmit = (event) => { event.preventDefault(); window.sent += 1; }; });
    const input = await page.evaluateHandle(twofaCodeControl, "input");
    await fillTwofaInput(page, input, "123456");
    await input.dispose();
    await submitTwofaCode(page);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await page.close(); }
});

test("structural fallback rejects non-2FA routes and lookalike domains", async () => {
  for (const url of ["https://www.facebook.com/login/", "https://www.facebook.com/marketplace/", "https://facebook.com.evil.test/two_step_verification/two_factor/"]) {
    const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"), url);
    try { assert.equal((await page.evaluate(twofaCodeControl)).stage, "waiting"); }
    finally { await page.close(); }
  }
});

test("multiple unlabelled fields and unrelated open dialogs do not result in guessed code entry", async () => {
  const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"));
  try {
    await page.evaluate(() => document.querySelector("form").append(document.createElement("input")));
    assert.equal((await page.evaluate(twofaCodeControl)).stage, "ambiguous");
    await page.setContent(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ") + '<div role="dialog">Different confirmation method</div>');
    assert.equal((await page.evaluate(twofaCodeControl)).stage, "waiting");
  } finally { await page.close(); }
});

test("disabled and readonly inputs are not filled and blank codes never submit", async () => {
  const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"));
  try {
    await page.evaluate(() => { window.clicked = false; document.querySelector("#next").setAttribute("aria-disabled", "false"); document.querySelector("#next").onclick = () => { window.clicked = true; }; });
    assert.equal((await page.evaluate(twofaCodeControl, "submit")).stage, "code");
    assert.equal(await page.evaluate(() => window.clicked), false);
    await page.$eval("input[type='text']", (node) => { node.readOnly = true; });
    assert.equal((await page.evaluate(twofaCodeControl)).stage, "waiting");
    await page.$eval("input[type='text']", (node) => { node.readOnly = false; node.disabled = true; });
    assert.equal((await page.evaluate(twofaCodeControl)).stage, "waiting");
  } finally { await page.close(); }
});

test("rerendered primary button is reacquired while loading and clicked only once", async () => {
  const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"));
  try {
    await page.evaluate(() => {
      window.clicks = 0;
      document.querySelector("input[type='text']").oninput = () => setTimeout(() => {
        const button = document.querySelector("#next").cloneNode(true);
        button.setAttribute("aria-disabled", "false");
        button.onclick = () => { window.clicks += 1; button.setAttribute("aria-disabled", "true"); };
        document.querySelector("#next").replaceWith(button);
      }, 300);
    });
    const input = await page.evaluateHandle(twofaCodeControl, "input");
    assert.equal(await fillTwofaInput(page, input, "123456"), true);
    await input.dispose();
    await submitTwofaCode(page, { timeoutMs: 2000, pollMs: 20 });
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await page.close(); }
});

test("ambiguous controls and unavailable Continue never fall back to Try another way", async () => {
  const page = await fixture(screen("कोड", "जारी रखें", "दूसरा तरीका आज़माएँ"));
  try {
    await page.evaluate(() => { window.wrong = false; document.querySelector("#other").onclick = () => { window.wrong = true; }; });
    const input = await page.evaluateHandle(twofaCodeControl, "input");
    await fillTwofaInput(page, input, "123456");
    await input.dispose();
    await assert.rejects(submitTwofaCode(page, { timeoutMs: 100, pollMs: 20 }), /nut Tiep tuc/);
    await page.evaluate(() => {
      const extra = document.createElement("div"); extra.setAttribute("role", "button"); extra.textContent = "Extra action"; document.querySelector("main").append(extra);
      document.querySelector("#next").setAttribute("aria-disabled", "false");
    });
    assert.equal((await page.evaluate(twofaCodeControl)).canContinue, false);
    await assert.rejects(submitTwofaCode(page, { timeoutMs: 100, pollMs: 20 }), /nut Tiep tuc/);
    assert.equal(await page.evaluate(() => window.wrong), false);
  } finally { await page.close(); }
});

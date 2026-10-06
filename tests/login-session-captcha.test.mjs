import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createDangNhap, facebookLoginPlan, readLoginCaptchaChallenge, assertNoLoginCaptcha, chooseAuthenticationAppTwofa, submitTwofaCode } from "../modules/dangnhap.js";
import { buildCaptchaProfileName } from "../modules/profile_name.js";
import { mapFullError, buildRuntimeProfileName, stripResolvedNamePrefixes } from "../modules/lamfull.js";
import { isRetryableFailure, isUnknownFailure, startAutoRetryBatch } from "../modules/batch_retry.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
let browser;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
before(async () => { browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(html, { captchaRedirect = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const visits = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) visits.push(url.pathname + url.search);
    if (captchaRedirect && url.hostname === "www.facebook.com" && url.pathname === "/") {
      void request.respond({ status: 302, headers: { location: "https://www.facebook.com/two_step_verification/authentication/?flow=pre_authentication" } }).catch(() => {});
      return;
    }
    const body = url.pathname === "/settings/" ? "<h1>Account language</h1>English (US)" : html;
    void request.respond({ status: 200, contentType: "text/html", body }).catch(() => {});
  });
  return { context, page, visits };
}

function managerFixture(name = "Full 15/7-61500000000000-Arizona-tool") {
  const names = new Map([["p1", name], ["p2", "other-profile"]]);
  const updates = [];
  return {
    names, updates,
    async getProfileNameById(id) { return names.get(id); },
    async updateProfileName(id, name) { names.set(id, name); updates.push([id, name]); },
    async gotoWithRetry(page, url) { return page.goto(url, { waitUntil: "domcontentloaded" }); },
    sendLog() {}
  };
}

test("account-only login reuses an authenticated session instead of clearing cookies or opening login/password-manager pages", async () => {
  const { context, page, visits } = await fixture("<h1>Home</h1>");
  const manager = managerFixture();
  const logs = [];
  const login = createDangNhap({ addRuntimeLog: (message) => logs.push(message) });
  let deleted = 0;
  const deleteCookie = page.deleteCookie.bind(page);
  page.deleteCookie = async (...args) => { deleted += 1; return deleteCookie(...args); };
  try {
    await page.setCookie({ name: "c_user", value: "61500000000000", domain: ".facebook.com", path: "/", secure: true });
    deleted = 0;
    for (const forceAccountLogin of [true, false]) {
      const result = await login.ensureFacebookLogin(manager, page, { uid: "61500000000000", raw: {} }, "p1", () => {}, { forceAccountLogin });
      assert.equal(result.source, "session");
      assert.equal(result.ok, true);
    }
    assert.equal(deleted, 0);
    assert.ok(visits.includes("/settings/?tab=language&locale=en_US"));
    assert.equal(visits.some((url) => /profile\.php|\/login|password-manager|chrome:\/\//.test(url)), false);
    assert.equal(logs.some((line) => /don mat khau|xoa session cu|chuyen ve nick chinh|tai khoan mat khau/.test(line)), false);
    assert.equal((await page.cookies("https://www.facebook.com")).find((cookie) => cookie.name === "c_user")?.value, "61500000000000");
  } finally { await context.close(); }
});

test("login plan distinguishes session reuse, account-only fallback, and existing cookie-first tools", () => {
  const state = { hasSession: true, credentialStep: "logged_in" };
  assert.equal(facebookLoginPlan(state, { forceAccountLogin: true }), "session");
  for (const patch of [{ hasSession: false }, { onLoginForm: true }, { onContinue: true }, { onPasswordModal: true }, { credentialStep: "twofa" }, { checkpointStatus: "cp956" }, { url: "https://www.facebook.com/lite/" }, { url: "https://www.facebook.com/login/" }]) {
    assert.equal(facebookLoginPlan({ ...state, ...patch }, { forceAccountLogin: true }), "account");
    assert.equal(facebookLoginPlan({ ...state, ...patch }), "cookie");
  }
});

test("the authentication URL alone is not CAPTCHA; visible widget or not-a-robot banner is", async () => {
  const { context, page } = await fixture("<body></body>");
  try {
    await page.goto("https://www.facebook.com/two_step_verification/authentication/?flow=pre_authentication");
    await page.setContent('<label>कोड<input type="text"></label>');
    assert.equal(await page.evaluate(readLoginCaptchaChallenge), false);
    await page.setContent('<iframe src="https://www.google.com/recaptcha/enterprise/anchor?k=fixture" width="304" height="78"></iframe>');
    assert.equal(await page.evaluate(readLoginCaptchaChallenge), true);
    await page.setContent('<iframe style="display:none" src="https://www.google.com/recaptcha/enterprise/anchor?k=fixture"></iframe>');
    assert.equal(await page.evaluate(readLoginCaptchaChallenge), false);
    await page.setContent("<p>I'm not a robot</p>");
    assert.equal(await page.evaluate(readLoginCaptchaChallenge), true);
    await page.goto("https://facebook.com.evil.test/two_step_verification/authentication/");
    await page.setContent("<p>I'm not a robot</p>");
    assert.equal(await page.evaluate(readLoginCaptchaChallenge), false);
  } finally { await context.close(); }
});

test("CAPTCHA exits shared login promptly, preserves the original name, and never grows duplicate prefixes", async () => {
  const { context, page, visits } = await fixture("<p>I'm not a robot</p>", { captchaRedirect: true });
  const manager = managerFixture("capcha-loicapcha-capcha-Full 15/7-61500000000000-Arizona-tool");
  const login = createDangNhap({ addRuntimeLog() {} });
  const expected = "capcha-Full 15/7-61500000000000-Arizona-tool";
  try {
    const started = Date.now();
    await assert.rejects(login.ensureFacebookLogin(manager, page, { uid: "61500000000000", raw: {} }, "p1", () => {}, { forceAccountLogin: true }), (error) => error.status === "capcha" && error.code === "LOGIN_CAPTCHA" && error.retryable === true && error.captchaProfileName === expected);
    assert.ok(Date.now() - started < 5000, "Do not wait two minutes on an already-visible CAPTCHA.");
    assert.equal(manager.names.get("p1"), expected);
    await manager.updateProfileName("p1", "loi-generated-2v-name");
    assert.equal(manager.names.get("p1"), expected);
    await manager.updateProfileName("p2", "healthy-name");
    assert.equal(manager.names.get("p2"), "healthy-name");
    await assert.rejects(login.ensureFacebookLogin(manager, page, {}, "p1"), (error) => error.status === "capcha");
    assert.equal(manager.names.get("p1"), expected);
    assert.equal(visits.some((url) => url.includes("profile.php")), false);
  } finally { delete browser.__loginCaptcha; await context.close(); }
});

test("CAPTCHA appearing during method selection or button loading interrupts their polling", async () => {
  const { context, page } = await fixture("<body></body>");
  try {
    await page.goto("https://www.facebook.com/two_step_verification/authentication/");
    await page.setContent('<h1>Check your notifications on another device</h1><p>Waiting for approval</p><button id="try">Try another way</button>');
    await page.evaluate(() => { document.querySelector("#try").onclick = () => setTimeout(() => { document.body.innerHTML = "<p>I'm not a robot</p>"; }, 100); });
    await assert.rejects(chooseAuthenticationAppTwofa(page, { timeoutMs: 2000, pollMs: 20, actionDelayMs: 5, checkChallenge: () => assertNoLoginCaptcha(page) }), (error) => error.code === "LOGIN_CAPTCHA");
    delete page.browser().__loginCaptcha;
    await page.setContent('<input autocomplete="one-time-code" value="123456"><button disabled>Continue</button>');
    await page.evaluate(() => setTimeout(() => { document.body.innerHTML = "<p>I'm not a robot</p>"; }, 100));
    await assert.rejects(submitTwofaCode(page, { timeoutMs: 2000, pollMs: 20, checkChallenge: () => assertNoLoginCaptcha(page) }), (error) => error.code === "LOGIN_CAPTCHA");
  } finally { delete page.browser().__loginCaptcha; await context.close(); }
});

test("name and error normalization recognize old CAPTCHA aliases while success can remove the temporary marker", () => {
  for (const name of ["capcha-capcha-name-tool", "loicapcha-capcha-name-tool", "name-tool"]) {
    assert.equal(buildCaptchaProfileName(name), "capcha-name-tool");
    assert.equal(buildCaptchaProfileName(buildCaptchaProfileName(name)), "capcha-name-tool");
  }
  assert.equal(buildRuntimeProfileName({ status: "capcha", tenChuan: "capcha-name-tool" }), "capcha-name-tool");
  assert.equal(stripResolvedNamePrefixes("capcha-capcha-2v-name-tool"), "2v-name-tool");
  assert.equal(mapFullError({ status: "loi", message: "login: reCAPTCHA / not a robot" }).status, "capcha");
});

test("CAPTCHA is retryable but not unknown, while terminal Marketplace and checkpoint errors remain excluded", () => {
  for (const result of [{ trangThai: "capcha", chiTiet: "not a robot" }, { trangThai: "loicapcha" }, { trangThai: "loi", chiTiet: "login: reCAPTCHA" }]) {
    const job = { status: "error", result };
    assert.equal(isRetryableFailure(job), true);
    assert.equal(isUnknownFailure(job), false);
  }
  for (const job of [{ status: "success", result: { trangThai: "capcha" } }, { status: "stopped", result: { trangThai: "capcha" } }, { status: "error", result: { trangThai: "die cho", chiTiet: "CAPTCHA" } }, { status: "error", result: { trangThai: "cp956", chiTiet: "CAPTCHA" } }]) assert.equal(isRetryableFailure(job), false);
});

test("retry batch finishes the first pass, retries only CAPTCHA accounts, and removes successes from the next pass", async () => {
  const runtime = { jobs: new Map(), running: false };
  const passes = [];
  await startAutoRetryBatch({ runtime, tool: "tool login", profileIds: ["captcha1", "captcha2", "terminal"], config: {}, maxRetries: 2, module: {
    async runQueue(ids) {
      passes.push([...ids]);
      for (const id of ids) {
        const success = (id === "captcha1" && passes.length >= 2) || (id === "captcha2" && passes.length >= 3);
        runtime.jobs.set(id, success ? { status: "success", result: { trangThai: "thành công" } } : { status: "error", result: { trangThai: id === "terminal" ? "die cho" : "capcha", chiTiet: id === "terminal" ? "Marketplace isn't available to you" : "not a robot" } });
      }
      return {};
    }
  } });
  for (let i = 0; i < 200 && runtime.batch.active; i += 1) await pause(10);
  assert.equal(runtime.batch.active, false);
  assert.deepEqual(passes, [["captcha1", "captcha2", "terminal"], ["captcha1", "captcha2"], ["captcha2"]]);
  assert.equal(runtime.jobs.get("captcha1").status, "success");
  assert.equal(runtime.jobs.get("captcha2").status, "success");
  assert.equal(runtime.jobs.get("terminal").status, "error");
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import { findPublishedListingLink } from "../modules/listing_link.js";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", {
  paths: [fileURLToPath(new URL("../bundled-apps/Shipping-Full-Studio/app/", import.meta.url))]
}));
let browser;
before(async () => { browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });
const title = "LEGO Marvel Spider-Man Bundle 4 Set Lot Sealed NIB Miles Mech Car Spin Electro";
const id = "2017696512182170";
const options = { timeoutMs: 1200, pollMs: 20, maxAttempts: 1 };

async function fixture(html, { pulse = false } = {}) {
  const page = await browser.newPage();
  let reloads = 0;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.pathname.includes("selling")) {
      if (pulse) {
        void request.respond({ status: 302, headers: { location: "https://www.facebook.com/marketplace/seller/listings" } }).catch(() => {});
        return;
      }
    }
    void request.respond({ status: 200, contentType: "text/html", body: html }).catch(() => {});
  });
  const originalReload = page.reload.bind(page);
  page.reload = async (...args) => { reloads += 1; return originalReload(...args); };
  return { page, reloads: () => reloads };
}

test("classic direct product links remain supported and no initial F5 is needed", async () => {
  const { page, reloads } = await fixture(`<article><a href='/marketplace/item/${id}/'>${title}</a></article>`);
  try {
    assert.equal(new URL(await findPublishedListingLink(page, title, options)).pathname, `/marketplace/item/${id}/`);
    assert.equal(reloads(), 0);
  } finally { await page.close(); }
});

test("classic More options for / View listing still works with delayed menus", async () => {
  const { page, reloads } = await fixture(`<p>${title}</p><button aria-label='More options for ${title}' onclick="setTimeout(()=>{document.querySelector('#menu').hidden=false},180)">...</button>
    <div id='menu' role='menu' hidden><button role='menuitem' onclick="history.pushState({},'', '/marketplace/item/${id}/')">View listing</button></div>`);
  try {
    assert.equal(new URL(await findPublishedListingLink(page, title, options)).pathname, `/marketplace/item/${id}/`);
    assert.equal(reloads(), 0);
  } finally { await page.close(); }
});

test("new Pulse table finds the full title in More actions labels, waits for View, and avoids View messages/Edit", async () => {
  const { page, reloads } = await fixture(`
    <table role='table'><tbody><tr role='row'><td>${title.slice(0, 22)}...</td><td><button>Edit</button><button aria-label='More actions for ${title}' onclick="setTimeout(()=>{document.querySelector('#menu').hidden=false},350)">...</button></td></tr></tbody></table>
    <div id='menu' role='menu' aria-label='Listing actions' hidden>
      <a role='menuitem' href='/marketplace/seller/inbox/'>View messages</a><a role='menuitem' href='/marketplace/edit/'>Edit</a>
      <a role='menuitem' href='/marketplace/item/${id}/?ref=seller_listings'>View</a>
    </div>`, { pulse: true });
  try {
    const link = new URL(await findPublishedListingLink(page, title, options));
    assert.equal(link.pathname, `/marketplace/item/${id}/`);
    assert.equal(link.searchParams.get("ref"), "seller_listings");
    assert.equal(reloads(), 0);
  } finally { await page.close(); }
});

test("similar titles select only the requested row's More actions menu", async () => {
  const { page } = await fixture(`<table><tbody>
    <tr><td>${title} Extra</td><td><button aria-label='More actions for ${title} Extra' onclick="document.body.dataset.wrong='yes'">...</button></td></tr>
    <tr><td>${title}</td><td><button aria-label='More actions for ${title}' onclick="document.querySelector('#menu').hidden=false">...</button></td></tr>
    </tbody></table><div role='menu' id='menu' hidden><a role='menuitem' href='/marketplace/item/${id}/' onclick='event.preventDefault()'>View</a></div>`);
  try {
    assert.equal(new URL(await findPublishedListingLink(page, title, options)).pathname, `/marketplace/item/${id}/`);
    assert.equal(await page.evaluate(() => document.body.dataset.wrong || ""), "");
  } finally { await page.close(); }
});

test("a different product's direct anchor is not confused with the target table row", async () => {
  const { page } = await fixture(`<table><tbody><tr><td><a href='/marketplace/item/111111/'>Different product</a></td></tr>
    <tr><td>${title}</td><td><button aria-label='More actions for ${title}' onclick="document.querySelector('#menu').hidden=false">...</button></td></tr>
    </tbody></table><div role='menu' id='menu' hidden><a role='menuitem' href='/marketplace/item/${id}/'>View</a></div>`);
  try { assert.equal(new URL(await findPublishedListingLink(page, title, options)).pathname, `/marketplace/item/${id}/`); }
  finally { await page.close(); }
});

test("menu navigation delay uses its confirmed item href without refreshing or waiting for timeout", async () => {
  const { page, reloads } = await fixture(`<p>${title}</p><button aria-label='More actions for ${title}' onclick="document.querySelector('#menu').hidden=false">...</button>
    <div role='menu' id='menu' hidden><a role='menuitem' href='/marketplace/item/${id}/' onclick="event.preventDefault();document.body.dataset.clicked='yes'">View</a></div>`);
  try {
    assert.equal(new URL(await findPublishedListingLink(page, title, options)).pathname, `/marketplace/item/${id}/`);
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), "yes");
    assert.equal(reloads(), 0);
  } finally { await page.close(); }
});

test("no matching title/menu reports a link failure instead of returning an unrelated listing", async () => {
  const { page } = await fixture("<article><a href='/marketplace/item/111111/'>Unrelated product</a></article>");
  try {
    await assert.rejects(findPublishedListingLink(page, title, { timeoutMs: 80, pollMs: 10, maxAttempts: 1 }), (error) => error.status === "loi link sp");
  } finally { await page.close(); }
});

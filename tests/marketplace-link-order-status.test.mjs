import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, after, test } from "node:test";
import { classifyCurrentPage } from "../modules/marketplace_link_order.js";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
let browser;
before(async () => { browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
after(async () => { await browser?.close(); });
for (const [title, button, expected] of [
  ['<span>Sold</span> · LEGO System 1967', '', 'sold'],
  ['<span>Pending</span> · BLACK AND WHITE BARBIE', '', 'pending'],
  ['<span>Pending</span> · BLACK AND WHITE BARBIE', '<button>Buy now</button>', 'pending'],
  ['Active gray button', '<button style="background:rgb(228,230,235)">Buy now</button>', 'buy now'],
  ['Active translucent button', '<button style="opacity:0.6">Buy now</button>', 'buy now'],
  ['Disabled checkout', '<button disabled>Buy now</button>', 'thâm buy now'],
  ['ARIA disabled checkout', '<div role="button" aria-disabled="true">Buy now</div>', 'thâm buy now'],
  ['LEGO sold separately', '<button>Out of stock</button>', 'out of stock'],
  ['Sold separately LEGO pieces', '', 'không rõ'],
  ['Pending · Old layout', '<button>Out of stock</button>', 'pending'],
]) {
  test(`listing title ${title} => ${expected}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<aside><h1>Marketplace</h1></aside><main style="margin-left:400px"><h1>${title}</h1><p>$45</p>${button}<p>Details</p><p>Condition: New</p></main>`);
      assert.equal(await classifyCurrentPage(page, 500), expected);
    } finally { await page.close(); }
  });
}
test('hidden pending heading and description mentioning sold do not override live listing', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1 style="display:none">Pending · Hidden</h1><main><h1>LEGO System</h1><p>Other sets sold separately</p><button>Send seller a message</button></main>');
    assert.equal(await classifyCurrentPage(page, 500), 'send seller a message');
  } finally { await page.close(); }
});

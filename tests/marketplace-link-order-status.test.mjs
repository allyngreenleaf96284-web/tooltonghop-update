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
  ['Message action', '<button>Message</button>', 'send seller a message'],
  ['Composer label', '<footer><span>Send seller a message</span><input value="Is this available?"><button>Send</button></footer>', 'send seller a message'],
  ['Checkout with composer', '<button>Buy now</button><footer><span>Send seller a message</span><input><button>Send</button></footer>', 'buy now'],
  ['Description only', '<p>Send seller a message</p>', 'không rõ'],
  ['LEGO sold separately', '<button>Out of stock</button>', 'out of stock'],
  ['Sold separately LEGO pieces', '', 'không rõ'],
  ['Pending · Old layout', '<button>Out of stock</button>', 'pending'],
]) {
  test(`listing title ${title} => ${expected}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<aside><h1>Marketplace</h1></aside><main style="margin-left:400px"><h1>${title}</h1><p>$45</p>${button}<p>Details</p><p>Condition: New</p></main>`);
      assert.equal(await classifyCurrentPage(page, expected === "send seller a message" ? 8500 : expected === "thâm buy now" ? 2500 : 500), expected);
    } finally { await page.close(); }
  });
}
test('hidden pending heading and description mentioning sold do not override live listing', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h1 style="display:none">Pending · Hidden</h1><main><h1>LEGO System</h1><p>Other sets sold separately</p><button>Send seller a message</button></main>');
    assert.equal(await classifyCurrentPage(page, 8500), 'send seller a message');
  } finally { await page.close(); }
});

test('initially disabled checkout becomes active before the gray confirmation window', async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent('<h1>Fixture</h1><button disabled>Buy now</button><script>setTimeout(()=>document.querySelector("button").disabled=false,150)</script>');
    assert.equal(await classifyCurrentPage(page,2500),'buy now');
  }finally{await page.close();}
});

test('sidebar Message and unrelated composer do not determine the listing status', async()=>{
  const page=await browser.newPage();
  try{
    await page.setContent('<aside style="position:absolute;left:0;width:200px"><button>Message</button><footer><span>Send seller a message</span><input><button>Send</button></footer></aside><main style="margin-left:500px"><h1>Unknown fixture</h1><p>$30</p></main>');
    assert.equal(await classifyCurrentPage(page,500),'không rõ');
  }finally{await page.close();}
});

for (const inner of [false,true]) test(`actions remain readable after scrolling ${inner?'the product panel':'the document'} past them`,async()=>{
  const page=await browser.newPage();
  try {
    await page.setViewport({width:800,height:400});
    await page.setContent(`<main id="product" style="margin-left:200px;${inner?'height:300px;overflow:auto;':''}"><h1>Fixture product</h1><button>Message</button><div style="height:1600px"></div></main>`);
    await page.evaluate(inner=>{if(inner)document.querySelector('#product').scrollTop=900;else window.scrollTo(0,900);},inner);
    assert.ok(await page.$eval('button',el=>el.getBoundingClientRect().bottom<0));
    assert.equal(await classifyCurrentPage(page,8500),'send seller a message');
  }finally{await page.close();}
});

test('unknown status recovers an overscrolled virtualized product panel automatically',async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent('<main id="panel" style="height:250px;overflow:auto"><h1>Fixture product</h1><div id="actions"></div><div style="height:1800px"></div></main><aside id="sidebar" style="height:100px;overflow:auto"><div style="height:2000px">Sidebar</div></aside>');
    await page.evaluate(()=>{
      const panel=document.querySelector('#panel');panel.scrollTop=900;
      document.querySelector('#sidebar').scrollTop=400;
      panel.addEventListener('scroll',()=>{if(panel.scrollTop<100)document.querySelector('#actions').innerHTML='<button>Make an offer</button>';});
    });
    assert.equal(await classifyCurrentPage(page,3000),'make an offer');
    assert.equal(await page.$eval('#sidebar',el=>el.scrollTop),400);
  }finally{await page.close();}
});

test('bounded down/up search can trigger lazy actions without reaching the bottom feed',async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent('<main id="panel" style="height:250px;overflow:auto"><h1>Fixture product</h1><div id="actions"></div><div style="height:3000px"></div></main>');
    await page.evaluate(()=>{
      const panel=document.querySelector('#panel');window.maxScroll=0;
      panel.addEventListener('scroll',()=>{window.maxScroll=Math.max(window.maxScroll,panel.scrollTop);if(panel.scrollTop>80)document.querySelector('#actions').innerHTML='<button>Buy now</button>';});
    });
    assert.equal(await classifyCurrentPage(page,4000),'buy now');
    assert.ok(await page.evaluate(()=>window.maxScroll<500));
  }finally{await page.close();}
});

test('scroll recovery finds the product pane even when virtualization removed its title',async()=>{
  const page=await browser.newPage();
  try{
    await page.setViewport({width:800,height:400});
    await page.setContent('<main id="panel" style="height:300px;overflow:auto"><div id="product"></div><div style="height:2000px">Virtualized content</div></main>');
    await page.evaluate(()=>{
      const panel=document.querySelector('#panel');panel.scrollTop=800;
      panel.addEventListener('scroll',()=>{if(panel.scrollTop<100)document.querySelector('#product').innerHTML='<h1>Fixture product</h1><button>Message</button>';});
    });
    assert.equal(await classifyCurrentPage(page,11000),'send seller a message');
  }finally{await page.close();}
});

test('checkout siblings override Message in a smaller title wrapper',async()=>{
 const page=await browser.newPage();try{
 await page.setContent('<main><header><h1>Product</h1><button>Message</button></header><section><button>Buy now</button><button>Make an offer</button></section></main>');
 assert.equal(await classifyCurrentPage(page,1000),'buy now- make an offer');
 }finally{await page.close();}
});
test('Message loading first cannot mask checkout rendered later',async()=>{
 const page=await browser.newPage();try{
 await page.setContent('<main><h1>Product</h1><button>Message</button><section id="checkout"></section><script>setTimeout(()=>document.querySelector("#checkout").innerHTML="<button>Buy now</button><button>Make an offer</button>",1200)</script></main>');
 assert.equal(await classifyCurrentPage(page,4000),'buy now- make an offer');
 }finally{await page.close();}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { checkWindowBounds, createLinkCheckDisplay, openCheckWindow } from "../modules/link_check_display.js";
const require = createRequire(import.meta.url);

for (const total of [1, 4, 6, 10]) test(`${total} windows have equal bounds without overlap or taskbar intrusion`, () => {
  const area = {left: 20, top: 10, width: 1920, height: 1040};
  const windows = Array.from({length:total},(_,i)=>checkWindowBounds(i,total,area));
  for(const [i,a] of windows.entries()) {
    assert.equal(a.width, windows[0].width);assert.equal(a.height, windows[0].height);
    assert.ok(a.left>=area.left && a.top>=area.top && a.left+a.width<=area.left+area.width && a.top+a.height<=area.top+area.height);
    assert.ok(a.width>=500);
    for(const b of windows.slice(i+1)) assert.ok(a.left+a.width<=b.left || b.left+b.width<=a.left || a.top+a.height<=b.top || b.top+b.height<=a.top);
  }
  assert.equal(windows.reduce((n,w)=>n+w.width*w.height,0),area.width*area.height);
});

test('different profile sizes get a common viewport, DPR and zoom across navigation',async()=>{
  const browser=await require('puppeteer-core').launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  let reads=0;
  const display=createLinkCheckDisplay({readWorkArea:async()=>{reads++;return {left:0,top:0,width:1920,height:1040};}});
  display.reset(40);
  try {
    const pages=await Promise.all([browser.newPage(),browser.newPage()]);
    await pages[0].setViewport({width:1600,height:900});await pages[1].setViewport({width:1360,height:768});
    await Promise.all(pages.map((page,i)=>display.apply(page,i,10)));
    await Promise.all(pages.map(page=>page.goto('data:text/html,<h1>Fixture</h1>')));
    const metrics=await Promise.all(pages.map(page=>page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:document.documentElement.style.zoom}))));
    assert.deepEqual(metrics[0],metrics[1]);assert.equal(metrics[0].zoom,'0.4');assert.equal(metrics[0].dpr,1);assert.equal(reads,1);
  } finally {await browser.close();}
});

test('extra check pages are distinct native windows in the existing authenticated profile context',async()=>{
  const browser=await require('puppeteer-core').launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const first=await browser.newPage();
    await first.setCookie({name:'fixture_session',value:'shared-profile',domain:'example.test',path:'/'});
    const second=await openCheckWindow(browser);
    assert.equal(second.browserContext(),first.browserContext());
    assert.equal((await second.cookies('https://example.test')).find(cookie=>cookie.name==='fixture_session')?.value,'shared-profile');
    const ids=[];
    for(const page of [first,second]){const cdp=await page.target().createCDPSession();try{ids.push((await cdp.send('Browser.getWindowForTarget')).windowId);}finally{await cdp.detach();}}
    assert.notEqual(ids[0],ids[1]);
  }finally{await browser.close();}
});

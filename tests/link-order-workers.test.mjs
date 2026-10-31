import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { partitionLinkTasks, linkCheckProfileIds } from '../modules/marketplace_link_order.js';

test('legacy profiles and extra profiles are normalized and duplicates cannot open twice', () => {
  assert.deepEqual(linkCheckProfileIds({marketplaceCheckNick1Id:' p1 ', marketplaceCheckNick2Id:'p2', marketplaceCheckExtraNickIds:['p3','p4','p5','p1','p\u200b2','']}), ['p1','p2','p3','p4','p5']);
  assert.deepEqual(linkCheckProfileIds({marketplaceCheckNick1Id:'p1',marketplaceCheckNick2Id:'p2'}), ['p1','p2']);
});
for (const n of [0, 2, 5, 13, 103]) {
  test(`${n} links are balanced across five profiles without duplicate claims`, async () => {
    const tasks=Array.from({length:n}, (_, i)=>({rowNumber:i+2,link:`https://example.test/${i}`}));
    const buckets=partitionLinkTasks(tasks,5);
    assert.equal(buckets.length,5);
    assert.ok(Math.max(...buckets.map(x=>x.length))-Math.min(...buckets.map(x=>x.length))<=1);
    const claims=[];
    await Promise.all(buckets.flatMap((bucket, owner)=> Array.from({length:4}, async()=> {
      while(bucket.length){const task=bucket.shift();claims.push({owner,...task});await Promise.resolve();}
    })));
    assert.equal(claims.length,n);
    assert.equal(new Set(claims.map(x=>x.rowNumber)).size,n);
    const remaining=tasks.filter(x=>x.rowNumber%2===0);
    const retry=partitionLinkTasks(remaining,3).flat();
    assert.deepEqual(retry.map(x=>x.rowNumber).sort((a,b)=>a-b),remaining.map(x=>x.rowNumber));
  });
}

import { createRequire } from 'node:module';
import { createMarketplaceLinkOrderTool } from '../modules/marketplace_link_order.js';
const require=createRequire(import.meta.url);
test('five browsers check sixty rows once and write the existing status column', async()=>{
  const puppeteer=require('puppeteer-core');
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-hide-run-'));
  const runtime={jobs:new Map(),running:false};
  const writes=[],visits=[],pages=[],loginOptions=[];
  const ids=['p1','p2','p3','p4','p5'];
  const tool=createMarketplaceLinkOrderTool({runtime,createWindowPage:browser=>browser.newPage(),journalPath:path.join(directory,"pending.json"),addRuntimeLog(message,type){if(type === "error" || type === "warn") console.log(message);},
    getGoogleAccessToken:async()=> 'fixture',
    SheetsClient:class {
      async metadata(){return {sheets:[{properties:{title:'Links',sheetId:0}}]};}
      async getValues(){return [['uid','LINK SP','tình trạng nick 1'],...Array.from({length:60},(_,i)=>['u',`https://www.facebook.com/marketplace/item/${100+i}`,''])];}
      async batchUpdateValues(data){writes.push(...data);}
    },
    getRowsByProfileIds:async()=>new Map(ids.map(id=>[id,{uid:id}])),
    dangNhap:{ensureFacebookLogin:async(manager,page,row,id,progress,options)=>{loginOptions.push(options);}},
    getHideManager:()=>({
      async connectBrowser(id){return {async newPage(){
        const page=await browser.newPage();pages.push({id,page});await page.setRequestInterception(true);
        page.on('request',request=>{if(request.isNavigationRequest())visits.push({id,url:request.url()});void request.respond({status:200,contentType:'text/html; charset=utf-8',body:request.url().includes('/159')?'<h1>New unsupported layout</h1><p>$20</p>':request.url().includes('/158')?'<h1>Fixture product</h1><footer><span>Send seller a message</span><input><button>Send</button></footer>':'<h1>Sold · Fixture product</h1><p>$20</p>'}).catch(()=>{});});const goto=page.goto.bind(page);page.goto=async(...args)=>{if(id==='p1')await new Promise(resolve=>setTimeout(resolve,700));return goto(...args);};return page;
      },async disconnect(){}};},async stopHideMyAccProfile(){}
    })
  });
  try{
    const result=await tool.run({credentialsPath:'fixture',marketplaceCheckSpreadsheetId:'fixture',marketplaceCheckNick1Id:'p1',marketplaceCheckNick2Id:'p2',marketplaceCheckExtraNickIds:['p3','p4','p5','p1'],marketplaceCheckTabsPerNick:3,marketplaceCheckTimeoutMs:10000});
    assert.equal(result.started,5);
    const deadline=Date.now()+25000;
    while(runtime.running && Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(runtime.running,false,JSON.stringify([...runtime.jobs.values()]));
    assert.equal(writes.length,60);
    assert.equal(new Set(writes.map(x=>x.range)).size,60);
    assert.ok(writes.every(x=>/!C\d+$/.test(x.range)));
    assert.equal(writes.filter(x=>x.values[0][0]==='sold').length,58);
    assert.equal(writes.filter(x=>x.values[0][0]==='send seller a message').length,1);
    assert.equal(writes.filter(x=>x.values[0][0]==='không rõ').length,1);
    assert.equal(new Set(visits.map(x=>x.url)).size,60);
    assert.equal(pages.length,15,'three check windows per profile');
    assert.equal(loginOptions.length,5);assert.ok(loginOptions.every(options=>options.robustLanguage===true));
    assert.equal(result.windows,15);
    assert.ok(ids.every(id=>visits.some(x=>x.id===id)));
    assert.ok(visits.filter(x=>x.id==='p1').length < Math.max(...ids.map(id=>visits.filter(x=>x.id===id).length)), 'fast profiles take work while slow profile is loading');
    assert.equal(runtime.linkOrderProgress.sheetPending,0);
    assert.equal(runtime.linkOrderProgress.total,60);
    assert.equal(runtime.linkOrderProgress.checked,60);
    assert.equal(runtime.linkOrderProgress.completed,59);
    assert.equal(runtime.linkOrderProgress.pending,1);
    assert.equal(runtime.linkOrderProgress.manualReview,1);
    assert.equal(runtime.linkOrderProgress.pass,1,"unknown layout waits for manual review instead of restarting");
    assert.equal(runtime.linkOrderProgress.inFlight,0);
    assert.equal(runtime.linkOrderProgress.activeProfiles,0);
    assert.equal(runtime.linkOrderProgress.running,false);
  }finally{runtime.stopRequested=true;await browser.close();await rm(directory,{recursive:true,force:true});}
});

test('Add nick check creates editable inputs and removing one preserves the others', async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function extraLinkCheckNickIds()'),source.indexOf('async function startLinkOrder()'));
  const browser=await require('puppeteer-core').launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<button id="addLinkCheckNick">Add</button><div id="linkCheckExtraNicks"></div>');
    await page.evaluate("window.$ = id => document.getElementById(id);"+code);
    await page.click('#addLinkCheckNick');
    await page.type('[data-link-check-nick]','p3');
    await page.evaluate(()=>{addLinkCheckNick('p4');addLinkCheckNick('p5');});
    assert.deepEqual(await page.evaluate(()=>extraLinkCheckNickIds()),['p3','p4','p5']);
    await page.click('#linkCheckExtraNicks > div:nth-child(2) button');
    assert.deepEqual(await page.evaluate(()=>extraLinkCheckNickIds()),['p3','p5']);
  }finally{await browser.close();}
});

test('tab count is configured exactly once inside the link check settings',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.equal((html.match(/id="marketplaceCheckTabsPerNick"/g)||[]).length,1);
  assert.ok(html.slice(html.indexOf('id="linkOrderModule"'),html.indexOf('id="linkOrderToolProgressPanel"')).includes('id="marketplaceCheckTabsPerNick"'));
});

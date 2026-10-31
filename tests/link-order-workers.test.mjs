import assert from 'node:assert/strict';
import { test } from 'node:test';
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
test('five browsers check thirteen rows once and write the existing status column', async()=>{
  const puppeteer=require('puppeteer-core');
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const runtime={jobs:new Map(),running:false};
  const writes=[],visits=[];
  const ids=['p1','p2','p3','p4','p5'];
  const tool=createMarketplaceLinkOrderTool({runtime,addRuntimeLog(message,type){if(type === "error" || type === "warn") console.log(message);},
    getGoogleAccessToken:async()=> 'fixture',
    SheetsClient:class {
      async metadata(){return {sheets:[{properties:{title:'Links',sheetId:0}}]};}
      async getValues(){return [['uid','LINK SP','tình trạng nick 1'],...Array.from({length:13},(_,i)=>['u',`https://www.facebook.com/marketplace/item/${100+i}`,''])];}
      async batchUpdateValues(data){writes.push(...data);}
    },
    getRowsByProfileIds:async()=>new Map(ids.map(id=>[id,{uid:id}])),
    dangNhap:{ensureFacebookLogin:async()=>{}},
    getHideManager:()=>({
      async connectBrowser(id){return {async newPage(){
        const page=await browser.newPage();await page.setRequestInterception(true);
        page.on('request',request=>{if(request.isNavigationRequest())visits.push({id,url:request.url()});void request.respond({status:200,contentType:'text/html; charset=utf-8',body:'<h1>Sold · Fixture product</h1><p>$20</p>'});});return page;
      },async disconnect(){}};},async stopHideMyAccProfile(){}
    })
  });
  try{
    const result=await tool.run({credentialsPath:'fixture',marketplaceCheckSpreadsheetId:'fixture',marketplaceCheckNick1Id:'p1',marketplaceCheckNick2Id:'p2',marketplaceCheckExtraNickIds:['p3','p4','p5','p1'],marketplaceCheckTabsPerNick:3});
    assert.equal(result.started,5);
    const deadline=Date.now()+25000;
    while(runtime.running && Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(runtime.running,false,JSON.stringify([...runtime.jobs.values()]));
    assert.equal(writes.length,13);
    assert.equal(new Set(writes.map(x=>x.range)).size,13);
    assert.ok(writes.every(x=>x.values[0][0]==='sold' && /!C\d+$/.test(x.range)));
    assert.equal(new Set(visits.map(x=>x.url)).size,13);
    assert.deepEqual(ids.map(id=>visits.filter(x=>x.id===id).length),[3,3,3,2,2]);
    assert.equal(runtime.linkOrderProgress.total,13);
    assert.equal(runtime.linkOrderProgress.checked,13);
    assert.equal(runtime.linkOrderProgress.completed,13);
    assert.equal(runtime.linkOrderProgress.pending,0);
    assert.equal(runtime.linkOrderProgress.inFlight,0);
    assert.equal(runtime.linkOrderProgress.activeProfiles,0);
    assert.equal(runtime.linkOrderProgress.running,false);
  }finally{runtime.stopRequested=true;await browser.close();}
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

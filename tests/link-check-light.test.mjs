import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installLightLinkCheck, createLinkCheckProgress } from '../modules/link_check_light.js';
import { classifyCurrentPage } from '../modules/marketplace_link_order.js';
const require=createRequire(import.meta.url);

test('light tab blocks heavy resources, keeps CSS/JavaScript, and classifies without waiting three seconds',async()=>{
  const hits=[], failed=[];
  const server=http.createServer((req,res)=>{
    hits.push(req.url);
    if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end('@font-face{font-family:fixture;src:url(/font.woff2)}h1{font-family:fixture;background:rgb(228,230,235)}');}
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end('setTimeout(()=>{document.querySelector("main").innerHTML="<h1>Pending · Fixture</h1>"},250);');}
    res.setHeader('Content-Type','text/html');
    res.end('<link rel="stylesheet" href="/style.css"><main><h1>Loading</h1></main><img src="/huge.jpg"><video preload="auto" src="/movie.mp4"></video><script src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    page.on('requestfailed',req=>failed.push(req.resourceType()));
    await installLightLinkCheck(page);
    const listeners=page.listenerCount('request');
    await installLightLinkCheck(page);
    assert.equal(page.listenerCount('request'),listeners);
    await page.goto(`http://127.0.0.1:${server.address().port}/listing`,{waitUntil:'domcontentloaded'});
    const started=Date.now();
    assert.equal(await classifyCurrentPage(page,3000),'pending');
    assert.ok(Date.now()-started<2000,'known status must not incur a fixed three-second sleep');
    await page.evaluate(()=>document.fonts.ready);
    assert.ok(hits.includes('/style.css')&&hits.includes('/app.js'));
    assert.ok(!hits.includes('/huge.jpg')&&!hits.includes('/font.woff2')&&!hits.includes('/movie.mp4'));
    assert.ok(failed.includes('image')&&failed.includes('font'));
    await page.goto('about:blank');
    assert.equal(await page.evaluate(()=>document.querySelector('h1')),null);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('aggregate counts distinct rows and keeps unknown/failed writes pending across retry passes',()=>{
  const runtime={};
  const retry=value=>['không rõ','lỗi check'].includes(value);
  const progress=createLinkCheckProgress(runtime,5,retry);
  const plan=(id,statuses)=>({spreadsheetId:id,title:'Links',nick1Index:1,
    values:[['LINK SP','tình trạng nick 1'],...statuses.map((s,i)=>['link'+i,s])],
    sharedQueue:{tasks:statuses.flatMap((s,i)=>!s||retry(s)?[{rowNumber:i+2}]:[])}});
  const a=plan('A',['','','sold']),b=plan('B',['']);
  progress.register([a,b]);assert.equal(progress.summary.total,3);
  progress.wrote(a,{rowNumber:2},'sold');progress.wrote(a,{rowNumber:3},'không rõ');
  assert.equal(progress.summary.checked,2);assert.equal(progress.summary.completed,1);assert.equal(progress.summary.pending,2);
  // A write failure never invokes wrote(), so B is not counted as checked.
  progress.register([plan('A',['sold','không rõ','sold']),b]);
  progress.wrote(a,{rowNumber:3},'pending');progress.wrote(a,{rowNumber:3},'pending');
  assert.equal(progress.summary.checked,2);assert.equal(progress.summary.retryable,0);
  progress.wrote(b,{rowNumber:2},'hết hạn');
  assert.equal(progress.summary.completed,3);assert.equal(progress.summary.pending,0);
  progress.finish();assert.equal(progress.summary.running,false);
});

test('UI displays link totals instead of profile totals and keeps unresolved links visible',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function linkOrderProgressPresentation('),source.indexOf('function renderToolProgress(data)'));
  const context={};vm.createContext(context);vm.runInContext(code,context);
  const result=context.linkOrderProgressPresentation({total:1000,checked:800,completed:790,retryable:10,inFlight:8,activeProfiles:4,profileCount:5,pass:2,running:true});
  assert.equal(result.countLabel,'Đã check 800 / 1000 link');assert.equal(result.percent,79);
  assert.match(result.textLabel,/Còn 210/);assert.match(result.textLabel,/Nick hoạt động 4\/5/);
  assert.equal(context.linkOrderProgressPresentation({total:10,completed:8,running:false}).stateLabel,'còn link chưa xong');
});

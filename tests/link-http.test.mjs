import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { accountUid, parseCheckProxy, classifyHttpListing, createHttpCheckClient } from '../modules/link_http_client.js';
import { runHttpLinkChecks, createHttpSheetWriter } from '../modules/link_http_runner.js';
import { readHttpListingActions } from '../modules/link_http_html.js';
const require=createRequire(import.meta.url),exec=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const payload=(id,status)=>JSON.stringify({data:{listing:{__typename:'GroupCommerceProductItem',id,...status}}});

test('proxy/cookie parsing accepts supported forms and rejects missing auth session',()=>{
  assert.equal(parseCheckProxy('127.0.0.1:8000').port,'8000');
  const proxy=parseCheckProxy('127.0.0.1:8000:user:pass');assert.equal(proxy.username,'user');assert.equal(proxy.password,'pass');
  assert.equal(parseCheckProxy('http://user:pass@localhost:80').hostname,'localhost');
  assert.throws(()=>parseCheckProxy('socks5://localhost:1080'));
  assert.equal(accountUid('c_user=10001; xs=fixture;'),'10001');
  assert.throws(()=>accountUid('c_user=10001;'));assert.throws(()=>accountUid('c_user=10001; xs=x\r\nInjected: y'));
});

test('proxy authentication errors retain HTTP 407 without exposing credentials',async()=>{
  const proxy=http.createServer();
  proxy.on('connect',(req,socket)=>socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const client=createHttpCheckClient({cookie:'c_user=10001; xs=fixture;',proxy:`127.0.0.1:${proxy.address().port}:fixture-user:fixture-secret`});
  try{await assert.rejects(client.verifyUs(),error=>/HTTP 407/.test(error.message)&&!error.message.includes('fixture-secret')&&!error.message.includes('fixture-user'));}
  finally{client.close();await new Promise(resolve=>proxy.close(resolve));}
});

test('HTML classification requires evidence for the requested listing and never guesses gray Buy now',()=>{
  const response=html=>({html,status:200,url:'https://www.facebook.com/marketplace/item/123/'});
  for(const [field,expected] of [['is_sold','sold'],['is_pending','pending'],['is_buy_now_enabled','buy now']])assert.equal(classifyHttpListing(response(`<script type="application/json">${payload('123',{[field]:true,...(field==='is_buy_now_enabled'?{is_sold:false,is_pending:false,is_checkout_enabled:true}:{})})}</script>`),'123').status,expected);
  assert.equal(classifyHttpListing(response(`<script type="application/json">${payload('999',{is_sold:true})}</script><p>Sold separately</p><button>Buy now</button>`),'123').status,'không rõ');
  assert.equal(classifyHttpListing(response('<link rel="canonical" href="https://www.facebook.com/marketplace/item/123/"><h1>Pending · Product</h1>'),'123').status,'pending');
  assert.equal(classifyHttpListing({status:200,url:'https://www.facebook.com/login/',html:'login'},'123').blocked,true);
  assert.equal(classifyHttpListing({status:429,url:'https://www.facebook.com/marketplace/item/123/',html:''},'123').blocked,true);
  assert.equal(classifyHttpListing(response('<form id="login_form"><input name="email"></form>'),'123').blocked,true);
});

test('real Facebook fragment shape merges delivery and availability before deciding status',()=>{
  const script=value=>`<script type="application/json" data-sjs>${JSON.stringify({require:[['ScheduledServerJS','handle',null,[{__bbox:{result:{data:{target:value}}}}]]]})}</script>`;
  const delivery={__typename:'GroupCommerceProductItem',id:'123',__isMarketplaceListingWithDeliveryOptions:'MarketplaceListingWithDeliveryOptions',is_buy_now_enabled:true};
  for(const status of ['sold','pending']){
    const availability={__typename:'GroupCommerceProductItem',id:'123',__isMarketplaceListingRenderable:'MarketplaceListingRenderable',is_sold:status==='sold',is_pending:status==='pending',is_checkout_enabled:false};
    for(const html of [script(delivery)+script(availability),script(availability)+script(delivery)]) assert.equal(classifyHttpListing({html,status:200,url:'https://www.facebook.com/marketplace/item/123/'},'123').status,status);
  }
  const unresolved={...delivery,is_sold:false,is_pending:false,is_checkout_enabled:false};
  assert.equal(classifyHttpListing({html:script(unresolved),status:200,url:'https://www.facebook.com/marketplace/item/123/'},'123').status,'không rõ');
  const legacy={__typename:'MarketplaceListing',id:'123',is_sold:true};
  assert.equal(classifyHttpListing({html:script(legacy),status:200,url:'https://www.facebook.com/marketplace/item/123/'},'123').status,'sold');
});

test('server-rendered controls resolve Buy now plus Make an offer and explicit disabled Buy now',()=>{
  const target={__typename:'GroupCommerceProductItem',id:'123',marketplace_listing_title:'Fixture product',is_sold:false,is_pending:false,is_buy_now_enabled:true,is_checkout_enabled:false};
  const classify=buttons=>classifyHttpListing({status:200,url:'https://www.facebook.com/marketplace/item/123/',html:`<script type="application/json">${JSON.stringify(target)}</script><main><section><h1>Fixture product</h1><div>${buttons}</div></section><aside><h1>Other product</h1><button>Out of stock</button></aside></main>`},'123').status;
  assert.equal(classify('<div role="button"><span>Buy now</span></div><button>Make an offer</button>'),'buy now- make an offer');
  assert.equal(classify('<div aria-disabled="true" role="button"><span>Buy now</span></div>'),'thâm buy now');
  assert.equal(classify('<button disabled>Buy now</button>'),'thâm buy now');
  assert.equal(classify('<button>Send seller a message</button>'),'send seller a message');
  assert.equal(classify('<button>Out of stock</button>'),'out of stock');
  assert.equal(readHttpListingActions('<section><h1>Other product</h1><button>Buy now</button></section>','Fixture product'),'');
  assert.equal(readHttpListingActions('<section><h1>Fixture product</h1><div aria-hidden="true"><button>Make an offer</button></div><button>Buy now</button></section>','Fixture product'),'buy now');
  const segment='<div hidden id="S:3"><section><h1>Fixture product</h1><button aria-disabled="true">Buy now</button></section></div>';
  assert.equal(readHttpListingActions(segment+'<template data-rsi="" data-sid="S:3" data-pid="P:3"></template>','Fixture product'),'thâm buy now');
  assert.equal(readHttpListingActions(segment,'Fixture product'),'');
  assert.equal(readHttpListingActions('<main><h1>Fixture product</h1></main><aside><button>Buy now</button></aside>','Fixture product'),'');
});

test('durable writer replays failed batches, preserves other cells, and refuses moved rows',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-http-journal-'));
  try{
    let fail=true;const writes=[];
    const plan={spreadsheetId:'fixture',title:"O'Brien",nick1Index:2,linkIndex:1,values:[['uid','link','status'],['u','https://www.facebook.com/marketplace/item/123/','']],client:{async batchUpdateValues(batch){if(fail)throw Error('fixture quota');writes.push(...batch);}}};
    const file=path.join(directory,'pending.json');
    const writer=await createHttpSheetWriter([plan],file);await writer.write(plan,{rowNumber:2,link:plan.values[1][1]},'sold');
    await assert.rejects(writer.flush());assert.equal(writer.pendingCount,1);
    fail=false;const restored=await createHttpSheetWriter([plan],file);await restored.flush();
    assert.equal(restored.pendingCount,0);assert.equal(writes[0].range,"'O''Brien'!C2");assert.equal(plan.values[1][0],'u');
    await restored.write(plan,{rowNumber:2,link:plan.values[1][1]},'pending');plan.values[1][1]='different link';
    await assert.rejects(restored.flush(),/da doi link/);assert.equal(writes.length,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('three cookie/proxy accounts run concurrently without Hide, share unique tasks, batch Sheet writes, and expose no credentials',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-http-run-'));
  try{
    const runtime={jobs:new Map()},writes=[],visits=[];let active=0,peak=0;
    const plan={spreadsheetId:'fixture',title:'Links',linkIndex:1,nick1Index:2,values:[['uid','LINK SP','status'],...Array.from({length:12},(_,i)=>['u',`https://www.facebook.com/marketplace/item/${100+i}/`,''])],client:{async batchUpdateValues(batch){writes.push(...batch);}}};
    const accounts=[10001,10002,10003].map(uid=>({cookie:`c_user=${uid}; xs=fixture-secret;`,proxy:'localhost:8000'}));
    const result=await runHttpLinkChecks({config:{marketplaceHttpAccounts:accounts,marketplaceCheckSpreadsheetId:'fixture',marketplaceHttpConcurrency:2},runtime,log(){},readPlan:async()=>plan,journalPath:path.join(directory,'pending.json'),
      createClient:nick=>({async verifyUs(){await delay(10);},async get(url){if(url.includes('/me?'))return {status:200,url,html:`{"USER_ID":"${nick.uid}"}`};
        active++;peak=Math.max(peak,active);visits.push(url);await delay(15);active--;const id=new URL(url).pathname.match(/item\/(\d+)/)[1];
        return {status:200,url,html:`<script type="application/json">${payload(id,{is_sold:true})}</script>`};},close(){}})});
    assert.equal(result.started,3);const deadline=Date.now()+5000;while(runtime.running&&Date.now()<deadline)await delay(10);
    assert.equal(runtime.running,false);assert.ok(peak>2);assert.equal(visits.length,12);assert.equal(new Set(visits).size,12);
    assert.equal(writes.length,12);assert.equal(runtime.linkOrderProgress.completed,12);assert.equal(runtime.linkOrderProgress.sheetPending,0);
    assert.ok(!JSON.stringify([...runtime.jobs.values()]).includes('fixture-secret'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HTTP account editor has exactly cookie and proxy fields, removes rows, and toggles modes',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function linkHttpAccounts()'),source.indexOf('function extraLinkCheckNickIds()'));
  const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<select id="marketplaceCheckMode"><option value="hide">Hide</option><option value="http">HTTP</option></select><div id="linkHttpSettings"><button id="addLinkHttpNick">Add</button><div id="linkHttpAccounts"></div></div><div id="linkHideAccounts"></div><label><input id="marketplaceCheckTabsPerNick"></label>');
    await page.evaluate('window.$=id=>document.getElementById(id);'+code);
    await page.select('#marketplaceCheckMode','http');await page.click('#addLinkHttpNick');
    assert.equal(await page.$$eval('[data-link-http-account] input',nodes=>nodes.length),2);
    await page.type('[data-cookie]','c_user=10001; xs=fixture;');await page.type('[data-proxy]','localhost:8000');
    assert.deepEqual(await page.evaluate(()=>linkHttpAccounts()),[{cookie:'c_user=10001; xs=fixture;',proxy:'localhost:8000'}]);
    assert.equal(await page.$eval('#linkHideAccounts',node=>node.classList.contains('hidden')),true);
    await page.click('[data-link-http-account] button');assert.equal(await page.$$eval('[data-link-http-account]',nodes=>nodes.length),0);
  }finally{await browser.close();}
});

test('a rejected session does not consume links assigned to healthy sessions',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-http-auth-'));
  try{
    const runtime={jobs:new Map()},writes=[];
    const plan={spreadsheetId:'fixture',title:'Links',linkIndex:0,nick1Index:1,values:[['link','status'],['https://www.facebook.com/marketplace/item/123/','']],client:{async batchUpdateValues(batch){writes.push(...batch);}}};
    await runHttpLinkChecks({runtime,log(){},config:{marketplaceCheckSpreadsheetId:'fixture',marketplaceHttpAccounts:[10001,10002].map(uid=>({cookie:`c_user=${uid}; xs=fixture;`,proxy:'localhost:8000'}))},readPlan:async()=>plan,journalPath:path.join(directory,'pending.json'),
      createClient:nick=>({async verifyUs(){if(nick.uid==='10001')throw new Error('Proxy not US');},async get(url){return url.includes('/me?')?{status:200,url,html:`{"USER_ID":"${nick.uid}"}`}:{status:200,url,html:`<script type="application/json">${payload('123',{is_pending:true})}</script>`};},close(){}})});
    while(runtime.running)await delay(10);
    assert.equal(runtime.jobs.get('http-10001').status,'error');assert.equal(writes.length,1);assert.equal(writes[0].values[0][0],'pending');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Stop aborts requests, releases clients, and leaves unfinished rows untouched',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-http-stop-'));
  try{
    const runtime={jobs:new Map()},writes=[];let closed=0;
    const plan={spreadsheetId:'fixture',title:'Links',linkIndex:0,nick1Index:1,values:[['link','status'],['https://www.facebook.com/marketplace/item/123/','']],client:{async batchUpdateValues(batch){writes.push(...batch);}}};
    await runHttpLinkChecks({runtime,log(){},config:{marketplaceCheckSpreadsheetId:'fixture',marketplaceHttpAccounts:[{cookie:'c_user=10001; xs=fixture;',proxy:'localhost:8000'}]},readPlan:async()=>plan,journalPath:path.join(directory,'pending.json'),
      createClient:()=>({async verifyUs(){},async get(url,{signal}){if(url.includes('/me?'))return {status:200,url,html:'{"USER_ID":"10001"}'};
        runtime.stopRequested=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));},close(){closed++;}})});
    const deadline=Date.now()+5000;while(runtime.running&&Date.now()<deadline)await delay(20);
    assert.equal(runtime.running,false);assert.equal(closed,1);assert.equal(writes.length,0);assert.equal(runtime.linkOrderProgress.pending,1);assert.equal(runtime.linkOrderProgress.inFlight,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('native HTTP client tunnels TLS through authenticated proxy, reuses cookie updates, and sends no cookie to IP lookup',async(t)=>{
  const openssl='C:/Program Files/Git/usr/bin/openssl.exe';try{await access(openssl);}catch{t.skip('openssl fixture generator unavailable');return;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'link-http-tls-'));
  let secure,proxy;
  const sockets=new Set(),seen=[],connects=[];
  try{
    await exec(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem'),'-days','1','-subj','/CN=www.facebook.com','-addext','subjectAltName=DNS:www.facebook.com,DNS:api64.ipify.org']);
    secure=https.createServer({key:await readFile(path.join(directory,'key.pem')),cert:await readFile(path.join(directory,'cert.pem'))},(req,res)=>{
      seen.push({host:req.headers.host,cookie:req.headers.cookie||'',userAgent:req.headers['user-agent'],accept:req.headers.accept});res.setHeader('Content-Type','application/json');
      if(req.headers.host==='api64.ipify.org')return res.end('{"ip":"2001:db8::1"}');
      res.setHeader('Set-Cookie','xs=updated-fixture; Path=/');res.setHeader('Content-Encoding','gzip');res.end(gzipSync('{"USER_ID":"10001"}'));
    });
    await new Promise(resolve=>secure.listen(0,'127.0.0.1',resolve));
    proxy=http.createServer();proxy.on('connect',(req,socket,head)=>{
      connects.push(req.headers['proxy-authorization']);const target=net.connect(secure.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target).pipe(socket);});
      for(const connection of [socket,target]){sockets.add(connection);connection.on('error',()=>{});connection.on('close',()=>sockets.delete(connection));}
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const moduleUrl=new URL('../modules/link_http_client.js',import.meta.url).href;
    const script=`import {createHttpCheckClient} from ${JSON.stringify(moduleUrl)};const client=createHttpCheckClient({cookie:'c_user=10001; xs=original-fixture;',proxy:'http://user:pass@127.0.0.1:${proxy.address().port}'},{lookupCountry:async(ip)=>{if(ip!=='2001:db8::1')throw Error('bad IPv6 exit');return {country:'US'};}});try{await client.verifyUs();const reply=await client.get('https://www.facebook.com/me');if(JSON.parse(reply.html).USER_ID!=='10001')throw Error('bad gzip');await client.get('https://www.facebook.com/me');console.log('ok');}finally{client.close();}`;
    const result=await exec(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NODE_EXTRA_CA_CERTS:path.join(directory,'cert.pem')},timeout:20000});
    assert.match(result.stdout,/ok/);assert.ok(connects.every(value=>value==='Basic '+Buffer.from('user:pass').toString('base64')));
    assert.equal(seen[0].host,'api64.ipify.org');assert.equal(seen[0].cookie,'');assert.match(seen[2].cookie,/xs=updated-fixture/);
    assert.ok(seen.every(item=>item.userAgent==='ToolTongHop-LinkCheck/1.0'));
    assert.equal(seen[0].accept,'application/json');assert.match(seen[1].accept,/text\/html/);assert.ok(!seen[1].accept.includes('application/json'));
  }finally{for(const socket of sockets)socket.destroy();if(proxy)await new Promise(resolve=>proxy.close(resolve));if(secure)await new Promise(resolve=>secure.close(resolve));await rm(directory,{recursive:true,force:true});}
});

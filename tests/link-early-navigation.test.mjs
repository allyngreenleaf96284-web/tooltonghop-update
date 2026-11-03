import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {classifyPage} from '../modules/marketplace_link_order.js';
const require=createRequire(import.meta.url);
test('recognizes new product before a blocking script finishes loading',async()=>{
 const server=createServer((req,res)=>{if(req.url.startsWith('/slow'))return;res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>Sold · New product</h1><script src="/slow.js"></script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent('<h1>Pending · Old product</h1>');const start=Date.now();assert.equal(await classifyPage(page,`http://127.0.0.1:${server.address().port}/product`,10000),'sold');assert.ok(Date.now()-start<5000);}
 finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});


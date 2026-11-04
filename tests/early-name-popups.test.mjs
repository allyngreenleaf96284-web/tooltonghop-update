import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {checkThreeVDisplayName} from '../modules/early_display_name.js';
import {dismissIncidentalPopups} from '../modules/incidental_popups.js';
const require=createRequire(import.meta.url);
test('3v detects non-Latin name early; 2v does not inspect names',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();const content=name=>`<aside><h1>Item for sale</h1><div><img src="x"><span>${name}</span><div><span>Listing to Marketplace</span><span> · </span><span>Public</span></div></div><input placeholder="Title"></aside>`;
 await page.setContent(content('المطيري الجوهرة'));await assert.rejects(checkThreeVDisplayName(page,{kind:'progress',totalSteps:3}),error=>error.status==='cdt');
 assert.equal(await checkThreeVDisplayName(page,{kind:'progress',totalSteps:2}),'');
 await page.setContent(content('Ngô Minh Vũ'));assert.equal(await checkThreeVDisplayName(page,{kind:'progress',totalSteps:3}),'Ngô Minh Vũ');
 }finally{await browser.close();}
});
test('incidental Meta dialog closes while seller and language workflow dialogs stay open',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>void request.respond({status:200,contentType:'text/html; charset=utf-8',body:`<div role="dialog" id="meta"><h2>Your Meta Account is here</h2><button aria-label="Close" onclick="this.parentElement.remove()">X</button></div><div role="dialog" id="seller"><h2>Seller information setup</h2><button aria-label="Close" onclick="this.parentElement.remove()">X</button></div><div role="dialog" id="language"><h2>Select language</h2><button aria-label="Close" onclick="this.parentElement.remove()">X</button></div>`}).catch(()=>{}));await page.goto('https://www.facebook.com/');
 assert.equal(await dismissIncidentalPopups(page),1);assert.equal(await page.$('#meta'),null);assert.ok(await page.$('#seller'));assert.ok(await page.$('#language'));
 }finally{await browser.close();}
});

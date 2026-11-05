import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {waitShippingControl,closeWeightMenu} from '../modules/shipping_dialog.js';
const require=createRequire(import.meta.url);
test('delayed modal and weight options are clicked once; ready modal is never toggled closed',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<button id="launcher">Select delivery label</button><div id="modal" role="dialog" hidden><h2>Change delivery method</h2><label id="weightLabel">Package weight</label><button id="weight" role="combobox" aria-labelledby="weightLabel" aria-expanded="false">2-5 lbs</button><div id="options" role="listbox" hidden><div role="option">0.9-2.25 kg (2-5 lbs)</div></div><button>Update</button></div>`);
 await page.evaluate(()=>{window.clicks=0;window.weights=0;document.querySelector('#launcher').onclick=()=>{window.clicks++;setTimeout(()=>document.querySelector('#modal').hidden=false,500);};document.querySelector('#weight').onclick=()=>{window.weights++;const field=document.querySelector('#weight');if(field.getAttribute('aria-expanded')==='true'){field.setAttribute('aria-expanded','false');document.querySelector('#options').hidden=true;}else{field.setAttribute('aria-expanded','true');setTimeout(()=>document.querySelector('#options').hidden=false,500);}};});
 await waitShippingControl(page,'label','Delivery',{pollMs:30,retryMs:2000});await waitShippingControl(page,'label','Delivery',{pollMs:30,retryMs:2000});assert.equal(await page.evaluate(()=>window.clicks),1);
 await waitShippingControl(page,'weight','Delivery',{pollMs:30,retryMs:2000});assert.equal(await page.evaluate(()=>window.weights),1);await closeWeightMenu(page);assert.equal(await closeWeightMenu(page,false),true);assert.equal(await page.$eval('#modal',el=>el.hidden),false);
 await assert.rejects(waitShippingControl(page,'label','Delivery',{shouldStop:()=>true}),error=>error.status==='stopped');
 }finally{await browser.close();}
});
test('label retries only while dialog is absent and stops clicking after it appears',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<button onclick="window.count=(window.count||0)+1;if(window.count===2)document.querySelector('[role=dialog]').hidden=false">Select delivery label</button><div role="dialog" hidden>Change delivery method</div>`);await waitShippingControl(page,'label','Delivery',{retryMs:150,pollMs:25});assert.equal(await page.evaluate(()=>window.count),2);await waitShippingControl(page,'label','Delivery',{retryMs:150,pollMs:25});assert.equal(await page.evaluate(()=>window.count),2);
 }finally{await browser.close();}
});
test('every progress panel shows a copyable UID instead of the Hide profile id',async()=>{
 const {readFile}=await import('node:fs/promises');const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const fn=app.slice(app.indexOf('function renderToolProgressPanel({'),app.indexOf('let loginPauseRequestPending'));
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent('<section id="panel"><div id="status"></div><div id="count"></div><div id="text"></div><div id="bar"></div><div id="list"></div></section>');await page.addScriptTag({content:`const $=id=>document.getElementById(id);const escapeHtml=x=>String(x);const escapeAttr=escapeHtml;const state={profiles:[{id:'hide-profile-private',uid:'61575115240717'}]};`+fn});await page.evaluate(()=>renderToolProgressPanel({panelId:'panel',stateId:'status',countId:'count',textId:'text',barId:'bar',listId:'list',stateLabel:'running',countLabel:'1/1',textLabel:'Progress',percent:50,jobs:[{profileId:'hide-profile-private',status:'running',tool:'lam full',liveStatus:'Checking'}]}));assert.equal(await page.$eval('[data-copy-login-uid]',el=>el.textContent),'61575115240717');assert.equal(await page.$eval('#list',el=>el.textContent.includes('hide-profile-private')),false);
 }finally{await browser.close();}
});
test('weight menu without option/radio roles is detected without toggling it again',async()=>{
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<div><h2>Change delivery method</h2><button role="combobox" onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#menu').hidden=!document.querySelector('#menu').hidden">Package weight</button><div id="menu"><div>0.9-2.25 kg (2-5 lbs)</div></div></div>`);
 await waitShippingControl(page,'weight','Delivery',{pollMs:20});assert.equal(await page.evaluate(()=>window.clicks||0),0);
 assert.equal(await closeWeightMenu(page),false);assert.equal(await closeWeightMenu(page,false),true);
 }finally{await browser.close();}
});

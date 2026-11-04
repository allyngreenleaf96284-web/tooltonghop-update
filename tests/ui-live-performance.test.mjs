import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('5000 profile rows retain DOM and delegated selection across live updates',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const fn=app.slice(app.indexOf('const profileTablePages='),app.indexOf('function renderActiveModule()'));
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent('<div id="statVisible"></div><div id="statSelected"></div><table><tbody id="profileRows"></tbody></table>');
 await page.addScriptTag({content:`const $=id=>document.getElementById(id);const escapeHtml=x=>String(x||'');const escapeAttr=escapeHtml;const sheetValue=(p,k)=>p.sheetData?.[k]||'';const updateSelectionSummary=()=>{};const updateSelectAllState=()=>{};const toggleProfile=()=>{};const state={selectedIds:new Set(),duplicates:{duplicateProfileIds:[]},profiles:Array.from({length:5000},(_,i)=>({id:'p'+i,name:'Profile '+i,uid:String(i)}))};const visibleProfiles=()=>state.profiles;`+fn});
 const result=await page.evaluate(()=>{renderRows();const row=document.querySelector('tr');const checkbox=row.querySelector('input');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));renderRows();const selected=state.selectedIds.has('p0');const retained=document.querySelector('tr')===row;const input=row.querySelector('input');renderRows();const stableInput=row.querySelector('input')===input;state.profiles[1].name='Updated';renderRows();return {selected,retained,stableInput,changed:document.querySelectorAll('tr')[1].textContent.includes('Updated'),count:document.querySelectorAll('tr').length};});
 assert.deepEqual(result,{selected:true,retained:true,stableInput:true,changed:true,count:100});
 await page.evaluate(()=>{profileTablePages.get('profileRows').page=1;renderRows();});
 assert.equal(await page.$eval('tr',row=>row.dataset.profileId),'p100');
 await page.evaluate(()=>{profileTablePages.get('profileRows').page=0;renderRows();});
 assert.equal(await page.$eval('tr input',input=>input.checked),true);
 }finally{await browser.close();}
});
test('Full renders only 100 rows for a 5000-profile folder',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const helper=app.slice(app.indexOf('const profileTablePages='),app.indexOf('let lastUiInteraction='));
 const full=app.slice(app.indexOf('function renderFullRows()'),app.indexOf('function updateFullSelectAllState()'));
 const ids=[...full.matchAll(/\$\("([^"]+)"\)/g)].map(match=>match[1]).filter(id=>id!=='fullRows');
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent([...new Set(ids)].map(id=>`<div id="${id}"></div>`).join('')+'<div class="table-wrap"><table><tbody id="fullRows"></tbody></table></div>');
 await page.addScriptTag({content:`const $=id=>document.getElementById(id);const escapeHtml=x=>String(x||'');const escapeAttr=escapeHtml;const sheetValue=(p,k)=>p.sheetData?.[k]||'';const updateSelectionSummary=()=>{};const updateFullSelectAllState=()=>{};const syncRuntimeProfileRows=()=>{};const toolRuntimeIsVisible=()=>false;const isFullDone=()=>false;const state={selectedFolderId:'all',selectedFullIds:new Set(),folders:[],profiles:Array.from({length:5000},(_,i)=>({id:'p'+i,name:'Profile '+i,uid:String(i)}))};const fullProfiles=()=>state.profiles;`+helper+full});
 const timing=await page.evaluate(()=>{const start=performance.now();renderFullRows();return {ms:performance.now()-start,rows:document.querySelectorAll('#fullRows tr').length,total:document.querySelector('#fullVisible').textContent};});
 assert.equal(timing.rows,100);assert.equal(timing.total,'5000');console.log(`Full 5000 profiles: ${timing.ms.toFixed(1)}ms render`);
 await page.click('input.full-check');assert.equal(await page.evaluate(()=>state.selectedFullIds.has('p0')),true);
 }finally{await browser.close();}
});

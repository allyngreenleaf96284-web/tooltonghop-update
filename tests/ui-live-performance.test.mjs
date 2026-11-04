import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('5000 profile rows retain DOM and delegated selection across live updates',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const fn=app.slice(app.indexOf('function renderRows()'),app.indexOf('function renderActiveModule()'));
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage();await page.setContent('<div id="statVisible"></div><div id="statSelected"></div><table><tbody id="profileRows"></tbody></table>');
 await page.addScriptTag({content:`const $=id=>document.getElementById(id);const escapeHtml=x=>String(x||'');const escapeAttr=escapeHtml;const sheetValue=(p,k)=>p.sheetData?.[k]||'';const updateSelectionSummary=()=>{};const updateSelectAllState=()=>{};const toggleProfile=()=>{};const state={selectedIds:new Set(),duplicates:{duplicateProfileIds:[]},profiles:Array.from({length:5000},(_,i)=>({id:'p'+i,name:'Profile '+i,uid:String(i)}))};const visibleProfiles=()=>state.profiles;`+fn});
 const result=await page.evaluate(()=>{renderRows();const row=document.querySelector('tr');const checkbox=row.querySelector('input');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));renderRows();const selected=state.selectedIds.has('p0');const retained=document.querySelector('tr')===row;const input=row.querySelector('input');renderRows();const stableInput=row.querySelector('input')===input;state.profiles[1].name='Updated';renderRows();return {selected,retained,stableInput,changed:document.querySelectorAll('tr')[1].textContent.includes('Updated'),count:document.querySelectorAll('tr').length};});
 assert.deepEqual(result,{selected:true,retained:true,stableInput:true,changed:true,count:5000});
 }finally{await browser.close();}
});
